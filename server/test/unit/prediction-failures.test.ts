import { ObjectId } from "mongodb";
import { expect, test } from "vitest";
import { couldntPrepare, polymarketRefused, priceMoved } from "../../src/predictions/failures.ts";

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
