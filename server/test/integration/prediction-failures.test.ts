import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { orderView } from "../../src/predictions/views.ts";
import { BOOK, EVENT, predictionHarness, TOKEN, until } from "../support/prediction-harness.ts";

type Line = Record<string, unknown> & { level: number; msg: string };

let lines: Line[] = [];
let h: Awaited<ReturnType<typeof predictionHarness>>;
beforeAll(async () => {
    const logger = pino({ level: "debug" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
    h = await predictionHarness({ logger });
    await h.service.refreshFloat();
});
afterAll(() => h.database.close());

const WARN = 40;
const ERROR = 50;

const input = (amountUSD: string) => ({ requestId: randomUUID(), eventId: EVENT, tokenId: TOKEN, amountUSD });
const orderOf = (requestId: string) => h.database.collections.predictionOrders.findOne({ requestId });
const failed = async (requestId: string) => {
    await until(async () => (await orderOf(requestId))?.state === "failed");
    return (await orderOf(requestId))!;
};
// The log line follows the committed refund, so it is awaited rather than assumed
const about = async (order: { _id: { toHexString(): string } }) => {
    const mine = () => lines.filter((line) => line.order === order._id.toHexString());
    await until(async () => mine().length > 0);
    return mine();
};

async function place(refuse: () => void) {
    lines = [];
    const account = await h.seedAccount("100");
    refuse();
    const view = await h.service.place(account, input("10"));
    const order = await failed(view.requestId);
    return { account, order, logs: await about(order) };
}

test("an unknown Polymarket refusal is stored, logged once at error with Polymarket's words, and quoted to the person", async () => {
    const { account, order, logs } = await place(() =>
        h.trader.refuseNext(TOKEN, {
            reason: "rejected",
            message: "invalid order size",
            code: "unknown",
            status: 400,
        }),
    );
    expect(order).toMatchObject({ state: "failed", reason: "rejected", detail: "invalid order size" });
    expect(order.message).toBe('Polymarket refused the order: "invalid order size". Nothing was spent.');
    expect(orderView(order).message).toBe(order.message);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
        level: ERROR,
        msg: expect.stringContaining("Polymarket refused a prediction"),
        account: account._id.toHexString(),
        side: "buy",
        tokenId: TOKEN,
        amountUSD: "10",
        quotedPrice: 0.5,
        limitPrice: 0.52,
        worstPrice: 0.5,
        polymarketCode: "unknown",
        polymarketMessage: "invalid order size",
        polymarketStatus: 400,
        reason: "rejected",
    });
});

test("a minimum-size refusal is a warning with a plain sentence of its own", async () => {
    const { order, logs } = await place(() =>
        h.trader.refuseNext(TOKEN, {
            reason: "rejected",
            message: "Size (4.35) lower than the minimum: 5",
            status: 400,
        }),
    );
    expect(order.message).toBe("That's under Polymarket's minimum of 5 shares for this market. Nothing was spent.");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: WARN, polymarketMessage: "Size (4.35) lower than the minimum: 5" });
});

test("not enough balance on our pool says it is on our side and logs at error", async () => {
    const { order, logs } = await place(() =>
        h.trader.refuseNext(TOKEN, {
            reason: "unavailable",
            message: "not enough balance / allowance: the balance is not enough",
            code: "insufficient_balance_or_allowance",
        }),
    );
    expect(order).toMatchObject({ reason: "unavailable" });
    expect(order.message).toBe(
        "Our Polymarket balance can't cover this order right now. That's on our side, not yours. Nothing was spent.",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: ERROR, polymarketCode: "insufficient_balance_or_allowance" });
});

test("an exception while preparing becomes a reference the log carries, with the error", async () => {
    const { order, logs } = await place(() => h.trader.failSign(TOKEN));
    const ref = order._id.toHexString().slice(-6);
    expect(order).toMatchObject({ reason: "unavailable", detail: "signing failed" });
    expect(order.message).toBe(`Something went wrong on our side (ref ${ref}). Nothing was spent.`);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
        level: ERROR,
        msg: "Couldn't prepare a prediction: signing failed; the amount was refunded",
        ref,
        err: { message: "signing failed" },
    });
    expect(String(logs[0]!.order)).toContain(ref);
});

test("a price that moved past the limit before sending logs the quote, the limit and the book's worst price", async () => {
    lines = [];
    const account = await h.seedAccount("100");
    const asks = BOOK.asks[0]!;
    const before = asks.price;
    try {
        asks.price = 0.6;
        const view = await h.service.place(account, input("10"));
        const order = await failed(view.requestId);
        expect(order).toMatchObject({ reason: "price_moved" });
        expect(order.detail).toBe("the book's worst price 0.6 is over the limit 0.52");
        expect(order.message).toBe("The price moved, so your prediction didn't go through. Nothing was spent.");
        const logs = await about(order);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
            level: WARN,
            msg: expect.stringContaining("The price moved past a prediction's limit before it was sent"),
            quotedPrice: 0.5,
            limitPrice: 0.52,
            worstPrice: 0.6,
            amountUSD: "10",
        });
    } finally {
        asks.price = before;
    }
});

test("a failure that carries no reason still leaves a log line and a reference", async () => {
    lines = [];
    const account = await h.seedAccount("100");
    h.trader.onNext(TOKEN, "delay");
    const view = await h.service.place(account, input("10"));
    await until(async () => (await orderOf(view.requestId))?.state === "posted");
    const posted = (await orderOf(view.requestId))!;
    await h.service.fail(posted, "rejected", "posted");
    const order = (await orderOf(view.requestId))!;
    expect(order.message).toBe(
        `Something went wrong on our side (ref ${order._id.toHexString().slice(-6)}). Nothing was spent.`,
    );
    expect((await about(order)).filter((line) => line.level === ERROR)).toHaveLength(1);
});
