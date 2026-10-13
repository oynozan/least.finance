import { expect, test } from "vitest";
import { inFlight, traderNeeded } from "../../src/predictions/trader.ts";

test("the trader connects while trading is on, or while orders are still posted", () => {
    expect(traderNeeded({ PREDICTIONS_TRADING: "on" }, 0)).toBe(true);
    expect(traderNeeded({ PREDICTIONS_TRADING: "off" }, 0)).toBe(false);
    expect(traderNeeded({ PREDICTIONS_TRADING: "off" }, 2)).toBe(true);
});

test("a run in flight is not started twice, and can start again once done", async () => {
    let started = 0;
    let finish!: () => void;
    const start = inFlight(() => {
        started++;
        return new Promise<void>((resolve) => (finish = resolve));
    });
    start();
    start();
    expect(started).toBe(1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    start();
    expect(started).toBe(2);
});
