import { describe, expect, test } from "vitest";
import type { PoolRebalanceState } from "../../src/db/mongo.ts";
import {
    BAND_HIGH_PCT,
    BAND_LOW_PCT,
    FLOAT_MAX_AGE_MS,
    HALT_AFTER,
    decidePoolMove,
    isHalted,
    planPoolMove,
    usdToE6,
} from "../../src/predictions/pool-plan.ts";

const NOW = 1_800_000_000_000;
const none = { arc_to_polygon: false, polygon_to_arc: false };

type Decide = Parameters<typeof decidePoolMove>[0];

const decide = (usd: { target?: number; free: number }, over: Partial<Decide> = {}) =>
    decidePoolMove({
        tradingOn: true,
        targetE6: usdToE6(usd.target ?? 100),
        freeE6: usdToE6(usd.free),
        floatAt: NOW,
        now: NOW,
        lastMoveAt: null,
        pauseMs: 300_000,
        minMoveE6: usdToE6(10),
        maxMoveE6: usdToE6(100),
        halted: none,
        ...over,
    });

const topUp = (usd: number) => ({
    move: { direction: "arc_to_polygon", reason: "low", amountE6: usdToE6(usd) },
});
const drain = (usd: number) => ({
    move: { direction: "polygon_to_arc", reason: "high", amountE6: usdToE6(usd) },
});

describe("constants", () => {
    test("the bands, the halt count and the float age are the spec's", () => {
        expect([BAND_LOW_PCT, BAND_HIGH_PCT, HALT_AFTER, FLOAT_MAX_AGE_MS]).toEqual([50, 150, 3, 180_000]);
    });
});

describe("decidePoolMove", () => {
    test("free 49.99 is low and exactly 50 is in band", () => {
        expect(decide({ free: 49.99 })).toEqual(topUp(51));
        expect(decide({ free: 50 })).toEqual({ move: null, why: "in_band" });
    });

    test("exactly 150 is in band and 150.01 is high", () => {
        expect(decide({ free: 150 })).toEqual({ move: null, why: "in_band" });
        expect(decide({ free: 150.01 })).toEqual(drain(50));
    });

    test("the top-up is T minus free rounded up to a whole dollar", () => {
        expect(decide({ free: 30.2 })).toEqual(topUp(70));
    });

    test("a top-up is capped at the maximum", () => {
        expect(decide({ target: 200, free: 0 })).toEqual(topUp(100));
    });

    test("a top-up is raised to the minimum", () => {
        expect(decide({ target: 12, free: 5 })).toEqual(topUp(10));
    });

    test("the drain is free minus T rounded down", () => {
        expect(decide({ free: 160.9 })).toEqual(drain(60));
    });

    test("and capped", () => {
        expect(decide({ free: 400 })).toEqual(drain(100));
    });

    test("a drain under the minimum is too_small", () => {
        expect(decide({ target: 15, free: 23 })).toEqual({ move: null, why: "too_small" });
    });

    test("a minimum-sized top-up never trips the drain", () => {
        expect(decide({ target: 5, free: 1 })).toEqual(topUp(10));
        expect(decide({ target: 5, free: 11 })).toEqual({ move: null, why: "too_small" });
    });

    test("trading off, a float older than 180 s, a move inside the pause, and a float read at or before the last move each decide nothing", () => {
        expect(decide({ free: 0 }, { tradingOn: false })).toEqual({ move: null, why: "trading_off" });

        expect(decide({ free: 0 }, { floatAt: NOW - 181_000 })).toEqual({ move: null, why: "stale_float" });
        expect(decide({ free: 0 }, { floatAt: NOW - 180_000 })).toEqual(topUp(100));

        expect(decide({ free: 0 }, { lastMoveAt: NOW - 299_999 })).toEqual({ move: null, why: "in_pause" });
        expect(decide({ free: 0 }, { lastMoveAt: NOW - 300_000 })).toEqual(topUp(100));

        const pause = { pauseMs: 60_000, lastMoveAt: NOW - 120_000 };
        expect(decide({ free: 0 }, { ...pause, floatAt: NOW - 120_000 })).toEqual({
            move: null,
            why: "float_before_move",
        });
        expect(decide({ free: 0 }, { ...pause, floatAt: NOW - 119_999 })).toEqual(topUp(100));
    });

    test("a halted direction skips only its own", () => {
        const topUpHalted = { ...none, arc_to_polygon: true };
        const drainHalted = { ...none, polygon_to_arc: true };
        const both = { arc_to_polygon: true, polygon_to_arc: true };

        expect(decide({ free: 0 }, { halted: topUpHalted })).toEqual({ move: null, why: "halted" });
        expect(decide({ free: 0 }, { halted: drainHalted })).toEqual(topUp(100));
        expect(decide({ free: 0 }, { halted: both })).toEqual({ move: null, why: "halted" });

        expect(decide({ free: 400 }, { halted: drainHalted })).toEqual({ move: null, why: "halted" });
        expect(decide({ free: 400 }, { halted: topUpHalted })).toEqual(drain(100));
        expect(decide({ free: 400 }, { halted: both })).toEqual({ move: null, why: "halted" });

        expect(decide({ free: 100 }, { halted: both })).toEqual({ move: null, why: "in_band" });
    });
});

describe("planPoolMove", () => {
    type Plan = Parameters<typeof planPoolMove>[0];
    const plan = (over: Partial<Plan> = {}) =>
        planPoolMove({
            direction: "arc_to_polygon",
            amountE6: usdToE6(50),
            maxMoveE6: usdToE6(100),
            treasuryFreeE6: usdToE6(500),
            arcReserveE6: usdToE6(100),
            movedTodayE6: 0n,
            maxDayE6: usdToE6(300),
            freeFloatE6: 0n,
            ...over,
        });

    test("an in-bounds top-up is ok", () => {
        expect(plan()).toEqual({ ok: true });
    });

    test("zero is refused as amount", () => {
        const zero = plan({ amountE6: 0n });
        expect(zero).toMatchObject({ ok: false, kind: "amount" });
        expect(plan({ amountE6: -1n })).toMatchObject({ ok: false, kind: "amount" });
    });

    test("above the move cap is cap", () => {
        expect(plan({ amountE6: usdToE6(100) })).toEqual({ ok: true });
        expect(plan({ amountE6: usdToE6(100) + 1n })).toMatchObject({ ok: false, kind: "cap" });
        expect(
            plan({ direction: "polygon_to_arc", amountE6: usdToE6(100) + 1n, freeFloatE6: usdToE6(500) }),
        ).toMatchObject({ ok: false, kind: "cap" });
    });

    test("day total 250 + 60 is day, exactly 300 is ok", () => {
        expect(plan({ movedTodayE6: usdToE6(250), amountE6: usdToE6(60) })).toMatchObject({ ok: false, kind: "day" });
        expect(plan({ movedTodayE6: usdToE6(250), amountE6: usdToE6(50) })).toEqual({ ok: true });
    });

    test("treasury free 150, amount 60, reserve 100 is reserve; free 160 is ok", () => {
        const refused = plan({ treasuryFreeE6: usdToE6(150), amountE6: usdToE6(60) });
        expect(refused).toMatchObject({ ok: false, kind: "reserve" });
        expect(plan({ treasuryFreeE6: usdToE6(160), amountE6: usdToE6(60) })).toEqual({ ok: true });
    });

    test("a drain is not limited by the day total or the reserve", () => {
        const drained = plan({
            direction: "polygon_to_arc",
            amountE6: usdToE6(80),
            movedTodayE6: usdToE6(300),
            treasuryFreeE6: 0n,
            freeFloatE6: usdToE6(80),
        });
        expect(drained).toEqual({ ok: true });
    });

    test("a drain above free float is float; equal is ok", () => {
        const drain = { direction: "polygon_to_arc", amountE6: usdToE6(80) } as const;
        expect(plan({ ...drain, freeFloatE6: usdToE6(80) - 1n })).toMatchObject({ ok: false, kind: "float" });
        expect(plan({ ...drain, freeFloatE6: usdToE6(80) })).toEqual({ ok: true });
    });

    test("a top-up ignores free float", () => {
        expect(plan({ freeFloatE6: 0n })).toEqual({ ok: true });
    });

    test("every refusal is a plain sentence ending in a period", () => {
        const refusals = [
            plan({ amountE6: 0n }),
            plan({ amountE6: usdToE6(101) }),
            plan({ movedTodayE6: usdToE6(299) }),
            plan({ treasuryFreeE6: usdToE6(100) }),
            plan({ direction: "polygon_to_arc" }),
        ];
        for (const refusal of refusals) {
            expect(refusal.ok).toBe(false);
            if (!refusal.ok) expect(refusal.reason).toMatch(/^[A-Z$].*\.$/);
        }
    });
});

describe("usdToE6", () => {
    test("converts whole, fractional and float-error dollars exactly", () => {
        expect(usdToE6(100)).toBe(100_000_000n);
        expect(usdToE6(12.5)).toBe(12_500_000n);
        expect(usdToE6(0.1 + 0.2)).toBe(300_000n);
    });
});

describe("isHalted", () => {
    const row = (state: PoolRebalanceState, resolvedAt: Date | null = null) => ({ state, resolvedAt });

    test("three failed rows halt", () => {
        expect(isHalted({ stuck: false, last: [row("failed"), row("failed"), row("failed")] })).toBe(true);
    });

    test("two failed and a done do not", () => {
        expect(isHalted({ stuck: false, last: [row("failed"), row("failed"), row("done")] })).toBe(false);
        expect(isHalted({ stuck: false, last: [row("done"), row("failed"), row("failed")] })).toBe(false);
    });

    test("a stuck row halts at once", () => {
        expect(isHalted({ stuck: true, last: [] })).toBe(true);
        expect(isHalted({ stuck: true, last: [row("done")] })).toBe(true);
    });

    test("three failed rows whose newest has resolvedAt do not", () => {
        const resolved = row("failed", new Date(NOW));
        expect(isHalted({ stuck: false, last: [resolved, row("failed"), row("failed")] })).toBe(false);
    });

    test("only the newest three rows count and a resolved older row does not matter", () => {
        const older = [row("failed", new Date(NOW))];
        expect(isHalted({ stuck: false, last: [row("failed"), row("failed"), row("failed"), ...older] })).toBe(true);
        expect(isHalted({ stuck: false, last: [row("failed"), row("failed"), ...older] })).toBe(false);
    });

    test("fewer than three rows never halt on failures", () => {
        expect(isHalted({ stuck: false, last: [] })).toBe(false);
        expect(isHalted({ stuck: false, last: [row("failed"), row("failed")] })).toBe(false);
    });

    test("stuck rows in the newest three count as failures", () => {
        expect(isHalted({ stuck: false, last: [row("stuck"), row("failed"), row("stuck")] })).toBe(true);
    });
});
