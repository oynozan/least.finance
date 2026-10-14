import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AccountDoc, PositionDoc, PredictionOrderDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { PredictionReconciler } from "../../src/predictions/reconciler.ts";
import { PredictionTracker } from "../../src/predictions/tracker.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

const clock = 1_000_000;
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

type Harness = Awaited<ReturnType<typeof predictionHarness>>;

/** An open position of `sharesE6` bought for $10, on an account holding `usdc`. */
async function holder(own: Harness, usdc = "90", sharesE6 = 20_000_000n) {
    const account = await own.seedAccount(usdc);
    const now = new Date();
    const position: PositionDoc = {
        _id: new ObjectId(),
        accountId: account._id,
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId: TOKEN,
        conditionId: "0xcondition",
        question: "Will it rain?",
        outcome: "YES",
        shares: toDecimal(sharesE6),
        cost: toDecimal(wei("10")),
        state: "open",
        proceeds: null,
        payout: null,
        openedAt: now,
        settledAt: null,
        updatedAt: now,
    };
    await own.database.collections.positions.insertOne(position);
    return { account, position };
}

const closeInput = (position: PositionDoc, requestId: string = randomUUID()) => ({
    requestId,
    positionId: position._id.toHexString(),
    quotedPrice: 0.48,
});
const orderOf = (own: Harness, requestId: string) => own.database.collections.predictionOrders.findOne({ requestId });
const positionOf = (own: Harness, id: ObjectId) => own.database.collections.positions.findOne({ _id: id });
const settled = async (own: Harness, requestId: string) => {
    await until(async () => {
        const order = await orderOf(own, requestId);
        return order !== null && order.state !== "placing" && order.state !== "posted";
    });
    return (await orderOf(own, requestId))!;
};
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind).sort();

test("a filled close credits the proceeds and closes the position", async () => {
    const { account, position } = await holder(h);
    const view = await h.service.close(account, closeInput(position));
    expect(view).toMatchObject({ side: "sell", state: "placing", positionId: position._id.toHexString() });
    const order = await settled(h, view.requestId);

    expect(order).toMatchObject({ state: "filled", side: "sell" });
    const closed = (await positionOf(h, position._id))!;
    expect(closed.state).toBe("closed");
    expect(fromDecimal(closed.proceeds!)).toBe(wei("9.6"));
    expect(closed.settledAt).toBeInstanceOf(Date);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("99.6"));
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_sell"]);
    expect(s.sum).toBe(s.balance);
});

test("a close is net of the fee, and the pool's gross proceeds cover it", async () => {
    const own = await predictionHarness({ feeRate: 0.05 });
    try {
        const { account, position } = await holder(own);
        const before = await own.trader.balanceE6();
        const view = await own.service.close(account, closeInput(position));
        await settled(own, view.requestId);

        // 20 shares at 0.48 is $9.60 gross, and the fee is 20 x 0.05 x 0.48 x 0.52 = $0.2496
        expect(fromDecimal((await positionOf(own, position._id))!.proceeds!)).toBe(wei("9.3504"));
        expect(await own.trader.balanceE6()).toBe(before + 9_350_400n);
        const s = await own.state(account._id);
        expect(s.balance).toBe(wei("99.3504"));
        expect(s.sum).toBe(s.balance);
    } finally {
        await own.database.close();
    }
});

test("a rejected close reopens the position and moves no money", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "reject:price_moved");
    const view = await h.service.close(account, closeInput(position));
    const order = await settled(h, view.requestId);

    expect(order).toMatchObject({ state: "failed", reason: "price_moved" });
    expect((await positionOf(h, position._id))!.state).toBe("open");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.rows).toHaveLength(1);
    expect(s.sum).toBe(s.balance);
});

test("a second close with another requestId is position_busy; the same requestId returns the same order", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "delay");
    const first = await h.service.close(account, closeInput(position));
    const error = await h.service.close(account, closeInput(position)).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("position_busy");
    expect(isAppError(error) && error.message).toBe("This position is already being sold.");

    const again = await h.service.close(account, closeInput(position, first.requestId));
    expect(again.id).toBe(first.id);
    expect(await h.database.collections.predictionOrders.countDocuments({ positionId: position._id })).toBe(1);
    expect((await positionOf(h, position._id))!.state).toBe("closing");
});

test("a position that isn't the person's, or isn't open, is not_found", async () => {
    const { position } = await holder(h);
    const other = await h.seedAccount("1");
    const stranger = await h.service.close(other, closeInput(position)).catch((e: unknown) => e);
    expect(isAppError(stranger) && stranger.code).toBe("not_found");

    const { account, position: done } = await holder(h);
    await h.database.collections.positions.updateOne({ _id: done._id }, { $set: { state: "closed" } });
    const closed = await h.service.close(account, closeInput(done)).catch((e: unknown) => e);
    expect(isAppError(closed) && closed.code).toBe("not_found");
});

test("a position below the minimum size can't be closed", async () => {
    const { account, position } = await holder(h, "90", 4_990_000n);
    const error = await h.service.close(account, closeInput(position)).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("below_minimum");
    expect(isAppError(error) && error.message).toBe("Too small to sell. It pays out when the market resolves.");
    expect((await positionOf(h, position._id))!.state).toBe("open");
    expect(await h.database.collections.predictionOrders.countDocuments({ positionId: position._id })).toBe(0);
});

test("shares are sold floored to 0.01 and the position closes", async () => {
    const { account, position } = await holder(h, "90", 20_123_456n);
    const view = await h.service.close(account, closeInput(position));
    const order = await settled(h, view.requestId);

    expect(order.state).toBe("filled");
    expect(h.trader.posts.at(-1)!.signed).toMatchObject({ side: "SELL", sharesE6: "20120000" });
    expect((await positionOf(h, position._id))!.state).toBe("closed");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("99.6576"));
    expect(s.sum).toBe(s.balance);
});

test("a sell that can't be prepared reopens the position", async () => {
    const { account, position } = await holder(h);
    h.trader.failSign(TOKEN);
    const view = await h.service.close(account, closeInput(position));
    const order = await settled(h, view.requestId);
    expect(order).toMatchObject({ state: "failed", reason: "unavailable" });
    expect((await positionOf(h, position._id))!.state).toBe("open");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
});

test("a placing sell is failed and its position reopened by recover", async () => {
    const { account, position } = await holder(h, "90");
    await h.database.collections.positions.updateOne({ _id: position._id }, { $set: { state: "closing" } });
    const order = placingSell(account, position);
    await h.database.collections.predictionOrders.insertOne(order);

    await h.service.recover();

    expect((await orderOf(h, order.requestId))!.state).toBe("failed");
    expect((await positionOf(h, position._id))!.state).toBe("open");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("90"));
    expect(s.rows).toHaveLength(1);
});

test("a delayed sell is settled by the tracker", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.close(account, closeInput(position));
    await until(async () => (await orderOf(h, view.requestId))?.state === "posted");
    const order = (await orderOf(h, view.requestId))!;
    await until(
        async () => h.trader.posts.some((p) => p.orderHash === order.orderHash) && !h.service.submitting(order._id),
    );

    await tracker.tick();
    expect((await orderOf(h, view.requestId))!.state).toBe("posted");
    expect((await positionOf(h, position._id))!.state).toBe("closing");

    h.trader.settleDelayed(order.orderHash!, "fill");
    await tracker.tick();

    expect((await orderOf(h, view.requestId))!.state).toBe("filled");
    expect((await positionOf(h, position._id))!.state).toBe("closed");
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("99.6"));
    expect(s.sum).toBe(s.balance);
});

test("a delayed sell the exchange cancels reopens the position", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.close(account, closeInput(position));
    await until(async () => (await orderOf(h, view.requestId))?.state === "posted");
    const order = (await orderOf(h, view.requestId))!;
    await until(
        async () => h.trader.posts.some((p) => p.orderHash === order.orderHash) && !h.service.submitting(order._id),
    );

    h.trader.settleDelayed(order.orderHash!, "cancel");
    await tracker.tick();

    expect((await orderOf(h, view.requestId))!.state).toBe("failed");
    expect((await positionOf(h, position._id))!.state).toBe("open");
    expect((await h.state(account._id)).balance).toBe(wei("90"));
});

test("a close is refused while a buy of the same token is in flight, and that buy then lands in the open position", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "delay");
    const buy = await h.service.place(account, {
        requestId: randomUUID(),
        eventId: EVENT,
        tokenId: TOKEN,
        amountUSD: "10",
    });
    await until(async () => (await orderOf(h, buy.requestId))?.state === "posted");
    const bought = (await orderOf(h, buy.requestId))!;
    await until(
        async () => h.trader.posts.some((p) => p.orderHash === bought.orderHash) && !h.service.submitting(bought._id),
    );

    const error = await h.service.close(account, closeInput(position)).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("position_busy");
    expect((await positionOf(h, position._id))!.state).toBe("open");

    h.trader.settleDelayed(bought.orderHash!, "fill");
    await tracker.tick();
    const after = (await positionOf(h, position._id))!;
    expect(after.state).toBe("open");
    expect(fromDecimal(after.shares)).toBe(20_000_000n + fromDecimal((await orderOf(h, buy.requestId))!.filledShares!));
});

test("shares bought while a sell is posted stay open after the sell settles", async () => {
    const { account, position } = await holder(h);
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.close(account, closeInput(position));
    await until(async () => (await orderOf(h, view.requestId))?.state === "posted");
    const sell = (await orderOf(h, view.requestId))!;
    await until(
        async () => h.trader.posts.some((p) => p.orderHash === sell.orderHash) && !h.service.submitting(sell._id),
    );

    const buy = await h.service.place(account, {
        requestId: randomUUID(),
        eventId: EVENT,
        tokenId: TOKEN,
        amountUSD: "10",
    });
    const bought = await settled(h, buy.requestId);
    expect(bought.state).toBe("filled");
    const extra = fromDecimal(bought.filledShares!);

    h.trader.settleDelayed(sell.orderHash!, "fill");
    await tracker.tick();

    expect((await orderOf(h, view.requestId))!.state).toBe("filled");
    const left = (await positionOf(h, position._id))!;
    expect(left.state).toBe("open");
    expect(fromDecimal(left.shares)).toBe(extra);
    expect(fromDecimal(left.cost)).toBe(fromDecimal(bought.cost!));
    expect(left.settledAt).toBeNull();
    const s = await h.state(account._id);
    expect(kinds(s.rows)).toEqual(["deposit", "prediction_buy", "prediction_sell"]);
    expect(s.sum).toBe(s.balance);
});

/** A posted sell of the holder's 20 shares, then a $10 buy of the same token that fills while the sell is out */
async function sellWithBuyDuring(own: Harness) {
    const { account, position } = await holder(own);
    own.trader.onNext(TOKEN, "delay");
    const view = await own.service.close(account, closeInput(position));
    await until(async () => (await orderOf(own, view.requestId))?.state === "posted");
    const sell = (await orderOf(own, view.requestId))!;
    await until(
        async () => own.trader.posts.some((p) => p.orderHash === sell.orderHash) && !own.service.submitting(sell._id),
    );
    const buy = await own.service.place(account, {
        requestId: randomUUID(),
        eventId: EVENT,
        tokenId: TOKEN,
        amountUSD: "10",
    });
    const bought = await settled(own, buy.requestId);
    expect(bought.state).toBe("filled");
    return { account, position, view, sell, bought };
}

test("a buy that fills while a sell is out leaves the position open and records the sold part on the sell order", async () => {
    const { account, position, view, sell } = await sellWithBuyDuring(h);
    const seen: PredictionOrderDoc[] = [];
    const listener = (update: { order: PredictionOrderDoc }) => {
        if (update.order._id.equals(sell._id)) seen.push(update.order);
    };
    h.bus.on("prediction:updated", listener);

    h.trader.settleDelayed(sell.orderHash!, "fill");
    await tracker.tick();
    h.bus.off("prediction:updated", listener);

    const order = (await orderOf(h, view.requestId))!;
    const left = (await positionOf(h, position._id))!;
    const s = await h.state(account._id);
    const credited = s.rows.find((row) => row.kind === "prediction_sell")!;
    expect(order.soldPart).toBeDefined();
    expect(fromDecimal(order.soldPart!.cost) + fromDecimal(left.cost)).toBe(wei("20"));
    expect(fromDecimal(order.soldPart!.proceeds)).toBe(fromDecimal(credited.amount));
    expect(order.soldPart!.at).toBeInstanceOf(Date);
    expect(await h.database.collections.positions.countDocuments({ accountId: account._id })).toBe(1);
    expect(left.state).toBe("open");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.soldPart).toBeDefined();
    expect(fromDecimal(seen[0]!.soldPart!.cost)).toBe(fromDecimal(order.soldPart!.cost));
});

test("a sell that closes the position sets no soldPart", async () => {
    const { account, position } = await holder(h);
    const view = await h.service.close(account, closeInput(position));
    const order = await settled(h, view.requestId);

    expect(order.state).toBe("filled");
    expect((await positionOf(h, position._id))!.state).toBe("closed");
    expect("soldPart" in order).toBe(false);
});

test("a partial sell fill that fails midway leaves no sold part", async () => {
    const own = await predictionHarness({ now: () => clock });
    try {
        await own.service.refreshFloat();
        const { account, position, sell } = await sellWithBuyDuring(own);
        const before = (await positionOf(own, position._id))!;
        await own.database.collections.accounts.deleteOne({ _id: account._id });

        await expect(own.service.settle(sell, 20_000_000n, 9_600_000n)).rejects.toThrow();

        const order = (await orderOf(own, sell.requestId))!;
        const after = (await positionOf(own, position._id))!;
        expect(order.state).toBe("posted");
        expect("soldPart" in order).toBe(false);
        expect(after.state).toBe("closing");
        expect(fromDecimal(after.shares)).toBe(fromDecimal(before.shares));
        expect(fromDecimal(after.cost)).toBe(fromDecimal(before.cost));
        expect(
            await own.database.collections.ledger.countDocuments({ accountId: account._id, kind: "prediction_sell" }),
        ).toBe(0);
    } finally {
        await own.database.close();
    }
});

test("after a partial sale the reconciler finds no mismatch", async () => {
    const own = await predictionHarness({ now: () => clock });
    try {
        const logs: { msg: string }[] = [];
        const logger = pino({ level: "debug" }, { write: (line: string) => void logs.push(JSON.parse(line)) });
        await own.service.refreshFloat();
        // The holder's shares never went through the trader
        own.trader.setHoldings([{ tokenId: TOKEN, sharesE6: 20_000_000n }]);
        const ownTracker = new PredictionTracker({
            collections: own.database.collections,
            service: own.service,
            trader: () => own.trader,
            logger: own.logger,
            pollMs: 0,
            now: () => clock,
        });
        const { sell } = await sellWithBuyDuring(own);
        own.trader.settleDelayed(sell.orderHash!, "fill");
        await ownTracker.tick();
        expect((await orderOf(own, sell.requestId))!.soldPart).toBeDefined();

        await new PredictionReconciler({
            collections: own.database.collections,
            trader: () => own.trader,
            logger,
            intervalMs: 0,
        }).tick();

        expect(logs.map((line) => line.msg)).not.toContain("The pool's holdings don't match the positions");
    } finally {
        await own.database.close();
    }
});

test("the sell quote is net of the fee and over the sellable shares", async () => {
    const { account, position } = await holder(h, "90", 20_123_456n);
    const quote = await h.service.quoteSell(account, position._id.toHexString());
    expect(quote).toEqual({
        positionId: position._id.toHexString(),
        side: "sell",
        shares: "20.12",
        proceedsUSD: "9.6576",
        avgPrice: 0.48,
        worstPrice: 0.48,
        feeUSD: "0",
        minShares: 5,
    });
});

function placingSell(account: AccountDoc, position: PositionDoc): PredictionOrderDoc {
    const now = new Date();
    return {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        side: "sell",
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId: TOKEN,
        conditionId: "",
        question: "Will it rain?",
        outcome: "YES",
        amount: toDecimal(0n),
        shares: position.shares,
        quotedPrice: 0.48,
        limitPrice: 0,
        positionId: position._id,
        orderHash: null,
        clobOrderId: null,
        signed: null,
        state: "placing",
        reason: null,
        filledShares: null,
        cost: null,
        postedAt: null,
        createdAt: now,
        updatedAt: now,
    };
}

const withBids = (own: Harness, bids: { price: number; size: number }[]) => {
    const book = own.trader.book.bind(own.trader);
    own.trader.book = async (tokenId: string) => ({ ...(await book(tokenId)), bids });
};

test("a sell quoted far under the best bid keeps the bid-based floor", async () => {
    const own = await predictionHarness();
    try {
        await own.service.refreshFloat();
        const { account, position } = await holder(own);
        const view = await own.service.close(account, { ...closeInput(position), quotedPrice: 0.01 });
        await until(async () => own.trader.posts.length === 1);
        expect(own.trader.posts[0]!.signed).toMatchObject({ side: "SELL", minPrice: 0.46 });
        const order = (await orderOf(own, view.requestId))!;
        expect(order).toMatchObject({ quotedPrice: 0.48, clientPrice: 0.01 });
    } finally {
        await own.database.close();
    }
});

test("a sell the bid fell more than 2 cents under is price_moved and the position stays open", async () => {
    const own = await predictionHarness();
    try {
        const { account, position } = await holder(own);
        withBids(own, [{ price: 0.44, size: 1000 }]);
        const input = closeInput(position);
        const error = await own.service.close(account, input).catch((e) => e);
        expect(isAppError(error) && error.code).toBe("price_moved");
        expect(isAppError(error) && error.message).toContain("Nothing was spent.");
        expect((await positionOf(own, position._id))!.state).toBe("open");
        expect(await orderOf(own, input.requestId)).toBeNull();
    } finally {
        await own.database.close();
    }
});

test("a sell into an empty bid side is price_moved", async () => {
    const own = await predictionHarness();
    try {
        const { account, position } = await holder(own);
        withBids(own, []);
        const error = await own.service.close(account, closeInput(position)).catch((e) => e);
        expect(isAppError(error) && error.code).toBe("price_moved");
        expect((await positionOf(own, position._id))!.state).toBe("open");
    } finally {
        await own.database.close();
    }
});
