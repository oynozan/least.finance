import { expect, test } from "vitest";
import { traderNeeded } from "../../src/predictions/trader.ts";

test("the trader connects while trading is on, or while orders are still posted", () => {
    expect(traderNeeded({ PREDICTIONS_TRADING: "on" }, 0)).toBe(true);
    expect(traderNeeded({ PREDICTIONS_TRADING: "off" }, 0)).toBe(false);
    expect(traderNeeded({ PREDICTIONS_TRADING: "off" }, 2)).toBe(true);
});
