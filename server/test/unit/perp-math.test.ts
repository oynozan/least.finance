import { describe, expect, it } from "vitest";
import { PERP_FEE_E6, PERP_FEE_USD } from "../../src/perps/fee.ts";
import {
    CLOSE_MIN_SLIPPAGE_BPS,
    OPEN_MIN_SLIPPAGE_BPS,
    dynamicLimit,
    leverageBound,
    limitPrice,
    liquidationPrice,
    meetsMinimum,
    minOrderE6,
    orderValueE6,
    raiseLimitToMinimum,
    roundPrice,
    roundPriceTo,
    roundSize,
    sizeFor,
    walkBook,
    worthMinimum,
} from "../../src/perps/math.ts";

describe("roundPrice", () => {
    it("roundPrice keeps 5 significant figures", () => {
        expect(roundPrice(65432.19, 5)).toBe("65432");
        expect(roundPrice(0.123456, 0)).toBe("0.12346");
    });

    it("decimals are capped at 6 - szDecimals", () => {
        expect(roundPrice(1.234567, 4)).toBe("1.23");
    });

    it("trailing zeros are stripped", () => {
        expect(roundPrice(65000, 5)).toBe("65000");
        expect(roundPrice(1.5, 2)).toBe("1.5");
        expect(roundPrice(1.50004, 0)).toBe("1.5");
    });
});

describe("roundPriceTo", () => {
    it("rounds up or down to the tick instead of to the nearest one", () => {
        // 5 significant figures, one decimal at most: a tick of 0.1 on BTC-sized prices
        expect(roundPriceTo(65325.04, 5, "up")).toBe("65326");
        expect(roundPriceTo(65325.96, 5, "down")).toBe("65325");
        expect(roundPriceTo(1.23451, 2, "up")).toBe("1.2346");
        expect(roundPriceTo(1.23459, 2, "down")).toBe("1.2345");
    });

    it("keeps a price already on a tick", () => {
        expect(roundPriceTo(65325, 5, "up")).toBe("65325");
        expect(roundPriceTo(65325.00000000001, 5, "up")).toBe("65325");
        expect(roundPriceTo(0.000159, 0, "down")).toBe("0.000159");
        expect(roundPriceTo(3030.0000000000005, 4, "up")).toBe("3030");
    });

    it("on a coin whose tick is a large part of its price, goes the way it is told while the nearest tick goes the other", () => {
        // szDecimals 0 leaves 6 decimals: a tick of 0.000001 on a price of 0.000161 is 62 bps
        expect(roundPrice(0.0001611, 0)).toBe("0.000161");
        expect(roundPriceTo(0.0001611, 0, "up")).toBe("0.000162");
        expect(roundPrice(0.0001619, 0)).toBe("0.000162");
        expect(roundPriceTo(0.0001619, 0, "down")).toBe("0.000161");
    });

    it("rounds up over a power of ten", () => {
        expect(roundPriceTo(9.99996, 5, "up")).toBe("10");
        expect(roundPriceTo(99999.4, 5, "up")).toBe("100000");
        expect(roundPriceTo(10.00001, 5, "down")).toBe("10");
    });
});

describe("walkBook", () => {
    const levels = [
        { price: 100, size: 1 },
        { price: 101, size: 2 },
        { price: 103, size: 5 },
    ];

    it("is the average price and the worst level a market order touches", () => {
        expect(walkBook(levels, 0.5)).toEqual({ avg: 100, worst: 100 });
        expect(walkBook(levels, 2)).toEqual({ avg: 100.5, worst: 101 });
        expect(walkBook(levels, 8)!.worst).toBe(103);
    });

    it("is null when the levels are too thin", () => {
        expect(walkBook(levels, 8.1)).toBeNull();
        expect(walkBook([], 1)).toBeNull();
    });
});

describe("dynamicLimit", () => {
    const btc = { mark: 65000, szDecimals: 5, minBps: OPEN_MIN_SLIPPAGE_BPS, maxBps: 300 };
    const deep = {
        bids: [{ price: 64990, size: 100 }],
        asks: [{ price: 65010, size: 100 }],
    };

    it("on a deep book an open sits the 50 bps minimum from the mid, rounded away", () => {
        const buy = dynamicLimit({ ...btc, ...deep, side: "long", action: "open", sizeCoin: 0.01 });
        expect(buy).toEqual({ limitPx: "65325", distanceBps: 50, avgPx: 65010, fillable: true });
        const sell = dynamicLimit({ ...btc, ...deep, side: "short", action: "open", sizeCoin: 0.01 });
        expect(sell).toEqual({ limitPx: "64675", distanceBps: 50, avgPx: 64990, fillable: true });
    });

    it("never rounds a buy limit down or a sell limit up", () => {
        const odd = { bids: [{ price: 65000.4, size: 100 }], asks: [{ price: 65000.6, size: 100 }] };
        // 65000.5 x 1.005 = 65325.5025 and x 0.995 = 64675.4975, on ticks of 1
        expect(dynamicLimit({ ...btc, ...odd, side: "long", action: "open", sizeCoin: 0.01 }).limitPx).toBe("65326");
        expect(dynamicLimit({ ...btc, ...odd, side: "short", action: "open", sizeCoin: 0.01 }).limitPx).toBe("64675");
    });

    it("on a coarse-tick coin the limit goes the way of the order, however far the nearest tick is", () => {
        const hmstr = {
            mark: 0.000158,
            szDecimals: 0,
            minBps: OPEN_MIN_SLIPPAGE_BPS,
            maxBps: 300,
            bids: [{ price: 0.000157, size: 1_000_000 }],
            asks: [{ price: 0.000159, size: 1_000_000 }],
        };
        const buy = dynamicLimit({ ...hmstr, side: "long", action: "open", sizeCoin: 1000 });
        const sell = dynamicLimit({ ...hmstr, side: "short", action: "open", sizeCoin: 1000 });
        // The spread is 126 bps, so the cushion is the spread: 63 bps of impact and 126 of cushion
        expect(buy.distanceBps).toBeCloseTo(189.9, 0);
        expect(Number(buy.limitPx)).toBeGreaterThanOrEqual(0.000158 * (1 + buy.distanceBps / 10_000));
        expect(Number(buy.limitPx)).toBeLessThan(0.000158 * (1 + buy.distanceBps / 10_000) + 0.000001);
        expect(Number(sell.limitPx)).toBeLessThanOrEqual(0.000158 * (1 - sell.distanceBps / 10_000));
        expect(Number(sell.limitPx)).toBeGreaterThan(0.000158 * (1 - sell.distanceBps / 10_000) - 0.000001);
    });

    it("the cushion grows with a wide spread", () => {
        const wide = { bids: [{ price: 64870, size: 100 }], asks: [{ price: 65130, size: 100 }] };
        const result = dynamicLimit({ ...btc, ...wide, side: "long", action: "open", sizeCoin: 0.01 });
        // The spread is 40 bps and the best ask is 20 from the mid: 20 + 40
        expect(result.distanceBps).toBeCloseTo(60, 6);
    });

    it("impact is the worst level the size reaches, from the mid", () => {
        const stepped = {
            bids: [{ price: 64990, size: 0.5 }],
            asks: [
                { price: 65010, size: 0.5 },
                { price: 65260, size: 0.5 },
            ],
        };
        const result = dynamicLimit({ ...btc, ...stepped, side: "long", action: "open", sizeCoin: 0.8 });
        // Reaching 65260 is 40 bps above 65000, and the cushion is 25
        expect(result.distanceBps).toBeCloseTo(((65260 - 65000) / 65000) * 10_000 + 25, 6);
        expect(result.avgPx).toBeCloseTo((0.5 * 65010 + 0.3 * 65260) / 0.8, 6);
        expect(result.fillable).toBe(true);
        expect(Number(result.limitPx)).toBeGreaterThanOrEqual(65260);
    });

    it("a book skewed from the mark anchors at the mark's band, not at the book", () => {
        // The mid is 3% over the mark; the anchor stops at 1.5% over it
        const skewed = { bids: [{ price: 66940, size: 100 }], asks: [{ price: 66960, size: 100 }] };
        const anchor = 65000 * 1.015;
        const impact = ((66960 - anchor) / anchor) * 10_000;
        const result = dynamicLimit({ ...btc, ...skewed, side: "long", action: "open", sizeCoin: 0.01 });
        expect(result.distanceBps).toBeCloseTo(impact + 25, 6);
        expect(result.fillable).toBe(true);
        expect(Number(result.limitPx)).toBeGreaterThanOrEqual(anchor * (1 + (impact + 25) / 10_000));
        // Under a tighter cap the same order can't fill, and the limit stops at the cap from the anchor
        const tight = dynamicLimit({ ...btc, ...skewed, maxBps: 100, side: "long", action: "open", sizeCoin: 0.01 });
        expect(tight.fillable).toBe(false);
        expect(tight.distanceBps).toBe(100);
        expect(tight.limitPx).toBe("66635");
    });

    it("a thin book that can't fill the size is unfillable and the limit goes to the cap", () => {
        const thin = { bids: [{ price: 64990, size: 0.1 }], asks: [{ price: 65010, size: 0.1 }] };
        const result = dynamicLimit({ ...btc, ...thin, side: "long", action: "open", sizeCoin: 0.5 });
        expect(result).toEqual({ limitPx: "66950", distanceBps: 300, avgPx: null, fillable: false });
    });

    it("a size that needs more than the cap is unfillable, though the book shows enough", () => {
        const far = {
            bids: [{ price: 64990, size: 100 }],
            asks: [
                { price: 65010, size: 0.1 },
                { price: 67500, size: 100 },
            ],
        };
        const result = dynamicLimit({ ...btc, ...far, side: "long", action: "open", sizeCoin: 0.5 });
        expect(result.fillable).toBe(false);
        expect(result.distanceBps).toBe(300);
        expect(result.avgPx).toBeGreaterThan(65010);
    });

    it("an empty book is unfillable and anchors at the mark", () => {
        const result = dynamicLimit({ ...btc, bids: [], asks: [], side: "short", action: "open", sizeCoin: 0.01 });
        expect(result).toEqual({ limitPx: "63050", distanceBps: 300, avgPx: null, fillable: false });
    });

    it("a close keeps 100 bps on a deep book and sells down or buys up", () => {
        const close = { ...btc, minBps: CLOSE_MIN_SLIPPAGE_BPS, maxBps: 500 };
        expect(dynamicLimit({ ...close, ...deep, side: "long", action: "close", sizeCoin: 0.01 })).toEqual({
            limitPx: "64350",
            distanceBps: 100,
            avgPx: 64990,
            fillable: true,
        });
        expect(dynamicLimit({ ...close, ...deep, side: "short", action: "close", sizeCoin: 0.01 }).limitPx).toBe(
            "65650",
        );
    });

    it("a close cushions twice the spread and never goes past its cap", () => {
        const close = { ...btc, minBps: CLOSE_MIN_SLIPPAGE_BPS, maxBps: 500 };
        const wide = { bids: [{ price: 64870, size: 100 }], asks: [{ price: 65130, size: 100 }] };
        // 20 bps to the best bid, and twice the 40 bps spread
        expect(
            dynamicLimit({ ...close, ...wide, side: "long", action: "close", sizeCoin: 0.01 }).distanceBps,
        ).toBeCloseTo(100, 6);
        const thin = { bids: [{ price: 64990, size: 0.001 }], asks: [{ price: 65010, size: 100 }] };
        expect(dynamicLimit({ ...close, ...thin, side: "long", action: "close", sizeCoin: 0.5 })).toEqual({
            limitPx: "61750",
            distanceBps: 500,
            avgPx: null,
            fillable: false,
        });
    });

    it("an optional cushion replaces the minimum one", () => {
        const base = { ...btc, minBps: 0, ...deep, side: "long" as const, action: "open" as const, sizeCoin: 0.01 };
        expect(dynamicLimit({ ...base, cushionBps: 60 }).distanceBps).toBeCloseTo(61.54, 1);
    });
});

describe("roundSize", () => {
    it("rounds down to szDecimals and strips trailing zeros", () => {
        expect(roundSize(0.0076929, 5)).toBe("0.00769");
        expect(roundSize(12, 0)).toBe("12");
        expect(roundSize(1.5, 3)).toBe("1.5");
    });
});

describe("limitPrice", () => {
    it("limitPrice open long is mark x 1.01, short x 0.99, close long x 0.97, close short x 1.03", () => {
        expect(limitPrice(65000, "long", "open", 100, 5)).toBe("65650");
        expect(limitPrice(65000, "short", "open", 100, 5)).toBe("64350");
        expect(limitPrice(65000, "long", "close", 300, 5)).toBe("63050");
        expect(limitPrice(65000, "short", "close", 300, 5)).toBe("66950");
    });
});

describe("sizeFor", () => {
    const base = { leverage: 5, feeRate: 0.00045, ourFeeE6: PERP_FEE_E6, price: 65000, szDecimals: 5 };

    it("sizeFor makes margin plus both fees fit the collateral", () => {
        const collateralE6 = 100_000_000n;
        const r = sizeFor({ ...base, collateralE6 })!;
        const total = r.marginE6 + r.entryFeeE6 + r.ourFeeE6;
        expect(total).toBeLessThanOrEqual(collateralE6);
        // (100 - 1) x 5 / (1 + 5 x 0.00045) = 493.89...
        expect(Number(r.notionalE6) / 1e6).toBeGreaterThan(493.2);
        expect(Number(r.notionalE6) / 1e6).toBeLessThan(493.9);
        // One coin step (1e-5 BTC) costs about 0.65 notional, so about 0.13 of collateral.
        expect(Number(collateralE6 - total) / 1e6).toBeLessThan(0.14);
        expect(r.entryFeeE6).toBeGreaterThan(0n);
    });

    it("sizeFor takes the flat fee out of the collateral before it sizes", () => {
        const r = sizeFor({ ...base, collateralE6: 100_000_000n })!;
        expect(r.ourFeeE6).toBe(1_000_000n);
        expect(r.sizeCoin).toBe("0.00759");
        expect(Number(r.notionalE6) / 1e6).toBeCloseTo(0.00759 * 65000, 4);
        expect(Number(r.notionalE6) / 1e6).toBeCloseTo(493.35, 2);
    });

    it("sizeFor charges no fee when given none", () => {
        const r = sizeFor({ ...base, ourFeeE6: 0n, collateralE6: 100_000_000n })!;
        expect(r.ourFeeE6).toBe(0n);
        expect(r.sizeCoin).toBe("0.00767");
    });

    it("sizeFor rounds the size down", () => {
        const r = sizeFor({ ...base, collateralE6: 100_000_000n })!;
        // 493.89 / 65000 = 0.0075983... coin, floored to 5 decimals.
        expect(r.sizeCoin).toBe("0.00759");
    });

    it("sizeFor returns null when the size rounds to zero", () => {
        expect(sizeFor({ ...base, collateralE6: 1_001_000n })).toBeNull();
        expect(sizeFor({ ...base, collateralE6: 100_000_000n, price: 1e9 })).toBeNull();
    });

    it("sizeFor returns null when the collateral doesn't cover the fee", () => {
        expect(sizeFor({ ...base, collateralE6: 1_000_000n })).toBeNull();
        expect(sizeFor({ ...base, collateralE6: 500_000n })).toBeNull();
        expect(sizeFor({ ...base, collateralE6: 0n })).toBeNull();
    });
});

describe("meetsMinimum", () => {
    it("meetsMinimum: 9.99 is collateral; $11 at 1x is position, $12 at 1x passes, $10 at 2x passes", () => {
        expect(meetsMinimum(9.99, 5, PERP_FEE_USD)).toBe("collateral");
        expect(meetsMinimum(10, 1, PERP_FEE_USD)).toBe("position");
        expect(meetsMinimum(11, 1, PERP_FEE_USD)).toBe("position");
        expect(meetsMinimum(12, 1, PERP_FEE_USD)).toBeNull();
        expect(meetsMinimum(10, 2, PERP_FEE_USD)).toBeNull();
    });

    it("meetsMinimum takes the fee out before it multiplies", () => {
        // (11.5 - 1) x 1 = 10.5 is under 11 though 11.5 x 1 is not
        expect(meetsMinimum(11.5, 1, PERP_FEE_USD)).toBe("position");
        expect(meetsMinimum(11.5, 1, 0)).toBeNull();
    });
});

describe("minOrderE6", () => {
    it("is $10 grossed up for the slippage a short may fill down to, with 0.1% to spare", () => {
        expect(minOrderE6(100)).toBe(10_111_112n);
        expect(minOrderE6(300)).toBe(10_319_588n);
    });

    it("a short filled down by that slippage still clears Hyperliquid's $10", () => {
        for (const bps of [1, 100, 300, 500]) {
            expect(Number(minOrderE6(bps)) * (1 - bps / 10_000)).toBeGreaterThanOrEqual(10_000_000);
        }
    });
});

describe("orderValueE6", () => {
    it("is the size times the price in millionths of a dollar, rounded down", () => {
        expect(orderValueE6("0.00016", "65000")).toBe(10_400_000n);
        expect(orderValueE6("0.00016", "62562.5")).toBe(10_010_000n);
        expect(orderValueE6("2700", "0.003708")).toBe(10_011_600n);
        expect(orderValueE6("0.000001", "0.5")).toBe(0n);
    });

    it("takes a mark as a number", () => {
        expect(orderValueE6("0.00016", 65000.5)).toBe(10_400_080n);
        expect(orderValueE6("2700", 0.0037)).toBe(9_990_000n);
    });
});

describe("worthMinimum", () => {
    it("holds an order worth $10.01 and not one cent under it", () => {
        expect(worthMinimum("0.00016", "62562.5")).toBe(true);
        expect(worthMinimum("0.00016", "62562")).toBe(false);
    });

    it("counts the decimals themselves, not floats that land a hair under", () => {
        // 1.25 x 8.008 is exactly 10.01, though the floats multiply to 10.009999999999998
        expect(1.25 * 8.008).toBeLessThan(10.01);
        expect(worthMinimum("1.25", "8.008")).toBe(true);
        expect(worthMinimum("1.25", "8.007")).toBe(false);
    });
});

describe("raiseLimitToMinimum", () => {
    it("leaves a limit that already clears the minimum as it is", () => {
        expect(raiseLimitToMinimum("64376", "0.00016", 5)).toBe("64376");
        expect(raiseLimitToMinimum("0.0038", "2700", 0)).toBe("0.0038");
    });

    it("raises a coarse-tick coin to the first tick worth $10.01", () => {
        // 2700 coins at 0.0036 are $9.72; $10.01 / 2700 is 0.0037074..., and a tick here is 0.000001
        expect(raiseLimitToMinimum("0.0036", "2700", 0)).toBe("0.003708");
        expect(worthMinimum("2700", "0.003708")).toBe(true);
        expect(worthMinimum("2700", "0.003707")).toBe(false);
    });

    it("raises a fine-tick coin to the first tick worth $10.01", () => {
        // 0.06 SOL at 160 is $9.60; $10.01 / 0.06 is 166.8333..., and a tick here is 0.01
        expect(raiseLimitToMinimum("160", "0.06", 2)).toBe("166.84");
        expect(worthMinimum("0.06", "166.84")).toBe(true);
        expect(worthMinimum("0.06", "166.83")).toBe(false);
    });

    it("lands on a tick that is worth exactly $10.01", () => {
        expect(raiseLimitToMinimum("190.5", "0.05", 2)).toBe("200.2");
        expect(raiseLimitToMinimum("8", "1.25", 2)).toBe("8.008");
    });

    it("always ends worth the minimum, and one tick lower would not be", () => {
        const coins = [
            [0, 0.00041],
            [0, 0.0173],
            [0, 0.92],
            [1, 3.4],
            [2, 27.8],
            [2, 162.5],
            [3, 162.5],
            [4, 3050],
            [5, 64800],
        ] as const;
        for (const [szDecimals, price] of coins) {
            for (const notional of [10.02, 10.4, 10.9]) {
                const size = roundSize(notional / price, szDecimals);
                const limit = roundPrice(price * 0.955, szDecimals);
                const raised = raiseLimitToMinimum(limit, size, szDecimals);
                expect(worthMinimum(size, raised), `${size} at ${raised}`).toBe(true);
                if (raised === limit) continue;
                const below = roundPriceTo(Number(raised) * (1 - 1e-9), szDecimals, "down");
                expect(worthMinimum(size, below), `${size} at ${below}`).toBe(false);
            }
        }
    });
});

describe("leverageBound", () => {
    const tables = [
        { lowerBound: "0.0", maxLeverage: 50 },
        { lowerBound: "500000.0", maxLeverage: 10 },
    ];

    it("leverageBound is the smallest of maxLeverage, the tier at the size, and 20", () => {
        const o = { maxLeverage: 50, marginTables: tables, configMax: 20 };
        expect(leverageBound({ ...o, notionalUSD: 600_000 })).toBe(10);
        expect(leverageBound({ ...o, notionalUSD: 1_000 })).toBe(20);
        expect(leverageBound({ ...o, maxLeverage: 5, notionalUSD: 1_000 })).toBe(5);
        expect(leverageBound({ ...o, marginTables: [], notionalUSD: 1_000 })).toBe(20);
    });
});

describe("liquidationPrice", () => {
    it("liquidationPrice long and short", () => {
        const o = { entry: 65000, sizeCoin: 0.0076923, marginUSD: 100, notionalUSD: 500, maxLeverage: 50 };
        // mmr = 0.01
        expect(liquidationPrice({ ...o, side: "long" })).toBeCloseTo(52525.24, 2);
        expect(liquidationPrice({ ...o, side: "short" })).toBeCloseTo(77227.74, 2);
    });
});
