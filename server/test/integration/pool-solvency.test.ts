import { pino } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { PoolDirection, PoolRebalanceDoc, PoolRebalanceState } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { PerpReconciler } from "../../src/perps/reconciler.ts";
import { poolAssets } from "../../src/predictions/pool-assets.ts";
import { FakeTrader } from "../support/fake-trader.ts";
import { e6, perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";
import { poolRebalanceRow } from "../support/pool-rebalance-row.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(open.splice(0).map((h) => h.close()));
});

const HOUR = 3_600_000;
const EMPTY_BOOK = { bids: [], asks: [], tickSize: 0.01, minOrderSize: 5, negRisk: false };
type Line = { level: number; msg: string } & Record<string, unknown>;

/** A perp harness whose master holds $500 on Hyperliquid, a pool trader, a clock and a pool-assets reader with its own log. */
async function world(o: { withTrader?: boolean } = {}) {
    const h = await perpHarness();
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    await h.fundMaster("500");
    const clock = { t: Date.now() };
    const trader = new FakeTrader({ bookOf: () => EMPTY_BOOK });
    const poolLines: Line[] = [];
    const assets = poolAssets({
        collections: h.database.collections,
        trader: () => (o.withTrader === false ? null : trader),
        now: () => clock.t,
        logger: pino({ level: "info" }, { write: (line: string) => void poolLines.push(JSON.parse(line)) }),
    });
    return { h, clock, trader, poolLines, assets };
}

type World = Awaited<ReturnType<typeof world>>;

/** Writes the pool's float document: the figures in dollars, read `ageMs` before the world's clock. */
async function setFloat(w: World, o: { balance: string; held?: string; unread?: string; ageMs?: number }) {
    const at = new Date(w.clock.t - (o.ageMs ?? 0));
    await w.h.database.collections.poolFloat.replaceOne(
        { _id: "polygon" },
        {
            balanceE6: toDecimal(e6(o.balance)),
            balanceAt: at,
            heldE6: toDecimal(e6(o.held ?? "0")),
            unreadFillsE6: toDecimal(e6(o.unread ?? "0")),
            updatedAt: at,
        },
        { upsert: true },
    );
}

/** Inserts a pool move row in `state`, entered `ageMs` before the world's clock; amounts are dollars, and no row takes the one-active slot. */
async function insertRow(
    w: World,
    o: {
        direction: PoolDirection;
        state: PoolRebalanceState;
        amount: string;
        maxFee?: string;
        reserved?: string;
        ageMs?: number;
        kind?: PoolRebalanceDoc["kind"];
    },
) {
    const at = new Date(w.clock.t - (o.ageMs ?? 0));
    const base = poolRebalanceRow({ kind: o.kind ?? "move", now: at });
    const row: PoolRebalanceDoc = {
        ...base,
        direction: o.kind === "wrap_idle" ? null : o.direction,
        state: o.state,
        amountE6: toDecimal(e6(o.amount)),
        maxFeeE6: toDecimal(e6(o.maxFee ?? "0")),
        reservedE6: toDecimal(e6(o.reserved ?? "0")),
    };
    await w.h.database.collections.poolRebalances.insertOne(row);
    return row;
}

/** A reconciler whose Arc side holds `arcUsdc` dollars; its own log lines are returned beside it. */
function reconciler(h: PerpHarness, arcUsdc: string, assets?: () => Promise<{ assetsE6: bigint; stale: boolean }>) {
    const lines: Line[] = [];
    const rec = new PerpReconciler({
        collections: h.database.collections,
        client: h.client,
        keyring: h.keyring,
        logger: pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) }),
        config: { PERPS_RECONCILE_TOLERANCE_USD: 5 },
        arcAssets: async () => wei(arcUsdc),
        withIndexLock: (index, fn) => h.service.withIndexLock(index, fn),
        ...(assets && { poolAssets: assets }),
    });
    return { rec, lines };
}

const SHORTFALL = "Solvency shortfall: the assets don't cover what people are owed";
const shortfallLines = (lines: Line[]) => lines.filter((line) => line.msg === SHORTFALL);

test("a failing idle-USDC read counts zero and marks the answer stale, so the shortfall is a warn", async () => {
    const w = await world();
    await setFloat(w, { balance: "50" });
    vi.spyOn(w.trader, "usdcBalanceE6").mockRejectedValue(new Error("Polygon RPC is down"));
    await w.h.seedAccount("1000");
    const { rec, lines } = reconciler(w.h, "400", w.assets);

    expect(await w.assets()).toEqual({ assetsE6: e6("50"), stale: true });
    const report = await rec.run();

    expect(report.shortfallE6).toBe(e6("50"));
    expect(shortfallLines(lines).map((line) => line.level)).toEqual([40]);
    expect(lines.filter((line) => line.level >= 50)).toEqual([]);
});

test("an arc_to_polygon row in forwarding counts as an asset", async () => {
    const w = await world();
    await insertRow(w, { direction: "arc_to_polygon", state: "forwarding", amount: "60", maxFee: "0.2", ageMs: 1000 });

    expect(await w.assets()).toEqual({ assetsE6: e6("59.8"), stale: false });
});

test("a polygon_to_arc forwarding row counts too", async () => {
    const w = await world();
    await insertRow(w, { direction: "polygon_to_arc", state: "forwarding", amount: "40", maxFee: "0.1", ageMs: 1000 });

    expect(await w.assets()).toEqual({ assetsE6: e6("39.9"), stale: false });
});

test("a forwarding row over an hour old isn't counted and logs an error", async () => {
    const w = await world();
    await insertRow(w, {
        direction: "arc_to_polygon",
        state: "forwarding",
        amount: "60",
        maxFee: "0.2",
        ageMs: HOUR + 1,
    });
    await insertRow(w, {
        direction: "polygon_to_arc",
        state: "forwarding",
        amount: "40",
        maxFee: "0.1",
        ageMs: HOUR - 1,
    });

    expect(await w.assets()).toEqual({ assetsE6: e6("39.9"), stale: false });
    const errors = w.poolLines.filter((line) => line.level >= 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ direction: "arc_to_polygon", amountUSD: "60" });
});

test("an overdue forwarding row logs its error once an hour, however often the check runs", async () => {
    const w = await world();
    await insertRow(w, { direction: "arc_to_polygon", state: "forwarding", amount: "60", ageMs: HOUR + 1 });

    await w.assets();
    await w.assets();
    expect(w.poolLines.filter((line) => line.level >= 50)).toHaveLength(1);

    w.clock.t += HOUR;
    await w.assets();
    expect(w.poolLines.filter((line) => line.level >= 50)).toHaveLength(2);
});

test("a submitting drain counts its reservation", async () => {
    const w = await world();
    await insertRow(w, {
        direction: "polygon_to_arc",
        state: "submitting",
        amount: "50",
        maxFee: "0.1",
        reserved: "50",
    });

    expect(await w.assets()).toEqual({ assetsE6: e6("50"), stale: false });
});

test("a submitting drain counts the reservation it holds, not its amount", async () => {
    const w = await world();
    await insertRow(w, { direction: "polygon_to_arc", state: "submitting", amount: "50", reserved: "0" });

    expect((await w.assets()).assetsE6).toBe(0n);
});

test("idle native USDC counts", async () => {
    const w = await world();
    w.trader.setUsdc(e6("7.5"));

    expect(await w.assets()).toEqual({ assetsE6: e6("7.5"), stale: false });
});

test("without a trader the idle USDC counts zero and the answer is not stale", async () => {
    const w = await world({ withTrader: false });
    await setFloat(w, { balance: "20" });

    expect(await w.assets()).toEqual({ assetsE6: e6("20"), stale: false });
});

test("a wrapping top-up adds nothing beyond the idle USDC", async () => {
    const w = await world();
    await insertRow(w, { direction: "arc_to_polygon", state: "wrapping", amount: "60", maxFee: "0.2" });
    w.trader.setUsdc(e6("59.8"));

    expect(await w.assets()).toEqual({ assetsE6: e6("59.8"), stale: false });
});

test("a wrapping top-up whose USDC is already wrapped counts nothing here", async () => {
    const w = await world();
    await insertRow(w, { direction: "arc_to_polygon", state: "wrapping", amount: "60", maxFee: "0.2" });

    expect((await w.assets()).assetsE6).toBe(0n);
});

test("rows that hold no money in flight add nothing", async () => {
    const w = await world();
    for (const state of ["queued", "sending", "done", "failed", "stuck"] as const) {
        await insertRow(w, { direction: "arc_to_polygon", state, amount: "50", maxFee: "0.1", reserved: "50" });
        await insertRow(w, { direction: "polygon_to_arc", state, amount: "50", maxFee: "0.1", reserved: "50" });
    }
    await insertRow(w, { direction: "arc_to_polygon", state: "submitting", amount: "50", reserved: "50", ageMs: 1000 });
    await insertRow(w, { direction: "arc_to_polygon", state: "wrapping", amount: "0", kind: "wrap_idle" });

    expect((await w.assets()).assetsE6).toBe(0n);
});

test("the gross balance isn't counted, only free float", async () => {
    const w = await world();
    await setFloat(w, { balance: "100", held: "30", unread: "20" });

    expect(await w.assets()).toEqual({ assetsE6: e6("50"), stale: false });
});

test("a free float below zero counts zero", async () => {
    const w = await world();
    await setFloat(w, { balance: "10", held: "30", unread: "5" });
    w.trader.setUsdc(e6("3"));

    expect((await w.assets()).assetsE6).toBe(e6("3"));
});

test("no float document counts zero and is not stale", async () => {
    const w = await world();

    expect(await w.assets()).toEqual({ assetsE6: 0n, stale: false });
});

test("a float document read 180 s ago is fresh and 181 s ago is stale", async () => {
    const w = await world();
    await setFloat(w, { balance: "10", ageMs: 180_000 });
    expect((await w.assets()).stale).toBe(false);

    await setFloat(w, { balance: "10", ageMs: 181_000 });
    expect((await w.assets()).stale).toBe(true);
});

test("every part adds up in one answer", async () => {
    const w = await world();
    await setFloat(w, { balance: "100", held: "10", unread: "5" });
    w.trader.setUsdc(e6("2"));
    await insertRow(w, { direction: "arc_to_polygon", state: "forwarding", amount: "60", maxFee: "0.5" });
    await insertRow(w, { direction: "polygon_to_arc", state: "forwarding", amount: "40", maxFee: "0.25" });
    await insertRow(w, { direction: "polygon_to_arc", state: "submitting", amount: "30", reserved: "30" });

    expect(await w.assets()).toEqual({
        assetsE6: e6("85") + e6("2") + e6("59.5") + e6("39.75") + e6("30"),
        stale: false,
    });
});

test("a shortfall with a stale float document logs warn, not error", async () => {
    const w = await world();
    await setFloat(w, { balance: "50", ageMs: 181_000 });
    await w.h.seedAccount("1000");
    const { rec, lines } = reconciler(w.h, "400", w.assets);

    const report = await rec.run();

    expect(report.shortfallE6).toBe(e6("50"));
    expect(shortfallLines(lines).map((line) => line.level)).toEqual([40]);
    expect(lines.filter((line) => line.level >= 50)).toEqual([]);
});

test("a shortfall with a fresh float document and a good read logs error", async () => {
    const w = await world();
    await setFloat(w, { balance: "50" });
    await w.h.seedAccount("1000");
    const { rec, lines } = reconciler(w.h, "400", w.assets);

    await rec.run();

    expect(shortfallLines(lines).map((line) => line.level)).toEqual([50]);
});

test("the pool's money joins the assets, so a top-up in flight is no shortfall", async () => {
    const w = await world();
    await w.h.seedAccount("1000");
    await insertRow(w, { direction: "arc_to_polygon", state: "forwarding", amount: "60" });

    const bare = reconciler(w.h, "440");
    expect((await bare.rec.run()).shortfallE6).toBe(e6("60"));
    expect(shortfallLines(bare.lines).map((line) => line.level)).toEqual([50]);

    const withPool = reconciler(w.h, "440", w.assets);
    expect((await withPool.rec.run()).shortfallE6).toBe(0n);
    expect(shortfallLines(withPool.lines)).toEqual([]);
});

test("without poolAssets the existing reconciler tests are unchanged", async () => {
    const w = await world();
    await setFloat(w, { balance: "500" });
    w.trader.setUsdc(e6("500"));
    await w.h.seedAccount("1000");
    const { rec, lines } = reconciler(w.h, "400");

    const report = await rec.run();

    expect(report.shortfallE6).toBe(e6("100"));
    expect(shortfallLines(lines).map((line) => line.level)).toEqual([50]);
});
