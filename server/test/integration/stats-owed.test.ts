import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterEach, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { readOwed } from "../../src/stats/owed.ts";
import { toUnitsDecimal } from "../../src/trading/units.ts";

const open: Database[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
});

async function fresh() {
    const database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    open.push(database);
    return database;
}
const usdc = (n: number) => toDecimal(BigInt(n) * 10n ** 18n);
const now = new Date();
const prices = (symbol: string) => ({ ETH: 3000, SOL: 150 })[symbol] ?? null;
const line = (lines: { id: string; usd: number }[], id: string) => lines.find((l) => l.id === id)?.usd;

test("an empty database owes nothing, in the fixed order", async () => {
    const { collections } = await fresh();
    const { lines, unpriced } = await readOwed({ collections, priceOf: prices });
    expect(lines.map((l) => l.id)).toEqual([
        "cash",
        "coins",
        "withdrawals",
        "coinWithdrawals",
        "predictionBuys",
        "perpFloatHeld",
    ]);
    expect(lines.map((l) => l.usd)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(lines.map((l) => l.label)).toEqual([
        "People's cash",
        "People's coins",
        "Withdrawals sending",
        "Coin withdrawals sending",
        "Prediction buys waiting",
        "Perp float held",
    ]);
    expect(unpriced).toEqual([]);
});

test("cash sums every account's balance", async () => {
    const { collections } = await fresh();
    for (const n of [5, 7]) {
        await collections.accounts.insertOne({
            _id: new ObjectId(),
            privyUserId: `u${n}`,
            depositIndex: n,
            depositAddress: `0x${n}`,
            balance: usdc(n),
            version: 1,
            openedAtBlock: 0,
            createdAt: now,
            updatedAt: now,
        });
    }
    expect(line((await readOwed({ collections, priceOf: prices })).lines, "cash")).toBe(12);
});

test("coins are units times price, and a coin with no price is listed", async () => {
    const { collections } = await fresh();
    const accountId = new ObjectId();
    await collections.holdings.insertMany([
        { _id: new ObjectId(), accountId, symbol: "ETH", units: toUnitsDecimal(10n ** 18n), network: "ethereum", updatedAt: now },
        { _id: new ObjectId(), accountId, symbol: "XYZ", units: toUnitsDecimal(5n * 10n ** 18n), network: "ethereum", updatedAt: now },
    ]);
    const { lines, unpriced } = await readOwed({ collections, priceOf: prices });
    expect(line(lines, "coins")).toBe(3000);
    expect(unpriced).toEqual(["XYZ"]);
});

test("only sending withdrawals count", async () => {
    const { collections } = await fresh();
    const accountId = new ObjectId();
    const base = { accountId, to: "0xabc", nonce: null, rawTx: null, txHash: null, failure: null, createdAt: now, updatedAt: now };
    await collections.withdrawals.insertMany([
        { ...base, _id: new ObjectId(), requestId: "a", amount: usdc(2), state: "sending" },
        { ...base, _id: new ObjectId(), requestId: "b", amount: usdc(9), state: "sent" },
    ]);
    const coinBase = { accountId, network: "ethereum", to: "0xabc", txHash: null, nonce: null, reason: null, createdAt: now, updatedAt: now };
    await collections.coinWithdrawals.insertMany([
        { ...coinBase, _id: new ObjectId(), requestId: "a", symbol: "ETH", units: toUnitsDecimal(2n * 10n ** 18n), state: "sending" },
        { ...coinBase, _id: new ObjectId(), requestId: "b", symbol: "ETH", units: toUnitsDecimal(10n ** 18n), state: "sent" },
    ]);
    const { lines } = await readOwed({ collections, priceOf: prices });
    expect(line(lines, "withdrawals")).toBe(2);
    expect(line(lines, "coinWithdrawals")).toBe(6000);
});

test("prediction buys in flight count, a filled one and a sell do not", async () => {
    const { collections } = await fresh();
    const accountId = new ObjectId();
    const order = (requestId: string, side: "buy" | "sell", state: string, n: number) =>
        ({
            _id: new ObjectId(),
            accountId,
            requestId,
            side,
            eventId: "e",
            marketId: "m",
            tokenId: "t",
            conditionId: "c",
            question: "q",
            outcome: "Yes",
            amount: usdc(n),
            shares: null,
            quotedPrice: 0.5,
            limitPrice: 0.5,
            positionId: null,
            orderHash: null,
            state,
            createdAt: now,
            updatedAt: now,
        }) as never;
    await collections.predictionOrders.insertMany([
        order("a", "buy", "placing", 1),
        order("b", "buy", "posted", 3),
        order("c", "buy", "filled", 5),
        order("d", "sell", "placing", 7),
    ]);
    expect(line((await readOwed({ collections, priceOf: prices })).lines, "predictionBuys")).toBe(4);
});

test("the Hyperliquid float held is read in E6", async () => {
    const { collections } = await fresh();
    await collections.perpFloat.insertOne({
        _id: "hyperliquid",
        balanceE6: toDecimal(0n),
        balanceAt: now,
        heldE6: toDecimal(1_500_000n),
        unreadFillsE6: toDecimal(0n),
        updatedAt: now,
    });
    expect(line((await readOwed({ collections, priceOf: prices })).lines, "perpFloatHeld")).toBe(1.5);
});
