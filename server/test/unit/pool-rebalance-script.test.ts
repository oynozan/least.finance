import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vitest";
import {
    parseCommand,
    parseUsd,
    planLines,
    queueMove,
    queueWrapIdle,
    refusalWhileOff,
    resolveRow,
    statusLines,
} from "../../scripts/pool-rebalance.ts";
import { connectDatabase, type Database, type PoolRebalanceDoc, type PoolRebalanceState } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { newPoolRebalance, type PoolConfig } from "../../src/predictions/pool-inputs.ts";
import { FakeTrader } from "../support/fake-trader.ts";

const e6 = (usdc: string) => parseUnits(usdc, 6);
const NOW = Date.parse("2026-10-15T12:00:00Z");
const MINUTE = 60_000;
/** A moment well before any real clock a test runs on. */
const LONG_AGO = Date.parse("2026-01-01T00:00:00Z");
const IN_FLIGHT: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping"];

let database: Database;
beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
});
afterAll(() => database.close());
beforeEach(async () => {
    await database.collections.poolRebalances.deleteMany({});
    await database.collections.poolFloat.deleteMany({});
});

const rows = () => database.collections.poolRebalances;

/** Inserts a row in `state`, holding the one-active slot only in the states that do. */
async function seed(
    state: PoolRebalanceState,
    o: {
        direction?: "arc_to_polygon" | "polygon_to_arc";
        usdc?: string;
        at?: number;
        kind?: "move" | "wrap_idle";
    } = {},
    keepActive = IN_FLIGHT.includes(state),
): Promise<PoolRebalanceDoc> {
    const row = newPoolRebalance({
        kind: o.kind ?? "move",
        direction: o.direction ?? "arc_to_polygon",
        source: "operator",
        reason: "operator",
        amountE6: e6(o.usdc ?? "10"),
        now: new Date(o.at ?? NOW),
    });
    const { active, ...rest } = row;
    const stored = { ...rest, state, ...(keepActive && { active }) } as PoolRebalanceDoc;
    await rows().insertOne(stored);
    return stored;
}

describe("parseUsd", () => {
    test("parseUsd refuses 0, -5, 5.5555555, abc and 1e3 and accepts 5, 5.5 and 0.000001", () => {
        const message = "Enter an amount above zero with at most 6 decimals.";
        for (const text of ["0", "-5", "5.5555555", "abc", "1e3"]) expect(() => parseUsd(text)).toThrow(message);
        expect(parseUsd("5")).toBe(5_000_000n);
        expect(parseUsd("5.5")).toBe(5_500_000n);
        expect(parseUsd("0.000001")).toBe(1n);
        expect(parseUsd("100.123456")).toBe(100_123_456n);
    });

    test("parseUsd refuses a zero with decimals, blanks, signs, separators and a lone point", () => {
        const message = "Enter an amount above zero with at most 6 decimals.";
        for (const text of ["0.0", "0.000000", "", " 5", "5 ", "5\n", "+5", "5.", ".5", "5,5", "1_000", "0x10", "٣"]) {
            expect(() => parseUsd(text), JSON.stringify(text)).toThrow(message);
        }
    });
});

describe("parseCommand", () => {
    test("parseCommand reads each command and refuses the odd ones before anything else runs", () => {
        expect(parseCommand(["status"])).toEqual({ name: "status" });
        expect(parseCommand(["plan"])).toEqual({ name: "plan" });
        expect(parseCommand(["wrap-idle"])).toEqual({ name: "wrap-idle" });
        expect(parseCommand(["move", "arc-to-polygon", "5.5"])).toEqual({
            name: "move",
            direction: "arc_to_polygon",
            amountE6: 5_500_000n,
        });
        expect(parseCommand(["move", "polygon-to-arc", "20"])).toEqual({
            name: "move",
            direction: "polygon_to_arc",
            amountE6: 20_000_000n,
        });
        const id = new ObjectId().toHexString();
        expect(parseCommand(["resolve", id, "done"])).toEqual({ name: "resolve", id, outcome: "done" });
        expect(parseCommand(["resolve", id, "failed"])).toEqual({ name: "resolve", id, outcome: "failed" });

        expect(() => parseCommand([])).toThrow(/Usage/);
        expect(() => parseCommand(["sing"])).toThrow(/Usage/);
        expect(() => parseCommand(["status", "now"])).toThrow(/Usage/);
        expect(() => parseCommand(["move", "sideways", "5"])).toThrow(/Usage/);
        expect(() => parseCommand(["move", "arc-to-polygon"])).toThrow(/Usage/);
        expect(() => parseCommand(["move", "arc-to-polygon", "5", "6"])).toThrow(/Usage/);
        expect(() => parseCommand(["move", "arc-to-polygon", "1e3"])).toThrow("Enter an amount above zero");
        expect(() => parseCommand(["resolve", id])).toThrow(/Usage/);
        expect(() => parseCommand(["resolve", id, "maybe"])).toThrow(/Usage/);
        expect(() => parseCommand(["resolve", "nope", "done"])).toThrow(/rebalance id/);
    });
});

describe("queueMove", () => {
    test("queueMove inserts one queued operator row", async () => {
        const before = Date.now();
        const result = await queueMove(rows(), { direction: "polygon_to_arc", amountE6: e6("12.5") });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const all = await rows().find({}).toArray();
        expect(all).toHaveLength(1);
        const [row] = all;
        expect(row?._id.equals(result.id)).toBe(true);
        expect(row).toMatchObject({
            kind: "move",
            direction: "polygon_to_arc",
            source: "operator",
            reason: "operator",
            state: "queued",
            active: true,
            attempts: 0,
            resolvedAt: null,
            doneAt: null,
        });
        expect(fromDecimal(row!.amountE6)).toBe(12_500_000n);
        expect(fromDecimal(row!.reservedE6)).toBe(0n);
        expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(row!.arc.burnRawTx).toBeNull();
        expect(row!.polygon.attemptedAt).toBeNull();
    });

    test("a second move while one is active or queued is rejected and returns the active row", async () => {
        const first = await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") });
        if (!first.ok) throw new Error("the first move should queue");

        for (const direction of ["arc_to_polygon", "polygon_to_arc"] as const) {
            const second = await queueMove(rows(), { direction, amountE6: e6("7") });
            expect(second.ok).toBe(false);
            if (second.ok) return;
            expect(second.active?._id.equals(first.id)).toBe(true);
            expect(second.active?.state).toBe("queued");
        }
        expect(await rows().countDocuments({})).toBe(1);

        // The slot stays taken while the row is mid-flight, and frees once the row ends
        await rows().updateOne({ _id: first.id }, { $set: { state: "forwarding" } });
        const during = await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("7") });
        expect(during.ok).toBe(false);
        expect(during.ok === false && during.active?.state).toBe("forwarding");

        await rows().updateOne({ _id: first.id }, { $set: { state: "done" }, $unset: { active: "" } });
        const after = await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("7") });
        expect(after.ok).toBe(true);
        expect(await rows().countDocuments({})).toBe(2);
    });

    test("a move is rejected while a row Circle's late forward moved on from stuck is still wrapping", async () => {
        const resumed = await seed("wrapping", {}, false);
        const result = await queueMove(rows(), { direction: "polygon_to_arc", amountE6: e6("7") });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.active?._id.equals(resumed._id)).toBe(true);
        expect(await rows().countDocuments({})).toBe(1);
    });

    test("stuck, failed and done rows never block a move", async () => {
        for (const state of ["stuck", "failed", "done"] as const) await seed(state);
        expect((await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") })).ok).toBe(true);
        expect(await rows().countDocuments({ active: true })).toBe(1);
    });

    test("two moves queued at the same instant leave one row and one rejection", async () => {
        const results = await Promise.all([
            queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") }),
            queueMove(rows(), { direction: "polygon_to_arc", amountE6: e6("5") }),
            queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("6") }),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(await rows().countDocuments({})).toBe(1);
        for (const result of results) if (!result.ok) expect(result.active).not.toBeNull();
    });

    test("an insert error that is not a duplicate key is thrown, not turned into a rejection", async () => {
        const broken = {
            findOne: async () => null,
            insertOne: async () => {
                throw new Error("mongo went away");
            },
        };
        await expect(queueMove(broken as never, { direction: "arc_to_polygon", amountE6: e6("5") })).rejects.toThrow(
            "mongo went away",
        );
    });
});

describe("queueWrapIdle", () => {
    test("queueWrapIdle inserts a wrap_idle row, and is rejected while a move is active", async () => {
        const wrap = await queueWrapIdle(rows());
        expect(wrap.ok).toBe(true);
        const [row] = await rows().find({}).toArray();
        expect(row).toMatchObject({
            kind: "wrap_idle",
            direction: null,
            source: "operator",
            reason: "operator",
            state: "queued",
            active: true,
        });
        expect(fromDecimal(row!.amountE6)).toBe(0n);

        // A wrap in the slot blocks a move, and a second wrap
        const move = await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") });
        expect(move.ok).toBe(false);
        expect((await queueWrapIdle(rows())).ok).toBe(false);

        await rows().deleteMany({});
        const queued = await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") });
        if (!queued.ok) throw new Error("the move should queue");
        const blocked = await queueWrapIdle(rows());
        expect(blocked.ok).toBe(false);
        expect(blocked.ok === false && blocked.active?._id.equals(queued.id)).toBe(true);
        expect(await rows().countDocuments({})).toBe(1);
    });
});

describe("resolveRow", () => {
    test("resolveRow marks only a stuck row, sets resolvedAt, and refuses an id that is not an ObjectId", async () => {
        const stuck = await seed("stuck", { at: LONG_AGO });
        const before = Date.now();
        expect(await resolveRow(rows(), stuck._id.toHexString(), "done")).toBe(true);

        const row = (await rows().findOne({ _id: stuck._id }))!;
        expect(row.state).toBe("done");
        expect(row.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
        expect(row.doneAt!.getTime()).toBeGreaterThanOrEqual(before);
        expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(row.resolvedAt!.getTime()).toBe(row.doneAt!.getTime());
        // Resolving never gives a row the one-active slot back
        expect("active" in row).toBe(false);

        // A second resolve finds nothing stuck
        expect(await resolveRow(rows(), stuck._id.toHexString(), "failed")).toBe(false);
        expect((await rows().findOne({ _id: stuck._id }))!.state).toBe("done");

        await expect(resolveRow(rows(), "nope", "done")).rejects.toThrow(/rebalance id/i);
        await expect(resolveRow(rows(), "", "failed")).rejects.toThrow(/rebalance id/i);
        await expect(resolveRow(rows(), "65f00000000000000000000z", "done")).rejects.toThrow(/rebalance id/i);
    });

    test("resolveRow marks a stuck row failed, and leaves a row in any other state as it was", async () => {
        const stuck = await seed("stuck", { direction: "polygon_to_arc", at: LONG_AGO });
        const before = Date.now();
        expect(await resolveRow(rows(), stuck._id.toHexString(), "failed")).toBe(true);
        const failed = (await rows().findOne({ _id: stuck._id }))!;
        expect(failed.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(failed).toMatchObject({ state: "failed" });
        expect(failed.resolvedAt).toBeInstanceOf(Date);
        expect(failed.doneAt).toBeInstanceOf(Date);
        expect("active" in failed).toBe(false);

        const others: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping", "done"];
        for (const state of others) {
            await rows().deleteMany({});
            const row = await seed(state);
            const stored = await rows().findOne({ _id: row._id });
            expect(await resolveRow(rows(), row._id.toHexString(), "done"), state).toBe(false);
            expect(await rows().findOne({ _id: row._id }), state).toEqual(stored);
        }
        expect(await resolveRow(rows(), new ObjectId().toHexString(), "done")).toBe(false);
    });

    test("resolving a stuck row lifts the halt it caused and a later move can queue", async () => {
        const stuck = await seed("stuck");
        expect(await resolveRow(rows(), stuck._id.toHexString(), "failed")).toBe(true);
        expect(await rows().countDocuments({ state: "stuck" })).toBe(0);
        expect((await queueMove(rows(), { direction: "arc_to_polygon", amountE6: e6("5") })).ok).toBe(true);
    });
});

describe("the script", () => {
    test("the script refuses when POOL_REBALANCE is off or unset", { timeout: 60_000 }, () => {
        for (const env of [{}, { POOL_REBALANCE: "off" }]) {
            const run = spawnSync(process.execPath, ["scripts/pool-rebalance.ts", "status"], { encoding: "utf8", env });
            expect(run.status, JSON.stringify(env)).not.toBe(0);
            expect(run.stderr).toMatch(/POOL_REBALANCE/);
            // The switch is read before the config, so no other variable is asked for
            expect(run.stderr).not.toMatch(/Invalid environment/);
        }
        for (const value of [undefined, "off", "ON", "", "true"]) {
            expect(refusalWhileOff({ POOL_REBALANCE: value }), String(value)).toMatch(/POOL_REBALANCE/);
        }
        expect(refusalWhileOff({ POOL_REBALANCE: "on" })).toBeNull();
    });

    test("an odd amount is refused before the config is loaded or Mongo is touched", { timeout: 60_000 }, () => {
        for (const amount of ["5.5555555", "1e3"]) {
            const run = spawnSync(process.execPath, ["scripts/pool-rebalance.ts", "move", "arc-to-polygon", amount], {
                encoding: "utf8",
                env: { POOL_REBALANCE: "on" },
            });
            expect(run.status, amount).toBe(1);
            expect(run.stderr, amount).toContain("Enter an amount above zero with at most 6 decimals.");
            expect(run.stderr, amount).not.toMatch(/Invalid environment/);
        }
        const run = spawnSync(process.execPath, ["scripts/pool-rebalance.ts", "resolve", "nope", "done"], {
            encoding: "utf8",
            env: { POOL_REBALANCE: "on" },
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/rebalance id/);
        expect(run.stderr).not.toMatch(/Invalid environment/);
    });
});

const config = (over: Partial<PoolConfig> = {}): PoolConfig => ({
    PREDICTIONS_TRADING: "on",
    POLYMARKET_FLOAT_USD: 100,
    POOL_REBALANCE_MAX_MOVE_USD: 100,
    POOL_REBALANCE_MAX_DAY_USD: 300,
    POOL_REBALANCE_ARC_RESERVE_USD: 100,
    POOL_REBALANCE_MIN_MOVE_USD: 10,
    POOL_REBALANCE_PAUSE_MIN: 5,
    ...over,
});

/** Stores the float document as the worker's last read left it. */
async function setFloat(o: { balance: string; held?: string; unread?: string; at?: number }) {
    await database.collections.poolFloat.insertOne({
        _id: "polygon",
        balanceE6: toDecimal(e6(o.balance)),
        balanceAt: new Date(o.at ?? NOW - 20_000),
        heldE6: toDecimal(e6(o.held ?? "0")),
        unreadFillsE6: toDecimal(e6(o.unread ?? "0")),
        updatedAt: new Date(o.at ?? NOW - 20_000),
    });
}

describe("plan", () => {
    const plan = (over: Partial<PoolConfig> = {}, treasury = "1000") =>
        planLines({
            collections: database.collections,
            config: config(over),
            treasuryFreeE6: async () => e6(treasury),
            now: NOW,
        }).then((lines) => lines.join("\n"));

    test("plan prints a top-up the bands call for and the limits allow, and queues nothing", async () => {
        await setFloat({ balance: "30" });
        const text = await plan();
        expect(text).toContain("Decision: arc_to_polygon $70 (low)");
        expect(text).toMatch(/limits allow/i);
        expect(await rows().countDocuments({})).toBe(0);
    });

    test("plan prints a drain the bands call for", async () => {
        await setFloat({ balance: "180", held: "10" });
        const text = await plan();
        expect(text).toContain("Decision: polygon_to_arc $70 (high)");
        expect(await rows().countDocuments({})).toBe(0);
    });

    test("plan says the worker would skip a top-up the Arc reserve or the day total refuses", async () => {
        await setFloat({ balance: "30" });
        expect(await plan({}, "120")).toMatch(/would skip.*reserve/i);
        await seed("done", { usdc: "280", at: NOW - 60 * MINUTE });
        expect(await plan()).toMatch(/would skip.*daily limit/i);
        expect(await rows().countDocuments({})).toBe(1);
    });

    test("plan names why the worker decides nothing", async () => {
        await setFloat({ balance: "100" });
        expect(await plan()).toMatch(/Decision: nothing.*between the bands/i);
        expect(await plan({ PREDICTIONS_TRADING: "off" })).toMatch(/Decision: nothing.*PREDICTIONS_TRADING is off/);

        await database.collections.poolFloat.deleteMany({});
        await setFloat({ balance: "30", at: NOW - 10 * MINUTE });
        expect(await plan()).toMatch(/Decision: nothing.*older than 3 minutes/);

        await database.collections.poolFloat.deleteMany({});
        await setFloat({ balance: "105" });
        await seed("done", { at: NOW - MINUTE });
        expect(await plan()).toMatch(/Decision: nothing.*pause/i);

        await database.collections.poolFloat.deleteMany({});
        expect(await plan()).toMatch(/no float read/i);
    });

    test("plan says an active move stops the worker from deciding, and shows a halted direction", async () => {
        await setFloat({ balance: "30" });
        const active = await seed("forwarding");
        const text = await plan();
        expect(text).toContain(active._id.toHexString());
        expect(text).toMatch(/already (active|in flight)/i);
        expect(text).not.toContain("Decision: arc_to_polygon");

        await rows().deleteMany({});
        await seed("stuck", { at: NOW - 60 * MINUTE });
        const halted = await plan();
        expect(halted).toMatch(/halted: arc_to_polygon/i);
        expect(halted).toMatch(/Decision: nothing.*halted/i);
    });

    test("plan reports a treasury that can't be read instead of guessing", async () => {
        await setFloat({ balance: "30" });
        const lines = await planLines({
            collections: database.collections,
            config: config(),
            treasuryFreeE6: async () => {
                throw new Error("the Arc node is down");
            },
            now: NOW,
        });
        expect(lines.join("\n")).toMatch(/Couldn't read the treasury.*the Arc node is down/);
        expect(await rows().countDocuments({})).toBe(0);
    });
});

describe("status", () => {
    const trader = () => new FakeTrader({ bookOf: () => ({}) as never, balanceE6: e6("98") });
    const status = (over: { trader?: FakeTrader | null; treasury?: () => Promise<bigint> } = {}) =>
        statusLines({
            collections: database.collections,
            trader: over.trader === undefined ? trader() : over.trader,
            treasuryFreeE6: over.treasury ?? (async () => e6("950")),
            now: NOW,
        }).then((lines) => lines.join("\n"));

    test("status prints both sides, the idle USDC, both wallets, the active row and the last five rows", async () => {
        await setFloat({ balance: "98", held: "10", unread: "3", at: NOW - 2 * MINUTE });
        const fake = trader();
        fake.setUsdc(e6("1.25"));
        const old = await seed("done", { usdc: "11", at: NOW - 70 * MINUTE });
        const recent: PoolRebalanceDoc[] = [];
        for (const [minutes, state] of [
            [60, "failed"],
            [50, "done"],
            [40, "done"],
            [30, "done"],
            [20, "done"],
        ] as const) {
            recent.push(await seed(state, { usdc: "21", at: NOW - minutes * MINUTE }));
        }
        const active = await seed("wrapping", { usdc: "33", at: NOW - 10 * MINUTE });

        const text = await status({ trader: fake });
        expect(text).toContain("Arc treasury free: $950");
        expect(text).toContain("balance $98");
        expect(text).toContain("held $10");
        expect(text).toContain("unread fills $3");
        expect(text).toContain("free $85");
        expect(text).toMatch(/read 2m/);
        expect(text).toContain("$98");
        expect(text).toMatch(/Idle native USDC.*\$1\.25/);
        expect(text).toContain("Pool wallet configured: 0x1111111111111111111111111111111111111111");
        expect(text).toContain("Pool wallet derived from the pool key: 0x1111111111111111111111111111111111111111");
        expect(text).not.toMatch(/warning/i);
        expect(text).toMatch(/Active move:.*wrapping/);
        expect(text).toContain(active._id.toHexString());
        // The five newest rows only: the active one and four of the five before it
        expect(text).toContain(recent[4]!._id.toHexString());
        expect(text).toContain(recent[1]!._id.toHexString());
        expect(text).not.toContain(recent[0]!._id.toHexString());
        expect(text).not.toContain(old._id.toHexString());
    });

    test("status warns when the configured pool wallet is not the one the key derives, or has no code", async () => {
        const fake = trader();
        fake.setDerived({ derived: "0x2222222222222222222222222222222222222222" });
        expect(await status({ trader: fake })).toMatch(/warning.*not the wallet the pool key controls/i);

        const bare = trader();
        bare.setDerived({ hasCode: false });
        expect(await status({ trader: bare })).toMatch(/warning.*no code/i);
    });

    test("status prints what it can when a read fails", async () => {
        await setFloat({ balance: "98" });
        const text = await status({
            trader: null,
            treasury: async () => {
                throw new Error("the Arc node is down");
            },
        });
        expect(text).toMatch(/Arc treasury free: unavailable.*the Arc node is down/);
        expect(text).toMatch(/Idle native USDC.*unavailable/);
        expect(text).toMatch(/Pool wallet.*unavailable/i);
        expect(text).toContain("balance $98");
        expect(text).toMatch(/Active move: none/);

        const broken = trader();
        broken.usdcBalanceE6 = async () => {
            throw new Error("polygon rpc down");
        };
        const partial = await status({ trader: broken });
        expect(partial).toMatch(/Idle native USDC.*unavailable.*polygon rpc down/);
        expect(partial).toContain("Arc treasury free: $950");
        expect(partial).toMatch(/configured/i);
    });

    test("status says so when no float has been read, and lists a halted direction", async () => {
        const quiet = await status();
        expect(quiet).toMatch(/no float read/i);
        expect(quiet).toMatch(/halted: none/i);

        await seed("stuck", { direction: "polygon_to_arc", at: NOW - 3 * 60 * MINUTE });
        expect(await status()).toMatch(/halted: polygon_to_arc/i);
    });

    test("status shows a failed row's reason", async () => {
        const failed = await seed("failed");
        await rows().updateOne({ _id: failed._id }, { $set: { lastError: "That would pass the daily limit." } });
        expect(await status()).toContain("That would pass the daily limit.");
    });
});
