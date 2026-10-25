import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import type { HeldReaders, HeldWallet } from "../../src/stats/held.ts";
import { pnlPoints } from "../../src/stats/pnl.ts";
import { toDecimal } from "../../src/db/money.ts";
import { DEPOSITS_EVERY_REFRESH_MAX_ACCOUNTS, DEPOSITS_REFRESH_MS, StatsService } from "../../src/stats/stats.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let database: Database;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
});
afterAll(async () => {
    await database.close();
});

const wallet = (id: HeldWallet["id"], usd: number, error: string | null = null): HeldWallet => ({
    id,
    label: id,
    network: "X",
    address: null,
    usd,
    parts: usd ? [{ symbol: "USDC", amount: String(usd), usd }] : [],
    error,
});
const readers = (table: Partial<Record<HeldWallet["id"], () => Promise<HeldWallet>>> = {}): HeldReaders => ({
    treasury: async () => wallet("treasury", 100),
    deposits: async () => wallet("deposits", 20),
    pool: async () => wallet("pool", 10),
    hyperliquid: async () => wallet("hyperliquid", 5),
    inventoryEvm: async () => wallet("inventoryEvm", 0),
    inventorySolana: async () => wallet("inventorySolana", 0),
    transit: async () => wallet("transit", 0),
    ...table,
});
const fees = { totalUsd: 1, spreadUsd: 1, perpUsd: 0 };

type Extra = Partial<ConstructorParameters<typeof StatsService>[0]>;
function service(r: HeldReaders, clock: { now: number }, extra: Extra = {}) {
    return new StatsService({
        collections: database.collections,
        readers: r,
        readOwed: async () => ({ lines: [{ id: "cash", label: "People's cash", usd: 50 }], unpriced: [] }),
        readFees: async () => ({ "7D": fees, "30D": fees, All: fees }),
        logger: pino({ level: "silent" }),
        now: () => clock.now,
        ...extra,
    });
}

test("a refresh gives the held, owed and equity", async () => {
    const stats = service(readers(), { now: Date.UTC(2026, 0, 1, 10, 5) });
    expect(stats.view()).toBeNull();
    await stats.refresh();
    const view = stats.view()!;
    expect(view).toMatchObject({ heldUsd: "135", owedUsd: "50", equityUsd: "85", estimated: false });
    expect(view.wallets).toHaveLength(7);
    expect(view.fees["7D"].totalUsd).toBe("1");
});

test("a failing reader keeps the last value and marks the snapshot estimated", async () => {
    let fail = false;
    const clock = { now: Date.UTC(2026, 0, 2, 10, 5) };
    const stats = service(
        readers({ treasury: async () => (fail ? wallet("treasury", 0, "boom") : wallet("treasury", 100)) }),
        clock,
    );
    await stats.refresh();
    const good = stats.view()!.wallets.find((w) => w.id === "treasury")!;
    fail = true;
    clock.now += 60_000;
    await stats.refresh();
    const view = stats.view()!;
    const kept = view.wallets.find((w) => w.id === "treasury")!;
    expect(kept).toMatchObject({ usd: "100", error: "boom", readAt: good.readAt });
    expect(view.estimated).toBe(true);
    expect(view.heldUsd).toBe("135");

    // The next hour's record is the estimated one.
    clock.now += HOUR;
    await stats.refresh();
    const row = await database.collections.statsSnapshots.findOne({
        at: new Date(Math.floor(clock.now / HOUR) * HOUR),
    });
    expect(row).toMatchObject({ estimated: true, heldUsd: 135, equityUsd: 85 });
});

test("one snapshot per hour, even across a restart", async () => {
    const clock = { now: Date.UTC(2026, 0, 3, 10, 5) };
    const { statsSnapshots } = database.collections;
    const from = new Date(Date.UTC(2026, 0, 3));
    const count = () => statsSnapshots.countDocuments({ at: { $gte: from, $lt: new Date(from.getTime() + DAY) } });
    const first = service(readers(), clock);
    await first.refresh();
    clock.now += 60_000;
    await first.refresh();
    await service(readers(), clock).refresh();
    expect(await count()).toBe(1);
    clock.now += HOUR;
    await first.refresh();
    expect(await count()).toBe(2);
});

test("a reader that never answers times out, and the others still make the snapshot", async () => {
    const clock = { now: Date.UTC(2026, 0, 4, 10, 5) };
    const stats = service(readers({ pool: () => new Promise<HeldWallet>(() => undefined) }), clock, {
        readTimeoutMs: 50,
    });
    const first = stats.refresh();
    // A refresh already running is joined, not stacked.
    expect(stats.refresh()).toBe(first);
    await first;
    const view = stats.view()!;
    expect(view.wallets.find((w) => w.id === "pool")).toMatchObject({ usd: "0" });
    expect(view.wallets.find((w) => w.id === "pool")!.error).toMatch(/^Timed out after/);
    expect(view.estimated).toBe(true);
    expect(view.heldUsd).toBe("125");
    expect(
        await database.collections.statsSnapshots.countDocuments({ at: new Date(Math.floor(clock.now / HOUR) * HOUR) }),
    ).toBe(1);
});

const snap = (at: number, equityUsd: number) => ({ at: new Date(at), equityUsd });

test("pnlPoints: 7D is hourly and 30D is every four hours", () => {
    const now = Date.UTC(2026, 0, 31, 12);
    const rows = Array.from({ length: 24 * 40 }, (_, i) => snap(now - i * HOUR, 1000 - i));
    const week = pnlPoints(rows, "7D", now);
    expect(week.points).toHaveLength(7 * 24 + 1);
    expect(week.points.at(-1)).toEqual({ at: new Date(now).toISOString(), equityUsd: "1000" });
    expect(week.changeUsd).toBe("168");
    const month = pnlPoints(rows, "30D", now);
    expect(month.points.length).toBeLessThanOrEqual(30 * 6 + 1);
    expect(month.points.length).toBeGreaterThan(170);
    for (const p of month.points.slice(0, -1)) expect(new Date(p.at).getUTCHours() % 4).toBe(3);
});

test("pnlPoints: All is daily, capped at 200 points, and keeps the newest", () => {
    const now = Date.UTC(2026, 6, 1, 12);
    const rows = Array.from({ length: 24 * 500 }, (_, i) => snap(now - i * HOUR, 5000 - i));
    const all = pnlPoints(rows, "All", now);
    expect(all.points.length).toBeLessThanOrEqual(200);
    expect(all.points.at(-1)!.at).toBe(new Date(now).toISOString());
    expect(pnlPoints([], "All", now)).toEqual({ range: "All", points: [], changeUsd: "0" });
    expect(pnlPoints([snap(Date.UTC(2026, 0, 1, 23), 1), snap(Date.UTC(2026, 0, 1, 5), 2)], "All", now).points).toEqual(
        [{ at: new Date(Date.UTC(2026, 0, 1, 23)).toISOString(), equityUsd: "1" }],
    );
});

test("a first read that fails shows the wallet's real label and network, and a complete read replaces the estimated hour", async () => {
    const clock = { now: Date.UTC(2026, 0, 5, 10, 5) };
    let fail = true;
    const stats = service(
        readers({
            hyperliquid: async () => {
                if (fail) throw new Error("down");
                return wallet("hyperliquid", 5);
            },
        }),
        clock,
    );
    await stats.refresh();
    const first = stats.view()!.wallets.find((w) => w.id === "hyperliquid")!;
    expect(first).toMatchObject({
        label: "Hyperliquid float",
        network: "Hyperliquid",
        usd: "0",
        error: "down",
        readAt: null,
    });
    const at = new Date(Math.floor(clock.now / HOUR) * HOUR);
    const { statsSnapshots } = database.collections;
    expect(await statsSnapshots.findOne({ at })).toMatchObject({ estimated: true, heldUsd: 130 });

    fail = false;
    clock.now += 60_000;
    await stats.refresh();
    expect(await statsSnapshots.countDocuments({ at })).toBe(1);
    expect(await statsSnapshots.findOne({ at })).toMatchObject({ estimated: false, heldUsd: 135, equityUsd: 85 });

    // The hour is done: a later failure leaves the complete record alone.
    fail = true;
    clock.now += 60_000;
    await stats.refresh();
    expect(await statsSnapshots.findOne({ at })).toMatchObject({ estimated: false, heldUsd: 135 });
});

const hourAt = (now: number) => new Date(Math.floor(now / HOUR) * HOUR);

test("a wallet with an earlier good read keeps its value on a timeout, and the hour's record is estimated", async () => {
    const clock = { now: Date.UTC(2026, 0, 6, 10, 5) };
    let hang = false;
    const stats = service(
        readers({ pool: () => (hang ? new Promise<HeldWallet>(() => undefined) : Promise.resolve(wallet("pool", 10))) }),
        clock,
        { readTimeoutMs: 50 },
    );
    await stats.refresh();
    const good = stats.view()!.wallets.find((w) => w.id === "pool")!;
    expect(stats.view()!.estimated).toBe(false);
    hang = true;
    clock.now += HOUR;
    await stats.refresh();
    const view = stats.view()!;
    const kept = view.wallets.find((w) => w.id === "pool")!;
    expect(kept).toMatchObject({ usd: "10", readAt: good.readAt });
    expect(kept.error).toMatch(/^Timed out after/);
    expect(view.estimated).toBe(true);
    expect(await database.collections.statsSnapshots.findOne({ at: hourAt(clock.now) })).toMatchObject({
        estimated: true,
        heldUsd: 135,
    });
});

test("the timer doesn't tick again until the previous run has ended", async () => {
    const starts: number[] = [];
    const stats = service(
        readers({
            pool: async () => {
                starts.push(Date.now());
                await new Promise((resolve) => setTimeout(resolve, 100));
                return wallet("pool", 10);
            },
        }),
        { now: Date.UTC(2026, 0, 7, 10, 5) },
        { refreshMs: 100 },
    );
    stats.start();
    for (let waited = 0; starts.length < 3 && waited < 8000; waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
    await stats.stop();
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(190);
});

test("a fresh service, like a restart, replaces an estimated snapshot of the hour with a complete read", async () => {
    const clock = { now: Date.UTC(2026, 0, 8, 10, 5) };
    const down = service(
        readers({
            hyperliquid: async () => {
                throw new Error("down");
            },
        }),
        clock,
    );
    await down.refresh();
    const { statsSnapshots } = database.collections;
    expect(await statsSnapshots.findOne({ at: hourAt(clock.now) })).toMatchObject({ estimated: true, heldUsd: 130 });
    clock.now += 60_000;
    await service(readers(), clock).refresh();
    expect(await statsSnapshots.countDocuments({ at: hourAt(clock.now) })).toBe(1);
    expect(await statsSnapshots.findOne({ at: hourAt(clock.now) })).toMatchObject({ estimated: false, heldUsd: 135 });
});

test("a held coin with no price makes the view and the snapshot estimated", async () => {
    const clock = { now: Date.UTC(2026, 0, 9, 10, 5) };
    const stats = service(
        readers({
            inventoryEvm: async () => ({
                ...wallet("inventoryEvm", 0),
                parts: [{ symbol: "ZZZ", amount: "3", usd: null }],
            }),
        }),
        clock,
    );
    await stats.refresh();
    expect(stats.view()!.estimated).toBe(true);
    expect(await database.collections.statsSnapshots.findOne({ at: hourAt(clock.now) })).toMatchObject({
        estimated: true,
    });
});

test("a wallet that is not set up is a fact, not an estimate", async () => {
    const stats = service(
        readers({ pool: async () => wallet("pool", 0, "Not set up") }),
        { now: Date.UTC(2026, 0, 10, 10, 5) },
    );
    await stats.refresh();
    expect(stats.view()!.estimated).toBe(false);
});

test("owed or fees reused after a later failure make the view estimated", async () => {
    for (const broken of ["owed", "fees"] as const) {
        let fail = false;
        const clock = { now: Date.UTC(2026, 0, 11, 10, 5) };
        const stats = new StatsService({
            collections: database.collections,
            readers: readers(),
            readOwed: async () => {
                if (fail && broken === "owed") throw new Error("mongo");
                return { lines: [{ id: "cash", label: "People's cash", usd: 50 }], unpriced: [] };
            },
            readFees: async () => {
                if (fail && broken === "fees") throw new Error("mongo");
                return { "7D": fees, "30D": fees, All: fees };
            },
            logger: pino({ level: "silent" }),
            now: () => clock.now,
        });
        await stats.refresh();
        expect(stats.view()!.estimated).toBe(false);
        fail = true;
        clock.now += 60_000;
        await stats.refresh();
        expect(stats.view()!).toMatchObject({ estimated: true, owedUsd: "50" });
        fail = false;
        clock.now += 60_000;
        await stats.refresh();
        expect(stats.view()!.estimated).toBe(false);
    }
});

test("a reader that throws at once, before returning a promise, doesn't sink the refresh", async () => {
    const stats = service(
        {
            ...readers(),
            pool: () => {
                throw new Error("sync boom");
            },
        },
        { now: Date.UTC(2026, 0, 12, 10, 5) },
    );
    await stats.refresh();
    const view = stats.view()!;
    expect(view.wallets.find((w) => w.id === "pool")).toMatchObject({ error: "sync boom", usd: "0" });
    expect(view.estimated).toBe(true);
});

test("a reader that never resolves is called once across several refreshes", async () => {
    const clock = { now: Date.UTC(2026, 0, 13, 10, 5) };
    let calls = 0;
    const stats = service(
        readers({
            pool: () => {
                calls++;
                return new Promise<HeldWallet>(() => undefined);
            },
        }),
        clock,
        { readTimeoutMs: 30 },
    );
    for (let i = 0; i < 4; i++) {
        await stats.refresh();
        clock.now += 60_000;
    }
    expect(calls).toBe(1);
    expect(stats.view()!.wallets.find((w) => w.id === "pool")!.error).toMatch(/^Timed out after/);
});

test("deposits are read on every refresh with few accounts", async () => {
    const clock = { now: Date.UTC(2026, 0, 14, 10, 5) };
    let calls = 0;
    const stats = service(
        readers({
            deposits: async () => {
                calls++;
                return wallet("deposits", 20);
            },
        }),
        clock,
    );
    for (let i = 0; i < 3; i++) {
        await stats.refresh();
        clock.now += 60_000;
    }
    expect(calls).toBe(3);
});

test("with many accounts the deposits are read every 10 minutes", async () => {
    const big = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    try {
        const at = new Date();
        await big.collections.accounts.insertMany(
            Array.from({ length: DEPOSITS_EVERY_REFRESH_MAX_ACCOUNTS + 1 }, (_, i) => ({
                _id: new ObjectId(),
                privyUserId: `did:privy:${i}`,
                depositIndex: i + 1,
                depositAddress: `0x${i.toString(16).padStart(40, "0")}`,
                balance: toDecimal(0n),
                version: 0,
                openedAtBlock: 0,
                createdAt: at,
                updatedAt: at,
            })),
        );
        const clock = { now: Date.UTC(2026, 0, 15, 10, 5) };
        let calls = 0;
        const stats = new StatsService({
            collections: big.collections,
            readers: readers({
                deposits: async () => {
                    calls++;
                    return wallet("deposits", 20);
                },
            }),
            readOwed: async () => ({ lines: [], unpriced: [] }),
            readFees: async () => ({ "7D": fees, "30D": fees, All: fees }),
            logger: pino({ level: "silent" }),
            now: () => clock.now,
        });
        for (let i = 0; i < 3; i++) {
            await stats.refresh();
            clock.now += 60_000;
        }
        expect(calls).toBe(1);
        clock.now += DEPOSITS_REFRESH_MS;
        await stats.refresh();
        expect(calls).toBe(2);
    } finally {
        await big.close();
    }
});

test("a failed deposits read waits 10 minutes before the next try, even with few accounts", async () => {
    const clock = { now: Date.UTC(2026, 0, 16, 10, 5) };
    let calls = 0;
    const stats = service(
        readers({
            deposits: async () => {
                calls++;
                throw new Error("rpc down");
            },
        }),
        clock,
    );
    for (let i = 0; i < 5; i++) {
        await stats.refresh();
        clock.now += 60_000;
    }
    expect(calls).toBe(1);
    expect(stats.view()!.estimated).toBe(true);
    clock.now += DEPOSITS_REFRESH_MS;
    await stats.refresh();
    expect(calls).toBe(2);
});
