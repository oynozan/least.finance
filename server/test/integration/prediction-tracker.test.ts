import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { PredictionOrderDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { PredictionTracker } from "../../src/predictions/tracker.ts";
import { withTimeouts } from "../../src/predictions/trader.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

let clock = 1_000_000;
let h: Awaited<ReturnType<typeof predictionHarness>>;
let tracker: PredictionTracker;
beforeAll(async () => {
    h = await predictionHarness({ now: () => clock });
    await h.service.refreshFloat();
    tracker = new PredictionTracker({
        collections: h.database.collections,
        service: h.service,
        trader: () => h.trader,
        logger: h.logger,
        pollMs: 0,
        now: () => clock,
    });
});
afterAll(() => h.database.close());

const input = (amountUSD: string) => ({ requestId: randomUUID(), eventId: EVENT, tokenId: TOKEN, amountUSD });
const orderOf = (id: string) => h.database.collections.predictionOrders.findOne({ requestId: id });
const posted = async (requestId: string) => {
    await until(async () => (await orderOf(requestId))?.state === "posted");
    const order = (await orderOf(requestId))!;
    // the order is posted a moment before the trader sees the post
    await until(async () => h.trader.posts.some((p) => p.orderHash === order.orderHash));
    return order;
};

// Followed only once this process is done sending it
const sent = async (order: { _id: ObjectId }) => until(async () => !h.service.submitting(order._id));

test("a delayed order is settled by the tracker when it fills", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);

    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");

    h.trader.settleDelayed(order.orderHash!, "fill");
    await tracker.tick();

    expect((await orderOf(view.requestId))!.state).toBe("filled");
    const position = await h.database.collections.positions.findOne({ accountId: account._id });
    expect(fromDecimal(position!.shares)).toBe(20_000_000n);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("a delayed order the exchange cancels is refunded as price_moved", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);
    h.trader.settleDelayed(order.orderHash!, "cancel");
    await tracker.tick();
    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", reason: "price_moved" });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const unknownPost = async (usdc = "100") => {
    const account = await h.seedAccount(usdc);
    h.trader.onNext(TOKEN, "unknown");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);
    await until(async () => (await orderOf(view.requestId))?.postUnknownAt != null);
    return { account, view, order: (await orderOf(view.requestId))! };
};

test("an unknown post is not refunded inside the quarantine even when lookup says missing", async () => {
    const { account, view, order } = await unknownPost();
    expect(order.postUnknownAt).toBeInstanceOf(Date);

    for (const minutes of [3, 11, 14]) {
        clock += minutes * MIN - (clock - order.postUnknownAt!.getTime());
        await tracker.tick();
        expect((await orderOf(view.requestId))!.state).toBe("posted");
    }
    expect(h.trader.findFills).not.toContain(order.orderHash);
    expect((await h.state(account._id)).balance).toBe(wei("90"));
});

test("an unknown post past the quarantine with no trade is refunded and watched for a day", async () => {
    const { account, view, order } = await unknownPost();
    clock += 15 * MIN + 1;
    await tracker.tick();

    const final = (await orderOf(view.requestId))!;
    expect(final).toMatchObject({ state: "failed", reason: "unavailable" });
    expect(h.trader.findFills).toContain(order.orderHash);
    expect(final.watchUntil!.getTime()).toBe(clock + 24 * HOUR);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
});

test("an unknown post past the quarantine with a trade is settled, not refunded", async () => {
    const { account, view, order } = await unknownPost();
    h.trader.setFound(order.orderHash!, { makingE6: 10_000_000n, takingE6: 20_000_000n });
    clock += 15 * MIN + 1;
    await tracker.tick();

    expect((await orderOf(view.requestId))!.state).toBe("filled");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("a findFill error leaves the order posted", async () => {
    const { account, view } = await unknownPost();
    h.trader.failFindFill();
    clock += 15 * MIN + 1;
    await tracker.tick();
    h.trader.failFindFill(false);

    expect((await orderOf(view.requestId))!.state).toBe("posted");
    expect((await h.state(account._id)).balance).toBe(wei("90"));
});

test("a trade that can't be linked to the order needs review and is never refunded", async () => {
    const { account, view, order } = await unknownPost();
    h.trader.setFound(order.orderHash!, "unlinked");
    const error = vi.spyOn(h.logger, "error");
    clock += 15 * MIN + 1;
    await tracker.tick();

    const flagged = (await orderOf(view.requestId))!;
    expect(flagged.state).toBe("posted");
    expect(flagged.needsReviewAt).toBeInstanceOf(Date);
    expect(error).toHaveBeenCalledTimes(1);

    clock += HOUR;
    await tracker.tick();
    expect(h.trader.findFills.filter((hash) => hash === order.orderHash)).toHaveLength(1);
    expect((await orderOf(view.requestId))!.state).toBe("posted");
    expect((await h.state(account._id)).balance).toBe(wei("90"));
    error.mockRestore();
});

test("a clear post answer that turns up missing still gives up after 2 minutes", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);
    h.trader.setLookup(order.orderHash!, { kind: "missing" });
    expect((await orderOf(view.requestId))!.postUnknownAt ?? null).toBeNull();

    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");
    clock += 121_000;
    await tracker.tick();
    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", reason: "unavailable" });
    expect(h.trader.findFills).not.toContain(order.orderHash);
    expect((await h.state(account._id)).balance).toBe(wei("100"));
});

const refundedBuy = async () => {
    const made = await unknownPost();
    clock += 15 * MIN + 1;
    await tracker.tick();
    expect((await orderOf(made.view.requestId))!.state).toBe("failed");
    return made;
};
const LATE = { makingE6: 10_000_000n, takingE6: 20_000_000n };

test("a refunded order that fills late is booked and the person re-debited once", async () => {
    const { account, view, order } = await refundedBuy();
    h.trader.setFound(order.orderHash!, LATE);
    clock += 61_000;
    await tracker.tick();
    clock += 61_000;
    await tracker.tick();

    const final = (await orderOf(view.requestId))!;
    expect(final).toMatchObject({ state: "filled", lateFill: "settled" });
    const positions = await h.database.collections.positions.find({ accountId: account._id }).toArray();
    expect(positions).toHaveLength(1);
    expect(fromDecimal(positions[0]!.shares)).toBe(20_000_000n);
    const s = await h.state(account._id);
    const buys = s.rows.filter((r) => r.kind === "prediction_buy");
    expect(buys).toHaveLength(2);
    expect(new Set(buys.map((r) => r.refId.toHexString())).size).toBe(2);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("a late fill the person can't cover is orphaned, not booked", async () => {
    const { account, view, order } = await refundedBuy();
    await h.ledger.runInTransaction((session) =>
        h.ledger.debitInSession(session, account._id, wei("100"), "withdrawal", new ObjectId()),
    );
    h.trader.setFound(order.orderHash!, LATE);
    const error = vi.spyOn(h.logger, "error");
    clock += 61_000;
    await tracker.tick();
    clock += 61_000;
    await tracker.tick();

    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", lateFill: "orphaned" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(await h.database.collections.positions.countDocuments({ accountId: account._id })).toBe(0);
    const s = await h.state(account._id);
    expect(s.balance).toBe(0n);
    expect(s.sum).toBe(s.balance);
    error.mockRestore();
});

test("late settlement is exactly once", async () => {
    const { account, view, order } = await refundedBuy();
    const stored = (await orderOf(view.requestId))!;
    await Promise.all([
        h.service.settleLate(stored, LATE.makingE6, LATE.takingE6),
        h.service.settleLate(stored, LATE.makingE6, LATE.takingE6),
    ]);

    expect(await h.database.collections.positions.countDocuments({ accountId: account._id })).toBe(1);
    const s = await h.state(account._id);
    expect(s.rows.filter((r) => r.kind === "prediction_buy")).toHaveLength(2);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
    expect(order.orderHash).toBeTruthy();
});

test("a refunded order past its watch is not looked at again", async () => {
    const { view, order } = await refundedBuy();
    clock += 25 * HOUR;
    h.trader.setFound(order.orderHash!, LATE);
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("failed");
});

const heldPosition = async () => {
    const account = await h.seedAccount("0");
    const now = new Date();
    const position = {
        _id: new ObjectId(),
        accountId: account._id,
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId: TOKEN,
        conditionId: "0xcondition",
        question: "Will it rain?",
        outcome: "YES",
        shares: toDecimal(20_000_000n),
        cost: toDecimal(wei("10")),
        state: "open" as const,
        proceeds: null,
        payout: null,
        openedAt: now,
        settledAt: null,
        updatedAt: now,
    };
    await h.database.collections.positions.insertOne(position);
    h.trader.onNext(TOKEN, "unknown");
    const view = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
        quotedPrice: 0.48,
    });
    const order = await posted(view.requestId);
    await sent(order);
    await until(async () => (await orderOf(view.requestId))?.postUnknownAt != null);
    clock += 15 * MIN + 1;
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("failed");
    return { account, position, view, order };
};
const SOLD = { makingE6: 20_000_000n, takingE6: 9_600_000n };

test("a late sell fill closes a position that is still open", async () => {
    const { account, position, view, order } = await heldPosition();
    expect((await h.database.collections.positions.findOne({ _id: position._id }))!.state).toBe("open");
    h.trader.setFound(order.orderHash!, SOLD);
    clock += 61_000;
    await tracker.tick();

    expect(await orderOf(view.requestId)).toMatchObject({ state: "filled", lateFill: "settled" });
    expect((await h.database.collections.positions.findOne({ _id: position._id }))!.state).toBe("closed");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("9.6"));
    expect(s.sum).toBe(s.balance);
});

test("a late sell fill with the shares gone is orphaned", async () => {
    const { account, position, view, order } = await heldPosition();
    await h.database.collections.positions.updateOne(
        { _id: position._id },
        { $set: { shares: toDecimal(5_000_000n) } },
    );
    h.trader.setFound(order.orderHash!, SOLD);
    const error = vi.spyOn(h.logger, "error");
    clock += 61_000;
    await tracker.tick();

    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", lateFill: "orphaned" });
    expect(error).toHaveBeenCalledTimes(1);
    expect((await h.state(account._id)).balance).toBe(0n);
    error.mockRestore();
});

test("stop() returns within one timeout while lookups are hung, and skips the orders it hadn't reached", async () => {
    const own = await predictionHarness({ now: () => clock });
    await own.service.refreshFloat();
    const hashes: string[] = [];
    for (let i = 0; i < 6; i++) {
        const account = await own.seedAccount("100");
        own.trader.onNext(TOKEN, "delay");
        const view = await own.service.place(account, input("10"));
        await until(async () => {
            const order = await own.database.collections.predictionOrders.findOne({ requestId: view.requestId });
            return order?.state === "posted" && !own.service.submitting(order._id);
        });
        const order = (await own.database.collections.predictionOrders.findOne({ requestId: view.requestId }))!;
        own.trader.hangLookup(order.orderHash!);
        hashes.push(order.orderHash!);
    }
    const own_tracker = new PredictionTracker({
        collections: own.database.collections,
        service: own.service,
        trader: () => withTimeouts(own.trader, 200),
        logger: own.logger,
        pollMs: 10,
        now: () => clock,
    });
    own_tracker.start();
    await until(async () => own.trader.lookups.length >= 4);
    const started = Date.now();
    await own_tracker.stop();

    expect(Date.now() - started).toBeLessThan(1500);
    expect(own.trader.lookups).toHaveLength(4);
    for (const hash of hashes) own.trader.releaseLookup(hash);
    await own.database.close();
});

test("a slow order does not hold up the others in a pass", async () => {
    const own = await predictionHarness({ now: () => clock });
    await own.service.refreshFloat();
    const orders: PredictionOrderDoc[] = [];
    for (let i = 0; i < 3; i++) {
        const account = await own.seedAccount("100");
        own.trader.onNext(TOKEN, "delay");
        const view = await own.service.place(account, input("10"));
        await until(async () => {
            const order = await own.database.collections.predictionOrders.findOne({ requestId: view.requestId });
            return order?.state === "posted" && !own.service.submitting(order._id);
        });
        orders.push((await own.database.collections.predictionOrders.findOne({ requestId: view.requestId }))!);
    }
    own.trader.hangLookup(orders[0]!.orderHash!);
    for (const order of orders.slice(1)) own.trader.settleDelayed(order.orderHash!, "cancel");
    const slow = new PredictionTracker({
        collections: own.database.collections,
        service: own.service,
        trader: () => own.trader,
        logger: own.logger,
        pollMs: 0,
        now: () => clock,
    });
    const pass = slow.tick();
    await until(async () => {
        const rest = await own.database.collections.predictionOrders
            .find({ _id: { $in: orders.slice(1).map((o) => o._id) } })
            .toArray();
        return rest.every((o) => o.state === "failed");
    });
    own.trader.releaseLookup(orders[0]!.orderHash!);
    await pass;
    await own.database.close();
});

test("filled and refunded never both happen", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "hold");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);

    h.trader.release(TOKEN, "fill");
    await Promise.all([
        tracker.tick(),
        h.service.fail(order, "unavailable", "posted"),
        h.service.settle(order, 10_000_000n, 20_000_000n),
    ]);
    await until(async () => (await orderOf(view.requestId))!.state !== "posted");
    await h.service.refreshFloat();

    const final = (await orderOf(view.requestId))!;
    const positions = await h.database.collections.positions.countDocuments({ accountId: account._id });
    const s = await h.state(account._id);
    const refunds = s.rows.filter((r) => r.kind === "prediction_refund").length;
    if (final.state === "filled") {
        expect(positions).toBe(1);
        expect(refunds).toBe(0);
        expect(s.balance).toBe(wei("90"));
    } else {
        expect(final.state).toBe("failed");
        expect(positions).toBe(0);
        expect(refunds).toBe(1);
        expect(s.balance).toBe(wei("100"));
    }
    expect(s.sum).toBe(s.balance);
});

test("a post still in flight in this process is not given up on", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "hold");
    const view = await h.service.place(account, input("10"));
    await posted(view.requestId);

    clock += 121_000;
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");

    h.trader.release(TOKEN, "fill");
    await until(async () => (await orderOf(view.requestId))?.state === "filled");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("a placing order nothing is submitting is refunded after a minute", async () => {
    const account = await h.seedAccount("100");
    const _id = new ObjectId();
    const amount = wei("10");
    await h.ledger.runInTransaction((session) =>
        h.ledger.debitInSession(session, account._id, amount, "prediction_buy", _id),
    );
    const created = new Date(clock);
    await h.database.collections.predictionOrders.insertOne({
        _id,
        accountId: account._id,
        requestId: randomUUID(),
        side: "buy",
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId: TOKEN,
        conditionId: "",
        question: "Will it rain?",
        outcome: "YES",
        amount: toDecimal(amount),
        shares: null,
        quotedPrice: 0.5,
        limitPrice: 0,
        positionId: null,
        orderHash: null,
        clobOrderId: null,
        signed: null,
        state: "placing",
        reason: null,
        filledShares: null,
        cost: null,
        postedAt: null,
        createdAt: created,
        updatedAt: created,
    });

    clock += 30_000;
    await tracker.tick();
    expect((await h.database.collections.predictionOrders.findOne({ _id }))!.state).toBe("placing");

    clock += 31_000;
    await tracker.tick();
    expect(await h.database.collections.predictionOrders.findOne({ _id })).toMatchObject({
        state: "failed",
        reason: "unavailable",
    });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
});

test("a delayed order is open, not missing, until the exchange decides", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);

    expect(await h.trader.lookup({ orderHash: order.orderHash! })).toEqual({ kind: "open" });
    clock += 600_000;
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");

    h.trader.settleDelayed(order.orderHash!, "fill");
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("filled");
});

test("an unknown post that filled is settled by the tracker, not refunded", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "unknown-filled");
    const view = await h.service.place(account, input("10"));
    await sent(await posted(view.requestId));

    clock += 121_000;
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("filled");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("a post whose answer never came back is held, then decided by the trades, not refunded at 2 minutes", async () => {
    const account = await h.seedAccount("100");
    // The post hangs forever, as when the process dies before the answer
    h.trader.onNext(TOKEN, "hold");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    vi.spyOn(h.service, "submitting").mockReturnValue(false);
    try {
        expect((await orderOf(view.requestId))!.postUnknownAt).toBeInstanceOf(Date);
        h.trader.setFound(order.orderHash!, { makingE6: 10_000_000n, takingE6: 20_000_000n });

        clock += 121_000;
        await tracker.tick();
        expect((await orderOf(view.requestId))!.state).toBe("posted");
        expect(h.trader.findFills).not.toContain(order.orderHash);

        clock += 15 * MIN;
        await tracker.tick();
        await tracker.tick();
        expect((await orderOf(view.requestId))!.state).toBe("filled");
        expect(h.trader.findFills.filter((hash) => hash === order.orderHash)).toHaveLength(1);
        const s = await h.state(account._id);
        expect(s.balance).toBe(wei("90"));
        expect(s.sum).toBe(s.balance);
    } finally {
        vi.restoreAllMocks();
    }
});

test("a settle that throws after a filled answer leaves the order held and booked once by findFill", async () => {
    const account = await h.seedAccount("100");
    vi.spyOn(h.service, "settle").mockRejectedValueOnce(new Error("the database blinked"));
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);
    await sent(order);
    // The exchange doesn't know the order by id, only the trades name it
    h.trader.setLookup(order.orderHash!, { kind: "missing" });
    h.trader.setFound(order.orderHash!, { makingE6: 10_000_000n, takingE6: 20_000_000n });

    clock += 121_000;
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");
    expect(h.trader.findFills).not.toContain(order.orderHash);

    clock += 15 * MIN;
    await tracker.tick();
    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("filled");
    expect(h.trader.findFills.filter((hash) => hash === order.orderHash)).toHaveLength(1);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("no order is taken once orders are stopped", async () => {
    const stopped = await predictionHarness();
    try {
        const account = await stopped.seedAccount("100");
        stopped.service.stopOrders();
        await expect(stopped.service.place(account, input("10"))).rejects.toMatchObject({ code: "trading_off" });
    } finally {
        await stopped.database.close();
    }
});
