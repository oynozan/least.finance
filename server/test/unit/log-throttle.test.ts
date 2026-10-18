import { expect, test } from "vitest";
import { AppError, quoted, toApiError, upstreamSaid } from "../../src/errors.ts";
import { throttle } from "../../src/log-throttle.ts";

test("a repeating warning passes once per interval and counts what it held back", () => {
    let now = 0;
    const gate = throttle(60_000, () => now);
    expect(gate("a")).toEqual({ held: 0 });
    expect(gate("a")).toBeNull();
    expect(gate("a")).toBeNull();
    expect(gate("b")).toEqual({ held: 0 });
    now = 61_000;
    expect(gate("a")).toEqual({ held: 2 });
});

test("keys past their interval are dropped once the map is full, so held counts restart for them", () => {
    let now = 0;
    const gate = throttle(1_000, () => now, 3);
    gate("a");
    gate("a");
    gate("b");
    gate("c");
    now = 2_000;
    gate("d");
    // "a" was dropped with the others, so its two held lines are forgotten
    expect(gate("a")).toEqual({ held: 0 });
    // a key still inside its interval is kept
    expect(gate("d")).toBeNull();
});

test("an upstream's words are quoted on one short line", () => {
    expect(upstreamSaid("Polymarket", 'invalid\n  "order" size')).toBe("Polymarket refused: \"invalid 'order' size\"");
    expect(quoted("x".repeat(500)).length).toBe(122);
});

test("a quoted upstream sentence drops its own full stop, so the sentence around it doesn't end in two", () => {
    expect(`Hyperliquid refused the close: ${quoted("Order could not be placed.")}.`).toBe(
        'Hyperliquid refused the close: "Order could not be placed".',
    );
    expect(quoted("Is this allowed?!")).toBe('"Is this allowed"');
});

test("an internal AppError shows the ref it was logged under, other errors keep their message", () => {
    expect(toApiError(new AppError("internal", "We couldn't open your account."), "abc123").message).toBe(
        "We couldn't open your account (ref abc123).",
    );
    expect(toApiError(new AppError("unavailable", "Down."), "abc123").message).toBe("Down.");
    expect(new AppError("unauthorized", "x", { detail: "no_token" }).detail).toBe("no_token");
});
