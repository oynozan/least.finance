import { expect, test } from "@playwright/test";
import { cleanAmount } from "@/components/deposit-form";

test.describe("cleanAmount", () => {
    test("a typed decimal comma or dot is the decimal point, cut to the decimals", () => {
        expect(cleanAmount("0,5", 6)).toBe("0.5");
        expect(cleanAmount("0.5", 6)).toBe("0.5");
        expect(cleanAmount("12,", 6)).toBe("12.");
        expect(cleanAmount("1.23456789", 6)).toBe("1.234567");
        expect(cleanAmount("abc", 6)).toBe("");
    });

    test("a stray second separator after a decimal part is dropped, not folded into it", () => {
        expect(cleanAmount("1.5.", 6)).toBe("1.5");
        expect(cleanAmount("1,5,", 6)).toBe("1.5");
        expect(cleanAmount("1..", 6)).toBe("1.");
    });

    test("a pasted US-formatted number keeps its value", () => {
        expect(cleanAmount("1,234.56", 6)).toBe("1234.56");
        expect(cleanAmount("$1,234.56", 6)).toBe("1234.56");
        expect(cleanAmount("1,000.50", 6)).toBe("1000.50");
        expect(cleanAmount("1,234,567.89", 2)).toBe("1234567.89");
        expect(cleanAmount("1,234.", 6)).toBe("1234.");
    });

    test("a pasted number grouped by points before a decimal comma keeps its value", () => {
        expect(cleanAmount("1.234,56", 6)).toBe("1234.56");
        expect(cleanAmount("1.234.567,8", 6)).toBe("1234567.8");
    });

    test("without a decimal separator to tell them apart, the first comma or point is the decimal point", () => {
        expect(cleanAmount("1,000", 6)).toBe("1.000");
        expect(cleanAmount("0,125", 6)).toBe("0.125");
        // Unclear groups only ever read smaller, never ten or a thousand times more
        expect(cleanAmount("1,234,567", 6)).toBe("1.234567");
        expect(cleanAmount("1.234.567", 6)).toBe("1.234567");
    });

    test("a point typed by mistake in the middle is dropped and doesn't move the decimal point", () => {
        expect(cleanAmount("12.3.4", 6)).toBe("12.34");
        expect(cleanAmount("1a2b.3.4c", 6)).toBe("12.34");
        expect(cleanAmount("1.2.3", 6)).toBe("1.23");
    });
});
