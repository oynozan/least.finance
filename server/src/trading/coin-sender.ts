import type { MongoClient } from "mongodb";
import type { Logger } from "pino";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import type { Collections } from "../db/mongo.ts";
import { COINS, NETWORKS, type CoinEntry } from "../swaps/coins.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import { loopWatch } from "../loop-watch.ts";
import type { CoinWithdrawalDoc } from "./docs.ts";
import { RepeatGate, sendBack, sendRefusal, solanaErr, upstreamSaid, type SendFailure } from "./failures.ts";
import {
    MAX_ATTEMPTS,
    attemptOf,
    attemptsOf,
    highestFees,
    minedAmong,
    type InventoryChain,
    type PreparedTx,
} from "./inventory-chain.ts";
import { alreadySent, refused, refusedBy } from "./send-errors.ts";
import { UNIT_DECIMALS, fromUnitsDecimal } from "./units.ts";

/** What a Solana signature came to: confirmed, failed with the cluster's error, or not known to it yet. */
export type SolanaStatus = "confirmed" | "failed" | { state: "failed"; err: unknown } | null;

/** Sends SOL from the Solana inventory wallet; a signature is known before the transaction goes out. */
export type SolanaSender = {
    prepare(to: string, lamports: bigint): Promise<{ signature: string; broadcast(): Promise<void> }>;
    /** Null while the cluster doesn't know the signature. */
    status(signature: string): Promise<SolanaStatus>;
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
/** How often the same failure of a pass or a withdrawal is logged again while it goes on. */
const REPEAT_LOG_MS = 10 * 60_000;
/** A withdrawal still sending after this long is an error in the log, not a warning. */
const STUCK_ERROR_MS = 10 * 60_000;

const homeEntry = (symbol: string): { entry: CoinEntry; network: (typeof NETWORKS)[number] } | null => {
    const coin = COINS.find((candidate) => candidate.symbol === symbol);
    const entry = coin?.entries.find((candidate) => candidate.network === coin.home);
    const network = NETWORKS.find((candidate) => candidate.id === coin?.home);
    return coin && entry && network ? { entry, network } : null;
};

const networkName = (id: string) => NETWORKS.find((network) => network.id === id)?.name ?? id;

/** A failure that is ours to fix: the person is told it isn't available and gets their coins back. */
const unsupported = (doc: CoinWithdrawalDoc, detail: string): SendFailure => ({
    reason: "unsupported",
    detail,
    message: `${doc.symbol} can't be sent right now. ${sendBack(doc.symbol)}`,
    level: "error",
});

/** Sends each `sending` coin withdrawal from the inventory wallet, and gives the units back when the network refuses it. */
export class CoinSender {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #running: Promise<void> = Promise.resolve();
    readonly #repeats: RepeatGate;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#repeats = new RepeatGate(REPEAT_LOG_MS, this.#now);
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            const watch = loopWatch(this.#deps.logger, "coin send");
            const usualMs = this.#deps.intervalMs ?? 2_000;
            while (!signal.aborted) {
                let waitMs = usualMs;
                try {
                    await this.tick();
                    watch.ok();
                } catch (error) {
                    waitMs = watch.failed(error, usualMs);
                }
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, waitMs);
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

    /** What every log line about a withdrawal carries. */
    #fields(doc: CoinWithdrawalDoc) {
        return {
            withdrawal: doc._id.toHexString(),
            account: doc.accountId.toHexString(),
            requestId: doc.requestId,
            symbol: doc.symbol,
            units: doc.units.toString(),
            network: doc.network,
            to: doc.to,
            nonce: doc.nonce,
            txHash: doc.txHash,
        };
    }

    async #pass() {
        const docs = await this.#deps.collections.coinWithdrawals
            .find({ state: "sending" })
            .sort({ createdAt: 1 })
            .toArray();
        for (const doc of docs) {
            const key = doc._id.toHexString();
            try {
                await this.#process(doc);
                this.#repeats.clear(key);
            } catch (error) {
                await this.#stuck(doc, error);
            }
        }
    }

    /** An error that isn't a refusal leaves the withdrawal sending; it is logged once and again every while, and stored so the person can see it. */
    async #stuck(doc: CoinWithdrawalDoc, error: unknown) {
        const said = upstreamSaid(error);
        const again = this.#repeats.note(doc._id.toHexString(), said);
        if (again) {
            // The document as it is now, since this pass may have given it a nonce or a hash
            const current = (await this.#deps.collections.coinWithdrawals.findOne({ _id: doc._id })) ?? doc;
            const age = this.#now() - doc.createdAt.getTime();
            this.#deps.logger[age > STUCK_ERROR_MS ? "error" : "warn"](
                {
                    event: "coin-send:retry",
                    ...this.#fields(current),
                    attempts: attemptsOf(current).length,
                    sendingForMs: age,
                    repeatsLeftOut: again.skipped,
                    err: error,
                },
                `Couldn't send a coin withdrawal yet, it stays sending: ${said}`,
            );
            // The clock for resends is the document's updatedAt, so this leaves it alone
            await this.#deps.collections.coinWithdrawals.updateOne(
                { _id: doc._id, state: "sending" },
                { $set: { detail: said, message: `Still trying: ${said}` } },
            );
        }
    }

    async #process(doc: CoinWithdrawalDoc) {
        const home = homeEntry(doc.symbol);
        if (!home) return this.#fail(doc, unsupported(doc, `${doc.symbol} has no home network entry to send from`));
        if (home.network.kind === "solana") return this.#processSolana(doc, home.entry);
        return this.#processEvm(doc, home.entry, home.network.id as EvmNetworkId);
    }

    /** Base units of the coin on its network, from the stored units. */
    #baseUnits(doc: CoinWithdrawalDoc, entry: CoinEntry): bigint {
        return fromUnitsDecimal(doc.units) / 10n ** BigInt(UNIT_DECIMALS - entry.decimals);
    }

    /** The units rounded down to nothing at the coin's decimals. */
    #nothing(doc: CoinWithdrawalDoc, entry: CoinEntry): SendFailure {
        return {
            reason: "zero_amount",
            detail: `${doc.units.toString()} ${doc.symbol} is 0 at ${entry.decimals} decimals`,
            message: `${doc.units.toString()} ${doc.symbol} rounds to nothing at ${doc.symbol}'s ${entry.decimals} decimals, so there was nothing to send. ${sendBack(doc.symbol)}`,
            level: "warn",
        };
    }

    async #processEvm(doc: CoinWithdrawalDoc, entry: CoinEntry, network: EvmNetworkId) {
        const { chain } = this.#deps;
        const amount = this.#baseUnits(doc, entry);
        if (amount <= 0n) return this.#fail(doc, this.#nothing(doc, entry));
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

        // A recorded nonce is held back from new withdrawals even while its resend window runs
        if (doc.nonce !== null) chain.reserve(network, doc.nonce);
        const attempts = attemptsOf(doc);
        if (attempts.length > 0) {
            const mined = await minedAmong(chain, network, attempts);
            if (mined?.status === "success") return this.#sent(doc, mined.hash);
            if (mined?.status === "reverted")
                return this.#fail(doc, {
                    reason: "reverted",
                    detail: `The transfer reverted on ${networkName(network)} (tx ${mined.hash})`,
                    message: `The transfer reverted on ${networkName(network)} (tx ${mined.hash}). ${sendBack(doc.symbol)}`,
                    level: "warn",
                });
            if (this.#now() - doc.updatedAt.getTime() < (this.#deps.resendAfterMs ?? DEFAULT_RESEND_MS)) return;
            if (attempts.length >= MAX_ATTEMPTS) return;
        }

        // The nonce is stored before anything is signed, and a retry reuses it
        let nonce = doc.nonce;
        if (nonce === null) {
            nonce = await chain.nextNonce(network);
            const stored = await this.#deps.collections.coinWithdrawals.updateOne(
                { _id: doc._id, state: "sending", nonce: null },
                { $set: { nonce, updatedAt: new Date(this.#now()) } },
            );
            if (stored.modifiedCount === 0) return chain.release(network, nonce);
        }

        let prepared: PreparedTx;
        try {
            prepared = await chain.prepare(network, intent, nonce, highestFees(attempts));
        } catch (error) {
            return this.#answered(doc, error, network, nonce, attempts.length > 0);
        }
        await this.#deps.collections.coinWithdrawals.updateOne(
            { _id: doc._id, state: "sending" },
            {
                $set: {
                    txHash: prepared.hash,
                    attempts: [...attempts, attemptOf(prepared)],
                    updatedAt: new Date(this.#now()),
                },
            },
        );
        if (attempts.length + 1 === MAX_ATTEMPTS) {
            this.#deps.logger.error(
                {
                    event: "coin-send:unmined",
                    ...this.#fields(doc),
                    txHash: prepared.hash,
                    nonce,
                    attempts: attempts.length + 1,
                    ageMs: this.#now() - doc.createdAt.getTime(),
                    maxFeePerGas: prepared.fees.maxFeePerGas.toString(),
                    maxPriorityFeePerGas: prepared.fees.maxPriorityFeePerGas.toString(),
                },
                "A coin withdrawal is still unmined after its last resend",
            );
        }

        try {
            await chain.broadcast(network, prepared);
        } catch (error) {
            return this.#answered(doc, error, network, nonce, attempts.length > 0);
        }
    }

    /** A refused first attempt fails and frees its nonce, but a refused replacement leaves the earlier attempts to the receipts */
    async #answered(doc: CoinWithdrawalDoc, error: unknown, network: EvmNetworkId, nonce: number, replacing: boolean) {
        if (alreadySent(error) || (replacing && refused(error))) {
            const again = this.#repeats.note(`${doc._id.toHexString()}:nonce`, upstreamSaid(error));
            if (again)
                this.#deps.logger.warn(
                    {
                        event: "coin-send:nonce-in-use",
                        ...this.#fields(doc),
                        nonce,
                        attempts: attemptsOf(doc).length,
                        replacing,
                        upstream: upstreamSaid(error),
                        repeatsLeftOut: again.skipped,
                    },
                    "The nonce is already in use; the receipts decide",
                );
            return;
        }
        if (!refused(error)) throw error;
        await this.#fail(doc, sendRefusal(error, { symbol: doc.symbol, network: networkName(network) }), error);
        this.#deps.chain.release(network, nonce);
    }

    async #processSolana(doc: CoinWithdrawalDoc, entry: CoinEntry) {
        const { solana } = this.#deps;
        if (!solana)
            return this.#fail(doc, unsupported(doc, "Sending Solana coins isn't configured: no Solana sender"));
        if (entry.reserve === undefined)
            return this.#fail(doc, unsupported(doc, `${doc.symbol} is a Solana token, only native SOL can be sent`));
        const lamports = this.#baseUnits(doc, entry);
        if (lamports <= 0n) return this.#fail(doc, this.#nothing(doc, entry));

        if (doc.txHash) {
            const status = await solana.status(doc.txHash);
            if (status === "confirmed") return this.#sent(doc, doc.txHash);
            if (status === "failed" || (status && typeof status === "object")) {
                const err = typeof status === "object" ? solanaErr(status.err) : "no error given";
                return this.#fail(doc, {
                    reason: "solana_failed",
                    detail: `The transfer failed on Solana: ${err} (tx ${doc.txHash})`,
                    message: `The transfer failed on Solana: ${err} (tx ${doc.txHash}). ${sendBack(doc.symbol)}`,
                    level: "warn",
                });
            }
            // A signed transaction's blockhash expires, so one the cluster still doesn't know after this long is signed afresh
            if (this.#now() - doc.updatedAt.getTime() < (this.#deps.resendAfterMs ?? DEFAULT_RESEND_MS)) return;
        }
        let prepared: Awaited<ReturnType<SolanaSender["prepare"]>>;
        try {
            prepared = await solana.prepare(doc.to, lamports);
        } catch (error) {
            if (refused(error))
                return this.#fail(doc, sendRefusal(error, { symbol: doc.symbol, network: "Solana" }), error);
            throw error;
        }
        await this.#deps.collections.coinWithdrawals.updateOne(
            { _id: doc._id, state: "sending" },
            { $set: { txHash: prepared.signature, updatedAt: new Date(this.#now()) } },
        );
        try {
            await prepared.broadcast();
        } catch (error) {
            if (refused(error))
                return this.#fail(doc, sendRefusal(error, { symbol: doc.symbol, network: "Solana" }), error);
            throw error;
        }
    }

    async #sent(doc: CoinWithdrawalDoc, txHash: string) {
        const updated = await this.#deps.collections.coinWithdrawals.findOneAndUpdate(
            { _id: doc._id, state: "sending" },
            { $set: { state: "sent", txHash, detail: null, message: null, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (updated) this.#deps.onChange?.(updated, false);
    }

    /** Marks a definite refusal and puts the units back on the holding, in one transaction and only once. */
    async #fail(doc: CoinWithdrawalDoc, why: SendFailure, error?: unknown) {
        const { client, collections } = this.#deps;
        const at = new Date(this.#now());
        let failed: CoinWithdrawalDoc | null = null;
        await client.withSession((session) =>
            session.withTransaction(async () => {
                failed = await collections.coinWithdrawals.findOneAndUpdate(
                    { _id: doc._id, state: "sending" },
                    {
                        $set: {
                            state: "failed",
                            reason: why.reason,
                            detail: why.detail,
                            message: why.message,
                            updatedAt: at,
                        },
                    },
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
            this.#deps.logger[why.level](
                {
                    event: "coin-send:failed",
                    ...this.#fields(failed),
                    reason: why.reason,
                    upstream: why.detail,
                    matched: error === undefined ? undefined : refusedBy(error),
                    refunded: true,
                    ...(error !== undefined && { err: error }),
                },
                `A coin withdrawal failed and was given back: ${why.detail}`,
            );
            this.#deps.onChange?.(failed, true);
        }
    }
}
