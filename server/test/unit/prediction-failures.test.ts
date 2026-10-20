import { ObjectId } from "mongodb";
import { expect, test } from "vitest";
import {
    cancelled,
    couldntPrepare,
    isUpstreamFailure,
    polymarketRefused,
    priceMoved,
} from "../../src/predictions/failures.ts";

const buy = { _id: new ObjectId("66f000000000000000abcdef"), side: "buy" } as const;
const sell = { ...buy, side: "sell" } as const;
const refusal = (message: string, code?: string) => ({ reason: "rejected" as const, message, code });

test.each([
    [
        "Size (4.35) lower than the minimum: 5",
        undefined,
        "warn",
        "That's under Polymarket's minimum of 5 shares for this market. Nothing was spent.",
    ],
    [
        "order couldn't be fully filled. FOK orders are fully filled or killed.",
        "fok_not_filled",
        "warn",
        "The price moved, so your prediction didn't go through. Nothing was spent.",
    ],
    [
        "the market is not yet ready to process new orders",
        "market_not_ready",
        "warn",
        "This market isn't taking orders right now. Nothing was spent.",
    ],
    [
        "not enough balance / allowance",
        "insufficient_balance_or_allowance",
        "error",
        "Our Polymarket balance can't cover this order right now. That's on our side, not yours. Nothing was spent.",
    ],
    [
        "not enough balance / allowance: the allowance is not enough -> spender: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296, allowance: 0, sum of matched orders: 0, order amount (inc. fees): 3686680",
        undefined,
        "error",
        "Our Polymarket account isn't set up to trade this kind of market yet. That's on our side, not yours. Nothing was spent.",
    ],
    [
        "Trading restricted in your region",
        undefined,
        "error",
        "Polymarket doesn't accept orders from our servers' region right now. That's on our side. Nothing was spent.",
    ],
    [
        "invalid signature",
        undefined,
        "error",
        "Polymarket didn't accept our credentials. That's on our side. Nothing was spent.",
    ],
    [
        "Too many requests",
        undefined,
        "warn",
        "Polymarket is limiting how fast we can place orders. Try again in a moment. Nothing was spent.",
    ],
    [
        "price breaks minimum tick size rules",
        undefined,
        "error",
        "Polymarket refused the price we sent for this market's price steps. That's on our side. Nothing was spent.",
    ],
])("%s is told plainly", (message, code, level, sentence) => {
    const why = polymarketRefused(buy, refusal(message, code));
    expect(why.level).toBe(level);
    expect(why.message).toBe(sentence);
    expect(why.detail).toBe(message);
    expect(why.fields).toMatchObject({ polymarketMessage: message, polymarketCode: code ?? null });
});

test("a missing approval's log line names the setup script that grants it, other refusals keep the plain line", () => {
    const why = polymarketRefused(
        buy,
        refusal("not enough balance / allowance: the allowance is not enough -> spender: 0x1"),
    );
    expect(why.msg).toBe(
        "Polymarket refused a prediction: the pool wallet hasn't approved the spender Polymarket named. Run scripts/polymarket-setup.ts",
    );
    expect(polymarketRefused(buy, refusal("not enough balance / allowance")).msg).toBe(
        "Polymarket refused a prediction",
    );
});

test("an unknown refusal quotes Polymarket's words on one line", () => {
    const why = polymarketRefused(buy, refusal('order\n "weird"  thing '));
    expect(why.level).toBe("error");
    expect(why.message).toBe("Polymarket refused the order: \"order 'weird' thing\". Nothing was spent.");
});

test("a sale ends with the position instead of the money", () => {
    expect(polymarketRefused(sell, refusal("invalid order size")).message).toBe(
        'Polymarket refused the order: "invalid order size". Your position is back.',
    );
    expect(priceMoved(sell, "m", "d").message).toBe(
        "The price moved, so the sale didn't go through. Your position is back.",
    );
});

test("an exception while preparing is Polymarket's slowness, a missing connection, or ours with a reference", () => {
    const slow = couldntPrepare(buy, new Error("book timed out after 8000 ms"));
    expect(slow).toMatchObject({ level: "warn", message: "Polymarket didn't answer in time. Nothing was spent." });
    const down = couldntPrepare(buy, new Error("The trader isn't ready"));
    expect(down.message).toBe(
        "Predictions aren't connected to Polymarket right now. Try again shortly. Nothing was spent.",
    );
    const bug = couldntPrepare(buy, new TypeError("x is undefined"));
    expect(bug).toMatchObject({
        level: "error",
        message: "Something went wrong on our side (ref abcdef). Nothing was spent.",
        fields: { ref: "abcdef" },
    });
});

test("a cancelled order says why by Polymarket's status instead of always blaming the price", () => {
    const resolved = cancelled(buy, "CANCELED_MARKET_RESOLVED");
    expect(resolved).toMatchObject({
        reason: "market_closed",
        level: "warn",
        detail: "Polymarket cancelled the order (CANCELED_MARKET_RESOLVED)",
        message: "The market resolved before the order filled. Nothing was spent.",
    });
    expect(cancelled(sell, "INVALID")).toMatchObject({
        reason: "rejected",
        level: "error",
        message: "Polymarket marked the order invalid. That's on our side. Your position is back.",
    });
    expect(cancelled(buy, "CANCELED_BY_USER")).toMatchObject({ level: "error", reason: "unavailable" });
    expect(cancelled(buy, "CANCELED")).toMatchObject({
        reason: "price_moved",
        detail: "Polymarket cancelled the order unfilled (CANCELED)",
        fields: { polymarketStatus: "CANCELED" },
    });
    expect(cancelled(buy, undefined).detail).toBe("Polymarket cancelled the order unfilled (CANCELED)");
});

test("only Polymarket not answering counts as an outage, a bug of ours does not", () => {
    expect(isUpstreamFailure(Object.assign(new Error("x"), { name: "RequestRejectedError" }))).toBe(true);
    expect(isUpstreamFailure(new Error("lookup timed out after 5000 ms"))).toBe(true);
    expect(isUpstreamFailure(new Error("The order abc or its account def vanished while booking its fill"))).toBe(
        false,
    );
});
