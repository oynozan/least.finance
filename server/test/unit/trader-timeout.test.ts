import { expect, test } from "vitest";
import { withTimeouts } from "../../src/predictions/trader.ts";
import type { PoolTrader } from "../../src/predictions/trader.ts";

const hung = new Promise<never>(() => undefined);
const stuck = {
    book: () => hung,
    meta: () => hung,
    signBuy: () => hung,
    signSell: () => hung,
    post: () => hung,
    lookup: () => hung,
    balanceE6: () => hung,
    redeem: () => hung,
    transaction: () => hung,
    holdings: () => hung,
} as PoolTrader;

test("a hung read rejects once the time is up", async () => {
    const trader = withTimeouts(stuck, 20);
    await expect(trader.book("t")).rejects.toThrow(/timed out/);
    await expect(trader.meta("t")).rejects.toThrow(/timed out/);
    await expect(trader.lookup({ orderHash: "0x1", clobOrderId: null, tokenId: "t" })).rejects.toThrow(/timed out/);
    await expect(trader.balanceE6()).rejects.toThrow(/timed out/);
});

test("a hung post is unknown, so the order stays posted", async () => {
    const trader = withTimeouts(stuck, 20);
    expect(await trader.post({ orderHash: "0x1", signed: {} })).toEqual({ kind: "unknown" });
});

test("a prompt answer passes through", async () => {
    const trader = withTimeouts({ ...stuck, balanceE6: async () => 5n }, 20);
    expect(await trader.balanceE6()).toBe(5n);
});
