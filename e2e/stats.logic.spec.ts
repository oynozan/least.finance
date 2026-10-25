import { expect, test } from "@playwright/test";
import { fitY, toPoints } from "@/lib/stats/chart";
import type { StatsPnlView } from "@/server/src/protocol";

test("fitY pads the span by 8% on each side", () => {
    const { min, max } = fitY([0, 100]);
    expect(min).toBeCloseTo(-8);
    expect(max).toBeCloseTo(108);
});

test("fitY gives a flat series a span, so the line sits mid-chart", () => {
    const { min, max } = fitY([50, 50, 50]);
    expect(min).toBeLessThan(50);
    expect(max).toBeGreaterThan(50);
    expect((min + max) / 2).toBeCloseTo(50);
});

test("fitY gives a flat zero series a span too", () => {
    const { min, max } = fitY([0, 0]);
    expect(max).toBeGreaterThan(min);
});

test("fitY on nothing is a unit span", () => {
    const { min, max } = fitY([]);
    expect(max).toBeGreaterThan(min);
});

test("toPoints turns the view's strings into times and dollars, oldest first", () => {
    const view: StatsPnlView = {
        range: "7D",
        changeUsd: "5",
        points: [
            { at: "2026-10-25T10:00:00.000Z", equityUsd: "105.5" },
            { at: "2026-10-25T09:00:00.000Z", equityUsd: "100" },
        ],
    };
    expect(toPoints(view)).toEqual([
        { at: Date.parse("2026-10-25T09:00:00.000Z"), usd: 100 },
        { at: Date.parse("2026-10-25T10:00:00.000Z"), usd: 105.5 },
    ]);
});

test("toPoints drops a point whose figure is not a number", () => {
    const view: StatsPnlView = {
        range: "All",
        changeUsd: "0",
        points: [
            { at: "2026-10-25T09:00:00.000Z", equityUsd: "nope" },
            { at: "2026-10-25T10:00:00.000Z", equityUsd: "1" },
        ],
    };
    expect(toPoints(view)).toHaveLength(1);
});
