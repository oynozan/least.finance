import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { pad, parseUnits } from "viem";
import { afterEach, describe, expect, inject, test, vi } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { PoolRebalanceDoc, PoolRebalanceState } from "../../src/db/mongo.ts";
import { haltedDirections, newPoolRebalance } from "../../src/predictions/pool-inputs.ts";
import { FLOWS, type Flow } from "../../src/predictions/rebalance-flows.ts";
import { HourlyLog, POOL_ERRORS } from "../../src/predictions/rebalance-log.ts";
import { poolRowsOpen } from "../../src/predictions/rebalancer.ts";
import { FORWARD_HOOK_DATA } from "../../src/withdrawals/cctp-burn.ts";
import { poolHarness, type PoolHarness } from "../support/pool-harness.ts";
import { until } from "../support/prediction-harness.ts";
import { startStack } from "../support/stack.ts";

const e6 = (usdc: string) => parseUnits(usdc, 6);
const POOL_WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const HOUR = 3_600_000;

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

/** Nothing was signed from the treasury: its nonce is untouched and the messenger saw no call. */
async function expectNothingSigned(h: PoolHarness) {
    await h.payouts.tick();
    expect(await h.chain.getTransactionCount({ address: h.signer.address })).toBe(0);
    expect(await h.messenger.calls()).toEqual([]);
}

/** Runs `work` with the drain's send step stood in by nothing, so only the start path is under test. */
async function withoutSend(work: () => Promise<void>) {
    const saved = { ...FLOWS };
    Object.assign(FLOWS, { "polygon_to_arc:submitting": async () => undefined });
    try {
        await work();
    } finally {
        for (const key of Object.keys(FLOWS)) delete FLOWS[key];
        Object.assign(FLOWS, saved);
    }
}

const floatOf = async (h: PoolHarness) => (await h.database.collections.poolFloat.findOne({ _id: "polygon" }))!;

describe("a top-up (arc_to_polygon)", () => {
    test("a queued top-up inside the caps moves to sending with maxFeeE6 from Iris and the pool wallet as mintRecipient", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        const events: PoolRebalanceDoc[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => events.push(rebalance));

        await h.rebalancer.tick();

        const moved = await h.rowOf(row._id);
        expect(moved.state).toBe("sending");
        // max(3 * 71_067, 71_067 + 100_000) from the fake Iris's high fee
        expect(fromDecimal(moved.maxFeeE6)).toBe(213_201n);
        expect(moved.mintRecipient).toBe(POOL_WALLET);
        expect(moved.active).toBe(true);
        expect(moved.lastError).toBeNull();
        expect(moved.updatedAt.getTime()).toBe(h.clock.t);
        expect(events.map((event) => event.state)).toEqual(["sending"]);
        expect(h.iris.requests()).toEqual(["/v2/burn/USDC/fees/26/7?forward=true"]);
        expect(h.logged("Pool rebalance changed state")).toMatchObject([
            { level: 30, rebalance: row._id.toString(), direction: "arc_to_polygon", amountUSD: "50", to: "sending" },
        ]);
    });

    test("Payouts burns what the start path stored: domain 7, the pool wallet as mint recipient and the stored maxFee", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.pass();

        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        const calls = await h.messenger.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            name: "depositForBurnWithHook",
            amount: e6("50"),
            destinationDomain: 7,
            mintRecipient: pad(POOL_WALLET, { size: 32 }),
            destinationCaller: pad("0x", { size: 32 }),
            maxFee: 213_201n,
            minFinalityThreshold: 2000,
            hookData: FORWARD_HOOK_DATA,
        });
    });

    test("a top-up above the move cap ends failed", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "150" });

        await h.rebalancer.tick();

        const ended = await h.rowOf(row._id);
        expect(ended.state).toBe("failed");
        expect(ended.lastError).toBe("That is above the most one move may carry.");
        expect(ended.active).toBeUndefined();
        expect(ended.doneAt?.getTime()).toBe(h.clock.t);
        await expectNothingSigned(h);
    });

    test("a top-up the daily cap refuses ends failed, naming the cap, with nothing signed", async () => {
        const h = await open();
        await h.seed({ direction: "arc_to_polygon", usdc: "250", state: "done" });
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "60" });

        await h.rebalancer.tick();

        const ended = await h.rowOf(row._id);
        expect(ended.state).toBe("failed");
        expect(ended.lastError).toBe("That would pass the daily limit for moves to Polygon.");
        await expectNothingSigned(h);
    });

    test("the daily total counts rows of this direction that did not fail and were created in the last 24 hours, and a total of exactly the cap is allowed", async () => {
        const h = await open();
        const ago = (ms: number) => new Date(h.clock.t - ms);
        // Counted: 100 + 60 + 80 = 240; not counted: failed, older than a day, and the other direction
        await h.seed({ direction: "arc_to_polygon", usdc: "100", state: "done", at: ago(HOUR) });
        await h.seed({ direction: "arc_to_polygon", usdc: "60", state: "stuck", at: ago(23 * HOUR) });
        await h.seed({ direction: "arc_to_polygon", usdc: "80", state: "done", at: ago(24 * HOUR - 60_000) });
        await h.seed({ direction: "arc_to_polygon", usdc: "90", state: "failed", at: ago(HOUR) });
        await h.seed({ direction: "arc_to_polygon", usdc: "90", state: "done", at: ago(24 * HOUR + 60_000) });
        await h.seed({ direction: "polygon_to_arc", usdc: "90", state: "done", at: ago(HOUR) });

        const fits = await h.queue({ direction: "arc_to_polygon", usdc: "60" });
        await h.rebalancer.tick();
        expect((await h.rowOf(fits._id)).state).toBe("sending");
        await h.database.collections.poolRebalances.updateOne(
            { _id: fits._id },
            { $set: { state: "failed" }, $unset: { active: "" } },
        );

        const over = await h.queue({ direction: "arc_to_polygon", usdc: "61" });
        await h.rebalancer.tick();
        expect((await h.rowOf(over._id)).lastError).toBe("That would pass the daily limit for moves to Polygon.");
    });

    test("a top-up the Arc reserve refuses ends failed and logs 'Treasury too low to top up the pool' once an hour", async () => {
        const h = await open({ treasuryUsdc: "150" });
        const first = await h.queue({ direction: "arc_to_polygon", usdc: "60" });

        await h.rebalancer.tick();

        const ended = await h.rowOf(first._id);
        expect(ended.state).toBe("failed");
        expect(ended.lastError).toBe("That would leave the Arc treasury below its reserve.");
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(1);
        expect(h.logged(POOL_ERRORS.treasuryLow)[0]).toMatchObject({ level: 50, rebalance: first._id.toString() });
        await expectNothingSigned(h);

        h.advance(HOUR - 1);
        await h.queue({ direction: "arc_to_polygon", usdc: "60" });
        await h.rebalancer.tick();
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(1);

        h.advance(1);
        await h.queue({ direction: "arc_to_polygon", usdc: "60" });
        await h.rebalancer.tick();
        expect(h.logged(POOL_ERRORS.treasuryLow)).toHaveLength(2);
    });

    test("a top-up that leaves the treasury exactly its reserve is allowed", async () => {
        // free = 160.01 - the 0.01 gas reserve = 160.00; 160 - 60 = the 100 reserve
        const h = await open({ treasuryUsdc: "160.01" });
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "60" });

        await h.rebalancer.tick();

        expect((await h.rowOf(row._id)).state).toBe("sending");
    });

    test("a top-up still sending comes off the treasury before the next one's reserve is checked", async () => {
        const h = await open({ treasuryUsdc: "230" });
        const first = await h.queue({ direction: "arc_to_polygon", usdc: "60" });
        await h.rebalancer.tick();
        expect((await h.rowOf(first._id)).state).toBe("sending");
        await h.database.collections.poolRebalances.updateOne({ _id: first._id }, { $unset: { active: "" } });

        // 230 - 0.01 - 60 still sending = 169.99; another 70 would leave 99.99 under the 100 reserve
        const second = await h.queue({ direction: "arc_to_polygon", usdc: "70" });
        await h.rebalancer.tick();

        expect((await h.rowOf(second._id)).lastError).toBe("That would leave the Arc treasury below its reserve.");
    });

    test("an RPC failure reading the treasury leaves the row queued and signs nothing", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        vi.spyOn(h.withdrawals, "treasuryFree").mockRejectedValueOnce(new Error("rpc down"));

        await h.rebalancer.tick();

        const waiting = await h.rowOf(row._id);
        expect(waiting.state).toBe("queued");
        expect(waiting.lastError).toBeNull();
        expect(h.logged("Couldn't start a pool move, so it waits")).toHaveLength(1);
        await expectNothingSigned(h);

        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("sending");
    });

    test("the start waits for the treasury lock, so a withdrawal created meanwhile sees the top-up", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        let release!: () => void;
        const held = h.withdrawals.withTreasuryLock(() => new Promise<void>((resolve) => (release = resolve)));

        const ticking = h.rebalancer.tick();
        await sleep(300);
        expect((await h.rowOf(row._id)).state).toBe("queued");

        release();
        await held;
        await ticking;
        const moved = await h.rowOf(row._id);
        expect(moved.state).toBe("sending");
        // The next reader of treasuryFree already has the 50 taken off
        expect(await h.withdrawals.treasuryFree()).toBe(parseUnits("1000", 18) - parseUnits("50", 18) - 10n ** 16n);
    });

    test("a row that left queued while the treasury was read is not moved", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        vi.spyOn(h.withdrawals, "treasuryFree").mockImplementationOnce(async () => {
            await h.database.collections.poolRebalances.updateOne(
                { _id: row._id },
                { $set: { state: "failed", lastError: "Taken out by hand" }, $unset: { active: "" } },
            );
            return parseUnits("1000", 18);
        });

        await h.rebalancer.tick();

        const after = await h.rowOf(row._id);
        expect(after.state).toBe("failed");
        expect(after.lastError).toBe("Taken out by hand");
        await expectNothingSigned(h);
    });

    test("a row with no amount or no direction ends failed instead of looping", async () => {
        const h = await open();
        const empty = await h.queue({ direction: "arc_to_polygon", usdc: "0" });
        await h.rebalancer.tick();
        expect(await h.rowOf(empty._id)).toMatchObject({
            state: "failed",
            lastError: "The amount must be above zero.",
        });

        const lost = await h.queue({ usdc: "50", patch: { direction: null } });
        await h.rebalancer.tick();
        expect(await h.rowOf(lost._id)).toMatchObject({ state: "failed", lastError: "The move has no direction." });
        await expectNothingSigned(h);
    });

    test("two passes started at the same instant start the row once", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        const events: PoolRebalanceDoc[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => events.push(rebalance));

        await Promise.all([h.rebalancer.tick(), h.rebalancer.tick()]);

        expect((await h.rowOf(row._id)).state).toBe("sending");
        expect(events).toHaveLength(1);
        expect(h.iris.requests()).toHaveLength(1);
    });
});

describe("Iris", () => {
    test("Iris unreachable leaves the row queued and a 429 backs the shared limiter off", async () => {
        const h = await open();
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        h.iris.failWith(503);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("queued");
        expect(h.limiter.blockedUntil()).toBe(0);
        expect(h.logged("Iris couldn't price a pool move, so it waits")).toHaveLength(1);

        h.iris.failWith(429);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("queued");
        expect(h.limiter.blockedUntil()).toBe(h.clock.t + 300_000);

        // Backed off: Iris is not asked at all
        const asked = h.iris.requests().length;
        h.iris.failWith(null);
        await h.rebalancer.tick();
        expect(h.iris.requests()).toHaveLength(asked);
        expect((await h.rowOf(row._id)).state).toBe("queued");
        expect(h.logged("Iris's request budget is spent, so a pool move waits")).toHaveLength(1);

        await expectNothingSigned(h);

        h.advance(300_000);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("sending");
    });

    test("the rebalancer asks Iris through the shared limiter", async () => {
        const h = await open();
        await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        for (let i = 0; i < 5; i++) expect(h.limiter.take(h.clock.t)).toBe(true);

        await h.rebalancer.tick();

        // The five requests of this second are spent, so the rebalancer did not ask Iris
        expect(h.iris.requests()).toEqual([]);
    });
});

describe("the pool wallet check", () => {
    test("a configured wallet that differs from the derived one signs nothing and logs 'Pool wallet mismatch'", async () => {
        const h = await open();
        h.trader.setDerived({ derived: OTHER_WALLET });
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.rebalancer.tick();

        const ended = await h.rowOf(row._id);
        expect(ended.state).toBe("failed");
        expect(ended.lastError).toBe("Pool wallet mismatch");
        expect(h.logged(POOL_ERRORS.walletMismatch)).toMatchObject([
            { level: 50, configured: POOL_WALLET, derived: OTHER_WALLET, hasCode: true },
        ]);
        await expectNothingSigned(h);
    });

    test("so does a wallet with no code", async () => {
        const h = await open();
        h.trader.setDerived({ hasCode: false });
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed", lastError: "Pool wallet mismatch" });
        expect(h.logged(POOL_ERRORS.walletMismatch)).toHaveLength(1);
        await expectNothingSigned(h);
    });

    test("and the check runs once per process", async () => {
        const h = await open();
        const check = vi.spyOn(h.trader, "derivedWallet");
        const first = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.rebalancer.tick();
        expect((await h.rowOf(first._id)).state).toBe("sending");
        await h.database.collections.poolRebalances.updateOne(
            { _id: first._id },
            { $set: { state: "failed" }, $unset: { active: "" } },
        );

        const second = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.rebalancer.tick();

        expect((await h.rowOf(second._id)).state).toBe("sending");
        expect(check).toHaveBeenCalledTimes(1);
    });

    test("a derivedWallet call that throws leaves the row queued", async () => {
        const h = await open();
        const check = vi.spyOn(h.trader, "derivedWallet").mockRejectedValueOnce(new Error("polygon rpc down"));
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toMatchObject({ state: "queued", lastError: null });
        expect(h.logged("Couldn't check the pool wallet, so a pool move waits")).toHaveLength(1);
        await expectNothingSigned(h);

        // A failed check is not cached
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("sending");
        expect(check).toHaveBeenCalledTimes(2);
    });

    test("a mismatch is not cached either: once the wallet matches, the next row goes ahead", async () => {
        const h = await open();
        h.trader.setDerived({ hasCode: false });
        const first = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.rebalancer.tick();
        expect((await h.rowOf(first._id)).state).toBe("failed");

        h.trader.setDerived({ hasCode: true });
        const second = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.rebalancer.tick();

        expect((await h.rowOf(second._id)).state).toBe("sending");
    });
});

describe("a drain (polygon_to_arc)", () => {
    test("a queued drain bigger than free float ends failed with nothing reserved", async () => {
        const h = await open({ poolUsdc: "60" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "80" });

        await h.rebalancer.tick();

        const ended = await h.rowOf(row._id);
        expect(ended.state).toBe("failed");
        expect(ended.lastError).toBe("The pool does not have that much free float.");
        expect(ended.active).toBeUndefined();
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(0n);
        expect(h.rebalancer.pendingSend.size).toBe(0);
    });

    test("a queued drain reserves free float and moves to submitting in one transaction", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        const events: PoolRebalanceDoc[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => events.push(rebalance));

        await withoutSend(() => h.rebalancer.tick());

        const moved = await h.rowOf(row._id);
        expect(moved.state).toBe("submitting");
        expect(fromDecimal(moved.reservedE6)).toBe(e6("40"));
        // max(3 * 16_288, 16_288 + 100_000) from the fake Iris's high fee for 7 to 26
        expect(fromDecimal(moved.maxFeeE6)).toBe(116_288n);
        expect(moved.active).toBe(true);
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(e6("40"));
        expect(h.rebalancer.pendingSend).toEqual(new Set([row._id.toString()]));
        expect(events.map((event) => event.state)).toEqual(["submitting"]);
        expect(h.iris.requests()).toEqual(["/v2/burn/USDC/fees/7/26?forward=true"]);
    });

    test("pUSD that orders already hold is not drainable", async () => {
        const h = await open({ poolUsdc: "100" });
        await h.database.collections.poolFloat.updateOne({ _id: "polygon" }, { $set: { heldE6: toDecimal(e6("70")) } });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });

        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toMatchObject({
            state: "failed",
            lastError: "The pool does not have that much free float.",
        });
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(e6("70"));
    });

    test("a float document older than three minutes refuses the reservation: Free float is short.", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        h.advance(181_000);

        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed", lastError: "Free float is short." });
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(0n);
    });

    test("a row that left queued during the reservation holds nothing", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        const reserve = h.service.reserveForMove.bind(h.service);
        vi.spyOn(h.service, "reserveForMove").mockImplementation(async (session, amountE6) => {
            await reserve(session, amountE6);
            await h.database.collections.poolRebalances.updateOne(
                { _id: row._id },
                { $set: { state: "failed", lastError: "Taken out by hand" }, $unset: { active: "" } },
            );
        });

        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed", lastError: "Taken out by hand" });
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(0n);
        expect(h.rebalancer.pendingSend.size).toBe(0);
    });

    test("a drain does not check the pool wallet or read the treasury", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.setDerived({ derived: OTHER_WALLET });
        const treasury = vi.spyOn(h.withdrawals, "treasuryFree");
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });

        await h.rebalancer.tick();

        expect((await h.rowOf(row._id)).state).toBe("submitting");
        expect(treasury).not.toHaveBeenCalled();
    });

    test("Iris unreachable leaves a drain queued with nothing reserved", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        h.iris.failWith(503);

        await h.rebalancer.tick();

        expect((await h.rowOf(row._id)).state).toBe("queued");
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(0n);
    });
});

describe("wrap_idle", () => {
    test("a queued wrap_idle row moves to wrapping with no guard other than the trader", async () => {
        const h = await open({ treasuryUsdc: "0" });
        h.trader.setDerived({ derived: OTHER_WALLET });
        const row = await h.queue({ kind: "wrap_idle" });
        const saved = { ...FLOWS };
        // The start path alone is under test, so the wrap itself is stood in
        Object.assign(FLOWS, { "wrap_idle:wrapping": async () => undefined });
        try {
            await h.rebalancer.tick();

            expect(await h.rowOf(row._id)).toMatchObject({ state: "wrapping", active: true });
            expect(h.iris.requests()).toEqual([]);
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });
});

describe("the worker", () => {
    test("with no trader the worker asks for one and leaves the row queued", async () => {
        const h = await open();
        h.connect(false);
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.rebalancer.tick();

        expect(h.needs.count).toBe(1);
        expect((await h.rowOf(row._id)).state).toBe("queued");
        expect(h.iris.requests()).toEqual([]);

        h.connect(true);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("sending");
    });

    test("with no trader and nothing open the worker asks for nothing", async () => {
        const h = await open();
        h.connect(false);
        await h.seed({ direction: "arc_to_polygon", state: "done" });

        await h.rebalancer.tick();

        expect(h.needs.count).toBe(0);
    });

    test("poolRowsOpen counts queued, active and stuck rows and not done or failed ones", async () => {
        const h = await open();
        const { poolRebalances } = h.database.collections;
        expect(await poolRowsOpen(h.database.collections)).toBe(0);
        await h.seed({ state: "done" });
        await h.seed({ state: "failed" });
        expect(await poolRowsOpen(h.database.collections)).toBe(0);

        const states: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping", "stuck"];
        for (const [index, state] of states.entries()) {
            const row = await h.seed({ state });
            // Only one row may be active at once, so the active ones give the slot back
            await poolRebalances.updateOne({ _id: row._id }, { $unset: { active: "" } });
            expect(await poolRowsOpen(h.database.collections)).toBe(index + 1);
        }
    });

    test("a row in a fast state is followed every pass, and one in a slow state at most every 30 seconds", async () => {
        const h = await open();
        const fast = vi.fn<Flow>(async () => undefined);
        const slow = vi.fn<Flow>(async () => undefined);
        const parked = vi.fn<Flow>(async () => undefined);
        const saved = { ...FLOWS };
        Object.assign(FLOWS, {
            "polygon_to_arc:submitting": fast,
            "arc_to_polygon:forwarding": slow,
            "arc_to_polygon:stuck": parked,
        });
        try {
            await h.seed({ direction: "polygon_to_arc", state: "submitting" });
            await h.rebalancer.tick();
            await h.rebalancer.tick();
            await h.rebalancer.tick();
            expect(fast).toHaveBeenCalledTimes(3);
            await h.database.collections.poolRebalances.deleteMany({});

            const forwarding = await h.seed({ direction: "arc_to_polygon", state: "forwarding" });
            const stuck = await h.seed({ direction: "arc_to_polygon", state: "stuck" });
            await h.rebalancer.tick();
            h.advance(29_999);
            await h.rebalancer.tick();
            expect(slow).toHaveBeenCalledTimes(1);
            expect(parked).toHaveBeenCalledTimes(1);
            h.advance(1);
            await h.rebalancer.tick();
            expect(slow).toHaveBeenCalledTimes(2);
            expect(parked).toHaveBeenCalledTimes(2);
            expect(slow.mock.calls[0]![1]._id).toEqual(forwarding._id);
            expect(parked.mock.calls[0]![1]._id).toEqual(stuck._id);
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });

    test("a row in a slow state that changes state is followed at the next pass", async () => {
        const h = await open();
        const forwarding = vi.fn<Flow>(async () => undefined);
        const wrapping = vi.fn<Flow>(async () => undefined);
        const saved = { ...FLOWS };
        Object.assign(FLOWS, { "arc_to_polygon:forwarding": forwarding, "arc_to_polygon:wrapping": wrapping });
        try {
            const row = await h.seed({ direction: "arc_to_polygon", state: "forwarding" });
            await h.rebalancer.tick();
            await h.database.collections.poolRebalances.updateOne({ _id: row._id }, { $set: { state: "wrapping" } });
            await h.rebalancer.tick();
            expect(forwarding).toHaveBeenCalledTimes(1);
            expect(wrapping).toHaveBeenCalledTimes(1);
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });

    test("a sending row has no flow, and a flow that throws does not stop the others", async () => {
        const h = await open();
        const sending = vi.fn<Flow>(async () => undefined);
        const broken = vi.fn<Flow>(async () => {
            throw new Error("boom");
        });
        const stuck = vi.fn<Flow>(async () => undefined);
        const saved = { ...FLOWS };
        Object.assign(FLOWS, {
            "arc_to_polygon:sending": sending,
            "arc_to_polygon:forwarding": broken,
            "arc_to_polygon:stuck": stuck,
        });
        try {
            await h.seed({ direction: "arc_to_polygon", state: "forwarding" });
            await h.seed({ direction: "arc_to_polygon", state: "stuck" });
            await h.rebalancer.tick();
            expect(broken).toHaveBeenCalledTimes(1);
            expect(stuck).toHaveBeenCalledTimes(1);
            expect(h.logged("A pool rebalance step failed")).toHaveLength(1);

            await h.database.collections.poolRebalances.deleteMany({});
            await h.seed({ direction: "arc_to_polygon", state: "sending" });
            await h.rebalancer.tick();
            expect(sending).not.toHaveBeenCalled();
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });

    test("a flow is given a context whose move is guarded by the row's state, unsets active at the end and never sets it again", async () => {
        const h = await open();
        const moved: Array<PoolRebalanceDoc | null> = [];
        const flow = vi.fn<Flow>(async (ctx, row) => {
            moved.push(await ctx.move(row, "wrapping", { lastError: "retrying" }));
            // The same row object is now out of date, so a second move from its old state matches nothing
            moved.push(await ctx.move(row, "done"));
        });
        const saved = { ...FLOWS };
        Object.assign(FLOWS, { "arc_to_polygon:stuck": flow });
        try {
            // A stuck row has no active flag; moving it on must not set one
            const row = await h.seed({ direction: "arc_to_polygon", state: "stuck" });
            h.advance(5_000);
            await h.rebalancer.tick();
            expect(moved[0]).toMatchObject({ state: "wrapping", lastError: "retrying" });
            expect(moved[1]).toBeNull();
            const after = await h.rowOf(row._id);
            expect(after.state).toBe("wrapping");
            expect(after.active).toBeUndefined();
            expect(after.updatedAt.getTime()).toBe(h.clock.t);
            expect(after.doneAt).toBeNull();
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });

    test("move to done or failed sets doneAt and unsets active, and to stuck unsets active without doneAt", async () => {
        const h = await open();
        let target: PoolRebalanceState = "done";
        const ended: Array<PoolRebalanceDoc | null> = [];
        const flow = vi.fn<Flow>(async (ctx, row) => void ended.push(await ctx.move(row, target)));
        const saved = { ...FLOWS };
        Object.assign(FLOWS, { "arc_to_polygon:forwarding": flow });
        try {
            for (const to of ["done", "failed", "stuck"] as const) {
                target = to;
                await h.database.collections.poolRebalances.deleteMany({});
                await h.seed({ direction: "arc_to_polygon", state: "forwarding" });
                h.advance(1_000);
                await h.rebalancer.tick();
            }
            const [done, failed, stuck] = ended;
            expect(done).toMatchObject({ state: "done", doneAt: new Date(h.clock.t - 2_000) });
            expect(done!.active).toBeUndefined();
            expect(failed).toMatchObject({ state: "failed", doneAt: new Date(h.clock.t - 1_000) });
            expect(failed!.active).toBeUndefined();
            expect(stuck).toMatchObject({ state: "stuck", doneAt: null });
            expect(stuck!.active).toBeUndefined();
        } finally {
            for (const key of Object.keys(FLOWS)) delete FLOWS[key];
            Object.assign(FLOWS, saved);
        }
    });
});

describe("halted directions", () => {
    test("three failed moves in a row, or a stuck one, halt their own direction only, and a newer success or a resolve lifts it", async () => {
        const h = await open();
        const halted = () => haltedDirections(h.database.collections);
        const at = (n: number) => new Date(h.clock.t + n * 1_000);
        expect(await halted()).toEqual({ arc_to_polygon: false, polygon_to_arc: false });

        const failed = [];
        for (let n = 1; n <= 3; n++)
            failed.push(await h.seed({ direction: "arc_to_polygon", state: "failed", at: at(n) }));
        expect(await halted()).toEqual({ arc_to_polygon: true, polygon_to_arc: false });

        await h.database.collections.poolRebalances.updateOne({ _id: failed[2]!._id }, { $set: { resolvedAt: at(9) } });
        expect(await halted()).toEqual({ arc_to_polygon: false, polygon_to_arc: false });
        await h.database.collections.poolRebalances.updateOne({ _id: failed[2]!._id }, { $set: { resolvedAt: null } });
        expect(await halted()).toEqual({ arc_to_polygon: true, polygon_to_arc: false });

        await h.seed({ direction: "arc_to_polygon", state: "done", at: at(10) });
        expect(await halted()).toEqual({ arc_to_polygon: false, polygon_to_arc: false });

        await h.seed({ direction: "polygon_to_arc", state: "stuck", at: at(11) });
        expect(await halted()).toEqual({ arc_to_polygon: false, polygon_to_arc: true });
    });

    test("failed wrap_idle rows halt nothing", async () => {
        const h = await open();
        for (let n = 1; n <= 3; n++) await h.seed({ kind: "wrap_idle", state: "failed" });

        expect(await haltedDirections(h.database.collections)).toEqual({
            arc_to_polygon: false,
            polygon_to_arc: false,
        });
    });
});

describe("a restart", () => {
    test("a new worker leaves a sending row alone, asks nothing of Iris and checks the pool wallet again", async () => {
        const h = await open();
        const check = vi.spyOn(h.trader, "derivedWallet");
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
        await h.rebalancer.tick();
        const before = await h.rowOf(row._id);
        expect(before.state).toBe("sending");
        const asked = h.iris.requests().length;

        h.restart();
        await h.rebalancer.tick();

        expect(await h.rowOf(row._id)).toEqual(before);
        expect(h.iris.requests()).toHaveLength(asked);
        expect(check).toHaveBeenCalledTimes(1);

        // The new process checks the wallet once for the next move
        await h.database.collections.poolRebalances.updateOne({ _id: row._id }, { $unset: { active: "" } });
        const next = await h.queue({ direction: "arc_to_polygon", usdc: "20" });
        await h.rebalancer.tick();
        expect((await h.rowOf(next._id)).state).toBe("sending");
        expect(check).toHaveBeenCalledTimes(2);
    });

    test("the ids waiting to be sent belong to the process that reserved them", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        await withoutSend(() => h.rebalancer.tick());
        expect(h.rebalancer.pendingSend).toEqual(new Set([row._id.toString()]));

        h.restart();

        expect(h.rebalancer.pendingSend.size).toBe(0);
        // The reservation stays held on the row until a flow decides it
        expect((await h.rowOf(row._id)).state).toBe("submitting");
        expect(fromDecimal((await floatOf(h)).heldE6)).toBe(e6("40"));
    });
});

describe("rows and logs", () => {
    test("newPoolRebalance fills every spec 5.1 field and a wrap_idle row has amount 0", () => {
        const now = new Date("2026-10-14T10:00:00Z");
        const move = newPoolRebalance({
            kind: "move",
            direction: "arc_to_polygon",
            source: "auto",
            reason: "low",
            amountE6: e6("70"),
            now,
        });
        expect(move).toEqual({
            _id: expect.any(ObjectId),
            kind: "move",
            direction: "arc_to_polygon",
            source: "auto",
            reason: "low",
            amountE6: expect.anything(),
            maxFeeE6: expect.anything(),
            reservedE6: expect.anything(),
            active: true,
            state: "queued",
            attempts: 0,
            nextAt: null,
            lastError: null,
            mintRecipient: null,
            createdAt: now,
            updatedAt: now,
            doneAt: null,
            resolvedAt: null,
            arc: {
                approveNonce: null,
                approveRawTx: null,
                approveTxHash: null,
                burnNonce: null,
                burnRawTx: null,
                burnTxHash: null,
            },
            polygon: {
                attemptedAt: null,
                relayerTransactionId: null,
                relayerFinalAt: null,
                burnTxHash: null,
                burnLogSeen: null,
                wrapAttemptedAt: null,
                wrapTransactionId: null,
                wrapSubmittedAt: null,
                wrapFinalAt: null,
                mintedE6: null,
                balanceBeforeE6: null,
            },
            iris: { checkedAt: null, forwardTxHash: null, feeExecutedE6: null, delayReason: null },
        } satisfies Record<keyof PoolRebalanceDoc, unknown>);
        expect(fromDecimal(move.amountE6)).toBe(e6("70"));
        expect(fromDecimal(move.maxFeeE6)).toBe(0n);
        expect(fromDecimal(move.reservedE6)).toBe(0n);

        const wrap = newPoolRebalance({
            kind: "wrap_idle",
            direction: null,
            source: "operator",
            reason: "operator",
            amountE6: e6("70"),
            now,
        });
        expect(wrap.direction).toBeNull();
        expect(fromDecimal(wrap.amountE6)).toBe(0n);
        expect(wrap.state).toBe("queued");
        expect(wrap.active).toBe(true);
    });

    test("newPoolRebalance refuses a move with no direction", () => {
        expect(() =>
            newPoolRebalance({
                kind: "move",
                direction: null,
                source: "operator",
                reason: "operator",
                amountE6: e6("10"),
                now: new Date(),
            }),
        ).toThrow(/direction/);
    });

    test("an error line repeats at most once an hour per key", () => {
        const lines: Array<{ level: number; msg: string; id?: number }> = [];
        const logger = pino({ level: "debug" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
        let t = 1_000;
        const log = new HourlyLog(logger, () => t);

        log.once("row-1", "error", { id: 1 }, POOL_ERRORS.stuck);
        log.once("row-1", "error", { id: 1 }, POOL_ERRORS.stuck);
        log.once("row-2", "error", { id: 2 }, POOL_ERRORS.stuck);
        expect(lines).toMatchObject([
            { level: 50, msg: POOL_ERRORS.stuck, id: 1 },
            { level: 50, msg: POOL_ERRORS.stuck, id: 2 },
        ]);

        t += HOUR - 1;
        log.once("row-1", "error", { id: 1 }, POOL_ERRORS.stuck);
        expect(lines).toHaveLength(2);

        t += 1;
        log.once("row-1", "error", { id: 1 }, POOL_ERRORS.stuck);
        log.once("row-1", "warn", { id: 1 }, "Native USDC is idle in the pool wallet");
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatchObject({ level: 50, id: 1 });
    });

    test("the seven error strings are the spec's", () => {
        expect(Object.values(POOL_ERRORS).sort()).toEqual(
            [
                "A pool rebalance wrap keeps failing",
                "Pool rebalance burn delayed",
                "Pool rebalance confirmed without a burn",
                "Pool rebalance stuck: needs an operator",
                "Pool rebalancing halted after repeated failures",
                "Pool wallet mismatch",
                "Treasury too low to top up the pool",
            ].sort(),
        );
    });
});

describe("the whole server", () => {
    const SECRETS = {
        POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
        POLYMARKET_BUILDER_API_KEY: "key",
        POLYMARKET_BUILDER_API_SECRET: "secret",
        POLYMARKET_BUILDER_API_PASSPHRASE: "passphrase",
    };

    const queuedTopUp = () =>
        newPoolRebalance({
            kind: "move",
            direction: "arc_to_polygon",
            source: "operator",
            reason: "operator",
            amountE6: e6("50"),
            now: new Date(),
        });

    test("switch off: a queued row stays queued and nothing is decided", async () => {
        const stack = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { POOL_REBALANCE: "off", ...SECRETS },
        });
        try {
            const { poolRebalances } = stack.server.services.database.collections;
            const row = queuedTopUp();
            await poolRebalances.insertOne(row);

            // Longer than the worker's pass interval
            await sleep(2_600);

            expect(await poolRebalances.findOne({ _id: row._id })).toMatchObject({ state: "queued", lastError: null });
            expect(await poolRebalances.countDocuments()).toBe(1);
        } finally {
            await stack.stop();
        }
    });

    test("switch on: a queued top-up against an unfunded treasury ends failed inside the running server", async () => {
        const stack = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { POOL_REBALANCE: "on", ...SECRETS },
        });
        try {
            const { poolRebalances } = stack.server.services.database.collections;
            const row = queuedTopUp();
            await poolRebalances.insertOne(row);

            await until(async () => (await poolRebalances.findOne({ _id: row._id }))?.state === "failed", 10_000);

            const ended = (await poolRebalances.findOne({ _id: row._id }))!;
            expect(ended.lastError).toBe("That would leave the Arc treasury below its reserve.");
            expect(ended.active).toBeUndefined();
            expect(await stack.chain.client.getTransactionCount({ address: stack.treasury })).toBe(0);
        } finally {
            await stack.stop();
        }
    });
});
