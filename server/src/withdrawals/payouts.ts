import type { ClientSession } from "mongodb";
import type { Logger } from "pino";
import { HttpRequestError, keccak256, parseGwei, TimeoutError, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { MIN_BASE_FEE, type ArcClient } from "../chain/arc.ts";
import type { Collections, WithdrawalDoc } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";

const GAS_LIMIT = 21_000n;
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 30_000;
/** Passes an unrecognised refusal may leave the transaction unseen before the withdrawal is given up. */
const ABSENT_PASSES_BEFORE_FAIL = 5;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    client: ArcClient;
    signer: HDAccount;
    bus: Bus;
    logger: Logger;
    pollMs?: number;
    /** Sends a signed transaction; tests and the e2e backend wrap it. */
    broadcast?: (rawTx: Hex) => Promise<Hex>;
};

/** A node already holding or having mined the transaction: the receipt decides the rest. */
const alreadySent = (error: unknown) => /already known|nonce too low|already imported/i.test(String(error));

/** The network turned the transaction down, so it was never accepted and the amount can go back. */
const refused = (error: unknown) =>
    /insufficient funds|underpriced|gas too low|intrinsic gas|invalid sender|exceeds (the )?balance/i.test(
        String(error),
    );

/** The RPC couldn't be reached or answered late, so the transaction may still be on its way. */
const unreachable = (error: unknown) =>
    error instanceof HttpRequestError ||
    error instanceof TimeoutError ||
    /fetch failed|ECONN|ETIMEDOUT/i.test(String(error));

/** Pays each `sending` withdrawal from the treasury, signing once and re-sending the same transaction until it settles. */
export class Payouts {
    readonly #deps: Deps;
    #queue: Promise<unknown> = Promise.resolve();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #wake: (() => void) | null = null;
    /** Passes each withdrawal's unexplained refusal has gone by without its transaction turning up. */
    readonly #absent = new Map<string, number>();
    #unsubscribe: (() => void) | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    start() {
        if (this.#loop) return;
        const { bus, logger } = this.#deps;
        const onUpdated = ({ withdrawal }: { withdrawal: WithdrawalDoc }) => {
            if (withdrawal.state === "sending") this.#wake?.();
        };
        bus.on("withdrawal:updated", onUpdated);
        this.#unsubscribe = () => bus.off("withdrawal:updated", onUpdated);
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            while (!signal.aborted) {
                await this.tick().catch((error: unknown) => logger.warn({ err: error }, "Payout pass failed"));
                if (signal.aborted) return;
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, this.#deps.pollMs ?? 1_000);
                    function done() {
                        clearTimeout(timer);
                        signal.removeEventListener("abort", done);
                        resolve();
                    }
                    signal.addEventListener("abort", done, { once: true });
                    this.#wake = done;
                });
                this.#wake = null;
            }
        })();
    }

    async stop() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#stop?.abort();
        await this.#loop;
        await this.#queue.catch(() => undefined);
        this.#loop = null;
        this.#stop = null;
    }

    /** Pays every `sending` withdrawal, oldest first, one at a time. */
    tick(): Promise<void> {
        const run = this.#queue.catch(() => undefined).then(() => this.#pass());
        this.#queue = run;
        return run;
    }

    async #pass() {
        const { collections, logger } = this.#deps;
        const sending = await collections.withdrawals.find({ state: "sending" }).sort({ _id: 1 }).toArray();
        for (const withdrawal of sending) {
            if (this.#stop?.signal.aborted) return;
            try {
                await this.#pay(withdrawal);
            } catch (error) {
                logger.warn({ err: error, withdrawalId: withdrawal._id.toHexString() }, "Payout failed, will retry");
                // Later items would sign with a nonce this unsent one still owns.
                if (unreachable(error)) return;
            }
        }
    }

    /** Rejects as soon as stop() is called, so a slow receipt can't hold shutdown. */
    #abortable<T>(work: Promise<T>): Promise<T> {
        const signal = this.#stop?.signal;
        if (!signal) return work;
        if (signal.aborted) return Promise.reject(new Error("Payouts stopped"));
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new Error("Payouts stopped"));
            signal.addEventListener("abort", onAbort, { once: true });
            work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
        });
    }

    async #sign(withdrawal: WithdrawalDoc): Promise<WithdrawalDoc> {
        const { client, signer, collections } = this.#deps;
        const [pending, block, highest] = await Promise.all([
            client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
            client.getBlock(),
            collections.withdrawals
                .find({ state: "sending", rawTx: { $ne: null } })
                .sort({ nonce: -1 })
                .limit(1)
                .toArray(),
        ]);
        const nonce = Math.max(pending, highest[0]?.nonce != null ? highest[0].nonce + 1 : 0);
        const doubled = (block.baseFeePerGas ?? 0n) * 2n;
        const rawTx = await signer.signTransaction({
            type: "eip1559",
            chainId: client.chain!.id,
            nonce,
            to: withdrawal.to as Hex,
            value: fromDecimal(withdrawal.amount),
            gas: GAS_LIMIT,
            maxFeePerGas: doubled > MIN_BASE_FEE ? doubled : MIN_BASE_FEE,
            maxPriorityFeePerGas: PRIORITY_FEE,
        });
        const stored = await collections.withdrawals.findOneAndUpdate(
            { _id: withdrawal._id, state: "sending", rawTx: null },
            { $set: { nonce, rawTx, txHash: keccak256(rawTx), updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        return stored ?? (await collections.withdrawals.findOne({ _id: withdrawal._id })) ?? withdrawal;
    }

    async #pay(found: WithdrawalDoc) {
        const { client, broadcast, collections } = this.#deps;
        const withdrawal = found.rawTx ? found : await this.#sign(found);
        const rawTx = withdrawal.rawTx;
        if (!rawTx || withdrawal.state !== "sending") return;

        try {
            await (broadcast ?? ((tx: Hex) => client.sendRawTransaction({ serializedTransaction: tx })))(rawTx);
        } catch (error) {
            if (unreachable(error)) throw error;
            if (/nonce too low/i.test(String(error)) && !(await this.#mined(withdrawal))) {
                await collections.withdrawals.updateOne(
                    { _id: withdrawal._id, state: "sending", txHash: withdrawal.txHash },
                    { $set: { rawTx: null, txHash: null, nonce: null, updatedAt: new Date() } },
                );
                return;
            }
            if (!alreadySent(error) && !(await this.#seen(withdrawal))) {
                // An opaque error may follow a node accepting the transaction, so only a clear refusal refunds at once.
                const key = withdrawal._id.toHexString();
                const passes = (this.#absent.get(key) ?? 0) + 1;
                if (!refused(error) && passes < ABSENT_PASSES_BEFORE_FAIL) {
                    this.#absent.set(key, passes);
                    throw error;
                }
                this.#absent.delete(key);
                return this.#fail(withdrawal, "Rejected by the network");
            }
        }
        this.#absent.delete(withdrawal._id.toHexString());

        const hash = withdrawal.txHash!;
        const receipt = await this.#abortable(
            client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
        ).catch((error: unknown) => {
            if (error instanceof TimeoutError || /timed out|could not be found/i.test(String(error))) return null;
            throw error;
        });
        if (!receipt) return;
        if (receipt.status === "success") await this.#sent(withdrawal);
        else await this.#fail(withdrawal, "Reverted on the network");
    }

    /** True when the node knows the stored hash, pending or mined. */
    async #seen(withdrawal: WithdrawalDoc) {
        const found = await this.#deps.client
            .getTransaction({ hash: withdrawal.txHash as Hex })
            .catch((error: unknown) => {
                if (/not found|could not be found/i.test(String(error))) return null;
                throw error;
            });
        return found !== null;
    }

    /** True when the stored hash has a receipt; false when its nonce was taken by another transaction. */
    async #mined(withdrawal: WithdrawalDoc) {
        const receipt = await this.#deps.client
            .getTransactionReceipt({ hash: withdrawal.txHash as Hex })
            .catch((error: unknown) => {
                if (/not found|could not be found/i.test(String(error))) return null;
                throw error;
            });
        return receipt !== null;
    }

    async #sent(withdrawal: WithdrawalDoc) {
        const { collections, bus } = this.#deps;
        const moved = await collections.withdrawals.findOneAndUpdate(
            { _id: withdrawal._id, state: "sending" },
            { $set: { state: "sent", updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        if (!moved) return;
        const account = await collections.accounts.findOne({ _id: moved.accountId });
        bus.emit("withdrawal:updated", { withdrawal: moved, account });
    }

    /** Marks it failed and gives the amount back in one transaction, so the refund happens once. */
    async #fail(withdrawal: WithdrawalDoc, failure: string) {
        const { collections, ledger, bus, logger } = this.#deps;
        const result = await ledger.runInTransaction(async (session: ClientSession) => {
            const moved = await collections.withdrawals.findOneAndUpdate(
                { _id: withdrawal._id, state: "sending" },
                { $set: { state: "failed", failure, updatedAt: new Date() } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const account = await ledger.creditInSession(
                session,
                moved.accountId,
                fromDecimal(moved.amount),
                "withdrawal_refund",
                moved._id,
            );
            return { moved, account };
        });
        if (!result) return;
        logger.warn({ withdrawalId: withdrawal._id.toHexString(), failure }, "Withdrawal failed and was refunded");
        bus.emit("withdrawal:updated", { withdrawal: result.moved, account: result.account });
    }
}
