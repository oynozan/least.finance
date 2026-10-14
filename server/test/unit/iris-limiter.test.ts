import { expect, test } from "vitest";
import { IrisLimiter } from "../../src/crosschain/iris-limiter.ts";

const MINUTE = 60_000;

test("five takes in one second pass and the sixth is refused", () => {
    const limiter = new IrisLimiter();
    const taken = [0, 100, 200, 300, 999].map((now) => limiter.take(now));
    expect(taken).toEqual([true, true, true, true, true]);
    expect(limiter.take(999)).toBe(false);
    expect(limiter.take(999)).toBe(false);
});

test("a second later it allows again", () => {
    const limiter = new IrisLimiter();
    for (let i = 0; i < 5; i++) limiter.take(1_000);
    expect(limiter.take(1_999)).toBe(false);
    expect(limiter.take(2_000)).toBe(true);
});

test("backoff blocks every take for five minutes", () => {
    const limiter = new IrisLimiter();
    expect(limiter.blockedUntil()).toBe(0);
    limiter.backoff(10_000);
    expect(limiter.blockedUntil()).toBe(10_000 + 5 * MINUTE);
    expect(limiter.take(10_000)).toBe(false);
    expect(limiter.take(10_000 + 5 * MINUTE - 1)).toBe(false);
    expect(limiter.take(10_000 + 5 * MINUTE)).toBe(true);
});

test("a refused take is not counted against the window", () => {
    const limiter = new IrisLimiter();
    limiter.backoff(0);
    for (let i = 0; i < 20; i++) limiter.take(i);
    expect(limiter.take(5 * MINUTE)).toBe(true);
    expect(limiter.take(5 * MINUTE)).toBe(true);
    expect(limiter.take(5 * MINUTE)).toBe(true);
    expect(limiter.take(5 * MINUTE)).toBe(true);
    expect(limiter.take(5 * MINUTE)).toBe(true);
    expect(limiter.take(5 * MINUTE)).toBe(false);
});

test("two holders of one limiter share the budget", () => {
    const limiter = new IrisLimiter();
    const payouts = limiter;
    const rebalancer = limiter;
    expect([payouts.take(0), payouts.take(0), payouts.take(0)]).toEqual([true, true, true]);
    expect([rebalancer.take(0), rebalancer.take(0)]).toEqual([true, true]);
    expect(payouts.take(0)).toBe(false);
    expect(rebalancer.take(0)).toBe(false);

    rebalancer.backoff(500);
    expect(payouts.take(1_500)).toBe(false);
    expect(payouts.blockedUntil()).toBe(500 + 5 * MINUTE);
});

test("the budget and the pause can be set", () => {
    const limiter = new IrisLimiter({ perSecond: 2, backoffMs: 1_000 });
    expect([limiter.take(0), limiter.take(0), limiter.take(0)]).toEqual([true, true, false]);
    limiter.backoff(5_000);
    expect(limiter.blockedUntil()).toBe(6_000);
    expect(limiter.take(5_999)).toBe(false);
    expect(limiter.take(6_000)).toBe(true);
});
