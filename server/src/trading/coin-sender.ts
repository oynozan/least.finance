import type { MongoClient } from "mongodb";
import type { Logger } from "pino";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import type { Collections } from "../db/mongo.ts";
import { COINS, NETWORKS, type CoinEntry } from "../swaps/coins.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import type { CoinWithdrawalDoc } from "./docs.ts";
import type { InventoryChain, PreparedTx } from "./inventory-chain.ts";
import { alreadySent, refused } from "./send-errors.ts";
import { UNIT_DECIMALS, fromUnitsDecimal } from "./units.ts";

/** Sends SOL from the Solana inventory wallet; a signature is known before the transaction goes out. */
export type SolanaSender = {
    prepare(to: string, lamports: bigint): Promise<{ signature: string; broadcast(): Promise<void> }>;
    /** Null while the cluster doesn't know the signature. */
    status(signature: string): Promise<"confirmed" | "failed" | null>;
};

type Deps = {
    client: MongoClient;
    collections: Pick<Collections, "coinWithdrawals" | "holdings">;
    chain: InventoryChain;
    /** Without it a Solana withdrawal is refused and given back. */
    solana?: SolanaSender;
    logger: Logger;
    intervalMs?: number;
    /** Time without a receipt after which a stored transaction is signed and sent again on its nonce. */
    resendAfterMs?: number;
    /** Called after a withdrawal reaches `sent` or `failed`; `refunded` is true when its units went back. */
    onChange?: (withdrawal: CoinWithdrawalDoc, refunded: boolean) => void;
    now?: () => number;
};

const DEFAULT_RESEND_MS = 120_000;

const homeEntry = (symbol: string): { entry: CoinEntry; network: (typeof NETWORKS)[number] } | null => {
    const coin = COINS.find((candidate) => candidate.symbol === symbol);
    const entry = coin?.entries.find((candidate) => candidate.network === coin.home);
    const network = NETWORKS.find((candidate) => candidate.id === coin?.home);
    return coin && entry && network ? { entry, network } : null;
};

/** Sends each `sending` coin withdrawal from the inventory wallet, and gives the units back when the network refuses it. */
export class CoinSender {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #running: Promise<void> = Promise.resolve();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            while (!signal.aborted) {
                await this.tick().catch((error: unknown) =>
                    this.#deps.logger.warn({ err: error }, "Coin send pass failed"),
                );
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, this.#deps.intervalMs ?? 2_000);
                    function done() {
                        clearTimeout(timer);
                        signal.removeEventListener("abort", done);
                        resolve();
                    }
                    signal.addEventListener("abort", done, { once: true });
                });
            }
        })();
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    /** One pass over the withdrawals still sending, oldest first; passes never overlap. */
    tick(): Promise<void> {
        const run = this.#running.then(() => this.#pass());
        this.#running = run.catch(() => undefined);
        return run;
    }

    async #pass() {
        const docs = await this.#deps.collections.coinWithdrawals
            .find({ state: "sending" })
            .sort({ createdAt: 1 })
            .toArray();
        for (const doc of docs) {
            try {
                await this.#process(doc);
            } catch (error) {
                this.#deps.logger.warn(
                    { err: error, withdrawal: doc._id.toString() },
                    "Couldn't send a coin withdrawal",
                );
            }
        }
    }

    async #process(doc: CoinWithdrawalDoc) {
        const home = homeEntry(doc.symbol);
        if (!home) return this.#fail(doc, `${doc.symbol} can't be sent`);
        if (home.network.kind === "solana") return this.#processSolana(doc, home.entry);
        return this.#processEvm(doc, home.entry, home.network.id as EvmNetworkId);
    }

    /** Base units of the coin on its network, from the stored units. */
    #baseUnits(doc: CoinWithdrawalDoc, entry: CoinEntry): bigint {
        return fromUnitsDecimal(doc.units) / 10n ** BigInt(UNIT_DECIMALS - entry.decimals);
    }

    async #processEvm(doc: CoinWithdrawalDoc, entry: CoinEntry, network: EvmNetworkId) {
        const { chain } = this.#deps;
        const amount = this.#baseUnits(doc, entry);
        if (amount <= 0n) return this.#fail(doc, "Nothing to send");
        const native = entry.reserve !== undefined;
        const intent = native
            ? { to: doc.to as Address, data: "0x" as Hex, value: amount }
            : {
                  to: entry.address as Address,
                  data: encodeFunctionData({
                      abi: erc20Abi,
                      functionName: "transfer",
                      args: [doc.to as Address, amount],
                  }),
                  value: 0n,
              };

        if (doc.txHash) {
            const receipt = await chain.receipt(network, doc.txHash as Hex);
            if (receipt === "success") return this.#sent(doc, doc.txHash);
            if (receipt === "reverted") return this.#fail(doc, "The transfer reverted on the network");
            if (this.#now() - doc.updatedAt.getTime() < (this.#deps.resendAfterMs ?? DEFAULT_RESEND_MS)) return;
        }

        // The nonce is stored before anything is signed, and a retry reuses it
        let nonce = doc.nonce;
        if (nonce === null) {
            nonce = await chain.nextNonce(network);
            const stored = await this.#deps.collections.coinWithdrawals.updateOne(
                { _id: doc._id, state: "sending", nonce: null },
                { $set: { nonce, updatedAt: new Date(this.#now()) } },
            );
            if (stored.modifiedCount === 0) return;
        } else {
            chain.reserve(network, nonce);
        }

        let prepared: PreparedTx;
        try {
            prepared = await chain.prepare(network, intent, nonce);
        } catch (error) {
            if (refused(error)) return this.#fail(doc, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
        await this.#deps.collections.coinWithdrawals.updateOne(
            { _id: doc._id, state: "sending" },
            { $set: { txHash: prepared.hash, updatedAt: new Date(this.#now()) } },
        );

        try {
            await chain.broadcast(network, prepared);
        } catch (error) {
            if (alreadySent(error)) {
                this.#deps.logger.warn(
                    { withdrawal: doc._id.toString() },
                    "The nonce was already used; the receipt decides",
                );
                return;
            }
            if (refused(error)) return this.#fail(doc, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
    }

    async #processSolana(doc: CoinWithdrawalDoc, entry: CoinEntry) {
        const { solana } = this.#deps;
        if (!solana) return this.#fail(doc, "Sending Solana coins isn't available");
        if (entry.reserve === undefined) return this.#fail(doc, `${doc.symbol} can't be sent on Solana`);
        const lamports = this.#baseUnits(doc, entry);
        if (lamports <= 0n) return this.#fail(doc, "Nothing to send");

        if (doc.txHash) {
            const status = await solana.status(doc.txHash);
            if (status === "confirmed") return this.#sent(doc, doc.txHash);
            if (status === "failed") return this.#fail(doc, "The transfer failed on the network");
            // A signed transaction's blockhash expires, so one the cluster still doesn't know after this long is signed afresh
            if (this.#now() - doc.updatedAt.getTime() < (this.#deps.resendAfterMs ?? DEFAULT_RESEND_MS)) return;
        }
        let prepared: Awaited<ReturnType<SolanaSender["prepare"]>>;
        try {
            prepared = await solana.prepare(doc.to, lamports);
        } catch (error) {
            if (refused(error)) return this.#fail(doc, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
        await this.#deps.collections.coinWithdrawals.updateOne(
            { _id: doc._id, state: "sending" },
            { $set: { txHash: prepared.signature, updatedAt: new Date(this.#now()) } },
        );
        try {
            await prepared.broadcast();
        } catch (error) {
            if (refused(error)) return this.#fail(doc, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
    }

    async #sent(doc: CoinWithdrawalDoc, txHash: string) {
        const updated = await this.#deps.collections.coinWithdrawals.findOneAndUpdate(
            { _id: doc._id, state: "sending" },
            { $set: { state: "sent", txHash, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (updated) this.#deps.onChange?.(updated, false);
    }

    /** Marks a definite refusal and puts the units back on the holding, in one transaction and only once. */
    async #fail(doc: CoinWithdrawalDoc, reason: string) {
        const { client, collections } = this.#deps;
        const at = new Date(this.#now());
        let failed: CoinWithdrawalDoc | null = null;
        await client.withSession((session) =>
            session.withTransaction(async () => {
                failed = await collections.coinWithdrawals.findOneAndUpdate(
                    { _id: doc._id, state: "sending" },
                    { $set: { state: "failed", reason, updatedAt: at } },
                    { returnDocument: "after", session },
                );
                if (!failed) return;
                await collections.holdings.updateOne(
                    { accountId: doc.accountId, symbol: doc.symbol },
                    { $inc: { units: doc.units }, $set: { network: doc.network, updatedAt: at } },
                    { upsert: true, session },
                );
            }),
        );
        if (failed) {
            this.#deps.logger.warn(
                { withdrawal: doc._id.toString(), reason },
                "A coin withdrawal failed and was given back",
            );
            this.#deps.onChange?.(failed, true);
        }
    }
}

const firstLine = (error: unknown) =>
    String((error as Error)?.message ?? error)
        .split("\n")[0]!
        .slice(0, 200);
