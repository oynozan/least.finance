import type { ClientSession } from "mongodb";
import type { Logger } from "pino";
import { HttpRequestError, keccak256, parseGwei, TimeoutError, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { MIN_BASE_FEE, type ArcClient } from "../chain/arc.ts";
import { IrisError, ARC_DOMAIN, POLYGON_DOMAIN, type Iris } from "../crosschain/iris.ts";
import { IrisLimiter } from "../crosschain/iris-limiter.ts";
import type { Collections, PoolRebalanceDoc, WithdrawalDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import { loopWatch } from "../loop-watch.ts";
import { alreadySent, refused, upstreamLine } from "../trading/send-errors.ts";
import {
    BurnInputError,
    ARC_USDC_ERC20,
    TOKEN_MESSENGER_V2,
    encodeApprove,
    encodeBurn,
    encodeBurnToEvm,
    weiToUsdc6,
} from "./cctp-burn.ts";
import {
    networkRefused,
    rebalanceError,
    reverted,
    unsendable,
    withdrawalRef,
    type PayoutStep,
    type Why,
} from "./failures.ts";
import { FORWARDING_DELAYED_MS } from "./views.ts";

const GAS_LIMIT = 21_000n;
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 30_000;
/** Gas for the USDC approve and for the burn, which can't be estimated before the approve is mined. */
const APPROVE_GAS = 120_000n;
const BURN_GAS = 600_000n;
/** How often a stalled or failed forward is logged per withdrawal. */
const STALL_LOG_MS = 60 * 60_000;
/** How often the same payout error, or the same pass-level error, is logged while it keeps repeating. */
const RETRY_LOG_MS = 5 * 60_000;
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
    /** The Iris request budget this shares with the other holders of it; a private one by default. */
    irisLimiter?: IrisLimiter;
    /** The TokenMessengerV2 burns go to; the mainnet one by default. */
    tokenMessenger?: Address;
    /** The USDC ERC-20 view that is approved and burned; Arc's by default. */
    usdc?: Address;
    now?: () => number;
};

type Step = Exclude<PayoutStep, "pay">;

/** The RPC couldn't be reached or answered late, so the transaction may still be on its way. */
const unreachable = (error: unknown) =>
    error instanceof HttpRequestError ||
    error instanceof TimeoutError ||
    /fetch failed|ECONN|ETIMEDOUT/i.test(String(error));

/** Pays each `sending` withdrawal and each `sending` pool top-up from the treasury, signing once and re-sending the same transaction until it settles. */
export class Payouts {
    readonly #deps: Deps;
    #queue: Promise<unknown> = Promise.resolve();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #wake: (() => void) | null = null;
    /** Passes each withdrawal's unexplained refusal has gone by without its transaction turning up. */
    readonly #absent = new Map<string, number>();
    #unsubscribe: (() => void) | null = null;
    readonly #irisLimiter: IrisLimiter;
    /** The last time each forwarding withdrawal's stall or failure was logged. */
    readonly #logged = new Map<string, number>();
    /** What Iris last said about each forwarding withdrawal. */
    readonly #lastIris = new Map<string, unknown>();

    readonly #now: () => number;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#irisLimiter = deps.irisLimiter ?? new IrisLimiter();
    }

    start() {
        if (this.#loop) return;
        const { bus, logger } = this.#deps;
        const onUpdated = ({ withdrawal }: { withdrawal: WithdrawalDoc }) => {
            if (withdrawal.state === "sending") this.#wake?.();
        };
        const onRebalance = ({ rebalance }: { rebalance: PoolRebalanceDoc }) => {
            if (rebalance.state === "sending") this.#wake?.();
        };
        bus.on("withdrawal:updated", onUpdated);
        bus.on("pool-rebalance:updated", onRebalance);
        this.#unsubscribe = () => {
            bus.off("withdrawal:updated", onUpdated);
            bus.off("pool-rebalance:updated", onRebalance);
        };
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            const watch = loopWatch(logger, "payout");
            const usualMs = this.#deps.pollMs ?? 1_000;
            while (!signal.aborted) {
                let waitMs = usualMs;
                try {
                    await this.tick();
                    watch.ok();
                } catch (error) {
                    waitMs = watch.failed(error, usualMs);
                }
                if (signal.aborted) return;
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, waitMs);
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
        try {
            await this.#payAll();
        } finally {
            // After the payouts, so an Iris that is slow to answer never holds one back.
            if (!this.#stop?.signal.aborted) {
                await this.#followForwards().catch((error: unknown) => {
                    if (this.#dueForLog(`follow:${upstreamLine(error, 80)}`, this.#now(), RETRY_LOG_MS))
                        this.#deps.logger.warn(
                            { err: error, event: "payout.follow_failed" },
                            "Checking on the Solana withdrawals that are being delivered failed",
                        );
                });
            }
        }
    }

    async #payAll() {
        const { collections, logger } = this.#deps;
        const sending = await collections.withdrawals.find({ state: "sending" }).sort({ _id: 1 }).toArray();
        let storedPaid = false;
        for (const withdrawal of sending) {
            if (this.#stop?.signal.aborted) return;
            try {
                const signed = withdrawal.network === "solana" ? withdrawal.solana?.approveRawTx : withdrawal.rawTx;
                // Anything signed now would sit above a top-up's stored transactions, so those are sent first.
                if (!signed && !storedPaid) {
                    if (!(await this.#payRebalances(true))) return;
                    storedPaid = true;
                }
                if (withdrawal.network === "solana") {
                    // A burn still unsent above its approve owns the next nonce, so nothing may be signed past it.
                    if (!(await this.#paySolana(withdrawal))) return;
                } else await this.#pay(withdrawal);
            } catch (error) {
                if (error instanceof BurnInputError) {
                    // Nothing was signed, and the same input would fail again, so the person gets the money back.
                    await this.#fail(withdrawal, unsendable(error, withdrawal._id));
                    continue;
                }
                if (
                    this.#dueForLog(
                        `retry:${withdrawal._id.toHexString()}:${upstreamLine(error, 80)}`,
                        this.#now(),
                        RETRY_LOG_MS,
                    )
                ) {
                    logger.warn(
                        {
                            event: "withdrawal.retry",
                            withdrawalId: withdrawal._id.toHexString(),
                            accountId: withdrawal.accountId.toHexString(),
                            network: withdrawal.network ?? "arc",
                            amount: formatUsdc(fromDecimal(withdrawal.amount)),
                            to: withdrawal.solana?.wallet ?? withdrawal.to,
                            txHash: withdrawal.solana?.burnTxHash ?? withdrawal.txHash,
                            err: error,
                        },
                        "Paying a withdrawal hit an error and will be retried",
                    );
                }
                // Whatever this withdrawal signed may be unsent, so later ones must not sign above it.
                return;
            }
        }
        await this.#payRebalances(false);
    }

    /** Pays the `sending` pool top-ups oldest first, only the signed ones when asked; false when one is unconfirmed or couldn't be sent. */
    async #payRebalances(signedOnly: boolean): Promise<boolean> {
        const { collections, logger } = this.#deps;
        const rebalances = await collections.poolRebalances
            .find(
                signedOnly
                    ? { direction: "arc_to_polygon", state: "sending", "arc.approveRawTx": { $ne: null } }
                    : { direction: "arc_to_polygon", state: "sending" },
            )
            .sort({ _id: 1 })
            .toArray();
        for (const rebalance of rebalances) {
            if (this.#stop?.signal.aborted) return false;
            try {
                if (!(await this.#payRebalance(rebalance))) return false;
            } catch (error) {
                if (
                    this.#dueForLog(
                        `retry:${rebalance._id.toHexString()}:${upstreamLine(error, 80)}`,
                        this.#now(),
                        RETRY_LOG_MS,
                    )
                ) {
                    logger.warn(
                        { event: "rebalance.retry", rebalanceId: rebalance._id.toHexString(), err: error },
                        "Paying a pool top-up hit an error and will be retried",
                    );
                }
                return false;
            }
        }
        return true;
    }

    /** Signs the approve and the burn of a Solana withdrawal on consecutive nonces and stores both before either is sent. */
    async #signSolana(withdrawal: WithdrawalDoc): Promise<WithdrawalDoc> {
        const { client, signer, collections } = this.#deps;
        const solana = withdrawal.solana!;
        const { nonce, maxFeePerGas } = await this.#nextNonce();
        const usdc = this.#deps.usdc ?? ARC_USDC_ERC20;
        const messenger = this.#deps.tokenMessenger ?? TOKEN_MESSENGER_V2;
        // What can never be encoded is told apart from a node error, which is worth retrying
        let amount6: bigint;
        let approveData: Hex;
        let burnData: Hex;
        try {
            amount6 = weiToUsdc6(fromDecimal(withdrawal.amount));
            approveData = encodeApprove(amount6, messenger);
            burnData = encodeBurn({
                amount6,
                usdcAccount: solana.usdcAccount,
                wallet: solana.wallet,
                setup: solana.setup,
                maxFee6: weiToUsdc6(fromDecimal(solana.maxFee)),
                burnToken: usdc,
            });
        } catch (error) {
            throw error instanceof BurnInputError ? error : new BurnInputError(upstreamLine(error), { cause: error });
        }
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
        const approveRawTx = await sign(nonce, usdc, approveData, APPROVE_GAS);
        const burnRawTx = await sign(nonce + 1, messenger, burnData, BURN_GAS);
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
                this.#deps.logger.warn(
                    {
                        event: "withdrawal.resign",
                        withdrawalId: withdrawal._id.toHexString(),
                        accountId: withdrawal.accountId.toHexString(),
                        step,
                        nonce: step === "approve" ? solana.approveNonce : solana.burnNonce,
                        txHash: hash,
                        err: error,
                    },
                    "A payout's nonce was already used by another transaction, so it will be signed again",
                );
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
                await this.#fail(withdrawal, networkRefused(error, step, hash));
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
        await this.#fail(withdrawal, reverted(step, hash, receipt.gasUsed));
        return "ended";
    }

    /** Signs the approve and the burn of a pool top-up on consecutive nonces and stores both before either is sent, leaving `updatedAt` alone. */
    async #signRebalance(rebalance: PoolRebalanceDoc): Promise<PoolRebalanceDoc> {
        const { client, signer, collections } = this.#deps;
        const { nonce, maxFeePerGas } = await this.#nextNonce();
        const amount6 = fromDecimal(rebalance.amountE6);
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
            encodeBurnToEvm({
                amount6,
                domain: POLYGON_DOMAIN,
                recipient: rebalance.mintRecipient as Address,
                maxFee6: fromDecimal(rebalance.maxFeeE6),
                burnToken: usdc,
            }),
            BURN_GAS,
        );
        const stored = await collections.poolRebalances.findOneAndUpdate(
            { _id: rebalance._id, state: "sending", "arc.approveRawTx": null },
            {
                $set: {
                    "arc.approveNonce": nonce,
                    "arc.approveRawTx": approveRawTx,
                    "arc.approveTxHash": keccak256(approveRawTx),
                    "arc.burnNonce": nonce + 1,
                    "arc.burnRawTx": burnRawTx,
                    "arc.burnTxHash": keccak256(burnRawTx),
                },
            },
            { returnDocument: "after" },
        );
        return stored ?? (await collections.poolRebalances.findOne({ _id: rebalance._id })) ?? rebalance;
    }

    /** Sends the approve, then the burn, each once mined; the burn mined moves the top-up to `forwarding`. False while a sent transaction is still unconfirmed. */
    async #payRebalance(found: PoolRebalanceDoc): Promise<boolean> {
        const { collections, bus } = this.#deps;
        if (!found.arc.approveRawTx && !found.mintRecipient) {
            await this.#failRebalance(found, {
                failure: "No mint recipient",
                detail: "The pool top-up row has no mint recipient address",
                level: "error",
                step: "approve",
                txHash: null,
            });
            return true;
        }
        const rebalance = found.arc.approveRawTx ? found : await this.#signRebalance(found);
        if (rebalance.state !== "sending" || !rebalance.arc.approveRawTx) return true;
        for (const step of ["approve", "burn"] as const) {
            const settled = await this.#settleRebalance(rebalance, step);
            if (settled !== "mined") return settled === "ended";
        }
        const moved = await collections.poolRebalances.findOneAndUpdate(
            { _id: rebalance._id, state: "sending" },
            { $set: { state: "forwarding", updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (!moved) return true;
        bus.emit("pool-rebalance:updated", { rebalance: moved });
        return true;
    }

    /** Broadcasts one stored transaction of a pool top-up and waits for it: mined successfully, still unconfirmed, or ended (failed or its signatures dropped). */
    async #settleRebalance(rebalance: PoolRebalanceDoc, step: Step): Promise<"mined" | "pending" | "ended"> {
        const { client, broadcast, collections } = this.#deps;
        const rawTx = (step === "approve" ? rebalance.arc.approveRawTx : rebalance.arc.burnRawTx) as Hex;
        const hash = (step === "approve" ? rebalance.arc.approveTxHash : rebalance.arc.burnTxHash) as Hex;
        const key = `${rebalance._id.toHexString()}:${step}`;
        const stored = { txHash: hash };

        try {
            await (broadcast ?? ((tx: Hex) => client.sendRawTransaction({ serializedTransaction: tx })))(rawTx);
        } catch (error) {
            if (unreachable(error)) throw error;
            if (/nonce too low/i.test(String(error)) && !(await this.#mined(stored))) {
                this.#deps.logger.warn(
                    {
                        event: "rebalance.resign",
                        rebalanceId: rebalance._id.toHexString(),
                        step,
                        nonce: step === "approve" ? rebalance.arc.approveNonce : rebalance.arc.burnNonce,
                        txHash: hash,
                        err: error,
                    },
                    "A pool top-up's nonce was already used by another transaction, so it will be signed again",
                );
                await collections.poolRebalances.updateOne(
                    { _id: rebalance._id, state: "sending", [`arc.${step}TxHash`]: hash },
                    {
                        $set: {
                            "arc.approveNonce": null,
                            "arc.approveRawTx": null,
                            "arc.approveTxHash": null,
                            "arc.burnNonce": null,
                            "arc.burnRawTx": null,
                            "arc.burnTxHash": null,
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
                await this.#failRebalance(rebalance, networkRefused(error, step, hash));
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
        await this.#failRebalance(rebalance, reverted(step, hash, receipt.gasUsed));
        return "ended";
    }

    /** Marks a top-up failed without touching any balance: nothing was burned, so the treasury only lost gas. */
    async #failRebalance(rebalance: PoolRebalanceDoc, why: Omit<Why, "message">) {
        const { collections, bus, logger } = this.#deps;
        const at = new Date(this.#now());
        const moved = await collections.poolRebalances.findOneAndUpdate(
            { _id: rebalance._id, state: "sending" },
            {
                $set: { state: "failed", lastError: rebalanceError(why), doneAt: at, updatedAt: at },
                $unset: { active: "" },
            },
            { returnDocument: "after" },
        );
        if (!moved) return;
        const fields = {
            rebalanceId: rebalance._id.toHexString(),
            direction: rebalance.direction,
            amountE6: fromDecimal(rebalance.amountE6).toString(),
        };
        logger[why.step === "burn" ? "error" : why.level](
            {
                ...fields,
                event: "rebalance.failed",
                step: why.step,
                txHash: why.txHash,
                failure: why.failure,
                detail: why.detail,
                err: why.err,
            },
            "A pool top-up failed and the treasury kept its USDC",
        );
        // The approve stays as it is: the next one overwrites it, and a reset would cost another transaction.
        if (why.step === "burn")
            logger.info(fields, "A failed pool burn leaves the TokenMessengerV2 allowance in place");
        bus.emit("pool-rebalance:updated", { rebalance: moved });
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
                {
                    event: "withdrawal.stalled",
                    withdrawalId: id,
                    accountId: doc.accountId.toHexString(),
                    amount: formatUsdc(fromDecimal(doc.amount)),
                    to: doc.solana?.wallet,
                    burnTxHash: doc.solana?.burnTxHash,
                    stalledForMin: Math.round((now - doc.updatedAt.getTime()) / 60_000),
                    iris: this.#lastIris.get(id) ?? doc.solana?.irisLast ?? null,
                },
                "A Solana withdrawal is taking too long to be delivered",
            );
        }

        const next = forwarding[0];
        if (!next || !this.#irisLimiter.take(now)) return;
        const id = next._id.toHexString();
        await collections.withdrawals.updateOne(
            { _id: next._id, state: "forwarding" },
            { $set: { "solana.irisCheckedAt": new Date(now) } },
        );

        let message;
        try {
            message = await iris.message({ domain: ARC_DOMAIN, burnTxHash: next.solana!.burnTxHash! });
        } catch (error) {
            if (error instanceof IrisError && (error.kind === "rate_limited" || error.kind === "timeout")) {
                this.#irisLimiter.backoff(now);
            }
            const kind = error instanceof IrisError ? error.kind : "unknown";
            if (this.#dueForLog(`iris:${kind}`, now, RETRY_LOG_MS)) {
                logger.warn(
                    {
                        event: "iris.unavailable",
                        kind,
                        withdrawalId: id,
                        burnTxHash: next.solana!.burnTxHash,
                        err: error,
                    },
                    "Circle's Iris couldn't be asked about a Solana withdrawal",
                );
            }
            return;
        }
        const raw = message?.raw ?? null;
        const changed = JSON.stringify(this.#lastIris.get(id) ?? next.solana!.irisLast ?? null) !== JSON.stringify(raw);
        this.#lastIris.set(id, raw);
        if (changed) {
            await collections.withdrawals.updateOne(
                { _id: next._id, state: "forwarding" },
                { $set: { "solana.irisLast": raw } },
            );
        }
        if (message?.status === "failed") {
            const forwardFields = {
                event: "withdrawal.forward_failed",
                withdrawalId: id,
                accountId: next.accountId.toHexString(),
                amount: formatUsdc(fromDecimal(next.amount)),
                to: next.solana!.wallet,
                burnTxHash: next.solana!.burnTxHash,
                iris: raw,
            };
            if (!next.solana!.forwardFailure) {
                // Stored once, so the person is told Circle said it failed, also after a restart
                const flagged = await collections.withdrawals.findOneAndUpdate(
                    { _id: next._id, state: "forwarding", "solana.forwardFailure": null },
                    {
                        $set: {
                            "solana.forwardFailure": { detail: JSON.stringify(raw).slice(0, 500), at: new Date(now) },
                            updatedAt: new Date(now),
                        },
                    },
                    { returnDocument: "after" },
                );
                if (flagged) {
                    const account = await collections.accounts.findOne({ _id: flagged.accountId });
                    bus.emit("withdrawal:updated", { withdrawal: flagged, account });
                }
            }
            if (this.#dueForLog(`failed:${id}`, now)) {
                logger.error(
                    forwardFields,
                    `Circle reported a Solana withdrawal's delivery failed (ref ${withdrawalRef(next._id)})`,
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

    /** True at most once per `every` (an hour by default) per key. */
    #dueForLog(key: string, now: number, every = STALL_LOG_MS) {
        const last = this.#logged.get(key);
        if (last !== undefined && now - last < every) return false;
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
        const [pending, block, arc, burn, rebalance] = await Promise.all([
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
            collections.poolRebalances
                .find({ state: "sending", "arc.burnRawTx": { $ne: null } })
                .sort({ "arc.burnNonce": -1 })
                .limit(1)
                .toArray(),
        ]);
        const after = (value: number | null | undefined) => (value != null ? value + 1 : 0);
        const nonce = Math.max(
            pending,
            after(arc[0]?.nonce),
            after(burn[0]?.solana?.burnNonce),
            after(rebalance[0]?.arc.burnNonce),
        );
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
                this.#deps.logger.warn(
                    {
                        event: "withdrawal.resign",
                        withdrawalId: withdrawal._id.toHexString(),
                        accountId: withdrawal.accountId.toHexString(),
                        step: "pay",
                        nonce: withdrawal.nonce,
                        txHash: withdrawal.txHash,
                        err: error,
                    },
                    "A payout's nonce was already used by another transaction, so it will be signed again",
                );
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
                return this.#fail(withdrawal, networkRefused(error, "pay", withdrawal.txHash));
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
        else await this.#fail(withdrawal, reverted("pay", hash, receipt.gasUsed));
    }

    /** True when the node knows the stored hash, pending or mined. */
    async #seen(withdrawal: Pick<WithdrawalDoc, "txHash">) {
        const found = await this.#deps.client
            .getTransaction({ hash: withdrawal.txHash as Hex })
            .catch((error: unknown) => {
                if (/not found|could not be found/i.test(String(error))) return null;
                throw error;
            });
        return found !== null;
    }

    /** True when the stored hash has a receipt; false when its nonce was taken by another transaction. */
    async #mined(withdrawal: Pick<WithdrawalDoc, "txHash">) {
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
    async #fail(withdrawal: WithdrawalDoc, why: Why) {
        const { collections, ledger, bus, logger } = this.#deps;
        const result = await ledger.runInTransaction(async (session: ClientSession) => {
            const moved = await collections.withdrawals.findOneAndUpdate(
                { _id: withdrawal._id, state: "sending" },
                {
                    $set: {
                        state: "failed",
                        failure: why.failure,
                        detail: why.detail,
                        message: why.message,
                        updatedAt: new Date(),
                    },
                },
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
        logger[why.level](
            {
                event: "withdrawal.failed",
                withdrawalId: withdrawal._id.toHexString(),
                accountId: result.moved.accountId.toHexString(),
                requestId: result.moved.requestId,
                network: result.moved.network ?? "arc",
                amount: formatUsdc(fromDecimal(result.moved.amount)),
                to: result.moved.solana?.wallet ?? result.moved.to,
                step: why.step,
                txHash: why.txHash,
                failure: why.failure,
                detail: why.detail,
                err: why.err,
            },
            "A withdrawal failed and was refunded",
        );
        bus.emit("withdrawal:updated", { withdrawal: result.moved, account: result.account });
    }
}
