import { Decimal128 } from "mongodb";
import { describe, expect, it } from "vitest";
import { e6ToWei, formatE6, formatUsdc, fromDecimal, toDecimal, weiToE6 } from "../../src/db/money.ts";

describe("money", () => {
    it.each([0n, 1n, 10n ** 16n, 12_345_678_901_234_567_890n, 10n ** 27n, 10n ** 33n + 7n, -1n, -(10n ** 27n)])(
        "%s wei survives a round trip through Decimal128",
        (wei) => {
            expect(fromDecimal(toDecimal(wei))).toBe(wei);
        },
    );

    it.each([
        ["1.5E+3", 1500n],
        ["15E+2", 1500n],
        ["1E+27", 10n ** 27n],
        ["-2.5E+1", -25n],
        ["1500", 1500n],
        ["0", 0n],
        ["1500E-2", 15n],
        ["15.00", 15n],
    ])("reads the Decimal128 %s as %s", (text, expected) => {
        expect(fromDecimal(Decimal128.fromString(text))).toBe(expected);
    });

    it.each(["0.5", "1.5", "1E-1", "-0.25", "1234E-5"])("rejects the fractional value %s", (text) => {
        expect(() => fromDecimal(Decimal128.fromString(text))).toThrow(/whole number/);
    });

    it("rejects values that are not numbers", () => {
        expect(() => fromDecimal(Decimal128.fromString("NaN"))).toThrow(/Not a number/);
        expect(() => fromDecimal(Decimal128.fromString("Infinity"))).toThrow(/Not a number/);
    });

    it("formats wei as decimal USDC strings", () => {
        expect(formatUsdc(0n)).toBe("0");
        expect(formatUsdc(1n)).toBe("0.000000000000000001");
        expect(formatUsdc(10n ** 16n)).toBe("0.01");
        expect(formatUsdc(12_500_000_000_000_000_000n)).toBe("12.5");
        expect(formatUsdc(10n ** 27n)).toBe("1000000000");
        expect(formatUsdc(-(10n ** 18n))).toBe("-1");
    });

    it("converts between e6 and wei", () => {
        expect(e6ToWei(1_500_000n)).toBe(1_500_000n * 10n ** 12n);
        expect(weiToE6(1_500_000n * 10n ** 12n)).toBe(1_500_000n);
    });

    it("floors wei to e6", () => {
        expect(weiToE6(1_999_999_999_999n)).toBe(1n);
        expect(weiToE6(999_999_999_999n)).toBe(0n);
    });

    it("formats e6 with up to six places and no trailing zeros", () => {
        expect(formatE6(1_234_500n)).toBe("1.2345");
        expect(formatE6(2_000_000n)).toBe("2");
        expect(formatE6(1n)).toBe("0.000001");
        expect(formatE6(0n)).toBe("0");
    });
});
