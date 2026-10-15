import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits, type Hex } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { PoolRebalanceDoc, PredictionRedemptionDoc } from "../../src/db/mongo.ts";
import { announce, FLOWS, stateChange, type FlowContext } from "../../src/predictions/rebalance-flows.ts";
import { HourlyLog, POOL_ERRORS } from "../../src/predictions/rebalance-log.ts";
import { poolHarness, type PoolHarness } from "../support/pool-harness.ts";
import { EVENT, TOKEN } from "../support/prediction-harness.ts";

const e6 = (usdc: string) => parseUnits(usdc, 6);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FORWARD = "0x00000000000000000000000000000000000000000000000000000000000000f0";
/** A burn an earlier drain already holds. */
const OLD_BURN: Hex = "0x00000000000000000000000000000000000000000000000000000000000000a1";
/** max(3 * 16_288, 16_288 + 100_000), the maxFee the fake Iris's high fee for 7 to 26 gives a drain. */
const MAX_FEE = 116_288n;

const opened: PoolHarness[] = [];
async function open(options: Parameters<typeof poolHarness>[0] = {}) {
    const harness = await poolHarness({ poolUsdc: "100", ...options });
    opened.push(harness);
    return harness;
}
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(opened.splice(0).map((harness) => harness.stop()));
});

/** Moves the clock on and runs one rebalancer pass. */
async function step(h: PoolHarness, ms = 2_000) {
    h.advance(ms);
    await h.rebalancer.tick();
}

/** The pool's float document in E6. */
async function poolOf(h: PoolHarness) {
    const doc = (await h.database.collections.poolFloat.findOne({ _id: "polygon" }))!;
    return {
        balance: fromDecimal(doc.balanceE6),
        held: fromDecimal(doc.heldE6),
        unread: fromDecimal(doc.unreadFillsE6),
    };
}

/** Queues a drain and runs one pass: it is reserved and, unless the gate or the relayer says otherwise, sent. */
async function drain(h: PoolHarness, usdc = "40") {
    const queued = await h.queue({ direction: "polygon_to_arc", usdc });
    await h.rebalancer.tick();
    return h.rowOf(queued._id);
}

/** A drain whose batch the relayer took and whose id is stored. */
async function drained(h: PoolHarness, usdc = "40") {
    const row = await drain(h, usdc);
    expect(row.state).toBe("submitting");
    expect(row.polygon.relayerTransactionId).not.toBeNull();
    return { row, batch: h.trader.batches[0]! };
}

/** A drain whose batch is confirmed with its burn, one pass later it is `forwarding`. */
async function burned(h: PoolHarness) {
    const { row, batch } = await drained(h);
    h.trader.confirmBatch(batch.id);
    await step(h);
    const forwarding = await h.rowOf(row._id);
    expect(forwarding.state).toBe("forwarding");
    return { row: forwarding, batch };
}

/** Seeds a done drain that holds `hash` as its burn, and the burn itself, which the over-covering scan also sees. */
async function earlierBurn(h: PoolHarness, hash: Hex) {
    const old = await h.seed({
        direction: "polygon_to_arc",
        usdc: "40",
        state: "done",
        at: new Date(h.clock.t - HOUR),
    });
    await h.database.collections.poolRebalances.updateOne({ _id: old._id }, { $set: { "polygon.burnTxHash": hash } });
    h.trader.burns.push({ txHash: hash, amountE6: e6("40") });
}

/** A flow context over the harness, with its own empty set of ids waiting to be sent, as a second process would have. */
function contextOf(h: PoolHarness): FlowContext {
    const ctx: FlowContext = {
        collections: h.database.collections,
        trader: h.trader,
        treasury: h.signer.address,
        pendingSend: new Set(),
        iris: h.irisClient,
        limiter: h.limiter,
        gate: h.gate,
        service: h.service,
        ledger: h.ledger,
        bus: h.bus,
        logger: h.logger,
        now: () => h.clock.t,
        config: h.config,
        log: new HourlyLog(h.logger, () => h.clock.t),
        irisSeen: new Map(),
        move: async (row, to, patch = {}) => {
            const moved = await stateChange(h.database.collections, row, to, patch, new Date(h.clock.t));
            if (moved) announce(ctx, moved, row.state);
            return moved;
        },
    };
    return ctx;
}

const messageRequests = (h: PoolHarness) => h.iris.requests().filter((url) => url.startsWith("/v2/messages/"));

describe("the drain from the reservation to done", () => {
    test("end to end: reservation, batch, burn log found, release as spent in one transaction, forced read, Iris complete, done", async () => {
        const h = await open();
        h.trader.lagBalance(true);
        const states: string[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => states.push(rebalance.state));
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });

        await h.rebalancer.tick();
        const out = await h.rowOf(row._id);
        const batch = h.trader.batches[0]!;
        expect(h.trader.batches).toHaveLength(1);
        // The amount, the fee headroom and the recipient go to the relayer in E6 and as the Arc treasury
        expect(batch).toMatchObject({
            kind: "unwrap-and-burn",
            amountE6: e6("40"),
            maxFeeE6: MAX_FEE,
            recipient: h.signer.address,
        });
        expect(out).toMatchObject({ state: "submitting", polygon: { relayerTransactionId: batch.id } });
        expect(out.polygon.attemptedAt?.getTime()).toBe(h.clock.t);
        expect(out.polygon.relayerFinalAt).toBeNull();
        expect(h.rebalancer.pendingSend.size).toBe(0);
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: e6("40"), unread: 0n });

        // A batch the relayer still calls pending changes nothing, and nothing is sent twice
        await step(h);
        await step(h);
        expect(await h.rowOf(row._id)).toEqual(out);
        expect(h.trader.batches).toHaveLength(1);

        // Confirmed with a burn log: forwarding, the hold released as spent and the balance re-read in the same pass
        h.trader.confirmBatch(batch.id);
        await step(h);
        const forwarding = await h.rowOf(row._id);
        expect(forwarding).toMatchObject({
            state: "forwarding",
            active: true,
            polygon: { burnTxHash: batch.hash, burnLogSeen: true, relayerTransactionId: batch.id },
        });
        expect(forwarding.polygon.relayerFinalAt?.getTime()).toBe(h.clock.t);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });

        // Circle has not forwarded yet: the row waits, then Iris (domain 7) says complete
        h.iris.setPending(batch.hash);
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        h.iris.setForwarded(batch.hash, FORWARD, { domain: 7, feeExecuted: 16_288 });
        await step(h, 30_000);
        const done = await h.rowOf(row._id);
        expect(done).toMatchObject({ state: "done", iris: { forwardTxHash: FORWARD } });
        expect(fromDecimal(done.iris.feeExecutedE6!)).toBe(16_288n);
        expect(done.active).toBeUndefined();
        expect(done.doneAt).not.toBeNull();
        expect(messageRequests(h)).toContain(`/v2/messages/7?transactionHash=${batch.hash}`);
        expect(states).toEqual(["submitting", "forwarding", "done"]);
        expect(h.trader.batches).toHaveLength(1);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
        expect(h.logged("Pool rebalance changed state").map((line) => line.to)).toEqual([
            "submitting",
            "forwarding",
            "done",
        ]);
    });

    test("attemptedAt is stored before the relayer is called, and the id right after it answers", async () => {
        const h = await open();
        const row = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        const atSend: PoolRebalanceDoc[] = [];
        const send = h.trader.unwrapAndBurn.bind(h.trader);
        vi.spyOn(h.trader, "unwrapAndBurn").mockImplementation(async (o) => {
            atSend.push(await h.rowOf(row._id));
            return send(o);
        });

        await h.rebalancer.tick();

        expect(atSend).toHaveLength(1);
        expect(atSend[0]!.polygon.attemptedAt?.getTime()).toBe(h.clock.t);
        expect(atSend[0]!.polygon.relayerTransactionId).toBeNull();
        expect(h.rebalancer.pendingSend.size).toBe(0);
        expect((await h.rowOf(row._id)).polygon.relayerTransactionId).toBe("batch-1");
        // With the id stored and the batch unconfirmed, the gate is shut to the redeemer
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "unconfirmed",
        });
    });

    test("a confirmed batch opens the gate and the forwarding row keeps no hold on it", async () => {
        const h = await open();
        const { batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        await step(h);

        await expect(h.gate.run(async () => 1, { from: "rebalancer" })).resolves.toMatchObject({ ran: true });
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });
    });

    test("a concurrent order can't take the reserved pUSD", async () => {
        const h = await open();
        await drain(h, "40");
        const account = await h.seedAccount("200");
        const order = (amountUSD: string) =>
            h.service.place(account, { requestId: randomUUID(), eventId: EVENT, tokenId: TOKEN, amountUSD });

        // 100 in the pool, 40 reserved: 60 is free
        await expect(order("70")).rejects.toMatchObject({ code: "float_short" });
        expect((await poolOf(h)).held).toBe(e6("40"));
        vi.spyOn(h.trader, "post").mockResolvedValue({ kind: "delayed", orderId: "parked" });
        await order("60");
        expect((await poolOf(h)).held).toBe(e6("100"));
        await expect(order("5")).rejects.toMatchObject({ code: "float_short" });
    });

    test("the drift check doesn't repair the reservation", async () => {
        const h = await open();
        await drain(h, "40");
        const account = await h.seedAccount("100");
        vi.spyOn(h.trader, "post").mockResolvedValue({ kind: "delayed", orderId: "parked" });
        await h.service.place(account, { requestId: randomUUID(), eventId: EVENT, tokenId: TOKEN, amountUSD: "10" });
        expect((await poolOf(h)).held).toBe(e6("50"));

        await h.service.refreshFloat();
        await h.service.refreshFloat();

        expect((await poolOf(h)).held).toBe(e6("50"));
        expect(h.logged("The pool's float holds drifted")).toHaveLength(0);
    });

    test("a repeat tick releases nothing a second time and heldE6 never goes negative", async () => {
        const h = await open();
        const first = h.rebalancer;
        const { row, batch } = await drained(h);
        const others = [h.restart(), h.restart(), h.restart()];
        h.trader.confirmBatch(batch.id);
        // With the final time stored, no worker is held back by the early write, so all four reach the guarded change
        await h.database.collections.poolRebalances.updateOne(
            { _id: row._id },
            { $set: { "polygon.relayerFinalAt": new Date(h.clock.t) } },
        );
        const release = vi.spyOn(h.service, "releaseForMove");
        const events: string[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => events.push(rebalance.state));

        await Promise.all([first, ...others].map((worker) => worker.tick()));

        expect(release).toHaveBeenCalledTimes(1);
        expect(events).toEqual(["forwarding"]);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });

        // Later passes find the row forwarding and release nothing
        await Promise.all([first, ...others].map((worker) => worker.tick()));
        expect(release).toHaveBeenCalledTimes(1);
        expect((await poolOf(h)).held).toBe(0n);
    });

    test("a repeat tick releases once even when no worker had stored relayerFinalAt yet", async () => {
        const h = await open();
        const first = h.rebalancer;
        const { batch } = await drained(h);
        const others = [h.restart(), h.restart(), h.restart()];
        h.trader.confirmBatch(batch.id);
        const release = vi.spyOn(h.service, "releaseForMove");

        await Promise.all([first, ...others].map((worker) => worker.tick()));

        expect(release).toHaveBeenCalledTimes(1);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a repeat tick on a never-sent row releases once too", async () => {
        const h = await open();
        h.gate.shut();
        const row = await drain(h, "40");
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });
        const first = h.restart();
        const others = [h.restart(), h.restart()];
        const release = vi.spyOn(h.service, "releaseForMove");

        await Promise.all([first, ...others].map((worker) => worker.tick()));

        expect(release).toHaveBeenCalledTimes(1);
        expect((await h.rowOf(row._id)).state).toBe("failed");
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
    });

    test("the state change and the release are one transaction: a release that throws changes nothing", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        vi.spyOn(h.service, "releaseForMove").mockRejectedValueOnce(new Error("the float write failed"));

        await step(h);
        const same = await h.rowOf(row._id);
        expect(same.state).toBe("submitting");
        expect(same.polygon.burnTxHash).toBeNull();
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });

        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a forced read that fails leaves the spent pUSD counted until a later read", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        const sync = vi.spyOn(h.trader, "syncBalance").mockRejectedValue(new Error("the CLOB is unreachable"));

        await step(h);

        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        // Free float does not jump back to 100 before a read shows the lower balance
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: e6("40") });
        expect(h.logged("Couldn't re-read the pool's balance after a pool drain")).toHaveLength(1);

        sync.mockRestore();
        await h.service.refreshFloat();
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });
});

describe("a drain that never went out, or was refused", () => {
    test("a restart that finds submitting with no attemptedAt fails and releases at once", async () => {
        const h = await open();
        const row = await h.seed({
            direction: "polygon_to_arc",
            usdc: "30",
            state: "submitting",
            patch: { reservedE6: toDecimal(e6("30")), maxFeeE6: toDecimal(MAX_FEE) },
        });
        await h.database.collections.poolFloat.updateOne({ _id: "polygon" }, { $set: { heldE6: toDecimal(e6("30")) } });

        await h.rebalancer.tick();

        const failed = await h.rowOf(row._id);
        expect(failed.state).toBe("failed");
        expect(failed.lastError).toBe("The batch was never sent.");
        expect(failed.active).toBeUndefined();
        expect(failed.doneAt).not.toBeNull();
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        expect(h.trader.batches).toHaveLength(0);
    });

    test("a send held back by the gate keeps the reservation and goes out when the gate opens", async () => {
        const h = await open();
        h.gate.shut();

        const held = await drain(h, "40");

        expect(held.state).toBe("submitting");
        expect(held.polygon.attemptedAt).toBeNull();
        expect(h.trader.batches).toHaveLength(0);
        expect(h.rebalancer.pendingSend).toEqual(new Set([held._id.toString()]));
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });

        // The gate stays shut for 11 minutes; the reservation holds meanwhile
        await step(h, 10 * MINUTE);
        expect(h.trader.batches).toHaveLength(0);
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });
        expect((await h.rowOf(held._id)).polygon.attemptedAt).toBeNull();

        await step(h, MINUTE);
        const sent = await h.rowOf(held._id);
        expect(h.trader.batches).toHaveLength(1);
        expect(sent.polygon).toMatchObject({ relayerTransactionId: "batch-1" });
        expect(sent.polygon.attemptedAt?.getTime()).toBe(h.clock.t);
        expect(h.rebalancer.pendingSend.size).toBe(0);
    });

    test("a restart while the send is held back fails and releases", async () => {
        const h = await open();
        h.gate.shut();
        const held = await drain(h, "40");
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });

        // The gate is open again, but the new process didn't reserve the row, so it never sends it
        h.advance(12 * MINUTE);
        h.restart();
        await h.rebalancer.tick();

        expect(await h.rowOf(held._id)).toMatchObject({ state: "failed", lastError: "The batch was never sent." });
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        expect(h.trader.batches).toHaveLength(0);
    });

    test("a never-sent decision made on a stale read does not fail a row that has since been attempted", async () => {
        const h = await open();
        h.gate.shut();
        const stale = await drain(h, "40");
        expect(stale.polygon.attemptedAt).toBeNull();
        // Another process sent the batch after this read
        await h.database.collections.poolRebalances.updateOne(
            { _id: stale._id },
            { $set: { "polygon.attemptedAt": new Date(h.clock.t) } },
        );

        await FLOWS["polygon_to_arc:submitting"]!(contextOf(h), stale);

        expect(await h.rowOf(stale._id)).toMatchObject({ state: "submitting", active: true });
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });
    });

    test("a pending id is dropped once the row has left submitting", async () => {
        const h = await open();
        h.gate.shut();
        const held = await drain(h, "40");
        expect(h.rebalancer.pendingSend.size).toBe(1);

        await h.database.collections.poolRebalances.updateOne(
            { _id: held._id },
            { $set: { state: "failed" }, $unset: { active: "" } },
        );
        await step(h);

        expect(h.rebalancer.pendingSend.size).toBe(0);
    });

    test("a refusal fails and releases", async () => {
        const h = await open();
        h.trader.onNextBatch("refuse");

        const failed = await drain(h, "40");

        expect(failed).toMatchObject({ state: "failed", lastError: "the relayer refused the batch" });
        expect(failed.active).toBeUndefined();
        expect(failed.polygon).toMatchObject({ relayerTransactionId: null });
        expect(failed.polygon.attemptedAt).not.toBeNull();
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        expect(h.rebalancer.pendingSend.size).toBe(0);
        expect(h.trader.batches).toHaveLength(0);

        // A failed drain is never sent again
        await step(h, 12 * MINUTE);
        expect(h.trader.batches).toHaveLength(0);
    });

    test("a refused batch sets relayerFinalAt, so the gate is open to the redeemer at once", async () => {
        const h = await open();
        h.trader.onNextBatch("refuse");

        const failed = await drain(h, "40");

        expect(failed.polygon.relayerFinalAt?.getTime()).toBe(h.clock.t);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });
        await expect(h.gate.run(async () => 1, { from: "rebalancer" })).resolves.toMatchObject({ ran: true });

        // Without relayerFinalAt the same row would hold the gate for its 11 minutes
        await h.database.collections.poolRebalances.updateOne(
            { _id: failed._id },
            { $set: { "polygon.relayerFinalAt": null } },
        );
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "unconfirmed",
        });
    });

    test("the batch is not submitted while a redemption is submitted, and the row is retried after it confirms", async () => {
        const h = await open();
        const now = new Date(h.clock.t);
        const redemption: PredictionRedemptionDoc = {
            _id: new ObjectId(),
            conditionId: "0xcondition",
            marketId: "mkt-1",
            state: "submitted",
            transactionId: "tx-redeem",
            attempts: 0,
            nextAt: now,
            lastError: null,
            createdAt: now,
            updatedAt: now,
        };
        await h.database.collections.predictionRedemptions.insertOne(redemption);

        const waiting = await drain(h, "40");
        await step(h);
        await step(h);

        expect(h.trader.batches).toHaveLength(0);
        expect((await h.rowOf(waiting._id)).polygon.attemptedAt).toBeNull();
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });
        expect(h.rebalancer.pendingSend.size).toBe(1);

        await h.database.collections.predictionRedemptions.updateOne(
            { _id: redemption._id },
            { $set: { state: "confirmed" } },
        );
        await step(h);

        expect(h.trader.batches).toHaveLength(1);
        expect((await h.rowOf(waiting._id)).polygon.relayerTransactionId).toBe("batch-1");
    });
});

describe("a batch whose outcome is unknown", () => {
    test("a timeout with a matching burn event is adopted", async () => {
        const h = await open();
        h.trader.onNextBatch("unknown-executed");
        const sent = await drain(h, "40");
        const attemptedAt = sent.polygon.attemptedAt!.getTime();
        expect(sent.polygon.relayerTransactionId).toBeNull();
        const batch = h.trader.batches[0]!;
        h.trader.confirmBatch(batch.id);
        // The gate is shut at once: the batch may still run
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "shut",
        });

        // The burn is on the chain, but the worker waits out the window before it reads the chain
        h.advance(attemptedAt + 10 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect((await h.rowOf(sent._id)).state).toBe("submitting");

        h.advance(MINUTE);
        await h.rebalancer.tick();
        const forwarding = await h.rowOf(sent._id);
        expect(forwarding).toMatchObject({
            state: "forwarding",
            polygon: { burnTxHash: batch.hash, burnLogSeen: true },
        });
        expect(forwarding.polygon.relayerFinalAt?.getTime()).toBe(attemptedAt + 11 * MINUTE);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
        expect(h.trader.batches).toHaveLength(1);

        h.iris.setForwarded(batch.hash, FORWARD, { domain: 7 });
        await step(h);
        expect((await h.rowOf(sent._id)).state).toBe("done");
    });

    test("a timeout with none stays submitting for 11 minutes, then fails and releases", async () => {
        const h = await open();
        h.trader.onNextBatch("unknown-lost");
        const sent = await drain(h, "40");
        const attemptedAt = sent.polygon.attemptedAt!.getTime();

        h.advance(attemptedAt + 10 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        const waiting = await h.rowOf(sent._id);
        expect(waiting).toMatchObject({ state: "submitting", active: true });
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });

        h.advance(MINUTE);
        await h.rebalancer.tick();
        const failed = await h.rowOf(sent._id);
        expect(failed.state).toBe("failed");
        expect(failed.active).toBeUndefined();
        expect(failed.polygon.relayerFinalAt?.getTime()).toBe(attemptedAt + 11 * MINUTE);
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        // It never went out a second time
        expect(h.trader.batches).toHaveLength(0);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });
    });

    test("a worker restarted after attemptedAt with no id never submits again", async () => {
        const h = await open();
        h.trader.onNextBatch("unknown-executed");
        const sent = await drain(h, "40");
        const attemptedAt = sent.polygon.attemptedAt!.getTime();
        expect(h.trader.batches).toHaveLength(1);

        h.restart();
        const submit = vi.spyOn(h.trader, "unwrapAndBurn");
        for (let at = h.clock.t; at < attemptedAt + 10 * MINUTE; at += 30_000) await step(h, 30_000);

        // The restarted worker has no pending send, so it waits like the old one did
        expect(submit).not.toHaveBeenCalled();
        expect(h.trader.batches).toHaveLength(1);
        expect(await h.rowOf(sent._id)).toMatchObject({
            state: "submitting",
            polygon: { attemptedAt: sent.polygon.attemptedAt, relayerTransactionId: null },
        });
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });

        // At the end of the window it scans; the batch never ran, so the row fails and releases
        h.advance(attemptedAt + 11 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect(await h.rowOf(sent._id)).toMatchObject({ state: "failed" });
        expect(submit).not.toHaveBeenCalled();
        expect(h.trader.batches).toHaveLength(1);
        expect(await poolOf(h)).toMatchObject({ held: 0n });
    });

    test("a call that throws is an unknown outcome: the attempt stays and the gate shuts", async () => {
        const h = await open();
        vi.spyOn(h.trader, "unwrapAndBurn").mockRejectedValueOnce(new Error("the relayer connection broke"));

        const sent = await drain(h, "40");

        expect(sent.state).toBe("submitting");
        expect(sent.polygon.attemptedAt).not.toBeNull();
        expect(sent.polygon.relayerTransactionId).toBeNull();
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: false });
        await step(h, 5 * MINUTE);
        expect(h.trader.batches).toHaveLength(0);
        await step(h, 6 * MINUTE);
        expect(await h.rowOf(sent._id)).toMatchObject({ state: "failed" });
        expect(h.trader.batches).toHaveLength(0);
    });

    test("a batch whose id can't be stored is decided like an unknown one, by the burn scan", async () => {
        const h = await open();
        const rows = h.database.collections.poolRebalances;
        const real = rows.findOneAndUpdate.bind(rows) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(rows, "findOneAndUpdate").mockImplementation(((...args: unknown[]) =>
            JSON.stringify(args[1]).includes("relayerTransactionId")
                ? Promise.reject(new Error("mongo went away"))
                : real(...args)) as never);

        const queued = await h.queue({ direction: "polygon_to_arc", usdc: "40" });
        await h.rebalancer.tick();
        vi.restoreAllMocks();

        // The relayer took the batch, but the row has an attempt and no id: the gate waits and nothing is sent again
        const sent = await h.rowOf(queued._id);
        expect(sent.polygon.attemptedAt).not.toBeNull();
        expect(sent.polygon.relayerTransactionId).toBeNull();
        expect(h.trader.batches).toHaveLength(1);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "unconfirmed",
        });
        h.trader.confirmBatch("batch-1");

        await step(h, 5 * MINUTE);
        expect((await h.rowOf(queued._id)).state).toBe("submitting");
        await step(h, 6 * MINUTE);

        expect(await h.rowOf(queued._id)).toMatchObject({
            state: "forwarding",
            polygon: { burnTxHash: h.trader.batches[0]!.hash },
        });
        expect(h.trader.batches).toHaveLength(1);
    });
});

describe("tracking the batch", () => {
    test("transaction lookups that keep throwing for 11 minutes fall back to the burn scan", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        const attemptedAt = row.polygon.attemptedAt!.getTime();
        h.trader.failTransactionCheck(true);
        h.trader.confirmBatch(batch.id);
        const scan = vi.spyOn(h.trader, "burnEvents");

        for (let at = h.clock.t; at < attemptedAt + 10 * MINUTE; at += 30_000) await step(h, 30_000);
        expect(scan).not.toHaveBeenCalled();
        expect((await h.rowOf(row._id)).state).toBe("submitting");
        expect(h.logged("Couldn't look up the drain batch, so a pool move waits")).toHaveLength(1);

        h.advance(attemptedAt + 11 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        const forwarding = await h.rowOf(row._id);
        expect(scan).toHaveBeenCalledWith({ since: row.polygon.attemptedAt });
        expect(forwarding).toMatchObject({
            state: "forwarding",
            polygon: { burnTxHash: batch.hash, burnLogSeen: true },
        });
        expect(forwarding.polygon.relayerFinalAt?.getTime()).toBe(attemptedAt + 11 * MINUTE);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("lookups that keep throwing and no burn event end failed, released with nothing spent", async () => {
        const h = await open();
        const { row } = await drained(h);
        h.trader.failTransactionCheck(true);

        await step(h, 11 * MINUTE);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed" });
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });
    });

    test("a batch the relayer still calls pending after the window is decided by the burn scan", async () => {
        const h = await open();
        const { row } = await drained(h);

        await step(h, 10 * MINUTE);
        expect((await h.rowOf(row._id)).state).toBe("submitting");
        await step(h, MINUTE);

        // The signed batch can no longer run, so with no burn on the chain nothing executed
        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed" });
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
    });

    test("a confirmed record with no hash falls back to the burn scan", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        vi.spyOn(h.trader, "transaction").mockResolvedValue({ state: "confirmed", hash: null, errorMsg: null });

        await step(h);

        // No wait for the window: the batch is confirmed, so its burn is already on the chain
        const forwarding = await h.rowOf(row._id);
        expect(forwarding).toMatchObject({
            state: "forwarding",
            polygon: { burnTxHash: batch.hash, burnLogSeen: true },
        });
        expect(forwarding.polygon.relayerFinalAt?.getTime()).toBe(h.clock.t);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a confirmed record with no hash and no burn event ends stuck, released as spent", async () => {
        const h = await open();
        const { row } = await drained(h);
        vi.spyOn(h.trader, "transaction").mockResolvedValue({ state: "confirmed", hash: null, errorMsg: null });

        await step(h);

        const stuck = await h.rowOf(row._id);
        expect(stuck.state).toBe("stuck");
        expect(stuck.active).toBeUndefined();
        expect(stuck.polygon.burnTxHash).toBeNull();
        expect(h.logged(POOL_ERRORS.noBurn)).toMatchObject([
            { level: 50, rebalance: row._id.toString(), hash: null, relayerTransactionId: "batch-1" },
        ]);
        // The unwrap may have run, so the pUSD counts as spent until a balance read shows it
        expect((await poolOf(h)).held).toBe(0n);
    });

    test("a log with another amount is not taken as the move's burn", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        h.trader.burns[0]!.amountE6 = e6("39");

        await step(h);

        const stuck = await h.rowOf(row._id);
        expect(stuck.state).toBe("stuck");
        expect(stuck.polygon.burnTxHash).toBeNull();
        expect(h.logged(POOL_ERRORS.noBurn)).toMatchObject([{ hash: batch.hash }]);
    });

    test("a burn event with another amount is not adopted by the scan", async () => {
        const h = await open();
        h.trader.onNextBatch("unknown-executed");
        const sent = await drain(h, "40");
        h.trader.confirmBatch(h.trader.batches[0]!.id);
        h.trader.burns[0]!.amountE6 = e6("41");

        await step(h, 11 * MINUTE);

        expect(await h.rowOf(sent._id)).toMatchObject({ state: "failed", polygon: { burnTxHash: null } });
        expect(await poolOf(h)).toMatchObject({ held: 0n });
    });

    test("the scan skips a burn another row holds, and adopts the one nothing holds", async () => {
        const h = await open();
        await earlierBurn(h, OLD_BURN);
        h.trader.onNextBatch("unknown-executed");
        const sent = await drain(h, "40");
        const batch = h.trader.batches[0]!;
        h.trader.confirmBatch(batch.id);
        expect(h.trader.burns.map((burn) => burn.txHash)).toEqual([OLD_BURN, batch.hash]);

        await step(h, 11 * MINUTE);

        expect(await h.rowOf(sent._id)).toMatchObject({ state: "forwarding", polygon: { burnTxHash: batch.hash } });
    });

    test("the scan with only a burn another row holds ends failed", async () => {
        const h = await open();
        await earlierBurn(h, OLD_BURN);
        h.trader.onNextBatch("unknown-lost");
        const sent = await drain(h, "40");

        await step(h, 11 * MINUTE);

        expect(await h.rowOf(sent._id)).toMatchObject({ state: "failed", polygon: { burnTxHash: null } });
        expect(await poolOf(h)).toMatchObject({ held: 0n });
    });

    test("a confirmed batch with no burn log ends stuck, released as spent, and logs 'Pool rebalance confirmed without a burn' with the hash", async () => {
        const h = await open();
        h.trader.onNextBatch("partial");
        const { row, batch } = await drained(h);
        // The unwrap ran and the burn did not
        h.trader.confirmBatch(batch.id);

        await step(h);

        const stuck = await h.rowOf(row._id);
        expect(stuck.state).toBe("stuck");
        expect(stuck.active).toBeUndefined();
        expect(stuck.polygon).toMatchObject({ burnTxHash: null, burnLogSeen: null });
        expect(stuck.polygon.relayerFinalAt).not.toBeNull();
        expect(h.logged(POOL_ERRORS.noBurn)).toMatchObject([
            { level: 50, rebalance: row._id.toString(), hash: batch.hash, relayerTransactionId: batch.id },
        ]);
        // The pUSD is gone from the pool: the hold is released and the balance re-read shows the 60 left
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });

        // Nothing to follow: no Iris request, and the stuck error comes once an hour
        const asked = h.iris.requests().length;
        await step(h, 30_000);
        await step(h, 30_000);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(1);
        expect(h.iris.requests()).toHaveLength(asked);
        await step(h, HOUR);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(2);
        expect(h.iris.requests()).toHaveLength(asked);
        expect((await h.rowOf(row._id)).state).toBe("stuck");
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a failed batch with no log ends failed with nothing spent", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.failBatch(batch.id);

        await step(h);

        const failed = await h.rowOf(row._id);
        expect(failed).toMatchObject({ state: "failed", lastError: "the relayer failed the batch" });
        expect(failed.active).toBeUndefined();
        expect(failed.polygon.relayerFinalAt?.getTime()).toBe(h.clock.t);
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
        expect(h.logged(POOL_ERRORS.noBurn)).toHaveLength(0);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });
    });

    test("a failed batch whose unwrap ran re-reads the pool's balance, with nothing counted as spent", async () => {
        const h = await open();
        h.trader.lagBalance(true);
        h.trader.onNextBatch("partial");
        const { row, batch } = await drained(h);
        // The unwrap ran and the burn did not: the pool's pUSD is gone and the USDC sits in the wallet
        h.trader.failBatch(batch.id);

        await step(h);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed" });
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a new worker resumes tracking a stored batch id and sends nothing", async () => {
        const h = await open();
        const { row, batch } = await drained(h);

        h.restart();
        const submit = vi.spyOn(h.trader, "unwrapAndBurn");
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("submitting");
        h.trader.confirmBatch(batch.id);
        await step(h);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "forwarding", polygon: { burnTxHash: batch.hash } });
        expect(submit).not.toHaveBeenCalled();
        expect(h.trader.batches).toHaveLength(1);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a failed record with no hash ends failed with the relayer's message and nothing spent", async () => {
        const h = await open();
        const { row } = await drained(h);
        vi.spyOn(h.trader, "transaction").mockResolvedValue({ state: "failed", hash: null, errorMsg: "out of gas" });

        await step(h);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "failed", lastError: "out of gas" });
        expect(await poolOf(h)).toEqual({ balance: e6("100"), held: 0n, unread: 0n });
    });

    test("a drain that ends failed after its batch may have run in part re-reads the pool's balance", async () => {
        // The CLOB shows 100 until it is told to re-read, though the wallet holds 60 after an unwrap that ran
        const noHash = await open();
        noHash.trader.lagBalance(true);
        const first = await drained(noHash);
        noHash.trader.setBalance(e6("60"));
        vi.spyOn(noHash.trader, "transaction").mockResolvedValue({
            state: "failed",
            hash: null,
            errorMsg: "out of gas",
        });
        await step(noHash);
        expect((await noHash.rowOf(first.row._id)).state).toBe("failed");
        expect(await poolOf(noHash)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });

        const reverted = await open();
        reverted.trader.lagBalance(true);
        const second = await drained(reverted);
        reverted.trader.setBalance(e6("60"));
        vi.spyOn(reverted.trader, "transaction").mockResolvedValue({
            state: "failed",
            hash: second.batch.hash,
            errorMsg: "reverted",
        });
        await step(reverted);
        expect((await reverted.rowOf(second.row._id)).state).toBe("failed");
        expect(await poolOf(reverted)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });

        const lost = await open();
        lost.trader.lagBalance(true);
        lost.trader.onNextBatch("unknown-lost");
        const sent = await drain(lost, "40");
        lost.trader.setBalance(e6("60"));
        await step(lost, 11 * MINUTE);
        expect((await lost.rowOf(sent._id)).state).toBe("failed");
        expect(await poolOf(lost)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a failed record whose receipt shows the move's burn is a burn", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        vi.spyOn(h.trader, "transaction").mockResolvedValue({ state: "failed", hash: batch.hash, errorMsg: "late" });

        await step(h);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "forwarding", polygon: { burnTxHash: batch.hash } });
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("a burn log that can't be read yet leaves the row submitting with the gate open, then settles", async () => {
        const h = await open();
        const { row, batch } = await drained(h);
        h.trader.confirmBatch(batch.id);
        const read = vi.spyOn(h.trader, "burnLog").mockRejectedValueOnce(new Error("no receipt yet"));

        await step(h);

        const same = await h.rowOf(row._id);
        expect(same.state).toBe("submitting");
        expect(same.polygon.relayerFinalAt).not.toBeNull();
        expect(await poolOf(h)).toMatchObject({ held: e6("40") });
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toMatchObject({ ran: true });

        await step(h);
        expect(read).toHaveBeenCalledTimes(2);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
    });
});

describe("after the burn", () => {
    test("a stalled Iris after the burn becomes stuck at 2 hours and a late complete finishes it", async () => {
        const h = await open();
        const { row, batch } = await burned(h);
        h.iris.setPending(batch.hash);

        h.advance(2 * HOUR);
        await h.rebalancer.tick();
        // Exactly 2 hours is not older than 2 hours
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(0);

        await step(h, 30_000);
        const stuck = await h.rowOf(row._id);
        expect(stuck.state).toBe("stuck");
        expect(stuck.active).toBeUndefined();
        expect(h.logged(POOL_ERRORS.stuck)).toMatchObject([
            {
                level: 50,
                rebalance: row._id.toString(),
                burnTxHash: batch.hash,
                iris: { status: "pending_confirmations" },
            },
        ]);

        // The stuck row is still followed, and the error comes once an hour
        const before = messageRequests(h).length;
        await step(h);
        expect(messageRequests(h)).toHaveLength(before + 1);
        await step(h, 30 * MINUTE);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(1);
        await step(h, 31 * MINUTE);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(2);

        h.iris.setForwarded(batch.hash, FORWARD, { domain: 7, feeExecuted: 16_288 });
        await step(h, 30_000);
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(done.iris.forwardTxHash).toBe(FORWARD);
        expect(h.trader.batches).toHaveLength(1);
        expect(await poolOf(h)).toEqual({ balance: e6("60"), held: 0n, unread: 0n });
    });

    test("Iris answering 429 or unreachable leaves the drain forwarding and backs the shared limiter off", async () => {
        const h = await open();
        const { row, batch } = await burned(h);
        h.iris.setForwarded(batch.hash, FORWARD, { domain: 7 });

        h.iris.failWith(500);
        await step(h, 30_000);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.limiter.blockedUntil()).toBe(0);

        h.iris.failWith(429);
        await step(h, 30_000);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.limiter.blockedUntil()).toBe(h.clock.t + 5 * MINUTE);

        h.iris.failWith(null);
        await step(h, 5 * MINUTE);
        expect((await h.rowOf(row._id)).state).toBe("done");
    });

    test("a delayReason logs 'Pool rebalance burn delayed' and nothing is sent again", async () => {
        const h = await open();
        const { row, batch } = await burned(h);
        h.iris.setDelayed(batch.hash, "insufficient_fee", 7);

        for (let i = 0; i < 3; i++) await step(h, 30_000);

        expect(await h.rowOf(row._id)).toMatchObject({
            state: "forwarding",
            iris: { delayReason: "insufficient_fee" },
        });
        expect(h.logged(POOL_ERRORS.burnDelayed)).toHaveLength(1);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a new worker on the same rows resumes forwarding from the stored burn hash and sends nothing", async () => {
        const h = await open();
        const { row, batch } = await burned(h);

        h.restart();
        h.iris.setForwarded(batch.hash, FORWARD, { domain: 7 });
        await step(h, 30_000);

        expect((await h.rowOf(row._id)).state).toBe("done");
        expect(h.trader.batches).toHaveLength(1);
        expect(messageRequests(h).at(-1)).toBe(`/v2/messages/7?transactionHash=${batch.hash}`);
    });

    test("a forwarding drain with no burn to follow only warns, once an hour", async () => {
        const h = await open();
        const row = await h.seed({ direction: "polygon_to_arc", usdc: "40", state: "forwarding" });

        await step(h, 30_000);
        await step(h, 30_000);

        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.logged("A forwarding pool drain has no burn to follow")).toHaveLength(1);
        expect(messageRequests(h)).toHaveLength(0);
    });

    test("a complete message with no forward hash (a failed forward) leaves the row forwarding", async () => {
        const h = await open();
        const { row, batch } = await burned(h);
        h.iris.setForwardFailed(batch.hash);

        for (let i = 0; i < 3; i++) await step(h, 30_000);

        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.trader.batches).toHaveLength(1);
    });
});
