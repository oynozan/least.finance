import type { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { PoolDirection, PoolRebalanceDoc } from "../../src/db/mongo.ts";
import { haltedDirections, newPoolRebalance, readDecisionInputs } from "../../src/predictions/pool-inputs.ts";
import { POOL_ERRORS } from "../../src/predictions/rebalance-log.ts";
import { poolHarness, type PoolHarness } from "../support/pool-harness.ts";

const e6 = (usdc: string) => parseUnits(usdc, 6);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FORWARD = "0x00000000000000000000000000000000000000000000000000000000000000f0";
const POOL_WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const PINO = { info: 30, warn: 40, error: 50 };

const DECIDED = "A pool move was queued by the bands";
const DROPPED = "Another pool move was already active, so the automatic one was dropped";
const SKIPPED = "An automatic pool move was skipped by its limits";
const STALE = "The pool's float read is too old to decide a pool move";
const NO_TREASURY = "Couldn't read the treasury, so a pool move isn't decided";
const NO_DECISION = "Couldn't decide a pool move";

const opened: PoolHarness[] = [];
async function open(options: Parameters<typeof poolHarness>[0] = {}) {
    const harness = await poolHarness(options);
    opened.push(harness);
    return harness;
}
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(opened.splice(0).map((harness) => harness.stop()));
});

/** Sets the pool's pUSD and reads the float, so the float document shows it as of the harness clock. */
async function setPool(h: PoolHarness, usdc: string) {
    h.trader.setBalance(e6(usdc));
    await h.service.refreshFloat();
}

const rowsOf = (h: PoolHarness) =>
    h.database.collections.poolRebalances.find({}).sort({ createdAt: 1, _id: 1 }).toArray();

const autoRows = async (h: PoolHarness) => (await rowsOf(h)).filter((row) => row.source === "auto");

/** Runs one pass `ms` later with the float read at that instant, as the tracker's refresh would. */
async function evaluateAfter(h: PoolHarness, ms: number) {
    h.advance(ms);
    await h.service.refreshFloat();
    await h.rebalancer.tick();
}

/** Moves the clock on and runs one rebalancer pass. */
async function step(h: PoolHarness, ms = 30_000) {
    h.advance(ms);
    await h.rebalancer.tick();
}

/** Takes a row that Payouts has burned for ($50 by default) through Circle's forward and the wrap to `done`. */
async function finish(h: PoolHarness, id: ObjectId, usdc = "50") {
    const burned = await h.rowOf(id);
    expect(burned.state).toBe("forwarding");
    h.iris.setForwarded(burned.arc.burnTxHash!, FORWARD, { domain: 26, feeExecuted: 71_067 });
    h.trader.setUsdc(e6(usdc) - 71_067n);
    await step(h);
    await step(h, 2_000);
    const batch = h.trader.batches.at(-1)!;
    h.trader.confirmBatch(batch.id);
    await step(h);
    expect((await h.rowOf(id)).state).toBe("done");
}

/** Nothing was signed from the treasury: its nonce is untouched and the messenger saw no call. */
async function expectNothingSigned(h: PoolHarness) {
    await h.payouts.tick();
    expect(await h.chain.getTransactionCount({ address: h.signer.address })).toBe(0);
    expect(await h.messenger.calls()).toEqual([]);
}

describe("the bands", () => {
    test("free under 50% of T with trading on queues exactly one auto top-up for the planned amount", async () => {
        const h = await open({ poolUsdc: "30.2" });

        await h.rebalancer.tick();

        const rows = await rowsOf(h);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
            kind: "move",
            direction: "arc_to_polygon",
            source: "auto",
            reason: "low",
            state: "queued",
            active: true,
            attempts: 0,
            nextAt: null,
            lastError: null,
            mintRecipient: null,
        });
        expect(fromDecimal(row!.amountE6)).toBe(e6("70"));
        expect(fromDecimal(row!.maxFeeE6)).toBe(0n);
        expect(row!.createdAt.getTime()).toBe(h.clock.t);
        expect(h.logged(DECIDED)).toMatchObject([
            {
                level: PINO.info,
                rebalance: row!._id.toString(),
                direction: "arc_to_polygon",
                amountUSD: "70",
                reason: "low",
                freeUSD: "30.2",
                targetUSD: "100",
            },
        ]);
        // Nothing has been reserved, signed or priced yet
        expect(h.iris.requests()).toEqual([]);

        // The next pass starts it, and while it is active no more rows are decided, however long that takes
        for (let n = 0; n < 12; n++) await evaluateAfter(h, 30_000);
        expect(await rowsOf(h)).toHaveLength(1);
        expect((await h.rowOf(row!._id)).state).toBe("sending");
        expect(h.logged(DECIDED)).toHaveLength(1);
        expect(h.logged(DROPPED)).toEqual([]);
    });

    test("over 150% queues one drain", async () => {
        const h = await open({ poolUsdc: "160.9" });

        await h.rebalancer.tick();

        const rows = await rowsOf(h);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: "move",
            direction: "polygon_to_arc",
            source: "auto",
            reason: "high",
            state: "queued",
            active: true,
            attempts: 0,
        });
        expect(fromDecimal(rows[0]!.amountE6)).toBe(e6("60"));
        // A drain reserves nothing until the start path takes it
        expect(fromDecimal(rows[0]!.reservedE6)).toBe(0n);
        expect(h.logged(DECIDED)).toMatchObject([{ direction: "polygon_to_arc", amountUSD: "60", reason: "high" }]);
    });

    test("between the bands queues nothing", async () => {
        const h = await open({ poolUsdc: "50" });

        for (const usdc of ["50", "75", "100", "125", "150"]) {
            await setPool(h, usdc);
            await evaluateAfter(h, MINUTE + 1);
        }

        expect(await rowsOf(h)).toEqual([]);
        expect(h.logged(DECIDED)).toEqual([]);
    });

    test("a drain above 150% that is under the minimum queues nothing", async () => {
        // T 15: free 23.00 is above 22.5, but free - T = 8 is under the $10 minimum
        const h = await open({ floatUsd: 15, poolUsdc: "23" });

        await h.rebalancer.tick();

        expect(await rowsOf(h)).toEqual([]);
    });

    test("a top-up is raised to the minimum and capped at the maximum", async () => {
        const raised = await open({ floatUsd: 12, poolUsdc: "5" });
        await raised.rebalancer.tick();
        expect(fromDecimal((await rowsOf(raised))[0]!.amountE6)).toBe(e6("10"));

        const capped = await open({ floatUsd: 200, poolUsdc: "0" });
        await capped.rebalancer.tick();
        expect(fromDecimal((await rowsOf(capped))[0]!.amountE6)).toBe(e6("100"));
    });

    test("held pUSD and fills not yet read are not free: the bands read free float", async () => {
        const h = await open({ poolUsdc: "100" });
        // 100 in the pool, 40 held by orders and 15 spent by fills the balance read hasn't seen: free 45
        await h.database.collections.poolFloat.updateOne(
            { _id: "polygon" },
            { $set: { heldE6: toDecimal(e6("40")), unreadFillsE6: toDecimal(e6("15")) } },
        );

        await h.rebalancer.tick();

        const rows = await rowsOf(h);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ direction: "arc_to_polygon", reason: "low" });
        // 100 - 45 = 55, rounded up to a whole dollar
        expect(fromDecimal(rows[0]!.amountE6)).toBe(e6("55"));
    });

    test("it evaluates at most once a minute by the injected clock", async () => {
        const h = await open({ poolUsdc: "100" });
        await h.rebalancer.tick();
        expect(await rowsOf(h)).toEqual([]);

        await setPool(h, "30");
        h.advance(2_000);
        await h.rebalancer.tick();
        h.advance(57_999);
        await h.rebalancer.tick();
        expect(await rowsOf(h)).toEqual([]);

        await setPool(h, "30");
        h.advance(1);
        await h.rebalancer.tick();
        expect(await rowsOf(h)).toHaveLength(1);
    });
});

describe("when nothing is decided", () => {
    describe("a float document older than 3 minutes, a move still in its pause, and a float read older than the last move each skip the decision", () => {
        test("a float document older than 3 minutes skips the decision, with a warn once an hour", async () => {
            const h = await open({ poolUsdc: "30" });

            h.advance(180_000);
            await h.rebalancer.tick();
            // Exactly 180 s old is still fresh
            expect(await rowsOf(h)).toHaveLength(1);
            await h.database.collections.poolRebalances.deleteMany({});

            h.advance(MINUTE + 1);
            await h.rebalancer.tick();
            expect(await rowsOf(h)).toEqual([]);
            expect(h.logged(STALE)).toHaveLength(1);
            expect(h.logged(STALE)[0]).toMatchObject({ level: PINO.warn });

            h.advance(MINUTE);
            await h.rebalancer.tick();
            expect(h.logged(STALE)).toHaveLength(1);

            // A fresh read decides again
            await evaluateAfter(h, MINUTE);
            expect(await rowsOf(h)).toHaveLength(1);
        });

        test("a move still in its pause skips the decision until the pause is over", async () => {
            const h = await open({ poolUsdc: "30" });
            await h.seed({
                direction: "arc_to_polygon",
                usdc: "50",
                state: "done",
                at: new Date(h.clock.t - 3 * MINUTE),
            });
            await setPool(h, "30");

            // 3 and 4 minutes after the move: paused; 5 minutes: decided
            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);
            await evaluateAfter(h, MINUTE);
            expect(await autoRows(h)).toEqual([]);
            await evaluateAfter(h, MINUTE);
            expect(await autoRows(h)).toHaveLength(1);
        });

        test("a float read older than the last move skips the decision", async () => {
            const h = await open({ poolUsdc: "30", config: { POOL_REBALANCE_PAUSE_MIN: 1 } });
            // The float was read at t0; the last move changed state 60 s later; it is now 150 s after the read
            h.advance(150_000);
            await h.seed({ direction: "arc_to_polygon", usdc: "50", state: "done", at: new Date(h.clock.t - 90_000) });

            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);

            // A read taken after the move decides
            await evaluateAfter(h, MINUTE);
            expect(await autoRows(h)).toHaveLength(1);
        });
    });

    test("a failed move starts the pause like any other", async () => {
        const h = await open({ poolUsdc: "30" });
        await h.seed({ direction: "arc_to_polygon", usdc: "50", state: "failed", at: new Date(h.clock.t - MINUTE) });
        await setPool(h, "30");

        await h.rebalancer.tick();

        expect(await autoRows(h)).toEqual([]);
    });

    test("no pool_float document and no trader decide nothing and do not throw", async () => {
        const h = await open({ poolUsdc: "30" });
        await h.database.collections.poolFloat.deleteMany({});

        await expect(h.rebalancer.tick()).resolves.toBeUndefined();
        expect(await rowsOf(h)).toEqual([]);
        expect(h.lines.filter((line) => (line.level as number) >= PINO.warn)).toEqual([]);

        // With the document back and the trader gone, nothing is decided and no trader is asked for
        await h.service.refreshFloat();
        h.connect(false);
        await expect(h.rebalancer.tick()).resolves.toBeUndefined();
        await evaluateAfter(h, MINUTE + 1);
        expect(await rowsOf(h)).toEqual([]);
        expect(h.needs.count).toBe(0);
    });

    test("with trading off nothing is decided, a queued move runs and an active row finishes", async () => {
        const h = await open({ trading: "off", poolUsdc: "30" });

        await h.rebalancer.tick();
        await setPool(h, "160.9");
        await evaluateAfter(h, MINUTE + 1);
        await setPool(h, "30");
        await evaluateAfter(h, MINUTE + 1);
        expect(await rowsOf(h)).toEqual([]);

        // The operator's queued move starts, burns and is followed through the wrap
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.pass();
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        await finish(h, row._id);

        // Still nothing decided, however low the float is
        h.advance(10 * MINUTE);
        await setPool(h, "10");
        await evaluateAfter(h, MINUTE + 1);
        expect(await autoRows(h)).toEqual([]);
        expect(h.logged(DECIDED)).toEqual([]);
    });

    test("turning trading off while an auto move is in flight lets it finish and decides nothing more", async () => {
        const h = await open({ poolUsdc: "30" });
        await h.rebalancer.tick();
        const [auto] = await rowsOf(h);
        await h.pass();
        expect((await h.rowOf(auto!._id)).state).toBe("forwarding");

        h.config.PREDICTIONS_TRADING = "off";
        await finish(h, auto!._id, "70");

        h.advance(10 * MINUTE);
        await setPool(h, "10");
        await evaluateAfter(h, MINUTE + 1);
        expect(await rowsOf(h)).toHaveLength(1);
    });

    test("after an auto move the next decision waits for the pause and a newer float read", async () => {
        const h = await open({ poolUsdc: "30" });
        await h.rebalancer.tick();
        const [auto] = await rowsOf(h);
        await h.pass();
        await finish(h, auto!._id, "70");
        const moved = await h.rowOf(auto!._id);
        const movedAt = moved.updatedAt.getTime();
        expect(movedAt).toBe(h.clock.t);

        // The pool is drawn down again at once; the float reads are low from here on
        h.trader.setBalance(e6("30"));
        await h.service.refreshFloat();
        await h.rebalancer.tick();
        expect(await rowsOf(h)).toHaveLength(1);

        // Four minutes after the move, with a fresh low read: still paused
        await evaluateAfter(h, 4 * MINUTE);
        expect(h.clock.t - movedAt).toBe(4 * MINUTE);
        expect(await rowsOf(h)).toHaveLength(1);

        // Five minutes after it: decided
        await evaluateAfter(h, MINUTE);
        const rows = await rowsOf(h);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ source: "auto", reason: "low", state: "queued" });
    });

    test("a failing read in the decision is a warn, the pass goes on, and the next minute decides", async () => {
        const h = await open({ poolUsdc: "30" });
        vi.spyOn(h.database.collections.poolFloat, "findOne").mockRejectedValueOnce(new Error("mongo went away"));

        await expect(h.rebalancer.tick()).resolves.toBeUndefined();

        expect(await rowsOf(h)).toEqual([]);
        expect(h.logged(NO_DECISION)).toMatchObject([{ level: PINO.warn, err: { message: "mongo went away" } }]);

        await evaluateAfter(h, MINUTE + 1);
        expect(await autoRows(h)).toHaveLength(1);
    });
});

describe("the advisory guard", () => {
    test("a top-up the Arc reserve would refuse queues nothing, logs 'Treasury too low' once an hour, and never halts top-ups", async () => {
        const h = await open({ poolUsdc: "30", treasuryUsdc: "150" });

        await h.rebalancer.tick();
        expect(await rowsOf(h)).toEqual([]);
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(1);
        expect(h.logged(POOL_ERRORS.treasuryLow)[0]).toMatchObject({ level: PINO.error, direction: "arc_to_polygon" });

        // Many evaluations in the hour: no rows, so nothing fails and nothing halts, and the line is not repeated
        for (let n = 0; n < 5; n++) await evaluateAfter(h, MINUTE + 1);
        expect(await rowsOf(h)).toEqual([]);
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(1);
        expect(await haltedDirections(h.database.collections)).toEqual({
            arc_to_polygon: false,
            polygon_to_arc: false,
        });

        await evaluateAfter(h, HOUR);
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(2);

        // The treasury is topped up: the very next evaluation decides
        await h.setTreasury("1000");
        await evaluateAfter(h, MINUTE + 1);
        expect(await autoRows(h)).toHaveLength(1);
        await expectNothingSigned(h);
    });

    test("a top-up the daily limit would refuse queues nothing and says so at info", async () => {
        const h = await open({ poolUsdc: "30" });
        // 250 moved in the last hour; another 70 would pass 300
        await h.seed({ direction: "arc_to_polygon", usdc: "100", state: "done", at: new Date(h.clock.t - HOUR) });
        await h.seed({ direction: "arc_to_polygon", usdc: "100", state: "done", at: new Date(h.clock.t - HOUR) });
        await h.seed({ direction: "arc_to_polygon", usdc: "50", state: "done", at: new Date(h.clock.t - HOUR) });
        await setPool(h, "30");

        await h.rebalancer.tick();

        expect(await autoRows(h)).toEqual([]);
        expect(h.logged(SKIPPED)).toMatchObject([
            {
                level: PINO.info,
                direction: "arc_to_polygon",
                amountUSD: "70",
                kind: "day",
                refusal: "That would pass the daily limit for moves to Polygon.",
            },
        ]);
        expect(h.logged(POOL_ERRORS.treasuryLow)).toEqual([]);
        expect(await haltedDirections(h.database.collections)).toEqual({
            arc_to_polygon: false,
            polygon_to_arc: false,
        });
    });

    test("a throw reading the treasury skips a top-up with a warn and leaves a drain alone", async () => {
        const h = await open({ poolUsdc: "30" });
        vi.spyOn(h.withdrawals, "treasuryFree").mockRejectedValue(new Error("the Arc node is down"));

        await h.rebalancer.tick();

        expect(await rowsOf(h)).toEqual([]);
        expect(h.logged(NO_TREASURY)).toMatchObject([{ level: PINO.warn, err: { message: "the Arc node is down" } }]);
        expect(h.logged(POOL_ERRORS.treasuryLow)).toEqual([]);

        await setPool(h, "160.9");
        await evaluateAfter(h, MINUTE + 1);
        const rows = await rowsOf(h);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ direction: "polygon_to_arc", source: "auto" });
    });

    describe("an auto row and an operator row take the same start path and the same guards", () => {
        test("an auto top-up and an operator top-up take the same start path and the same guard", async () => {
            const h = await open({ poolUsdc: "30" });
            await h.rebalancer.tick();
            const [auto] = await rowsOf(h);
            expect(auto).toMatchObject({ source: "auto", state: "queued" });

            // The treasury fell between the decision and the start
            await h.setTreasury("150");
            await h.rebalancer.tick();
            const refused = await h.rowOf(auto!._id);
            expect(refused).toMatchObject({
                state: "failed",
                lastError: "That would leave the Arc treasury below its reserve.",
            });
            expect(refused.active).toBeUndefined();

            const operator = await h.queue({ direction: "arc_to_polygon", usdc: "70" });
            await h.rebalancer.tick();
            expect(await h.rowOf(operator._id)).toMatchObject({ state: "failed", lastError: refused.lastError });
            await expectNothingSigned(h);
        });

        test("an auto drain and an operator drain take the same start path and the same guard", async () => {
            const h = await open({ poolUsdc: "160.9" });
            await h.rebalancer.tick();
            const [auto] = await rowsOf(h);
            expect(auto).toMatchObject({ source: "auto", direction: "polygon_to_arc", state: "queued" });

            // Orders took the free float between the decision and the start
            await setPool(h, "30");
            await h.rebalancer.tick();
            const refused = await h.rowOf(auto!._id);
            expect(refused).toMatchObject({
                state: "failed",
                lastError: "The pool does not have that much free float.",
            });

            const operator = await h.queue({ direction: "polygon_to_arc", usdc: "60" });
            await h.rebalancer.tick();
            expect(await h.rowOf(operator._id)).toMatchObject({ state: "failed", lastError: refused.lastError });
            expect(fromDecimal(refused.reservedE6)).toBe(0n);
        });
    });
});

describe("two moves at once", () => {
    test("the operator's row and the evaluate insert at the same instant: the loser is a quiet duplicate key", async () => {
        const h = await open({ poolUsdc: "30" });
        const { poolRebalances } = h.database.collections;
        const operator = newPoolRebalance({
            kind: "move",
            direction: "polygon_to_arc",
            source: "operator",
            reason: "operator",
            amountE6: e6("20"),
            now: new Date(h.clock.t),
        });
        // The operator's insert lands between the evaluate's read and its own insert
        const insert = poolRebalances.insertOne.bind(poolRebalances);
        const spy = vi.spyOn(poolRebalances, "insertOne").mockImplementationOnce((async (doc: PoolRebalanceDoc) => {
            await insert(operator);
            return insert(doc);
        }) as never);

        await expect(h.rebalancer.tick()).resolves.toBeUndefined();

        expect(spy).toHaveBeenCalledTimes(1);
        const rows = await rowsOf(h);
        expect(rows.map((row) => row._id)).toEqual([operator._id]);
        expect(await poolRebalances.countDocuments({ active: true })).toBe(1);
        expect(h.logged(DROPPED)).toMatchObject([{ level: PINO.info, direction: "arc_to_polygon", amountUSD: "70" }]);
        expect(h.logged(DECIDED)).toEqual([]);
        expect(h.lines.filter((line) => (line.level as number) >= PINO.warn)).toEqual([]);

        // Not retried in a loop: later evaluations see the active row and insert nothing
        for (let n = 0; n < 3; n++) await evaluateAfter(h, MINUTE + 1);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(h.logged(DROPPED)).toHaveLength(1);
        expect(await rowsOf(h)).toHaveLength(1);
    });

    test("a queued row that cannot start yet holds the decision back", async () => {
        const h = await open({ poolUsdc: "30" });
        vi.spyOn(h.irisClient, "forwardFee").mockRejectedValue(new Error("Iris is down"));
        const operator = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.rebalancer.tick();
        // Longer than the pause, so only the active row holds the decision back
        for (let n = 0; n < 7; n++) await evaluateAfter(h, MINUTE + 1);

        expect((await rowsOf(h)).map((row) => [row._id, row.state])).toEqual([[operator._id, "queued"]]);
        expect(h.logged(DECIDED)).toEqual([]);
        // The decision was not even tried, so there is no quiet duplicate key either
        expect(h.logged(DROPPED)).toEqual([]);
    });
});

describe("a stuck row that moved on", () => {
    test("a row resumed from stuck by a late forward still holds the decision back, though it has no active flag", async () => {
        const h = await open({ poolUsdc: "30" });
        // Circle's late forward moved a stuck top-up to wrapping, which never sets `active` again
        const resumed = await h.seed({
            direction: "arc_to_polygon",
            state: "wrapping",
            at: new Date(h.clock.t - 10 * MINUTE),
        });
        await h.database.collections.poolRebalances.updateOne({ _id: resumed._id }, { $unset: { active: "" } });
        await setPool(h, "30");

        expect(await haltedDirections(h.database.collections)).toEqual({
            arc_to_polygon: false,
            polygon_to_arc: false,
        });
        expect((await readDecisionInputs(h.database.collections, h.config, h.clock.t)).active).toBe(1);
        await h.rebalancer.tick();
        await evaluateAfter(h, MINUTE + 1);

        expect(await autoRows(h)).toEqual([]);
        expect(h.logged(DROPPED)).toEqual([]);
    });
});

describe("the per-direction halt", () => {
    const failedRows = async (h: PoolHarness, direction: PoolDirection, count = 3) => {
        const rows: PoolRebalanceDoc[] = [];
        // The oldest first, the newest 6 minutes ago, so the pause is over
        for (let n = count; n >= 1; n--) {
            rows.push(await h.seed({ direction, state: "failed", at: new Date(h.clock.t - (n + 5) * MINUTE) }));
        }
        return rows;
    };

    test("a stuck drain doesn't block a top-up; a stuck top-up blocks automatic top-ups", async () => {
        const stuckDrain = await open({ poolUsdc: "30" });
        await stuckDrain.seed({
            direction: "polygon_to_arc",
            state: "stuck",
            at: new Date(stuckDrain.clock.t - 10 * MINUTE),
        });
        await setPool(stuckDrain, "30");
        await stuckDrain.rebalancer.tick();
        expect(await autoRows(stuckDrain)).toMatchObject([{ direction: "arc_to_polygon", reason: "low" }]);
        // Only the drain's direction is reported halted
        expect(stuckDrain.logged(POOL_ERRORS.halted).map((line) => line.direction)).toEqual(["polygon_to_arc"]);

        const stuckTopUp = await open({ poolUsdc: "30" });
        await stuckTopUp.seed({
            direction: "arc_to_polygon",
            state: "stuck",
            at: new Date(stuckTopUp.clock.t - 10 * MINUTE),
        });
        await setPool(stuckTopUp, "30");
        await stuckTopUp.rebalancer.tick();
        expect(await autoRows(stuckTopUp)).toEqual([]);
        expect(stuckTopUp.logged(POOL_ERRORS.halted)).toMatchObject([
            { level: PINO.error, direction: "arc_to_polygon" },
        ]);

        // The drain direction of the same pool is not blocked
        await setPool(stuckTopUp, "160.9");
        await evaluateAfter(stuckTopUp, MINUTE + 1);
        expect(await autoRows(stuckTopUp)).toMatchObject([{ direction: "polygon_to_arc", reason: "high" }]);
    });

    describe("three failed rows halt one direction only, a queued move of that direction still runs, and a success or resolve (resolvedAt) lifts the halt", () => {
        test("three failed rows halt one direction only, with the error once an hour per direction", async () => {
            const h = await open({ poolUsdc: "30" });
            await failedRows(h, "arc_to_polygon");
            await setPool(h, "30");

            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);
            expect(h.logged(POOL_ERRORS.halted)).toHaveLength(1);
            expect(h.logged(POOL_ERRORS.halted)[0]).toMatchObject({ level: PINO.error, direction: "arc_to_polygon" });

            // The line is not repeated inside the hour, and is again after it
            await evaluateAfter(h, 30 * MINUTE);
            expect(h.logged(POOL_ERRORS.halted)).toHaveLength(1);
            await evaluateAfter(h, 30 * MINUTE);
            expect(h.logged(POOL_ERRORS.halted)).toHaveLength(2);
            expect(await autoRows(h)).toEqual([]);

            // The other direction keeps working
            await setPool(h, "160.9");
            await evaluateAfter(h, MINUTE + 1);
            expect(await autoRows(h)).toMatchObject([{ direction: "polygon_to_arc", reason: "high" }]);
        });

        test("a halted direction logs for each direction on its own", async () => {
            const h = await open({ poolUsdc: "100" });
            await failedRows(h, "arc_to_polygon");
            await failedRows(h, "polygon_to_arc");
            await setPool(h, "100");

            await h.rebalancer.tick();

            expect(
                h
                    .logged(POOL_ERRORS.halted)
                    .map((line) => line.direction)
                    .sort(),
            ).toEqual(["arc_to_polygon", "polygon_to_arc"]);
        });

        test("a queued move of a halted direction still runs", async () => {
            const h = await open({ poolUsdc: "30" });
            await failedRows(h, "arc_to_polygon");
            await setPool(h, "30");
            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);

            const operator = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
            await h.pass();

            expect((await h.rowOf(operator._id)).state).toBe("forwarding");
            expect(await h.messenger.calls()).toHaveLength(1);
        });

        test("a resolve lifts the halt", async () => {
            const h = await open({ poolUsdc: "30" });
            const failed = await failedRows(h, "arc_to_polygon");
            await setPool(h, "30");
            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);

            await h.database.collections.poolRebalances.updateOne(
                { _id: failed.at(-1)!._id },
                { $set: { resolvedAt: new Date(h.clock.t) } },
            );
            await evaluateAfter(h, MINUTE + 1);

            expect(await autoRows(h)).toMatchObject([{ direction: "arc_to_polygon", reason: "low" }]);
        });

        test("a success lifts the halt", async () => {
            const h = await open({ poolUsdc: "30" });
            await failedRows(h, "arc_to_polygon");
            await setPool(h, "30");
            await h.rebalancer.tick();
            expect(await autoRows(h)).toEqual([]);

            await h.seed({ direction: "arc_to_polygon", state: "done", at: new Date(h.clock.t - 6 * MINUTE) });
            await evaluateAfter(h, MINUTE + 1);

            expect(await autoRows(h)).toMatchObject([{ direction: "arc_to_polygon", reason: "low" }]);
        });

        test("three auto top-ups the start path fails halt top-ups; an operator success then lifts the halt", async () => {
            const h = await open({ poolUsdc: "30" });
            h.trader.setDerived({ derived: OTHER_WALLET });

            for (let n = 1; n <= 3; n++) {
                await evaluateAfter(h, 6 * MINUTE);
                expect(await autoRows(h)).toHaveLength(n);
                // The start path refuses the wallet and ends the row
                await h.rebalancer.tick();
                expect((await autoRows(h)).at(-1)).toMatchObject({
                    state: "failed",
                    lastError: POOL_ERRORS.walletMismatch,
                });
            }
            expect(await haltedDirections(h.database.collections)).toEqual({
                arc_to_polygon: true,
                polygon_to_arc: false,
            });

            // The fourth evaluation decides nothing and says why
            await evaluateAfter(h, 6 * MINUTE);
            expect(await autoRows(h)).toHaveLength(3);
            expect(h.logged(POOL_ERRORS.halted)).toHaveLength(1);

            // The operator's queued move still runs once the wallet is right, and its success lifts the halt
            h.trader.setDerived({ derived: POOL_WALLET });
            const operator = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
            await h.pass();
            await finish(h, operator._id);
            expect(await haltedDirections(h.database.collections)).toEqual({
                arc_to_polygon: false,
                polygon_to_arc: false,
            });

            h.trader.setBalance(e6("30"));
            await evaluateAfter(h, 6 * MINUTE);
            expect(await autoRows(h)).toHaveLength(4);
        });
    });
});

describe("readDecisionInputs", () => {
    test("reads the float, the limits in E6, the newest move, the halts and the active rows", async () => {
        const h = await open({
            floatUsd: 40.5,
            poolUsdc: "30",
            config: {
                POOL_REBALANCE_MAX_MOVE_USD: 55.5,
                POOL_REBALANCE_MIN_MOVE_USD: 7,
                POOL_REBALANCE_PAUSE_MIN: 3,
            },
        });
        const at = (ms: number) => new Date(h.clock.t - ms);
        await h.seed({ direction: "arc_to_polygon", state: "done", at: at(3 * HOUR) });
        const newest = await h.seed({ direction: "polygon_to_arc", state: "failed", at: at(2 * HOUR) });
        // A wrap_idle row is not a move, however new
        await h.seed({ kind: "wrap_idle", state: "wrapping", at: at(MINUTE) });
        await h.database.collections.poolFloat.updateOne(
            { _id: "polygon" },
            { $set: { heldE6: toDecimal(e6("4")), unreadFillsE6: toDecimal(e6("1.5")) } },
        );
        const float = (await h.database.collections.poolFloat.findOne({ _id: "polygon" }))!;

        const inputs = await readDecisionInputs(h.database.collections, h.config, h.clock.t);

        expect(inputs).toEqual({
            tradingOn: true,
            targetE6: 40_500_000n,
            freeE6: e6("24.5"),
            floatAt: float.balanceAt.getTime(),
            lastMoveAt: newest.updatedAt.getTime(),
            pauseMs: 3 * MINUTE,
            minMoveE6: 7_000_000n,
            maxMoveE6: 55_500_000n,
            halted: { arc_to_polygon: false, polygon_to_arc: false },
            active: 1,
        });
    });

    test("with no float document and no moves the float and the last move are null; trading off and halts show", async () => {
        const h = await open({ trading: "off", poolUsdc: "30" });
        await h.database.collections.poolFloat.deleteMany({});
        await h.seed({ direction: "polygon_to_arc", state: "stuck" });

        const inputs = await readDecisionInputs(h.database.collections, h.config, h.clock.t);

        expect(inputs).toMatchObject({
            tradingOn: false,
            freeE6: null,
            floatAt: null,
            halted: { arc_to_polygon: false, polygon_to_arc: true },
            active: 0,
        });

        await h.database.collections.poolRebalances.deleteMany({});
        expect((await readDecisionInputs(h.database.collections, h.config, h.clock.t)).lastMoveAt).toBeNull();
    });

    test("counts queued, sending, submitting, forwarding and wrapping rows as active and nothing else", async () => {
        const h = await open();
        await h.seed({ state: "queued" });
        for (const state of ["done", "failed", "stuck"] as const) await h.seed({ state });

        expect((await readDecisionInputs(h.database.collections, h.config, h.clock.t)).active).toBe(1);
    });
});
