import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { coinWalletAmount, depositPage, depositReport, parse, sourceReport } from "../../src/validation.ts";

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
});
