import { ObjectId } from "mongodb";
import { expect, test } from "vitest";
import { HyperliquidRefused, TimedOut } from "../../src/perps/client.ts";
import {
    OpenStepError,
    bookUnreadable,
    closeNeverSent,
    closeRefused,
    openFailed,
    openRefused,
} from "../../src/perps/failures.ts";

const order = { _id: new ObjectId("66b000000000000000abc123"), asset: "BTC" };

test.each([
    ["Order could not immediately match against any resting orders.", "price_moved", "warn", /price moved/],
    ["iocCancelRejected", "price_moved", "warn", /price moved/],
    ["marketOrderNoLiquidityRejected", "price_moved", "warn", /price moved/],
    ["Order must have minimum value of $10.", "below_minimum", "error", /minimum order is \$10/],
    ["minTradeNtlRejected", "below_minimum", "error", /minimum order is \$10/],
    ["Insufficient margin to place order.", "insufficient_margin", "warn", /collateral doesn't cover/],
    ["perpMarginRejected", "insufficient_margin", "warn", /collateral doesn't cover/],
    ["positionIncreaseAtOpenInterestCapRejected", "open_interest_cap", "warn", /limit for new BTC positions/],
    ["Cannot increase position when open interest is at cap", "open_interest_cap", "warn", /limit for new BTC/],
    ["perpMaxPositionRejected", "max_position", "warn", /maximum BTC position/],
    ["oracleRejected", "oracle", "warn", /reference price/],
    ["Price must be divisible by tick size.", "tick", "error", /on our side/],
] as const)("an open refused with %s says %s", (raw, code, level, message) => {
    const why = openRefused(raw, "BTC");
    expect(why).toMatchObject({ code, level, detail: raw });
    expect(why.message).toMatch(message);
    expect(why.message.endsWith("Nothing was spent.")).toBe(true);
    expect(why.fields).toMatchObject({ upstreamMessage: raw });
});

test("an open refused with words we don't know quotes them, trimmed to one line, and is an error", () => {
    const why = openRefused("Something\n  new   happened here", "BTC");
    expect(why).toMatchObject({ code: "rejected", level: "error", detail: "Something\n  new   happened here" });
    expect(why.message).toBe('Hyperliquid refused the order: "Something new happened here". Nothing was spent.');
});

test.each([
    ["no fill", "no_fill", "warn", /Nobody on the book took your close/],
    ["Order could not immediately match against any resting orders.", "no_fill", "warn", /Nobody on the book/],
    ["Order must have minimum value of $10.", "too_small", "error", /under Hyperliquid's \$10 minimum/],
    ["minTradeNtlRejected", "too_small", "error", /under Hyperliquid's \$10 minimum/],
    ["reduceOnlyRejected", "reduce_only", "warn", /would not reduce the position/],
    ["Reduce only order would increase position.", "reduce_only", "warn", /would not reduce the position/],
] as const)("a close refused with %s says %s", (raw, code, level, message) => {
    const why = closeRefused(raw);
    expect(why).toMatchObject({ code, level, detail: raw });
    expect(why.message).toMatch(message);
    expect(why.message).toMatch(/still open|stays open/);
});

test("a close refused with unknown words quotes them and says the position is still open", () => {
    expect(closeRefused("Order has invalid size.").message).toBe(
        'Hyperliquid refused the close: "Order has invalid size". Your position is still open.',
    );
});

test("a close that never went out says so", () => {
    expect(closeNeverSent()).toMatchObject({ code: "never_sent", level: "warn" });
});

test("a refused transfer quotes Hyperliquid, and an empty master says it is on our side", () => {
    const refused = openFailed(
        order,
        new OpenStepError("transfer", "x", { upstream: "Cannot transfer to this address." }),
    );
    expect(refused).toMatchObject({
        code: "transfer_refused",
        level: "error",
        detail: "Cannot transfer to this address.",
    });
    expect(refused.message).toBe(
        'Hyperliquid refused to fund your position: "Cannot transfer to this address". Nothing was spent.',
    );
    const empty = openFailed(
        order,
        new OpenStepError("top_up", "x", { upstream: "Insufficient balance for withdrawal" }),
    );
    expect(empty.message).toMatch(/on our side, not yours\. Nothing was spent\.$/);
});

test("a refused leverage quotes Hyperliquid", () => {
    const why = openFailed(order, new HyperliquidRefused("Invalid leverage value", '{"status":"err"}'));
    expect(why).toMatchObject({ code: "leverage_refused", detail: "Invalid leverage value" });
    expect(why.message).toBe('Hyperliquid refused the leverage: "Invalid leverage value". Nothing was spent.');
    expect(why.fields).toMatchObject({ upstreamRaw: '{"status":"err"}' });
});

test("a slow Hyperliquid says how long we waited", () => {
    const why = openFailed(order, new TimedOut("usdSend", 15_000));
    expect(why).toMatchObject({ code: "timeout", level: "warn" });
    expect(why.message).toBe("Hyperliquid didn't answer in 15 seconds. Nothing was spent.");
});

test("a market that is gone names itself", () => {
    expect(openFailed(order, new Error("Hyperliquid has no DOGE market")).message).toBe(
        "DOGE is no longer offered on Hyperliquid. Nothing was spent.",
    );
});

test("anything else is ours: a reference the log carries, and the error as the detail", () => {
    const why = openFailed(order, new Error("connection reset"));
    expect(why).toMatchObject({ code: "internal", level: "error", detail: "connection reset" });
    expect(why.message).toBe("Something went wrong on our side (ref abc123). Nothing was spent.");
    expect(why.fields).toEqual({ ref: "abc123" });
});

test("a book that can't be read says whether Hyperliquid was slow, limiting us, or unreachable", () => {
    expect(bookUnreadable(new TimedOut("book", 2_000))).toBe(
        "Hyperliquid didn't answer in 2 seconds, so no position was opened. Nothing was spent.",
    );
    expect(bookUnreadable(new Error("429 Too Many Requests"))).toMatch(/limiting how fast we can ask/);
    expect(bookUnreadable(new Error("fetch failed"))).toBe(
        "Couldn't reach Hyperliquid (fetch failed). Nothing was spent.",
    );
});
