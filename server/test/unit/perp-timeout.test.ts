import { expect, test } from "vitest";
import { withPerpTimeouts, type HyperliquidClient } from "../../src/perps/client.ts";

const hung = new Promise<never>(() => undefined);
const stuck = {
    meta: () => hung,
    book: () => hung,
    state: () => hung,
    userFees: () => hung,
    fills: () => hung,
    orderStatus: () => hung,
    usdSend: () => hung,
    updateLeverage: () => hung,
    order: () => hung,
} as unknown as HyperliquidClient;

test("each call is bounded by ms", async () => {
    const client = withPerpTimeouts(stuck, 20);
    const signer = {} as never;
    await expect(client.meta()).rejects.toThrow(/timed out/);
    await expect(client.book("BTC")).rejects.toThrow(/timed out/);
    await expect(client.state("0x1")).rejects.toThrow(/timed out/);
    await expect(client.userFees("0x1")).rejects.toThrow(/timed out/);
    await expect(client.fills("0x1", 0)).rejects.toThrow(/timed out/);
    await expect(client.orderStatus("0x1", "0xc")).rejects.toThrow(/timed out/);
    await expect(client.usdSend(signer, "0x2", 1n, 1)).rejects.toThrow(/timed out/);
    await expect(client.updateLeverage(signer, "BTC", 2)).rejects.toThrow(/timed out/);
});

test("an order that does not answer in time is unknown", async () => {
    const client = withPerpTimeouts(stuck, 20);
    const order = { asset: "BTC", isBuy: true, px: "1", sz: "1", reduceOnly: false, cloid: "0x1" };
    expect(await client.order({} as never, order)).toEqual({ kind: "unknown" });
});

test("a failing call keeps its own error", async () => {
    const client = withPerpTimeouts({ ...stuck, meta: () => Promise.reject(new Error("boom")) }, 20);
    await expect(client.meta()).rejects.toThrow("boom");
});
