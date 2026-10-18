import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

let h: Awaited<ReturnType<typeof predictionHarness>>;
beforeAll(async () => {
    h = await predictionHarness();
    await h.service.refreshFloat();
});
afterAll(() => h.database.close());

const input = (amountUSD: string, requestId = randomUUID()) => ({
    requestId,
    eventId: EVENT,
    tokenId: TOKEN,
    amountUSD,
});
const orderOf = (id: string) => h.database.collections.predictionOrders.findOne({ requestId: id });
const settled = async (requestId: string) => {
    await until(async () => {
        const order = await orderOf(requestId);
        return order !== null && order.state !== "placing" && order.state !== "posted";
    });
    return (await orderOf(requestId))!;
};
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind).sort();

test("a filled buy debits, records the shares, and refunds the unspent part", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    expect(view.state).toBe("placing");
    await until(async () => (await orderOf(view.requestId))?.state === "posted");

    const order = (await orderOf(view.requestId))!;
    await h.service.settle(order, 9_000_000n, 18_000_000n);

    const done = (await orderOf(view.requestId))!;
    expect(done.state).toBe("filled");
    expect(fromDecimal(done.cost!)).toBe(wei("9"));
    const position = await h.database.collections.positions.findOne({ accountId: account._id });
    expect(position).toMatchObject({ state: "open", tokenId: TOKEN, question: "Will it rain?", outcome: "YES" });
    expect(fromDecimal(position!.shares)).toBe(18_000_000n);
    expect(fromDecimal(position!.cost)).toBe(wei("9"));
    expect(done.positionId).toEqual(position!._id);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("91"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy", "prediction_refund"]);
    expect(s.sum).toBe(s.balance);
});

test("a buy the trader fills in full keeps the position and balances", async () => {
    const account = await h.seedAccount("100");
    const view = await h.service.place(account, input("10"));
    const order = await settled(view.requestId);
    expect(order.state).toBe("filled");
    const position = await h.database.collections.positions.findOne({ accountId: account._id });
    expect(fromDecimal(position!.shares)).toBe(20_000_000n);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("an unfilled buy refunds in full and fails with price_moved", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "reject:price_moved");
    const view = await h.service.place(account, input("10"));
    const order = await settled(view.requestId);
    expect(order).toMatchObject({ state: "failed", reason: "price_moved" });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy", "prediction_refund"]);
    expect(s.sum).toBe(s.balance);
    expect(await h.database.collections.positions.countDocuments({ accountId: account._id })).toBe(0);
});

test("the same requestId twice is one order and one debit", async () => {
    const account = await h.seedAccount("100");
    const requestId = randomUUID();
    h.trader.onNext(TOKEN, "delay");
    const [a, b] = await Promise.all([
        h.service.place(account, input("10", requestId)),
        h.service.place(account, input("10", requestId)),
    ]);
    const again = await h.service.place(account, input("10", requestId));
    expect(new Set([a.id, b.id, again.id]).size).toBe(1);
    expect(await h.database.collections.predictionOrders.countDocuments({ accountId: account._id })).toBe(1);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy"]);
});

test("a balance that's too low is refused and nothing is written", async () => {
    const account = await h.seedAccount("5");
    const error = await h.service.place(account, input("10")).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("insufficient_funds");
    expect(await h.database.collections.predictionOrders.countDocuments({ accountId: account._id })).toBe(0);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("5"));
    expect(s.rows).toHaveLength(1);
});

test("an amount over the free float is refused with float_short", async () => {
    const own = await predictionHarness();
    try {
        const account = await own.seedAccount("5000");
        own.trader.setBalance(50_000_000n);
        await own.service.refreshFloat();
        const error = await own.service.place(account, input("60")).catch((e: unknown) => e);
        expect(isAppError(error) && error.code).toBe("float_short");
        expect(isAppError(error) && error.message).toBe(
            "Predictions are limited to $50 right now. Try a smaller amount, or try again later. Nothing was spent.",
        );
        expect((await own.state(account._id)).rows).toHaveLength(1);
    } finally {
        await own.database.close();
    }
});

test("an outcome whose minimum is past the free float is refused by name, with the way out", async () => {
    const own = await predictionHarness();
    try {
        const account = await own.seedAccount("5000");
        own.trader.setBalance(2_000_000n);
        await own.service.refreshFloat();
        const offered = own.offered.current!;
        own.offered.current = {
            ...offered,
            outcome: { ...offered.outcome, label: "No change", buyPrice: 0.87, minUSD: 4.35 },
        };
        const error = await own.service.place(account, input("5")).catch((e: unknown) => e);
        expect(isAppError(error) && error.code).toBe("float_short");
        expect(isAppError(error) && error.message).toBe(
            "No change needs at least $4.35, and predictions are limited to $2 right now. Pick another outcome or question, or try again later. Nothing was spent.",
        );
        expect((await own.state(account._id)).rows).toHaveLength(1);
    } finally {
        await own.database.close();
    }
});

test("a float under Polymarket's $1 floor refuses as paused", async () => {
    const own = await predictionHarness();
    try {
        const account = await own.seedAccount("5000");
        own.trader.setBalance(900_000n);
        await own.service.refreshFloat();
        const error = await own.service.place(account, input("5")).catch((e: unknown) => e);
        expect(isAppError(error) && error.code).toBe("float_short");
        expect(isAppError(error) && error.message).toBe(
            "Predictions are paused right now. Try again later. Nothing was spent.",
        );
        expect((await own.state(account._id)).rows).toHaveLength(1);
    } finally {
        await own.database.close();
    }
});

test("two concurrent orders can't overdraw", async () => {
    const account = await h.seedAccount("10");
    h.trader.onNext(TOKEN, "delay");
    const results = await Promise.allSettled([
        h.service.place(account, input("6")),
        h.service.place(account, input("6")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("4"));
    expect(s.sum).toBe(s.balance);
});

test("a sign failure fails with unavailable and refunds", async () => {
    const account = await h.seedAccount("100");
    h.trader.failSign(TOKEN);
    const view = await h.service.place(account, input("10"));
    const order = await settled(view.requestId);
    expect(order).toMatchObject({ state: "failed", reason: "unavailable" });
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("100"));
    expect(s.sum).toBe(s.balance);
});

test("recover refunds placing orders once", async () => {
    const account = await h.seedAccount("100");
    // a crash left an order placing with its money held, so rewind one whose post never answers
    h.trader.onNext(TOKEN, "hold");
    const crashed = await h.service.place(account, input("20"));
    await until(async () => (await orderOf(crashed.requestId))?.state === "posted");
    await h.database.collections.predictionOrders.updateOne(
        { requestId: crashed.requestId },
        { $set: { state: "placing" } },
    );
    const before = await h.state(account._id);

    await h.service.recover();
    await h.service.recover();

    const order = (await orderOf(crashed.requestId))!;
    expect(order).toMatchObject({ state: "failed", reason: "unavailable" });
    const after = await h.state(account._id);
    expect(after.balance - before.balance).toBe(wei("20"));
    expect(after.rows.filter((r) => r.refId.equals(order._id) && r.kind === "prediction_refund")).toHaveLength(1);
    expect(after.sum).toBe(after.balance);
});

test("recover leaves a posted order alone: no refund row and the debit stays", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("20"));
    await until(async () => (await orderOf(view.requestId))?.state === "posted");

    await h.service.recover();

    const order = (await orderOf(view.requestId))!;
    expect(order.state).toBe("posted");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("80"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy"]);
    expect(s.sum).toBe(s.balance);
});

test("settling the same exact-spend fill twice books its shares once", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(view.requestId))?.state === "posted");
    const order = (await orderOf(view.requestId))!;

    // Spending the whole amount leaves no refund row for ref_unique to reject a repeat with
    await h.service.settle(order, 10_000_000n, 20_000_000n);
    await h.service.settle(order, 10_000_000n, 20_000_000n);

    const positions = await h.database.collections.positions.find({ accountId: account._id }).toArray();
    expect(positions).toHaveLength(1);
    expect(fromDecimal(positions[0]!.shares)).toBe(20_000_000n);
    expect(fromDecimal(positions[0]!.cost)).toBe(wei("10"));
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy"]);
    expect(s.sum).toBe(s.balance);
});

test("maxOrderUSD is null while trading is off and the free float when on", async () => {
    const on = await predictionHarness();
    const off = await predictionHarness({ trading: "off" });
    try {
        on.trader.setBalance(100_500_000n);
        await on.service.refreshFloat();
        expect(on.service.maxOrderUSD()).toBe(100);
        await off.service.refreshFloat();
        expect(off.service.maxOrderUSD()).toBeNull();
        const account = await off.seedAccount("10");
        const error = await off.service.place(account, input("5")).catch((e: unknown) => e);
        expect(isAppError(error) && error.code).toBe("trading_off");
    } finally {
        await on.database.close();
        await off.database.close();
    }
});

test("below the minimum and a closed market are refused before any hold", async () => {
    const account = await h.seedAccount("10");
    const low = await h.service.place(account, input("0.5")).catch((e: unknown) => e);
    expect(isAppError(low) && low.message).toBe("The minimum for this prediction is $1.");
    const saved = h.offered.current;
    h.offered.current = null;
    const closed = await h.service.place(account, input("5")).catch((e: unknown) => e);
    h.offered.current = saved;
    expect(isAppError(closed) && closed.code).toBe("market_closed");
    expect((await h.state(account._id)).rows).toHaveLength(1);
});

test("a quote prices the fill and refuses a book that can't fill", async () => {
    const quote = await h.service.quote({ eventId: EVENT, tokenId: TOKEN, amountUSD: "10" });
    expect(quote).toMatchObject({
        shares: "20",
        avgPrice: 0.5,
        worstPrice: 0.5,
        feeUSD: "0",
        payoutUSD: "20",
        minUSD: 1,
    });
    const error = await h.service.quote({ eventId: EVENT, tokenId: TOKEN, amountUSD: "900" }).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("price_moved");
});

test("a retried requestId returns the same view even when the checks would now refuse", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        const requestId = randomUUID();
        own.trader.onNext(TOKEN, "hold");
        const first = await own.service.place(account, input("10", requestId));

        const saved = own.offered.current;
        own.offered.current = null;
        const closed = await own.service.place(account, input("10", requestId));
        own.offered.current = saved;
        own.trader.setBalance(1_000_000n);
        await own.service.refreshFloat();
        const short = await own.service.place(account, input("10", requestId));
        own.config.PREDICTIONS_TRADING = "off";
        const off = await own.service.place(account, input("10", requestId));

        expect([closed.id, short.id, off.id]).toEqual([first.id, first.id, first.id]);
        expect((await own.state(account._id)).balance).toBe(wei("90"));
        await until(async () => own.trader.posts.length === 1);
        own.trader.release(TOKEN, "fill");
    } finally {
        await own.database.close();
    }
});

test("a posted write that fails refunds the order instead of leaving it placing", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        const orders = own.database.collections.predictionOrders;
        vi.spyOn(orders, "findOneAndUpdate").mockRejectedValueOnce(new Error("mongo blip"));
        const view = await own.service.place(account, input("10"));
        await until(async () => (await orders.findOne({ requestId: view.requestId }))?.state === "failed");
        expect(await orders.findOne({ requestId: view.requestId })).toMatchObject({ reason: "unavailable" });
        const s = await own.state(account._id);
        expect(s.balance).toBe(wei("100"));
        expect(s.sum).toBe(s.balance);
    } finally {
        vi.restoreAllMocks();
        await own.database.close();
    }
});

test("a fill that costs more than the amount is clamped to it with no refund", async () => {
    const own = await predictionHarness({ feeRate: 0.05 });
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        own.trader.onNext(TOKEN, "delay");
        const view = await own.service.place(account, input("10"));
        const orders = own.database.collections.predictionOrders;
        await until(async () => (await orders.findOne({ requestId: view.requestId }))?.state === "posted");
        const order = (await orders.findOne({ requestId: view.requestId }))!;

        // 20 shares at 0.50 plus the 0.25 fee comes to 10.25
        await own.service.settle(order, 10_000_000n, 20_000_000n);

        const done = (await orders.findOne({ requestId: view.requestId }))!;
        expect(done.state).toBe("filled");
        expect(fromDecimal(done.cost!)).toBe(wei("10"));
        const s = await own.state(account._id);
        expect(s.balance).toBe(wei("90"));
        expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy"]);
        expect(s.sum).toBe(s.balance);
    } finally {
        await own.database.close();
    }
});

test("a fee-bearing fill through the trader refunds only what it left unspent", async () => {
    const own = await predictionHarness({ feeRate: 0.05 });
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        const view = await own.service.place(account, input("10"));
        const orders = own.database.collections.predictionOrders;
        await until(async () => (await orders.findOne({ requestId: view.requestId }))?.state === "filled");
        const done = (await orders.findOne({ requestId: view.requestId }))!;
        const cost = fromDecimal(done.cost!);
        expect(cost).toBeLessThanOrEqual(wei("10"));
        expect(cost).toBeGreaterThan(wei("9.99"));
        const s = await own.state(account._id);
        expect(s.balance).toBe(wei("100") - cost);
        expect(kinds(s.rows)).toEqual(
            cost < wei("10") ? ["deposit", "prediction_buy", "prediction_refund"] : ["deposit", "prediction_buy"],
        );
        expect(s.sum).toBe(s.balance);
    } finally {
        await own.database.close();
    }
});

test("settling and failing use the account of the stored order, not the one in hand", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const filled = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(filled.requestId))?.state === "posted");
    const stale = { ...(await orderOf(filled.requestId))!, accountId: new ObjectId() };
    await h.service.settle(stale, 10_000_000n, 20_000_000n);
    expect(await h.database.collections.positions.countDocuments({ accountId: stale.accountId })).toBe(0);
    expect(await h.database.collections.positions.countDocuments({ accountId: account._id })).toBe(1);

    h.trader.onNext(TOKEN, "delay");
    const failed = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(failed.requestId))?.state === "posted");
    await h.service.fail({ ...(await orderOf(failed.requestId))!, accountId: new ObjectId() }, "rejected", "posted");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.sum).toBe(s.balance);
});

test("positions keeps settled ones for the whole chart window, and drops older ones", async () => {
    const account = await h.seedAccount("100");
    const day = 86_400_000;
    const settledAgo = async (days: number) => {
        const at = new Date(Date.now() - days * day);
        const _id = new ObjectId();
        await h.database.collections.positions.insertOne({
            _id,
            accountId: account._id,
            eventId: EVENT,
            marketId: "mkt-1",
            tokenId: TOKEN,
            conditionId: "0xcondition",
            question: "Will it rain?",
            outcome: "YES",
            shares: toDecimal(10_000_000n),
            cost: toDecimal(wei("5")),
            state: "lost",
            proceeds: null,
            payout: toDecimal(0n),
            openedAt: at,
            settledAt: at,
            updatedAt: at,
        });
        return _id.toHexString();
    };
    const tenDays = await settledAgo(10);
    const monthAgo = await settledAgo(29);
    const ancient = await settledAgo(60);

    const ids = (await h.service.positions(account)).positions.map((p) => p.id);
    expect(ids).toContain(tenDays);
    expect(ids).toContain(monthAgo);
    expect(ids).not.toContain(ancient);
});

test("a buy quoted far above the server price keeps the server's limit", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        const view = await own.service.place(account, { ...input("10"), quotedPrice: 0.98 });
        await until(async () => own.trader.posts.length === 1);
        expect(own.trader.posts[0]!.signed).toMatchObject({ side: "BUY", maxPrice: 0.52 });
        const order = (await own.database.collections.predictionOrders.findOne({ requestId: view.requestId }))!;
        expect(order).toMatchObject({ quotedPrice: 0.5, limitPrice: 0.52, clientPrice: 0.98 });
    } finally {
        await own.database.close();
    }
});

test("a buy quoted lower than the server price by under 2 cents keeps the client's tighter limit", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        await own.service.place(account, { ...input("10"), quotedPrice: 0.49 });
        await until(async () => own.trader.posts.length === 1);
        expect(own.trader.posts[0]!.signed).toMatchObject({ maxPrice: 0.51 });
    } finally {
        await own.database.close();
    }
});

test("a buy the market moved more than 2 cents past is price_moved before any hold", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        own.offered.current!.outcome.buyPrice = 0.53;
        const requestId = randomUUID();
        const error = await own.service.place(account, { ...input("10", requestId), quotedPrice: 0.5 }).catch((e) => e);
        expect(isAppError(error) && error.code).toBe("price_moved");
        expect(isAppError(error) && error.message).toBe(
            "The price moved from 50c to 53c, so your prediction didn't go through. Nothing was spent.",
        );
        expect(await own.database.collections.predictionOrders.countDocuments({ requestId })).toBe(0);
        const s = await own.state(account._id);
        expect(s.balance).toBe(wei("100"));
        expect(kinds(s.rows)).toEqual(["deposit"]);
        expect(own.trader.posts).toHaveLength(0);
    } finally {
        await own.database.close();
    }
});

test("exactly 2 cents of movement is still allowed", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        own.offered.current!.outcome.buyPrice = 0.52;
        await own.service.place(account, { ...input("10"), quotedPrice: 0.5 });
        await until(async () => own.trader.posts.length === 1);
        expect(own.trader.posts[0]!.signed).toMatchObject({ maxPrice: 0.52 });
    } finally {
        await own.database.close();
    }
});

test("a requestId retry still returns the original order even if the price now differs", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const account = await own.seedAccount("100");
        const first = { ...input("10"), quotedPrice: 0.5 };
        const view = await own.service.place(account, first);
        own.offered.current!.outcome.buyPrice = 0.7;
        const again = await own.service.place(account, first);
        expect(again.id).toBe(view.id);
        expect(await own.database.collections.predictionOrders.countDocuments({ requestId: first.requestId })).toBe(1);
    } finally {
        await own.database.close();
    }
});

test("a post that answers unknown records postUnknownAt, and a clear answer does not", async () => {
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "unknown");
    const unknown = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(unknown.requestId))?.postUnknownAt != null);
    expect(await orderOf(unknown.requestId)).toMatchObject({ state: "posted" });

    h.trader.onNext(TOKEN, "delay");
    const clear = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(clear.requestId))?.clobOrderId != null);
    expect(await orderOf(clear.requestId)).toMatchObject({ state: "posted", postUnknownAt: null });
});
