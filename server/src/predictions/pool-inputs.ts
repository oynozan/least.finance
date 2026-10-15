import { ObjectId } from "mongodb";
import type { Config } from "../config.ts";
import type { Collections, PoolDirection, PoolRebalanceDoc, PoolRebalanceState } from "../db/mongo.ts";
import { fromDecimal, toDecimal } from "../db/money.ts";
import { HALT_AFTER, isHalted, usdToE6 } from "./pool-plan.ts";

/** The settings the rebalancer reads. */
export type PoolConfig = Pick<
    Config,
    | "PREDICTIONS_TRADING"
    | "POLYMARKET_FLOAT_USD"
    | "POOL_REBALANCE_MAX_MOVE_USD"
    | "POOL_REBALANCE_MAX_DAY_USD"
    | "POOL_REBALANCE_ARC_RESERVE_USD"
    | "POOL_REBALANCE_MIN_MOVE_USD"
    | "POOL_REBALANCE_PAUSE_MIN"
>;

const DAY_MS = 86_400_000;
const FLOAT_ID = "polygon";
/** The states of a move in flight, which a row resumed from `stuck` is in without its `active` flag. */
const IN_FLIGHT: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping"];
export const DIRECTIONS: readonly PoolDirection[] = ["arc_to_polygon", "polygon_to_arc"];

/** A queued, active row with every field of the spec's row set; a `wrap_idle` row has no direction and an amount of 0. */
export function newPoolRebalance(o: {
    kind: "move" | "wrap_idle";
    direction: PoolDirection | null;
    source: "auto" | "operator";
    reason: "low" | "high" | "operator";
    amountE6: bigint;
    now: Date;
}): PoolRebalanceDoc {
    if (o.kind === "move" && o.direction === null) throw new Error("A move needs a direction");
    const wrap = o.kind === "wrap_idle";
    return {
        _id: new ObjectId(),
        kind: o.kind,
        direction: wrap ? null : o.direction,
        source: o.source,
        reason: o.reason,
        amountE6: toDecimal(wrap ? 0n : o.amountE6),
        maxFeeE6: toDecimal(0n),
        reservedE6: toDecimal(0n),
        active: true,
        state: "queued",
        attempts: 0,
        nextAt: null,
        lastError: null,
        mintRecipient: null,
        createdAt: new Date(o.now),
        updatedAt: new Date(o.now),
        doneAt: null,
        resolvedAt: null,
        arc: {
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: null,
        },
        polygon: {
            attemptedAt: null,
            relayerTransactionId: null,
            relayerFinalAt: null,
            burnTxHash: null,
            burnLogSeen: null,
            wrapAttemptedAt: null,
            wrapTransactionId: null,
            wrapSubmittedAt: null,
            wrapFinalAt: null,
            mintedE6: null,
            balanceBeforeE6: null,
        },
        iris: { checkedAt: null, forwardTxHash: null, feeExecutedE6: null, delayReason: null },
    };
}

/** E6 the pool was asked to move from Arc to Polygon in the last 24 hours: every such row but a failed one, without `excludeId`. */
export async function movedLast24hE6(collections: Collections, now: number, excludeId?: ObjectId): Promise<bigint> {
    const rows = await collections.poolRebalances
        .find(
            {
                kind: "move",
                direction: "arc_to_polygon",
                state: { $ne: "failed" },
                createdAt: { $gt: new Date(now - DAY_MS) },
                ...(excludeId && { _id: { $ne: excludeId } }),
            },
            { projection: { amountE6: 1 } },
        )
        .toArray();
    return rows.reduce((sum, row) => sum + fromDecimal(row.amountE6), 0n);
}

/** Per direction, whether automatic moves stop: a stuck row, or the newest three moves all failed or stuck. */
export async function haltedDirections(collections: Collections): Promise<Record<PoolDirection, boolean>> {
    const { poolRebalances } = collections;
    const halted = await Promise.all(
        DIRECTIONS.map(async (direction) => {
            const [last, stuck] = await Promise.all([
                poolRebalances
                    .find({ kind: "move", direction })
                    .sort({ createdAt: -1, _id: -1 })
                    .limit(HALT_AFTER)
                    .toArray(),
                poolRebalances.countDocuments({ kind: "move", direction, state: "stuck" }, { limit: 1 }),
            ]);
            const rows = last.map(({ state, resolvedAt }) => ({ state, resolvedAt }));
            return [direction, isHalted({ stuck: stuck > 0, last: rows })] as const;
        }),
    );
    return Object.fromEntries(halted) as Record<PoolDirection, boolean>;
}

/** The pool's free float in E6 from its stored balance less what orders and moves hold and fills not yet read; 0 with no document. */
export async function poolFreeFloatE6(collections: Collections): Promise<bigint> {
    const doc = await collections.poolFloat.findOne({ _id: FLOAT_ID });
    if (!doc) return 0n;
    return fromDecimal(doc.balanceE6) - fromDecimal(doc.heldE6) - fromDecimal(doc.unreadFillsE6);
}

/** What `decidePoolMove` needs, read from the float document and the rows; `freeE6` and `floatAt` are null while there is no float document. */
export type DecisionInputs = {
    tradingOn: boolean;
    targetE6: bigint;
    freeE6: bigint | null;
    floatAt: number | null;
    /** The newest `updatedAt` of any move row, failed ones included. */
    lastMoveAt: number | null;
    pauseMs: number;
    minMoveE6: bigint;
    maxMoveE6: bigint;
    halted: Record<PoolDirection, boolean>;
    /** Rows holding the one-active slot, and rows in flight without it (a stuck row that Circle's late forward moved on). */
    active: number;
};

/** Reads the float, the limits in E6, the newest move, the halted directions and the active rows; no input depends on `now`, which the callers pass on to `decidePoolMove`. */
export async function readDecisionInputs(
    collections: Collections,
    config: PoolConfig,
    now: number,
): Promise<DecisionInputs> {
    void now;
    const { poolFloat, poolRebalances } = collections;
    const [float, newest, active, halted] = await Promise.all([
        poolFloat.findOne({ _id: FLOAT_ID }),
        poolRebalances
            .find({ kind: "move" }, { projection: { updatedAt: 1 } })
            .sort({ updatedAt: -1 })
            .limit(1)
            .toArray(),
        poolRebalances.countDocuments({ $or: [{ active: true }, { state: { $in: IN_FLIGHT } }] }),
        haltedDirections(collections),
    ]);
    return {
        tradingOn: config.PREDICTIONS_TRADING === "on",
        targetE6: usdToE6(config.POLYMARKET_FLOAT_USD),
        freeE6: float && fromDecimal(float.balanceE6) - fromDecimal(float.heldE6) - fromDecimal(float.unreadFillsE6),
        floatAt: float ? float.balanceAt.getTime() : null,
        lastMoveAt: newest[0] ? newest[0].updatedAt.getTime() : null,
        pauseMs: config.POOL_REBALANCE_PAUSE_MIN * 60_000,
        minMoveE6: usdToE6(config.POOL_REBALANCE_MIN_MOVE_USD),
        maxMoveE6: usdToE6(config.POOL_REBALANCE_MAX_MOVE_USD),
        halted,
        active,
    };
}
