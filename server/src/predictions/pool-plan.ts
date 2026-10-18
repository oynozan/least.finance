import { formatE6 } from "../db/money.ts";
import type { PoolDirection, PoolRebalanceState } from "../db/mongo.ts";

export const BAND_LOW_PCT = 50;
export const BAND_HIGH_PCT = 150;
export const HALT_AFTER = 3;
export const FLOAT_MAX_AGE_MS = 180_000;

const DOLLAR_E6 = 1_000_000n;
const PERCENT = 100n;

/** A dollar figure for a reason, such as "$1,200"; the plan's reasons carry numbers so a failed row says which limit it hit. */
const usd = (e6: bigint) => `$${formatE6(e6 < 0n ? 0n : e6)}`;

const ceilToDollar = (e6: bigint): bigint => ((e6 + DOLLAR_E6 - 1n) / DOLLAR_E6) * DOLLAR_E6;
const floorToDollar = (e6: bigint): bigint => (e6 / DOLLAR_E6) * DOLLAR_E6;

/** The one conversion from a config dollar figure to E6 USDC units */
export function usdToE6(usd: number): bigint {
    return BigInt(Math.round(usd * 1e6));
}

export type PoolPlan =
    { ok: true } | { ok: false; kind: "amount" | "cap" | "day" | "reserve" | "float"; reason: string };

/** Whether a move may go ahead, where an Arc to Polygon top-up must also leave the treasury its reserve and stay under the day total */
export function planPoolMove(o: {
    direction: PoolDirection;
    amountE6: bigint;
    maxMoveE6: bigint;
    treasuryFreeE6: bigint;
    arcReserveE6: bigint;
    movedTodayE6: bigint;
    maxDayE6: bigint;
    freeFloatE6: bigint;
}): PoolPlan {
    if (o.amountE6 <= 0n) return { ok: false, kind: "amount", reason: "The amount must be above zero." };
    if (o.amountE6 > o.maxMoveE6) {
        return {
            ok: false,
            kind: "cap",
            reason: `${usd(o.amountE6)} is above the ${usd(o.maxMoveE6)} limit for one move.`,
        };
    }
    if (o.direction === "polygon_to_arc") {
        if (o.amountE6 > o.freeFloatE6) {
            return {
                ok: false,
                kind: "float",
                reason: `Only ${usd(o.freeFloatE6)} of the pool's float is free, and the move needs ${usd(o.amountE6)}.`,
            };
        }
        return { ok: true };
    }
    if (o.movedTodayE6 + o.amountE6 > o.maxDayE6) {
        return {
            ok: false,
            kind: "day",
            reason: `Today's moves to Polygon would reach ${usd(o.movedTodayE6 + o.amountE6)}, above the ${usd(o.maxDayE6)} daily limit.`,
        };
    }
    if (o.treasuryFreeE6 - o.amountE6 < o.arcReserveE6) {
        return {
            ok: false,
            kind: "reserve",
            reason: `The Arc treasury would drop to ${usd(o.treasuryFreeE6 - o.amountE6)}, below its ${usd(o.arcReserveE6)} reserve.`,
        };
    }
    return { ok: true };
}

export type PoolDecision =
    | {
          move: null;
          why: "trading_off" | "stale_float" | "in_pause" | "float_before_move" | "in_band" | "too_small" | "halted";
      }
    | { move: { direction: PoolDirection; reason: "low" | "high"; amountE6: bigint } };

/** What the worker should queue now, from the pool's free float against its target, with every time in ms */
export function decidePoolMove(o: {
    tradingOn: boolean;
    targetE6: bigint;
    freeE6: bigint;
    floatAt: number;
    now: number;
    lastMoveAt: number | null;
    pauseMs: number;
    minMoveE6: bigint;
    maxMoveE6: bigint;
    halted: Record<PoolDirection, boolean>;
}): PoolDecision {
    if (!o.tradingOn) return { move: null, why: "trading_off" };
    if (o.now - o.floatAt > FLOAT_MAX_AGE_MS) return { move: null, why: "stale_float" };
    if (o.lastMoveAt !== null) {
        if (o.now - o.lastMoveAt < o.pauseMs) return { move: null, why: "in_pause" };
        if (o.floatAt <= o.lastMoveAt) return { move: null, why: "float_before_move" };
    }

    const low = o.freeE6 * PERCENT < o.targetE6 * BigInt(BAND_LOW_PCT);
    const high = o.freeE6 * PERCENT > o.targetE6 * BigInt(BAND_HIGH_PCT);
    if (!low && !high) return { move: null, why: "in_band" };

    const direction: PoolDirection = low ? "arc_to_polygon" : "polygon_to_arc";
    if (o.halted[direction]) return { move: null, why: "halted" };

    if (low) {
        const wanted = ceilToDollar(o.targetE6 - o.freeE6);
        const amountE6 = wanted < o.minMoveE6 ? o.minMoveE6 : wanted;
        return { move: { direction, reason: "low", amountE6: amountE6 > o.maxMoveE6 ? o.maxMoveE6 : amountE6 } };
    }
    const wanted = floorToDollar(o.freeE6 - o.targetE6);
    if (wanted < o.minMoveE6) return { move: null, why: "too_small" };
    return { move: { direction, reason: "high", amountE6: wanted > o.maxMoveE6 ? o.maxMoveE6 : wanted } };
}

/** Whether automatic moves of one direction stop, given its newest rows first and whether a stuck row exists. */
export function isHalted(o: {
    stuck: boolean;
    last: { state: PoolRebalanceState; resolvedAt: Date | null }[];
}): boolean {
    if (o.stuck) return true;
    const newest = o.last.slice(0, HALT_AFTER);
    return (
        newest.length === HALT_AFTER &&
        newest.every((row) => (row.state === "failed" || row.state === "stuck") && row.resolvedAt === null)
    );
}
