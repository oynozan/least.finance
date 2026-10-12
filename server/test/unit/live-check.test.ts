import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the live check refuses to run without --yes-spend-real-money", () => {
    const run = spawnSync(process.execPath, ["scripts/polymarket-live-check.ts"], { encoding: "utf8", env: {} });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--yes-spend-real-money");
});

test("the live check only picks a market where $1 buys at least the minimum order size", async () => {
    const { buyClearsMinimum } = await import("../../scripts/live-check-guards.ts");
    const book = (minOrderSize: number) => ({ bids: [], asks: [], tickSize: 0.01, minOrderSize, negRisk: false });
    expect(buyClearsMinimum(book(5), 2_000_000n)).toBe(false);
    expect(buyClearsMinimum(book(5), 5_000_000n)).toBe(true);
    expect(buyClearsMinimum(book(0), 1n)).toBe(true);
});
