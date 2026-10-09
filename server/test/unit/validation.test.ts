import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { connectWallet, depositPage, depositReport, parse } from "../../src/validation.ts";

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
    it("accepts a wallet address, trimming it", () => {
        const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        expect(parse(connectWallet, { address: ` ${address} ` })).toEqual({ address });
    });

    it.each(["0x123", "hello", "", "0xZZ997970C51812dc3A010C7d01b50e0d17dc79C8"])(
        "rejects the address '%s'",
        (address) => {
            expect(() => parse(connectWallet, { address })).toThrow(AppError);
        },
    );

    it("rejects a missing address", () => {
        expect(() => parse(connectWallet, undefined)).toThrow(AppError);
    });

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
