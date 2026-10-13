import { describe, expect, it } from "vitest";
import {
    costOfFill,
    feeE6,
    limitBuyPrice,
    limitSellPrice,
    quoteBuy,
    quoteSell,
    referenceBuyPrice,
    referenceSellPrice,
} from "../../src/predictions/pricing.ts";
import type { Book, MarketMeta } from "../../src/predictions/trader.ts";

const meta: MarketMeta = { conditionId: "0xc", negRisk: false, tickSize: 0.01, feeRate: 0.07, feeExponent: 1 };
const free: MarketMeta = { ...meta, feeRate: 0 };
const book = (asks: [number, number][], bids: [number, number][] = []): Book => ({
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: bids.map(([price, size]) => ({ price, size })),
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
});

describe("feeE6", () => {
    it("matches the spec example: 100 shares at 0.5, rate 0.07", () => {
        expect(feeE6(100_000_000n, 0.5, meta)).toBe(1_750_000n);
    });

    it("rounds up to the next e6 unit", () => {
        expect(feeE6(1_000_001n, 0.5, meta)).toBe(17_501n);
    });

    it("rounds a fractional fee up when the exponent is not 1", () => {
        // 1.000001 shares × 0.07 × 0.25² = 4375.004375, so 4376 and not 4375
        expect(feeE6(1_000_001n, 0.5, { ...meta, feeExponent: 2 })).toBe(4_376n);
    });

    it("is zero without a rate", () => {
        expect(feeE6(100_000_000n, 0.5, free)).toBe(0n);
    });
});

describe("quoteBuy", () => {
    it("walks two levels for the average and worst price", () => {
        const q = quoteBuy(
            book([
                [0.5, 10],
                [0.6, 100],
            ]),
            free,
            11_000_000n,
        )!;
        expect(q.sharesE6).toBe(10_000_000n + 10_000_000n);
        expect(q.costE6).toBe(11_000_000n);
        expect(q.feeE6).toBe(0n);
        expect(q.avgPrice).toBeCloseTo(0.55, 9);
        expect(q.worstPrice).toBe(0.6);
    });

    it("keeps cost plus fee within the spend", () => {
        const q = quoteBuy(book([[0.5, 1000]]), meta, 10_000_000n)!;
        expect(q.costE6 + q.feeE6).toBeLessThanOrEqual(10_000_000n);
        expect(q.costE6 + q.feeE6).toBeGreaterThan(9_999_990n);
        expect(q.feeE6).toBeGreaterThan(0n);
    });

    it("returns null on a thin book", () => {
        expect(quoteBuy(book([[0.5, 10]]), free, 6_000_000n)).toBeNull();
        expect(quoteBuy(book([]), free, 1_000_000n)).toBeNull();
    });
});

describe("quoteSell", () => {
    it("is net of fee", () => {
        const q = quoteSell(book([], [[0.5, 100]]), meta, 100_000_000n)!;
        expect(q.feeE6).toBe(1_750_000n);
        expect(q.proceedsE6).toBe(50_000_000n - 1_750_000n);
        expect(q.avgPrice).toBe(0.5);
        expect(q.worstPrice).toBe(0.5);
    });

    it("walks the bids best first and returns null when short", () => {
        const b = book(
            [],
            [
                [0.6, 10],
                [0.4, 10],
            ],
        );
        const q = quoteSell(b, free, 15_000_000n)!;
        expect(q.proceedsE6).toBe(6_000_000n + 2_000_000n);
        expect(q.worstPrice).toBe(0.4);
        expect(quoteSell(b, free, 21_000_000n)).toBeNull();
    });
});

describe("limit prices", () => {
    it("adds 0.02 on tick 0.01", () => {
        expect(limitBuyPrice(0.55, 0.01)).toBe(0.57);
    });

    it("clamps at 1 minus the tick", () => {
        expect(limitBuyPrice(0.985, 0.01)).toBe(0.99);
        expect(limitBuyPrice(0.985, 0.001)).toBe(0.999);
    });

    it("rounds up onto a fine tick grid", () => {
        expect(limitBuyPrice(0.5551, 0.001)).toBe(0.576);
        expect(limitBuyPrice(0.5501, 0.01)).toBe(0.58);
    });

    it("mirrors on the sell side with a floor at the tick", () => {
        expect(limitSellPrice(0.55, 0.01)).toBe(0.53);
        expect(limitSellPrice(0.5549, 0.01)).toBe(0.53);
        expect(limitSellPrice(0.5551, 0.001)).toBe(0.535);
        expect(limitSellPrice(0.015, 0.01)).toBe(0.01);
        expect(limitSellPrice(0.015, 0.001)).toBe(0.001);
    });
});

describe("costOfFill", () => {
    it("is exact on a cent fill", () => {
        expect(costOfFill(50_000_000n, 100_000_000n, meta)).toBe(51_750_000n);
    });

    it("adds only the fee at the fill price, never more than the peak fee", () => {
        const making = 7_000_003n;
        const taking = 13_000_000n;
        const c = costOfFill(making, taking, meta);
        expect(c).toBe(making + feeE6(taking, Number(making) / Number(taking), meta));
        expect(c - making).toBeLessThanOrEqual(feeE6(taking, 0.5, meta));
    });
});

describe("referenceBuyPrice", () => {
    it("uses the server's price when the client sent none", () => {
        expect(referenceBuyPrice(undefined, 0.5)).toEqual({ ok: true, reference: 0.5 });
    });

    it("keeps the lower of the quote and the offered price", () => {
        expect(referenceBuyPrice(0.49, 0.5)).toEqual({ ok: true, reference: 0.49 });
        expect(referenceBuyPrice(0.51, 0.5)).toEqual({ ok: true, reference: 0.5 });
    });

    it("never lets a generous quote lift the limit past the offered price plus the slippage", () => {
        const check = referenceBuyPrice(0.98, 0.5);
        expect(check).toEqual({ ok: true, reference: 0.5 });
        expect(limitBuyPrice(0.5, 0.01)).toBe(0.52);
    });

    it("allows exactly 2 cents of movement and refuses more", () => {
        expect(referenceBuyPrice(0.5, 0.52)).toEqual({ ok: true, reference: 0.5 });
        expect(referenceBuyPrice(0.5, 0.53)).toEqual({ ok: false });
    });

    it("decides the boundary in whole e6 units, not floats", () => {
        expect(referenceBuyPrice(0.1, 0.12)).toEqual({ ok: true, reference: 0.1 });
        expect(referenceBuyPrice(0.57, 0.59)).toEqual({ ok: true, reference: 0.57 });
    });
});

describe("referenceSellPrice", () => {
    it("is refused with no bid", () => {
        expect(referenceSellPrice(0.48, null)).toEqual({ ok: false });
        expect(referenceSellPrice(undefined, null)).toEqual({ ok: false });
    });

    it("uses the best bid when the client sent none", () => {
        expect(referenceSellPrice(undefined, 0.48)).toEqual({ ok: true, reference: 0.48 });
    });

    it("keeps the higher of the quote and the best bid", () => {
        expect(referenceSellPrice(0.49, 0.48)).toEqual({ ok: true, reference: 0.49 });
        expect(referenceSellPrice(0.01, 0.48)).toEqual({ ok: true, reference: 0.48 });
        expect(limitSellPrice(0.48, 0.01)).toBe(0.46);
    });

    it("allows exactly 2 cents of fall and refuses more", () => {
        expect(referenceSellPrice(0.5, 0.48)).toEqual({ ok: true, reference: 0.5 });
        expect(referenceSellPrice(0.5, 0.47)).toEqual({ ok: false });
    });
});
