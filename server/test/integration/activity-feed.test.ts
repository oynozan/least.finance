import { randomUUID } from "node:crypto";
import { Decimal128, ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { AppError } from "../../src/errors.ts";
import { ActivityFeed, compareKeys, decodeCursor, encodeCursor, type FeedKey } from "../../src/pnl/feed.ts";
import type { ActivityItem, ActivityPage } from "../../src/protocol.ts";
import { seedRows, type SeedRow } from "../support/history-seed.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const slot = (index: number) => new Date(NOW - (index % 10) * HOUR);

let database: Database;
let feed: ActivityFeed;
const lines: Array<{ msg: string; accountId?: string; ms?: number; rows?: Record<string, number> }> = [];

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    feed = new ActivityFeed({ collections: database.collections, logger, now: () => NOW });
});
afterAll(() => database.close());

// The rank and document id an item sorts by, read back from its view
function keyOf(item: ActivityItem): FeedKey {
    const atMs = Date.parse(item.at);
    switch (item.kind) {
        case "deposit":
            return { atMs, rank: 0, id: item.deposit.id };
        case "withdrawal":
            return { atMs, rank: 1, id: item.withdrawal.id };
        case "swap":
            return { atMs, rank: 2, id: item.order.id };
        case "prediction":
            return { atMs, rank: item.part === "open" ? 3 : 4, id: item.position.id };
        case "sale":
            return { atMs, rank: 5, id: item.order.id };
        case "perp":
            return { atMs, rank: item.part === "open" ? 6 : 7, id: item.position.id };
        case "trade":
            return { atMs, rank: 8, id: item.trade.id };
    }
}

const hexKey = (key: FeedKey) => `${key.atMs}:${key.rank}:${key.id}`;

async function allPages(accountId: ObjectId, input: Parameters<ActivityFeed["page"]>[1]) {
    const pages: ActivityPage[] = [];
    let before = input.before;
    do {
        const page = await feed.page(accountId, { ...input, before });
        pages.push(page);
        before = page.next ?? undefined;
    } while (before);
    return pages;
}

const sizes = (pages: ActivityPage[]) => pages.map((page) => page.items.length);
const items = (pages: ActivityPage[]) => pages.flatMap((page) => page.items);

// 130 items over every kind, timestamps drawn from 10 values so many tie
function mixedRows(): SeedRow[] {
    const rows: SeedRow[] = [];
    for (let i = 0; i < 30; i++) rows.push({ kind: "deposit", usdc: "5", at: slot(i * 3) });
    for (let i = 0; i < 20; i++) rows.push({ kind: "withdrawal", usdc: "1", at: slot(i * 7 + 1) });
    for (let i = 0; i < 20; i++) rows.push({ kind: "swap", at: slot(i * 3 + 2) });
    for (let i = 0; i < 15; i++) {
        const state = (["closed", "won", "lost"] as const)[i % 3]!;
        rows.push({ kind: "prediction", state, cost: "4", openedAt: slot(i * 7 + 5), settledAt: slot(i * 3 + 4) });
    }
    for (let i = 0; i < 10; i++) rows.push({ kind: "sale", cost: "3", proceeds: "4", at: slot(i * 7 + 3) });
    for (let i = 0; i < 10; i++) {
        rows.push({
            kind: "perp",
            state: i % 2 ? "closed" : "liquidated",
            collateral: "10",
            proceeds: "0",
            openedAt: slot(i * 3 + 6),
            settledAt: slot(i * 7 + 8),
        });
    }
    return rows;
}

test("130 rows over all kinds page at 50 and every row appears once, newest first", async () => {
    const accountId = new ObjectId();
    await seedRows(database.collections, accountId, mixedRows());

    const pages = await allPages(accountId, { filter: "all" });

    expect(sizes(pages)).toEqual([50, 50, 30]);
    expect(pages.at(-1)!.next).toBeNull();
    const keys = items(pages).map(keyOf);
    expect(new Set(keys.map(hexKey)).size).toBe(130);
    for (let i = 1; i < keys.length; i++) expect(compareKeys(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    for (const page of pages.slice(0, -1)) {
        expect(decodeCursor(page.next!)).toEqual(keyOf(page.items.at(-1)!));
    }
    // Ties are real, so the key order is what keeps the pages whole
    expect(new Set(keys.map((key) => key.atMs)).size).toBeLessThanOrEqual(10);
});

test("trades and deposits filters page the same way", async () => {
    const accountId = new ObjectId();
    await seedRows(database.collections, accountId, mixedRows());

    const trades = await allPages(accountId, { filter: "trades" });
    const deposits = await allPages(accountId, { filter: "deposits" });

    expect(sizes(trades)).toEqual([50, 30]);
    expect(trades.at(-1)!.next).toBeNull();
    expect(items(trades).every((item) => !["deposit", "withdrawal"].includes(item.kind))).toBe(true);
    expect(new Set(items(trades).map((item) => hexKey(keyOf(item)))).size).toBe(80);
    expect(sizes(deposits)).toEqual([50]);
    expect(deposits[0]!.next).toBeNull();
    expect(items(deposits).every((item) => ["deposit", "withdrawal"].includes(item.kind))).toBe(true);
});

test("more than limit rows with one timestamp in one source are not cut", async () => {
    const accountId = new ObjectId();
    await seedRows(
        database.collections,
        accountId,
        Array.from({ length: 60 }, () => ({ kind: "deposit", usdc: "1", at: new Date(NOW) }) as const),
    );

    const pages = await allPages(accountId, { limit: 25 });

    expect(sizes(pages)).toEqual([25, 25, 10]);
    const ids = items(pages).map((item) => keyOf(item).id);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual([...ids].sort().reverse());
});

test("more than limit swaps with one timestamp are not cut", async () => {
    const accountId = new ObjectId();
    await seedRows(
        database.collections,
        accountId,
        Array.from({ length: 60 }, () => ({ kind: "swap", at: new Date(NOW) }) as const),
    );

    const pages = await allPages(accountId, { limit: 25 });

    expect(sizes(pages)).toEqual([25, 25, 10]);
    const ids = items(pages).map((item) => keyOf(item).id);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual([...ids].sort().reverse());
});

test("an empty account gives { items: [], next: null }", async () => {
    expect(await feed.page(new ObjectId(), {})).toEqual({ items: [], next: null });
});

test("a position is two items with the right part", async () => {
    const accountId = new ObjectId();
    const open = new Date(NOW - 5 * HOUR);
    const settled = new Date(NOW - 2 * HOUR);
    const instant = new Date(NOW - HOUR);
    const [live, closing, won, same] = await seedRows(database.collections, accountId, [
        { kind: "prediction", state: "open", cost: "5", openedAt: new Date(NOW - 9 * HOUR) },
        { kind: "prediction", state: "closing", cost: "5", openedAt: new Date(NOW - 8 * HOUR) },
        { kind: "prediction", state: "won", cost: "5", payout: "9", openedAt: open, settledAt: settled },
        { kind: "perp", state: "closed", collateral: "5", proceeds: "6", openedAt: instant, settledAt: instant },
    ]);

    const { items: list } = await feed.page(accountId, {});

    const shape = list.map((item) => [item.kind, "part" in item ? item.part : null, keyOf(item).id, item.at]);
    expect(shape).toEqual([
        ["perp", "settle", same!.toHexString(), instant.toISOString()],
        ["perp", "open", same!.toHexString(), instant.toISOString()],
        ["prediction", "settle", won!.toHexString(), settled.toISOString()],
        ["prediction", "open", won!.toHexString(), open.toISOString()],
        ["prediction", "open", closing!.toHexString(), new Date(NOW - 8 * HOUR).toISOString()],
        ["prediction", "open", live!.toHexString(), new Date(NOW - 9 * HOUR).toISOString()],
    ]);
    const settleView = list[2]!;
    expect(settleView.kind === "prediction" && settleView.position.state).toBe("won");

    const split = await allPages(accountId, { limit: 1 });
    expect(items(split).map(keyOf).map(hexKey)).toEqual(list.map(keyOf).map(hexKey));
});

test("a partial sale is one sale item with soldPart and no open", async () => {
    const accountId = new ObjectId();
    const at = new Date(NOW - 3 * HOUR);
    const [id] = await seedRows(database.collections, accountId, [{ kind: "sale", cost: "6", proceeds: "5.76", at }]);

    const page = await feed.page(accountId, {});

    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    if (item?.kind !== "sale") throw new Error("not a sale");
    expect(item.at).toBe(at.toISOString());
    expect(item.order.id).toBe(id!.toHexString());
    expect(item.order.side).toBe("sell");
    expect(item.order.soldPart).toEqual({ costUSD: "6", proceedsUSD: "5.76", at: at.toISOString() });
});

test("a swap that was never sent and a failed withdrawal are absent", async () => {
    const accountId = new ObjectId();
    const [sent, , sending] = await seedRows(database.collections, accountId, [
        { kind: "swap", at: new Date(NOW - 5 * HOUR), state: "failed" },
        { kind: "swap", at: new Date(NOW - 4 * HOUR), sent: false },
        { kind: "withdrawal", usdc: "3", at: new Date(NOW - 3 * HOUR), state: "sending" },
        { kind: "withdrawal", usdc: "2", at: new Date(NOW - 2 * HOUR), state: "failed" },
    ]);

    const { items: list } = await feed.page(accountId, {});

    expect(list.map((item) => [item.kind, keyOf(item).id])).toEqual([
        ["withdrawal", sending!.toHexString()],
        ["swap", sent!.toHexString()],
    ]);
});

test("two deposit logs in one transaction split across two pages appear once each", async () => {
    const accountId = new ObjectId();
    const txHash = `0x${"c".repeat(64)}`;
    const at = new Date(NOW - HOUR);
    await seedRows(database.collections, accountId, [
        { kind: "deposit", usdc: "5", at, txHash, logIndex: 0 },
        { kind: "deposit", usdc: "7", at, txHash, logIndex: 1 },
    ]);

    const pages = await allPages(accountId, { limit: 1 });

    expect(sizes(pages)).toEqual([1, 1]);
    const deposits = items(pages).map((item) => (item.kind === "deposit" ? item.deposit : null));
    expect(deposits.every((deposit) => deposit?.txHash === txHash)).toBe(true);
    expect(new Set(deposits.map((deposit) => deposit!.id)).size).toBe(2);
    expect(deposits.map((deposit) => deposit!.logIndex).sort()).toEqual([0, 1]);
});

test("limit defaults to 50", async () => {
    const accountId = new ObjectId();
    await seedRows(
        database.collections,
        accountId,
        Array.from({ length: 60 }, (_, i) => ({ kind: "deposit", usdc: "1", at: slot(i) }) as const),
    );

    const page = await feed.page(accountId, {});

    expect(page.items).toHaveLength(50);
    expect(page.next).not.toBeNull();
});

test("one account never sees another account's rows", async () => {
    const mine = new ObjectId();
    const theirs = new ObjectId();
    await seedRows(database.collections, mine, [
        { kind: "deposit", usdc: "1", at: slot(1) },
        { kind: "sale", cost: "1", proceeds: "2", at: slot(2) },
    ]);
    await seedRows(database.collections, theirs, [
        { kind: "deposit", usdc: "1", at: slot(0) },
        { kind: "perp", state: "closed", collateral: "1", proceeds: "2", openedAt: slot(0), settledAt: slot(0) },
    ]);

    expect(sizes(await allPages(mine, {}))).toEqual([2]);
    expect(sizes(await allPages(theirs, {}))).toEqual([3]);
});

test("cursors round trip and keys order by time, then rank, then id", () => {
    const key: FeedKey = { atMs: 1_760_000_000_123, rank: 5, id: "507f1f77bcf86cd799439011" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
    expect(encodeCursor(key)).toBe("1760000000123:5:507f1f77bcf86cd799439011");

    const later: FeedKey = { ...key, atMs: key.atMs + 1, rank: 0, id: "000000000000000000000000" };
    const higherRank: FeedKey = { ...key, rank: 6, id: "000000000000000000000000" };
    const higherId: FeedKey = { ...key, id: "507f1f77bcf86cd799439012" };
    const sorted = [key, higherId, higherRank, later].sort(compareKeys);
    expect(sorted).toEqual([later, higherRank, higherId, key]);
    expect(compareKeys(key, { ...key })).toBe(0);
    for (const other of [later, higherRank, higherId]) {
        expect(compareKeys(key, other)).toBeGreaterThan(0);
        expect(compareKeys(other, key)).toBeLessThan(0);
    }
});

test("a garbled before is bad_request", async () => {
    const id = "a1".repeat(12);
    for (const before of [
        "x",
        `1:9:${id}`,
        `99999999999999999:0:${id}`,
        `9000000000000000:0:${id}`,
        "1:0:zzzzzzzzzzzzzzzzzzzzzzzz",
    ]) {
        const error = await feed.page(new ObjectId(), { before }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("bad_request");
        expect((error as AppError).message).toBe("Invalid before: a cursor from a previous page");
    }
});

test("a run logs pnl.feed with ms and a count per source", async () => {
    const accountId = new ObjectId();
    await seedRows(database.collections, accountId, [
        { kind: "deposit", usdc: "5", at: slot(0) },
        { kind: "deposit", usdc: "5", at: slot(1) },
        { kind: "withdrawal", usdc: "1", at: slot(2) },
        { kind: "swap", at: slot(3) },
        { kind: "prediction", state: "won", cost: "1", payout: "2", openedAt: slot(4), settledAt: slot(3) },
        { kind: "sale", cost: "1", proceeds: "2", at: slot(5) },
        { kind: "perp", state: "closed", collateral: "1", proceeds: "2", openedAt: slot(6), settledAt: slot(5) },
    ]);

    await feed.page(accountId, {});
    await feed.page(accountId, { filter: "deposits" });

    const mine = lines.filter((line) => line.msg === "pnl.feed" && line.accountId === accountId.toHexString());
    expect(mine).toHaveLength(2);
    expect(mine[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(mine[0]!.rows).toEqual({
        deposits: 2,
        withdrawals: 1,
        swaps: 1,
        predictionOpens: 1,
        predictionSettles: 1,
        sales: 1,
        perpOpens: 1,
        perpSettles: 1,
        trades: 0,
    });
    expect(mine[1]!.rows).toMatchObject({ deposits: 2, withdrawals: 1, swaps: 0, perpSettles: 0 });
});

test("a buy from the balance is a trades row with its fill", async () => {
    const accountId = new ObjectId();
    await seedRows(database.collections, accountId, [{ kind: "deposit", usdc: "5", at: slot(1) }]);
    const { insertedId } = await database.collections.trades.insertOne({
        _id: new ObjectId(),
        accountId,
        requestId: randomUUID(),
        verb: "buy",
        symbol: "BNB",
        toSymbol: null,
        paidSymbol: "USDC",
        paidUnits: Decimal128.fromString("1"),
        gotSymbol: "BNB",
        gotUnits: Decimal128.fromString("0.002"),
        usd: Decimal128.fromString("1"),
        priceUSD: "500",
        toPriceUSD: null,
        hedged: false,
        createdAt: slot(0),
    });

    const all = await feed.page(accountId, {});
    const onlyTrades = await feed.page(accountId, { filter: "trades" });
    const onlyCash = await feed.page(accountId, { filter: "deposits" });

    expect(all.items.map((item) => item.kind)).toEqual(["trade", "deposit"]);
    expect(onlyTrades.items).toEqual([
        expect.objectContaining({
            kind: "trade",
            trade: expect.objectContaining({ id: insertedId.toHexString(), gotSymbol: "BNB", gotUnits: "0.002" }),
        }),
    ]);
    expect(onlyCash.items.map((item) => item.kind)).toEqual(["deposit"]);
});
