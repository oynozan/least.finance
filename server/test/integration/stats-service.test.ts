import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import type { HeldReaders, HeldWallet } from "../../src/stats/held.ts";
import { pnlPoints } from "../../src/stats/pnl.ts";
import { StatsService } from "../../src/stats/stats.ts";

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

function service(r: HeldReaders, clock: { now: number }, extra: { readTimeoutMs?: number } = {}) {
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
    expect(view.wallets.find((w) => w.id === "pool")).toMatchObject({ usd: "0", error: "Timed out after 0 s" });
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
