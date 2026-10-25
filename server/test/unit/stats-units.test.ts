import { expect, test } from "vitest";
import { usdFromE6, usdFromUnits, usdFromWei } from "../../src/stats/units.ts";

test("each scale converts to dollars once", () => {
    expect(usdFromWei(10n ** 18n)).toBe(1);
    expect(usdFromE6(1_000_000n)).toBe(1);
    expect(usdFromUnits(2n * 10n ** 18n)).toBe(2);
    expect(usdFromWei(1_500_000_000_000_000_000n)).toBe(1.5);
    expect(usdFromE6(-2_500_000n)).toBe(-2.5);
});
