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
        expect(cleanAmount("1,234,567", 6)).toBe("1234567");
        expect(cleanAmount("1,234,567.89", 2)).toBe("1234567.89");
        expect(cleanAmount("1,234.", 6)).toBe("1234.");
    });

    test("a comma before exactly three digits is a decimal point when nothing says otherwise", () => {
        expect(cleanAmount("1,000", 6)).toBe("1.000");
        expect(cleanAmount("0,125", 6)).toBe("0.125");
    });

    test("several groups are never merged into one fraction", () => {
        expect(cleanAmount("1.234,56", 6)).toBe("1234.56");
        expect(cleanAmount("1,23,456", 6)).toBe("123.456");
        expect(cleanAmount("1.2.3", 6)).toBe("12.3");
    });
});
