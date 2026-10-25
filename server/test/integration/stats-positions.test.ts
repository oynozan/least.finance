import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { positionsPage } from "../../src/stats/positions.ts";
import { toUnitsDecimal } from "../../src/trading/units.ts";
import { startStack, type Stack } from "../support/stack.ts";

const open: Database[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
});

const E6 = 10n ** 6n;
const WEI = 10n ** 18n;
const T0 = Date.UTC(2026, 9, 1);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const alice = new ObjectId("aaaaaaaaaaaaaaaaaaa1a2b3");
const bob = new ObjectId("bbbbbbbbbbbbbbbbbbbbc4d5");

async function fresh() {
    const database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    open.push(database);
    return database.collections;
}

const prediction = (minutes: number, over: Record<string, unknown> = {}) =>
    ({
        _id: new ObjectId(),
        accountId: alice,
        eventId: "e1",
        marketId: "m1",
        tokenId: "t1",
        conditionId: "c1",
        question: "Will it rain?",
        outcome: "Yes",
        shares: toDecimal(10n * E6),
        cost: toDecimal(4n * WEI),
        state: "open",
        proceeds: null,
        payout: null,
        openedAt: at(minutes),
        settledAt: null,
        updatedAt: at(minutes),
        ...over,
    }) as never;

const perp = (minutes: number, over: Record<string, unknown> = {}) =>
    ({
        _id: new ObjectId(),
        accountId: bob,
        index: 1,
        asset: "BTC",
        side: "long",
        leverage: 5,
        sizeCoin: "0.5",
        entryPx: "100",
        collateral: toDecimal(10n * WEI),
        openedFee: toDecimal(0n),
        state: "open",
        active: true,
        proceeds: null,
        realizedPnl: null,
        closeReason: null,
        snapshot: {
            markPx: "1",
            unrealizedPnlE6: toDecimal(3n * E6),
            liquidationPx: null,
            cumFundingE6: toDecimal(0n),
            at: at(minutes),
        },
        openedAt: at(minutes),
        settledAt: null,
        updatedAt: at(minutes),
        ...over,
    }) as never;

const holding = (minutes: number, symbol: string, whole: bigint) =>
    ({
        _id: new ObjectId(),
        accountId: alice,
        symbol,
        units: toUnitsDecimal(whole * WEI),
        network: "ethereum",
        updatedAt: at(minutes),
    }) as never;

const deps = (collections: Awaited<ReturnType<typeof fresh>>, bid: number | null = 0.5) => ({
    collections,
    outcomeBid: async () => bid,
    priceOf: (symbol: string) => ({ ETH: 2 })[symbol] ?? null,
});
const all = { page: 1, state: "all", kind: "all" } as const;

test("the merge is newest first across the three kinds", async () => {
    const c = await fresh();
    await c.positions.insertOne(prediction(1));
    await c.perpPositions.insertOne(perp(3));
    await c.holdings.insertOne(holding(2, "ETH", 1n));
    const page = await positionsPage(deps(c), all);
    expect(page.items.map((i) => i.kind)).toEqual(["perp", "coin", "prediction"]);
    expect(page).toMatchObject({ page: 1, pages: 1, total: 3 });
});

test("each filter returns its own count and total", async () => {
    const c = await fresh();
    await c.positions.insertMany([
        prediction(1),
        prediction(2, { state: "won", payout: toDecimal(10n * WEI), settledAt: at(5) }),
    ]);
    await c.perpPositions.insertMany([
        perp(3),
        perp(4, { state: "closed", active: false, proceeds: toDecimal(12n * WEI), settledAt: at(6) }),
    ]);
    await c.holdings.insertMany([holding(5, "ETH", 1n), holding(6, "BTC", 0n)]);
    const count = async (state: "all" | "open" | "closed", kind: "all" | "predictions" | "perps" | "coins") =>
        (await positionsPage(deps(c), { page: 1, state, kind })).total;
    expect(await count("all", "all")).toBe(5);
    expect(await count("open", "all")).toBe(3);
    expect(await count("closed", "all")).toBe(2);
    expect(await count("all", "predictions")).toBe(2);
    expect(await count("all", "perps")).toBe(2);
    expect(await count("all", "coins")).toBe(1);
    expect(await count("closed", "coins")).toBe(0);
    expect(await count("open", "perps")).toBe(1);
});

test("page 2 continues page 1 with no overlap and no gap", async () => {
    const c = await fresh();
    await c.positions.insertMany(Array.from({ length: 15 }, (_, i) => prediction(i * 3, { tokenId: `t${i}` })));
    await c.perpPositions.insertMany(Array.from({ length: 15 }, (_, i) => perp(i * 3 + 1, { index: i + 10 })));
    await c.holdings.insertMany(Array.from({ length: 5 }, (_, i) => holding(i * 3 + 2, `C${i}`, 1n)));
    const one = await positionsPage(deps(c), { ...all, page: 1 });
    const two = await positionsPage(deps(c), { ...all, page: 2 });
    const past = await positionsPage(deps(c), { ...all, page: 3 });
    expect(one).toMatchObject({ pages: 2, total: 35 });
    expect(one.items).toHaveLength(20);
    expect(two.items).toHaveLength(15);
    expect(past.items).toEqual([]);
    expect(past.pages).toBe(2);
    const times = [...one.items, ...two.items].map((i) => Date.parse(i.openedAt));
    expect(new Set([...one.items, ...two.items].map((i) => i.id)).size).toBe(35);
    expect(times).toEqual([...times].sort((a, b) => b - a));
});

test("an empty table is one empty page", async () => {
    const c = await fresh();
    expect(await positionsPage(deps(c), all)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
});

test("a prediction whose bid is unknown has a null value and PnL", async () => {
    const c = await fresh();
    await c.positions.insertOne(prediction(1));
    const [row] = (await positionsPage(deps(c, null), all)).items;
    expect(row).toMatchObject({
        valueUsd: null,
        pnlUsd: null,
        title: "Yes",
        detail: "Will it rain?",
        size: "10 shares",
    });
});

test("an open prediction is shares times the best bid, and its PnL is value minus cost", async () => {
    const c = await fresh();
    await c.positions.insertOne(prediction(1));
    const [row] = (await positionsPage(deps(c, 0.5), all)).items;
    expect(row).toMatchObject({ valueUsd: "5", pnlUsd: "1", state: "open", closedAt: null });
});

test("closed predictions: won is payout minus cost, lost is minus cost, closed is proceeds minus cost", async () => {
    const c = await fresh();
    await c.positions.insertMany([
        prediction(1, { state: "won", payout: toDecimal(10n * WEI), settledAt: at(9) }),
        prediction(2, { state: "lost", settledAt: at(9) }),
        prediction(3, { state: "closed", proceeds: toDecimal(3n * WEI), settledAt: at(9) }),
    ]);
    const items = (await positionsPage(deps(c), all)).items;
    const by = Object.fromEntries(items.map((i) => [i.state, i]));
    expect(by.won).toMatchObject({ pnlUsd: "6", valueUsd: "10", closedAt: at(9).toISOString() });
    expect(by.lost).toMatchObject({ pnlUsd: "-4", valueUsd: "0" });
    expect(by.closed).toMatchObject({ pnlUsd: "-1", valueUsd: "3" });
});

test("an open perp's value and PnL come from its snapshot", async () => {
    const c = await fresh();
    await c.perpPositions.insertOne(perp(1));
    const [row] = (await positionsPage(deps(c), all)).items;
    expect(row).toMatchObject({ title: "BTC long 5x", size: "0.5 BTC", valueUsd: "13", pnlUsd: "3", state: "open" });
});

test("a closed perp's PnL is proceeds minus collateral", async () => {
    const c = await fresh();
    await c.perpPositions.insertOne(
        perp(1, { state: "liquidated", active: false, proceeds: toDecimal(4n * WEI), settledAt: at(3) }),
    );
    const [row] = (await positionsPage(deps(c), all)).items;
    expect(row).toMatchObject({ pnlUsd: "-6", valueUsd: "4", state: "liquidated" });
});

test("a coin is units times price, with no PnL, and an unpriced coin has a null value", async () => {
    const c = await fresh();
    await c.holdings.insertMany([holding(1, "ETH", 3n), holding(2, "ZZZ", 1n)]);
    const items = (await positionsPage(deps(c), all)).items;
    expect(items.find((i) => i.title === "ETH")).toMatchObject({
        kind: "coin",
        size: "3 ETH",
        valueUsd: "6",
        pnlUsd: null,
        state: "open",
        closedAt: null,
    });
    expect(items.find((i) => i.title === "ZZZ")).toMatchObject({ valueUsd: null });
});

test("the account code is the last 6 hex of the account id", async () => {
    const c = await fresh();
    await c.positions.insertOne(prediction(1));
    await c.perpPositions.insertOne(perp(2));
    const items = (await positionsPage(deps(c), all)).items;
    expect(items.map((i) => i.account)).toEqual(["bbc4d5", "a1a2b3"]);
});

let s: Stack;
beforeAll(async () => {
    s = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(async () => {
    await s.stop();
});

test("GET /stats/positions serves a page and refuses bad input", async () => {
    const ok = await fetch(`${s.url}/stats/positions`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ page: 1, pages: expect.any(Number), items: expect.any(Array) });
    expect((await fetch(`${s.url}/stats/positions?page=500&state=closed&kind=perps`)).status).toBe(200);
    for (const bad of ["page=0", "page=501", "page=x", "page=1.5", "kind=x", "state=x"]) {
        const response = await fetch(`${s.url}/stats/positions?${bad}`);
        expect(response.status, bad).toBe(400);
        expect(((await response.json()) as any).error.code).toBe("bad_request");
    }
});
