import { describe, expect, it } from "vitest";
import { PERP_FEE_E6, PERP_FEE_USD } from "../../src/perps/fee.ts";
import {
    leverageBound,
    limitPrice,
    liquidationPrice,
    meetsMinimum,
    minOrderE6,
    roundPrice,
    roundSize,
    sizeFor,
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
