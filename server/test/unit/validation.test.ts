import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import {
    activityPage,
    coinWalletAmount,
    depositPage,
    depositReport,
    parse,
    perpOrder,
    perpQuote,
    sourceReport,
    withdrawRequest,
} from "../../src/validation.ts";

const hash = `0x${"AB".repeat(32)}`;
const catchError = (fn: () => unknown) => {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return undefined;
};

describe("parse", () => {
    it("lowercases a transaction hash", () => {
        expect(parse(depositReport, { txHash: hash })).toEqual({ txHash: hash.toLowerCase() });
    });

    it.each(["0x12", `0x${"g".repeat(64)}`, `${"a".repeat(64)}`, `0x${"a".repeat(65)}`])(
        "rejects the transaction hash '%s'",
        (txHash) => {
            expect(() => parse(depositReport, { txHash })).toThrow(AppError);
        },
    );

    it("names the field in the error and uses the bad_request code", () => {
        const error = catchError(() => parse(depositReport, { txHash: "nope" })) as AppError;
        expect(error).toBeInstanceOf(AppError);
        expect(error.code).toBe("bad_request");
        expect(error.status).toBe(400);
        expect(error.message).toContain("txHash");
    });

    it("accepts an empty deposit page request", () => {
        expect(parse(depositPage, undefined)).toEqual({});
    });

    it("coerces the page limit and checks its bounds", () => {
        expect(parse(depositPage, { limit: "25" })).toEqual({ limit: 25 });
        expect(parse(depositPage, { limit: 100 })).toEqual({ limit: 100 });
        for (const limit of [0, 101, -1, 1.5, "abc"]) {
            expect(() => parse(depositPage, { limit })).toThrow(AppError);
        }
    });

    it("checks the format of the before cursor", () => {
        const before = "507f1f77bcf86cd799439011";
        expect(parse(depositPage, { before })).toEqual({ before });
        for (const bad of ["123", "g".repeat(24), `${before}0`]) {
            const error = catchError(() => parse(depositPage, { before: bad })) as AppError;
            expect(error.code).toBe("bad_request");
            expect(error.message).toContain("before");
        }
    });
});

describe("activity page input", () => {
    const before = `1760000000000:3:${"a1".repeat(12)}`;

    it("activityPage accepts no fields, a filter and a limit of 1 or 100", () => {
        expect(parse(activityPage, undefined)).toEqual({});
        expect(parse(activityPage, { before })).toEqual({ before });
        for (const filter of ["all", "trades", "deposits"]) {
            expect(parse(activityPage, { filter })).toEqual({ filter });
        }
        expect(parse(activityPage, { limit: 1 })).toEqual({ limit: 1 });
        expect(parse(activityPage, { limit: "100" })).toEqual({ limit: 100 });
        expect(parse(activityPage, { before, limit: 50, filter: "trades" })).toEqual({
            before,
            limit: 50,
            filter: "trades",
        });
    });

    it("activityPage rejects limit 0, 101 and 1.5, an unknown filter and a malformed before, naming the field", () => {
        const id = "a1".repeat(12);
        const bad: Array<[string, Record<string, unknown>]> = [
            ["limit", { limit: 0 }],
            ["limit", { limit: 101 }],
            ["limit", { limit: 1.5 }],
            ["filter", { filter: "swaps" }],
            ["before", { before: "x" }],
            ["before", { before: `1:0:${id.slice(2)}` }],
            ["before", { before: `12345678901234567:0:${id}` }],
            ["before", { before: `1:10:${id}` }],
            ["before", { before: `1:0:${id.toUpperCase()}` }],
            ["before", { before: `-1:0:${id}` }],
            ["before", { before: `${before}0` }],
        ];
        for (const [field, input] of bad) {
            const error = catchError(() => parse(activityPage, input)) as AppError;
            expect(error).toBeInstanceOf(AppError);
            expect(error.code).toBe("bad_request");
            expect(error.message).toContain(field);
        }
    });
});

describe("deposit order input", () => {
    const wallet = "0x52908400098527886E0F7030069857D2E4169EE7";

    it("accepts a coin, a decimal amount and a wallet", () => {
        expect(parse(coinWalletAmount, { coin: "ethereum:ETH", amount: "0.5", wallet: ` ${wallet} ` })).toEqual({
            coin: "ethereum:ETH",
            amount: "0.5",
            wallet,
        });
    });

    it.each(["", "-1", "1e3", ".5", "1.", "0x10", "1,5"])("rejects the amount '%s'", (amount) => {
        expect(() => parse(coinWalletAmount, { coin: "ethereum:ETH", amount, wallet })).toThrow(AppError);
    });

    it("rejects a short coin, a short wallet and a long wallet", () => {
        expect(() => parse(coinWalletAmount, { coin: "ET", amount: "1", wallet })).toThrow(AppError);
        expect(() => parse(coinWalletAmount, { coin: "ethereum:ETH", amount: "1", wallet: "0x12" })).toThrow(AppError);
        expect(() => parse(coinWalletAmount, { coin: "ethereum:ETH", amount: "1", wallet: "a".repeat(65) })).toThrow(
            AppError,
        );
    });

    it("lowercases the hashes of a source report", () => {
        expect(parse(sourceReport, { orderId: "a".repeat(24), txHashes: [hash] }).txHashes).toEqual([
            hash.toLowerCase(),
        ]);
    });

    it("rejects a bad order id and none or too many hashes", () => {
        expect(() => parse(sourceReport, { orderId: "nope", txHashes: [hash] })).toThrow(AppError);
        expect(() => parse(sourceReport, { orderId: "a".repeat(24), txHashes: [] })).toThrow(AppError);
        expect(() => parse(sourceReport, { orderId: "a".repeat(24), txHashes: Array(5).fill(hash) })).toThrow(AppError);
    });

    describe("withdrawRequest", () => {
        const requestId = "3f0c2b1e-8d4a-4b6e-9c1d-2a5e7f9b0c3d";
        const to = "0x1234567890123456789012345678901234567890";

        it("accepts a UUID, an amount with up to 6 decimals and an address", () => {
            expect(parse(withdrawRequest, { requestId, amount: "12.5", to: ` ${to} ` })).toEqual({
                requestId,
                amount: "12.5",
                to,
            });
        });

        it.each(["", "-1", "1e3", ".5", "1.", "1.1234567", "1,5"])("rejects the amount '%s'", (amount) => {
            expect(() => parse(withdrawRequest, { requestId, amount, to })).toThrow(AppError);
        });

        it("rejects a request id that isn't a UUID and a short or long recipient", () => {
            expect(() => parse(withdrawRequest, { requestId: "nope", amount: "1", to })).toThrow(AppError);
            expect(() => parse(withdrawRequest, { requestId, amount: "1", to: "0x12" })).toThrow(AppError);
            expect(() => parse(withdrawRequest, { requestId, amount: "1", to: "a".repeat(65) })).toThrow(AppError);
        });
    });
});

describe("perp input", () => {
    const requestId = "3f0c2b1e-8d4a-4b6e-9c1d-2a5e7f9b0c3d";
    const quote = { side: "long", leverage: 3, collateralUSD: "25" };

    it.each(["BTC", "kPEPE", "kSHIB", "0G", "2Z", "S", "W"])("accepts the market %s", (asset) => {
        expect(parse(perpQuote, { ...quote, asset }).asset).toBe(asset);
        expect(parse(perpOrder, { ...quote, asset, requestId }).asset).toBe(asset);
    });

    it.each(["$", "bt c", "kPEPE!", "DOGE-PERP", "xyz:AAPL", "ABCDEFGHIJKLM", ""])(
        "rejects the market '%s'",
        (asset) => {
            expect(() => parse(perpQuote, { ...quote, asset })).toThrow(AppError);
        },
    );
});
