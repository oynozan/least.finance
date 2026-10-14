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
    findFill: () => hung,
    balanceE6: () => hung,
    redeem: () => hung,
    transaction: () => hung,
    holdings: () => hung,
    usdcBalanceE6: () => hung,
    syncBalance: () => hung,
    wrapUsdc: () => hung,
    unwrapAndBurn: () => hung,
    burnEvents: () => hung,
    burnLog: () => hung,
    derivedWallet: () => hung,
} as PoolTrader;

test("a hung read rejects once the time is up", async () => {
    const trader = withTimeouts(stuck, 20);
    await expect(trader.book("t")).rejects.toThrow(/timed out/);
    await expect(trader.meta("t")).rejects.toThrow(/timed out/);
    await expect(trader.lookup({ orderHash: "0x1", clobOrderId: null, tokenId: "t" })).rejects.toThrow(/timed out/);
    await expect(trader.balanceE6()).rejects.toThrow(/timed out/);
});

test("a hung trade lookup, redeem and holdings reject too", async () => {
    const trader = withTimeouts(stuck, 20);
    const since = new Date();
    await expect(trader.findFill({ orderHash: "0x1", tokenId: "t", side: "buy", since })).rejects.toThrow(/timed out/);
    await expect(trader.redeem("0xc")).rejects.toThrow(/timed out/);
    await expect(trader.holdings()).rejects.toThrow(/timed out/);
});

test("a hung post is unknown, so the order stays posted", async () => {
    const trader = withTimeouts(stuck, 20);
    expect(await trader.post({ orderHash: "0x1", signed: {} })).toEqual({ kind: "unknown" });
});

test("a hung wrap and a hung unwrapAndBurn are unknown", async () => {
    const trader = withTimeouts(stuck, 20);
    expect(await trader.wrapUsdc(5_000_000n)).toEqual({ kind: "unknown" });
    expect(
        await trader.unwrapAndBurn({
            amountE6: 5_000_000n,
            maxFeeE6: 100_000n,
            recipient: "0x000000000000000000000000000000000000b0b0",
        }),
    ).toEqual({ kind: "unknown" });
});

test("a wrap that fails outright is not turned into unknown", async () => {
    const trader = withTimeouts({ ...stuck, wrapUsdc: () => Promise.reject(new Error("bad batch")) }, 20);
    await expect(trader.wrapUsdc(5_000_000n)).rejects.toThrow("bad batch");
});

test("hung usdcBalanceE6, syncBalance, burnEvents, burnLog and derivedWallet reject as timed out", async () => {
    const trader = withTimeouts(stuck, 20);
    await expect(trader.usdcBalanceE6()).rejects.toThrow(/timed out/);
    await expect(trader.syncBalance()).rejects.toThrow(/timed out/);
    await expect(trader.burnEvents({ since: new Date() })).rejects.toThrow(/timed out/);
    await expect(trader.burnLog(`0x${"ab".repeat(32)}`)).rejects.toThrow(/timed out/);
    await expect(trader.derivedWallet()).rejects.toThrow(/timed out/);
});

test("a prompt answer passes through", async () => {
    const trader = withTimeouts({ ...stuck, balanceE6: async () => 5n }, 20);
    expect(await trader.balanceE6()).toBe(5n);
});

test("a prompt batch answer passes through", async () => {
    const trader = withTimeouts({ ...stuck, wrapUsdc: async () => ({ kind: "submitted", transactionId: "t1" }) }, 20);
    expect(await trader.wrapUsdc(5_000_000n)).toEqual({ kind: "submitted", transactionId: "t1" });
});
