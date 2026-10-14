import type { ClientSession } from "mongodb";
import type { Logger } from "pino";
import { HttpRequestError, keccak256, parseGwei, TimeoutError, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { MIN_BASE_FEE, type ArcClient } from "../chain/arc.ts";
import { IrisError, ARC_DOMAIN, type Iris } from "../crosschain/iris.ts";
import type { Collections, WithdrawalDoc } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import { ARC_USDC_ERC20, TOKEN_MESSENGER_V2, encodeApprove, encodeBurn, weiToUsdc6 } from "./cctp-burn.ts";
import { FORWARDING_DELAYED_MS } from "./views.ts";

const GAS_LIMIT = 21_000n;
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 30_000;
/** Gas for the USDC approve and for the burn, which can't be estimated before the approve is mined. */
const APPROVE_GAS = 120_000n;
const BURN_GAS = 600_000n;
/** Iris is asked at most this often in total, and not at all for a while after it said to slow down. */
const IRIS_MAX_PER_SECOND = 5;
const IRIS_BACKOFF_MS = 5 * 60_000;
/** How often a stalled or failed forward is logged per withdrawal. */
const STALL_LOG_MS = 60 * 60_000;
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
    /** Where forwards are followed; without it Solana withdrawals wait in `forwarding`. */
    iris?: Iris;
    /** The TokenMessengerV2 burns go to; the mainnet one by default. */
    tokenMessenger?: Address;
    /** The USDC ERC-20 view that is approved and burned; Arc's by default. */
    usdc?: Address;
    now?: () => number;
};

type Step = "approve" | "burn";

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
    /** When Iris was asked, within the last second. */
    #irisAsked: number[] = [];
    #irisBackoffUntil = 0;
    /** The last time each forwarding withdrawal's stall or failure was logged. */
    readonly #logged = new Map<string, number>();
    /** What Iris last said about each forwarding withdrawal. */
    readonly #lastIris = new Map<string, unknown>();

    readonly #now: () => number;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
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
        await this.#followForwards().catch((error: unknown) =>
            logger.warn({ err: error }, "Following Solana withdrawals failed"),
        );
        const sending = await collections.withdrawals.find({ state: "sending" }).sort({ _id: 1 }).toArray();
        for (const withdrawal of sending) {
            if (this.#stop?.signal.aborted) return;
            try {
                if (withdrawal.network === "solana") {
                    // A burn still unsent above its approve owns the next nonce, so nothing may be signed past it.
                    if (!(await this.#paySolana(withdrawal))) return;
                } else await this.#pay(withdrawal);
            } catch (error) {
                logger.warn({ err: error, withdrawalId: withdrawal._id.toHexString() }, "Payout failed, will retry");
                // Later items would sign with a nonce this unsent one still owns.
                if (unreachable(error)) return;
            }
        }
    }

    /** Signs the approve and the burn of a Solana withdrawal on consecutive nonces and stores both before either is sent. */
    async #signSolana(withdrawal: WithdrawalDoc): Promise<WithdrawalDoc> {
        const { client, signer, collections } = this.#deps;
        const solana = withdrawal.solana!;
        const { nonce, maxFeePerGas } = await this.#nextNonce();
        const amount6 = weiToUsdc6(fromDecimal(withdrawal.amount));
        const usdc = this.#deps.usdc ?? ARC_USDC_ERC20;
        const messenger = this.#deps.tokenMessenger ?? TOKEN_MESSENGER_V2;
        const sign = (n: number, to: Address, data: Hex, gas: bigint) =>
            signer.signTransaction({
                type: "eip1559",
                chainId: client.chain!.id,
                nonce: n,
                to,
                value: 0n,
                data,
                gas,
                maxFeePerGas,
                maxPriorityFeePerGas: PRIORITY_FEE,
            });
        const approveRawTx = await sign(nonce, usdc, encodeApprove(amount6, messenger), APPROVE_GAS);
        const burnRawTx = await sign(
            nonce + 1,
            messenger,
            encodeBurn({
                amount6,
                usdcAccount: solana.usdcAccount,
                wallet: solana.wallet,
                setup: solana.setup,
                maxFee6: weiToUsdc6(fromDecimal(solana.maxFee)),
                burnToken: usdc,
            }),
            BURN_GAS,
        );
        const stored = await collections.withdrawals.findOneAndUpdate(
            { _id: withdrawal._id, state: "sending", "solana.approveRawTx": null },
            {
                $set: {
                    "solana.approveNonce": nonce,
                    "solana.approveRawTx": approveRawTx,
                    "solana.approveTxHash": keccak256(approveRawTx),
                    "solana.burnNonce": nonce + 1,
                    "solana.burnRawTx": burnRawTx,
                    "solana.burnTxHash": keccak256(burnRawTx),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" },
        );
        return stored ?? (await collections.withdrawals.findOne({ _id: withdrawal._id })) ?? withdrawal;
    }

    /** Sends the approve, then the burn, each once mined; the burn mined moves the withdrawal to `forwarding`. False while a sent transaction is still unconfirmed. */
    async #paySolana(found: WithdrawalDoc): Promise<boolean> {
        const { collections, bus } = this.#deps;
        const withdrawal = found.solana?.approveRawTx ? found : await this.#signSolana(found);
        if (withdrawal.state !== "sending" || !withdrawal.solana?.approveRawTx) return true;
        for (const step of ["approve", "burn"] as const) {
            const settled = await this.#settle(withdrawal, step);
            if (settled !== "mined") return settled === "ended";
        }
        const moved = await collections.withdrawals.findOneAndUpdate(
            { _id: withdrawal._id, state: "sending" },
            { $set: { state: "forwarding", updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (!moved) return true;
        const account = await collections.accounts.findOne({ _id: moved.accountId });
        bus.emit("withdrawal:updated", { withdrawal: moved, account });
        return true;
    }

    /** Broadcasts one stored transaction of a Solana withdrawal and waits for it: mined successfully, still unconfirmed, or ended (failed or its signatures dropped). */
    async #settle(withdrawal: WithdrawalDoc, step: Step): Promise<"mined" | "pending" | "ended"> {
        const { client, broadcast, collections } = this.#deps;
        const solana = withdrawal.solana!;
        const rawTx = step === "approve" ? solana.approveRawTx! : solana.burnRawTx!;
        const hash = (step === "approve" ? solana.approveTxHash : solana.burnTxHash)!;
        const key = `${withdrawal._id.toHexString()}:${step}`;
        const stored = { ...withdrawal, txHash: hash };

        try {
            await (broadcast ?? ((tx: Hex) => client.sendRawTransaction({ serializedTransaction: tx })))(rawTx);
        } catch (error) {
            if (unreachable(error)) throw error;
            if (/nonce too low/i.test(String(error)) && !(await this.#mined(stored))) {
                await collections.withdrawals.updateOne(
                    { _id: withdrawal._id, state: "sending", [`solana.${step}TxHash`]: hash },
                    {
                        $set: {
                            "solana.approveNonce": null,
                            "solana.approveRawTx": null,
                            "solana.approveTxHash": null,
                            "solana.burnNonce": null,
                            "solana.burnRawTx": null,
                            "solana.burnTxHash": null,
                            updatedAt: new Date(),
                        },
                    },
                );
                return "ended";
            }
            if (!alreadySent(error) && !(await this.#seen(stored))) {
                const passes = (this.#absent.get(key) ?? 0) + 1;
                if (!refused(error) && passes < ABSENT_PASSES_BEFORE_FAIL) {
                    this.#absent.set(key, passes);
                    throw error;
                }
                this.#absent.delete(key);
                await this.#fail(withdrawal, "Rejected by the network");
                return "ended";
            }
        }
        this.#absent.delete(key);

        const receipt = await this.#abortable(
            client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
        ).catch((error: unknown) => {
            if (error instanceof TimeoutError || /timed out|could not be found/i.test(String(error))) return null;
            throw error;
        });
        if (!receipt) return "pending";
        if (receipt.status === "success") return "mined";
        await this.#fail(
            withdrawal,
            step === "approve" ? "Approval reverted on the network" : "Burn reverted on the network",
        );
        return "ended";
    }

    /** Logs stalled forwards and asks Iris about the forwarding withdrawal checked longest ago, within its request budget. */
    async #followForwards() {
        const { collections, iris, logger, bus } = this.#deps;
        if (!iris) return;
        const now = this.#now();
        const forwarding = await collections.withdrawals
            .find({ state: "forwarding", network: "solana" })
            .sort({ "solana.irisCheckedAt": 1, _id: 1 })
            .toArray();
        for (const doc of forwarding) {
            const id = doc._id.toHexString();
            if (now - doc.updatedAt.getTime() < FORWARDING_DELAYED_MS) continue;
            if (!this.#dueForLog(id, now)) continue;
            logger.error(
                { withdrawalId: id, burnTxHash: doc.solana?.burnTxHash, iris: this.#lastIris.get(id) ?? null },
                "Solana withdrawal stalled",
            );
        }

        const next = forwarding[0];
        if (!next || now < this.#irisBackoffUntil) return;
        this.#irisAsked = this.#irisAsked.filter((at) => now - at < 1_000);
        if (this.#irisAsked.length >= IRIS_MAX_PER_SECOND) return;
        this.#irisAsked.push(now);
        const id = next._id.toHexString();
        await collections.withdrawals.updateOne(
            { _id: next._id, state: "forwarding" },
            { $set: { "solana.irisCheckedAt": new Date(now) } },
        );

        let message;
        try {
            message = await iris.message({ domain: ARC_DOMAIN, burnTxHash: next.solana!.burnTxHash! });
        } catch (error) {
            if (error instanceof IrisError && error.kind === "rate_limited")
                this.#irisBackoffUntil = now + IRIS_BACKOFF_MS;
            logger.warn({ err: error, withdrawalId: id }, "Iris couldn't be asked about a Solana withdrawal");
            return;
        }
        this.#lastIris.set(id, message?.raw ?? null);
        if (message?.status === "failed") {
            if (this.#dueForLog(`failed:${id}`, now)) {
                logger.error(
                    { withdrawalId: id, burnTxHash: next.solana!.burnTxHash, iris: message.raw },
                    "Solana withdrawal forward failed",
                );
            }
            return;
        }
        if (message?.status !== "complete" || !message.forwardTxHash) return;
        const sent = await collections.withdrawals.findOneAndUpdate(
            { _id: next._id, state: "forwarding" },
            { $set: { state: "sent", "solana.forwardTxHash": message.forwardTxHash, updatedAt: new Date(now) } },
            { returnDocument: "after" },
        );
        if (!sent) return;
        this.#lastIris.delete(id);
        this.#logged.delete(id);
        const account = await collections.accounts.findOne({ _id: sent.accountId });
        bus.emit("withdrawal:updated", { withdrawal: sent, account });
    }

    /** True at most once an hour per key. */
    #dueForLog(key: string, now: number) {
        const last = this.#logged.get(key);
        if (last !== undefined && now - last < STALL_LOG_MS) return false;
        this.#logged.set(key, now);
        return true;
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

    /** The next free treasury nonce, counting every signed transaction still waiting to be sent, and the fee cap to sign with. */
    async #nextNonce() {
        const { client, signer, collections } = this.#deps;
        const [pending, block, arc, burn] = await Promise.all([
            client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
            client.getBlock(),
            collections.withdrawals
                .find({ state: "sending", rawTx: { $ne: null } })
                .sort({ nonce: -1 })
                .limit(1)
                .toArray(),
            collections.withdrawals
                .find({ state: "sending", "solana.burnRawTx": { $ne: null } })
                .sort({ "solana.burnNonce": -1 })
                .limit(1)
                .toArray(),
        ]);
        const after = (value: number | null | undefined) => (value != null ? value + 1 : 0);
        const nonce = Math.max(pending, after(arc[0]?.nonce), after(burn[0]?.solana?.burnNonce));
        const doubled = (block.baseFeePerGas ?? 0n) * 2n;
        return { nonce, maxFeePerGas: doubled > MIN_BASE_FEE ? doubled : MIN_BASE_FEE };
    }

    async #sign(withdrawal: WithdrawalDoc): Promise<WithdrawalDoc> {
        const { client, signer, collections } = this.#deps;
        const { nonce, maxFeePerGas } = await this.#nextNonce();
        const rawTx = await signer.signTransaction({
            type: "eip1559",
            chainId: client.chain!.id,
            nonce,
            to: withdrawal.to as Hex,
            value: fromDecimal(withdrawal.amount),
            gas: GAS_LIMIT,
            maxFeePerGas,
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
