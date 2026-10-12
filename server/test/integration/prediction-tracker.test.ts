import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { PredictionTracker } from "../../src/predictions/tracker.ts";
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

test("a delayed order is settled by the tracker when it fills", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    const order = await posted(view.requestId);

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
    h.trader.settleDelayed(order.orderHash!, "cancel");
    await tracker.tick();
    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", reason: "price_moved" });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
});

test("an unknown post that turns up missing after 2 minutes is refunded", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "unknown");
    const view = await h.service.place(account, input("10"));
    await posted(view.requestId);

    await tracker.tick();
    expect((await orderOf(view.requestId))!.state).toBe("posted");

    clock += 121_000;
    await tracker.tick();
    expect(await orderOf(view.requestId)).toMatchObject({ state: "failed", reason: "unavailable" });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
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
