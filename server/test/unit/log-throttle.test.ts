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

test("an upstream's words are quoted on one short line", () => {
    expect(upstreamSaid("Polymarket", 'invalid\n  "order" size')).toBe("Polymarket refused: \"invalid 'order' size\"");
    expect(quoted("x".repeat(500)).length).toBe(122);
});

test("an internal AppError shows the ref it was logged under, other errors keep their message", () => {
    expect(toApiError(new AppError("internal", "x"), "abc123").message).toBe(
        "Something went wrong on our side (ref abc123).",
    );
    expect(toApiError(new AppError("unavailable", "Down."), "abc123").message).toBe("Down.");
    expect(new AppError("unauthorized", "x", { detail: "no_token" }).detail).toBe("no_token");
});
