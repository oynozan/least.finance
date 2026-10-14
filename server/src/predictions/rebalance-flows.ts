import type { ClientSession, Decimal128 } from "mongodb";
import type { Logger } from "pino";
import type { Address } from "viem";
import { ARC_DOMAIN, IrisError, type Iris, type IrisMessage } from "../crosschain/iris.ts";
import type { IrisLimiter } from "../crosschain/iris-limiter.ts";
import type { Collections, PoolRebalanceDoc, PoolRebalanceState } from "../db/mongo.ts";
import { formatE6, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import type { PoolConfig } from "./pool-inputs.ts";
import type { PredictionService } from "./predictions.ts";
import { POOL_ERRORS, rowFields, type HourlyLog } from "./rebalance-log.ts";
import { GATE_SHUT_MS, type RelayerGate } from "./relayer-gate.ts";
import type { BatchSubmit, PoolTrader, RelayerTransaction } from "./trader.ts";

/** What a flow gets: the worker's collaborators, and `move`, the one guarded state change of a row. */
export type FlowContext = {
    collections: Collections;
    trader: PoolTrader;
    /** The Arc treasury, where a drain's burn mints. */
    treasury: Address;
    /** Ids of drain rows this process reserved and has not yet tried to send; a restart empties it. */
    pendingSend: Set<string>;
    iris: Iris;
    limiter: IrisLimiter;
    gate: RelayerGate;
    service: PredictionService;
    ledger: Ledger;
    bus: Bus;
    logger: Logger;
    now: () => number;
    config: PoolConfig;
    log: HourlyLog;
    /** The last body Iris gave for each row (by id), for the stuck error; kept in memory only. */
    irisSeen: Map<string, unknown>;
    /** Moves the row out of its current state (null when it is no longer in it), tells the server and logs it. */
    move(
        row: PoolRebalanceDoc,
        to: PoolRebalanceState,
        patch?: Record<string, unknown>,
    ): Promise<PoolRebalanceDoc | null>;
};

/** One step of a row in one state; it reads the row it is given and changes it only through `move` and guarded updates. */
export type Flow = (ctx: FlowContext, row: PoolRebalanceDoc) => Promise<void>;

export const flowKey = (row: PoolRebalanceDoc): string => `${row.direction ?? row.kind}:${row.state}`;

/** States that leave `active` off the row, so it stops holding the one-active slot. */
const ENDING: ReadonlySet<PoolRebalanceState> = new Set(["done", "failed", "stuck"]);

/** Moves a row out of the state in `row`, setting `updatedAt` (and `doneAt` on done or failed) and dropping `active` when it ends or sticks; never sets `active`. */
export function stateChange(
    collections: Collections,
    row: PoolRebalanceDoc,
    to: PoolRebalanceState,
    patch: Record<string, unknown>,
    at: Date,
    session?: ClientSession,
): Promise<PoolRebalanceDoc | null> {
    const finished = to === "done" || to === "failed";
    return collections.poolRebalances.findOneAndUpdate(
        { _id: row._id, state: row.state },
        {
            $set: { ...patch, state: to, updatedAt: at, ...(finished && { doneAt: at }) },
            ...(ENDING.has(to) && { $unset: { active: "" as const } }),
        },
        { returnDocument: "after", ...(session && { session }) },
    );
}

/** Tells the rest of the server that a row changed state, and logs it. */
export function announce(
    ctx: Pick<FlowContext, "bus" | "logger">,
    moved: PoolRebalanceDoc,
    from: PoolRebalanceState,
): void {
    ctx.bus.emit("pool-rebalance:updated", { rebalance: moved });
    ctx.logger.info(
        { ...rowFields(moved), from, to: moved.state, lastError: moved.lastError },
        "Pool rebalance changed state",
    );
}

const HOUR_MS = 3_600_000;
/** How long a forwarding or wrapping row may take before it needs an operator. */
const STUCK_AFTER_MS = 2 * HOUR_MS;
/** A wrap batch the relayer still calls pending this long after it went out can no longer run. */
const WRAP_UNCONFIRMED_MS = 30 * 60_000;
/** How long `done` waits for the float to show a wrap. */
const DONE_WAIT_MS = 10 * 60_000;
/** The wait before the first three wrap retries; later ones wait an hour. */
const WRAP_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Wrap failures after which the error line starts. */
const WRAP_ERROR_AFTER = 10;

const e6Of = (value: Decimal128 | null): bigint => (value ? fromDecimal(value) : 0n);

/** Writes fields of a row still in the state `row` shows (and matching `also`), leaving `updatedAt` alone. */
function write(
    ctx: Pick<FlowContext, "collections">,
    row: PoolRebalanceDoc,
    fields: Record<string, unknown>,
    also: Record<string, unknown> = {},
): Promise<PoolRebalanceDoc | null> {
    return ctx.collections.poolRebalances.findOneAndUpdate(
        { _id: row._id, state: row.state, ...also },
        { $set: fields },
        { returnDocument: "after" },
    );
}

/** Logs "Pool rebalance stuck: needs an operator" once an hour, with the row, its hashes and the last Iris body. */
export function logStuck(ctx: FlowContext, row: PoolRebalanceDoc): void {
    ctx.log.once(
        `stuck:${row._id}`,
        "error",
        {
            ...rowFields(row),
            approveTxHash: row.arc.approveTxHash,
            burnTxHash: row.arc.burnTxHash ?? row.polygon.burnTxHash,
            forwardTxHash: row.iris.forwardTxHash,
            relayerTransactionId: row.polygon.relayerTransactionId,
            wrapTransactionId: row.polygon.wrapTransactionId,
            iris: ctx.irisSeen.get(row._id.toString()) ?? null,
        },
        POOL_ERRORS.stuck,
    );
}

/** Moves a row older than 2 hours (by `updatedAt`) to `stuck`, and says so; true when the row was overdue. */
export async function markStuck(ctx: FlowContext, row: PoolRebalanceDoc): Promise<boolean> {
    if (ctx.now() - row.updatedAt.getTime() <= STUCK_AFTER_MS) return false;
    const stuck = await ctx.move(row, "stuck");
    if (stuck) logStuck(ctx, stuck);
    return true;
}

/** Asks Iris about the row's burn through the shared limiter; null while it can't be asked or knows nothing of the burn. */
export async function askIris(
    ctx: FlowContext,
    row: PoolRebalanceDoc,
    o: { domain: number; burnTxHash: string },
): Promise<IrisMessage | null> {
    const now = ctx.now();
    if (!ctx.limiter.take(now)) return null;
    let message: IrisMessage | null;
    try {
        message = await ctx.iris.message(o);
    } catch (error) {
        if (error instanceof IrisError && error.kind === "rate_limited") ctx.limiter.backoff(now);
        ctx.log.once(
            `iris:${row._id}`,
            "warn",
            { ...rowFields(row), err: error },
            "Iris couldn't be asked about a pool move",
        );
        return null;
    }
    ctx.irisSeen.set(row._id.toString(), message?.raw ?? null);
    await write(ctx, row, { "iris.checkedAt": new Date(now), "iris.delayReason": message?.delayReason ?? null });
    if (message?.delayReason) {
        ctx.log.once(
            `delayed:${row._id}`,
            "error",
            { ...rowFields(row), delayReason: message.delayReason, message: message.raw },
            POOL_ERRORS.burnDelayed,
        );
    }
    return message;
}

/** Follows a top-up's burn in Iris; a complete forward stores what Circle reports and moves the row to `wrapping`, anything else changes nothing. */
async function followForward(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    const burnTxHash = row.arc.burnTxHash;
    if (!burnTxHash) {
        ctx.log.once(`no-burn:${row._id}`, "warn", rowFields(row), "A forwarding pool move has no burn to follow");
        return;
    }
    const message = await askIris(ctx, row, { domain: ARC_DOMAIN, burnTxHash });
    if (message?.status !== "complete" || !message.forwardTxHash) return;
    const moved = await ctx.move(row, "wrapping", {
        "iris.forwardTxHash": message.forwardTxHash,
        "iris.feeExecutedE6": message.feeExecutedE6 === null ? null : toDecimal(message.feeExecutedE6),
        "iris.delayReason": message.delayReason,
    });
    if (!moved) return;
    ctx.irisSeen.delete(row._id.toString());
    ctx.logger.info(
        {
            ...rowFields(moved),
            forwardTxHash: message.forwardTxHash,
            feeExecutedUSD: message.feeExecutedE6 === null ? null : formatE6(message.feeExecutedE6),
        },
        "Circle forwarded a pool top-up",
    );
}

/** What the wallet must hold before the wrap goes out: the amount less the most Circle may take, or any balance above zero for `wrap_idle`. */
function wrapThreshold(row: PoolRebalanceDoc): bigint {
    if (row.kind === "wrap_idle") return 1n;
    const least = fromDecimal(row.amountE6) - fromDecimal(row.maxFeeE6);
    return least > 1n ? least : 1n;
}

/** The wait before wrap retry number `attempts`: 1, 5 and 15 minutes, then hourly. */
const wrapRetryMs = (attempts: number): number => WRAP_RETRY_MS[attempts - 1] ?? HOUR_MS;

/** One step of a wrap: finish, poll its batch, decide an unknown one, or submit. */
async function wrapStep(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    if (row.polygon.wrapFinalAt) await finishWrap(ctx, row);
    else if (row.polygon.wrapTransactionId) await pollWrap(ctx, row);
    else if (row.polygon.wrapAttemptedAt) await decideUnknownWrap(ctx, row);
    else await submitWrap(ctx, row);
}

/** Reads the wallet's native USDC; null (with a warning) when the read fails, which leaves the row as it is. */
async function readIdle(ctx: FlowContext, row: PoolRebalanceDoc): Promise<bigint | null> {
    try {
        return await ctx.trader.usdcBalanceE6();
    } catch (error) {
        ctx.log.once(
            `usdc:${row._id}`,
            "warn",
            { ...rowFields(row), err: error },
            "Couldn't read the pool wallet's USDC, so a pool move waits",
        );
        return null;
    }
}

/** Submits the wrap of the wallet's whole balance once it is due, recording the attempt before the batch goes out. */
async function submitWrap(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    if (row.nextAt && row.nextAt.getTime() > ctx.now()) return;
    const idle = await readIdle(ctx, row);
    if (idle === null) return;
    if (row.kind === "wrap_idle" && idle === 0n) {
        await ctx.move(row, "done");
        return;
    }
    if (idle < wrapThreshold(row)) return;
    let before: bigint;
    try {
        before = await ctx.trader.balanceE6();
    } catch (error) {
        ctx.log.once(
            `balance:${row._id}`,
            "warn",
            { ...rowFields(row), err: error },
            "Couldn't read the pool's balance, so a pool move waits",
        );
        return;
    }

    const ran = await ctx.gate.run(
        async (): Promise<{ sent: BatchSubmit; marked: PoolRebalanceDoc } | null> => {
            const marked = await write(
                ctx,
                row,
                {
                    "polygon.wrapAttemptedAt": new Date(ctx.now()),
                    "polygon.balanceBeforeE6": toDecimal(before),
                    "polygon.mintedE6": toDecimal(idle),
                },
                { "polygon.wrapAttemptedAt": null, "polygon.wrapTransactionId": null },
            );
            if (!marked) return null;
            let sent: BatchSubmit;
            try {
                sent = await ctx.trader.wrapUsdc(idle);
            } catch (error) {
                ctx.logger.warn({ ...rowFields(row), err: error }, "A pool wrap batch got no clear answer");
                sent = { kind: "unknown" };
            }
            if (sent.kind === "submitted") {
                await write(ctx, marked, {
                    "polygon.wrapTransactionId": sent.transactionId,
                    "polygon.wrapSubmittedAt": new Date(ctx.now()),
                });
            }
            return { sent, marked };
        },
        { from: "rebalancer" },
    );
    if (!ran.ran || !ran.value) return;

    const { sent, marked } = ran.value;
    if (sent.kind === "submitted") {
        ctx.logger.info(
            { ...rowFields(row), transactionId: sent.transactionId, wrappedUSD: formatE6(idle) },
            "Pool rebalance wrap submitted",
        );
    } else if (sent.kind === "refused") {
        await retryWrapLater(ctx, marked, sent.message);
    } else {
        ctx.gate.shut();
        ctx.logger.warn(rowFields(row), "A pool wrap batch may or may not have been sent, so it waits for its window");
    }
}

/** Clears the wrap attempt and its batch id together (the gate must not wait on a batch that can no longer run) and sets the retry time. */
async function retryWrapLater(ctx: FlowContext, row: PoolRebalanceDoc, why: string): Promise<void> {
    const attempts = row.attempts + 1;
    const retryAt = new Date(ctx.now() + wrapRetryMs(attempts));
    const cleared = await write(
        ctx,
        row,
        {
            "polygon.wrapTransactionId": null,
            "polygon.wrapAttemptedAt": null,
            attempts,
            nextAt: retryAt,
            lastError: why,
        },
        {
            "polygon.wrapTransactionId": row.polygon.wrapTransactionId,
            "polygon.wrapAttemptedAt": row.polygon.wrapAttemptedAt,
        },
    );
    if (!cleared) return;
    ctx.logger.warn({ ...rowFields(row), attempts, retryAt, lastError: why }, "A pool rebalance wrap will be retried");
    if (attempts >= WRAP_ERROR_AFTER) {
        ctx.log.once(
            `wrap-failing:${row._id}`,
            "error",
            { ...rowFields(row), attempts, lastError: why },
            POOL_ERRORS.wrapFailing,
        );
    }
}

/** Follows a submitted wrap batch: a confirmed one is final, a failed or 30-minute-old pending one is retried, a lookup that throws changes nothing. */
async function pollWrap(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    const id = row.polygon.wrapTransactionId!;
    let found: RelayerTransaction;
    try {
        found = await ctx.trader.transaction(id);
    } catch (error) {
        ctx.log.once(
            `lookup:${row._id}`,
            "warn",
            { ...rowFields(row), err: error },
            "Couldn't look up the wrap batch, so a pool move waits",
        );
        return;
    }
    if (found.state === "confirmed") {
        const marked = await write(
            ctx,
            row,
            { "polygon.wrapFinalAt": new Date(ctx.now()) },
            { "polygon.wrapTransactionId": id, "polygon.wrapFinalAt": null },
        );
        if (!marked) return;
        ctx.logger.info({ ...rowFields(row), transactionId: id, hash: found.hash }, "Pool rebalance wrap confirmed");
        await finishWrap(ctx, marked);
        return;
    }
    const since = (row.polygon.wrapSubmittedAt ?? row.polygon.wrapAttemptedAt ?? row.updatedAt).getTime();
    if (found.state === "failed") await retryWrapLater(ctx, row, found.errorMsg ?? "The wrap batch failed.");
    else if (ctx.now() - since >= WRAP_UNCONFIRMED_MS) await retryWrapLater(ctx, row, "The wrap batch stayed pending.");
}

/** Decides a wrap whose outcome is unknown, 11 minutes after it was attempted: the USDC still there means it never ran, gone means it did. */
async function decideUnknownWrap(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    const attemptedAt = row.polygon.wrapAttemptedAt!;
    if (ctx.now() - attemptedAt.getTime() < GATE_SHUT_MS) return;
    const idle = await readIdle(ctx, row);
    if (idle === null) return;
    const unchanged = { "polygon.wrapAttemptedAt": attemptedAt, "polygon.wrapTransactionId": null };
    if (idle >= wrapThreshold(row)) {
        const cleared = await write(ctx, row, { "polygon.wrapAttemptedAt": null }, unchanged);
        if (!cleared) return;
        ctx.logger.info(rowFields(row), "An unknown pool wrap never ran, so it is wrapped again");
        await submitWrap(ctx, cleared);
        return;
    }
    const marked = await write(
        ctx,
        row,
        { "polygon.wrapFinalAt": new Date(attemptedAt.getTime() + GATE_SHUT_MS) },
        { ...unchanged, "polygon.wrapFinalAt": null },
    );
    if (!marked) return;
    ctx.logger.info(rowFields(row), "An unknown pool wrap ran, since the wallet's USDC is gone");
    await finishWrap(ctx, marked);
}

/** Forces the float read after a wrap and ends the row `done` once it shows the rise, or 10 minutes after the wrap with a warning. */
async function finishWrap(ctx: FlowContext, row: PoolRebalanceDoc): Promise<void> {
    const finalAt = row.polygon.wrapFinalAt!.getTime();
    const expected = e6Of(row.polygon.balanceBeforeE6) + e6Of(row.polygon.mintedE6);
    let seen: bigint | null = null;
    try {
        await ctx.trader.syncBalance();
        await ctx.service.refreshFloat();
        const float = await ctx.collections.poolFloat.findOne({ _id: "polygon" });
        if (float && float.balanceAt.getTime() >= finalAt) seen = fromDecimal(float.balanceE6);
    } catch (error) {
        ctx.log.once(
            `float-read:${row._id}`,
            "warn",
            { ...rowFields(row), err: error },
            "Couldn't re-read the pool's balance after a wrap",
        );
    }
    if (seen !== null && seen >= expected) {
        await ctx.move(row, "done");
        return;
    }
    if (ctx.now() - finalAt < DONE_WAIT_MS) return;
    const moved = await ctx.move(row, "done");
    if (moved) {
        ctx.logger.warn(
            { ...rowFields(row), expectedUSD: formatE6(expected), seenUSD: seen === null ? null : formatE6(seen) },
            "The pool's balance didn't show the wrapped USDC in time",
        );
    }
}

const topUpForwarding: Flow = async (ctx, row) => {
    if (await markStuck(ctx, row)) return;
    await followForward(ctx, row);
};

const wrapping: Flow = async (ctx, row) => {
    if (await markStuck(ctx, row)) return;
    await wrapStep(ctx, row);
};

/** A stuck top-up is still followed: Iris while no forward is known, the wrap after it. */
const topUpStuck: Flow = async (ctx, row) => {
    logStuck(ctx, row);
    if (row.iris.forwardTxHash === null) await followForward(ctx, row);
    else await wrapStep(ctx, row);
};

const wrapStuck: Flow = async (ctx, row) => {
    logStuck(ctx, row);
    await wrapStep(ctx, row);
};

/** The flows by `${direction ?? kind}:${state}`. */
export const FLOWS: Record<string, Flow> = {
    "arc_to_polygon:forwarding": topUpForwarding,
    "arc_to_polygon:wrapping": wrapping,
    "arc_to_polygon:stuck": topUpStuck,
    "wrap_idle:wrapping": wrapping,
    "wrap_idle:stuck": wrapStuck,
};
