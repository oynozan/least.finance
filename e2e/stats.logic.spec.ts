import { expect, test } from "@playwright/test";
import { pageWindow } from "@/components/stats/pager";
import { fitY, toPoints } from "@/lib/stats/chart";
import { walletState } from "@/lib/stats/wallet";
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

test("a wallet the server calls Not set up is muted, not a problem", () => {
    expect(walletState({ error: "Not set up" })).toEqual({ notSetUp: true, problem: null });
});

test("any other read error is a problem, and a clean wallet with no address or dollars is neither", () => {
    expect(walletState({ error: "RPC timed out" })).toEqual({ notSetUp: false, problem: "RPC timed out" });
    expect(walletState({ error: null })).toEqual({ notSetUp: false, problem: null });
});

test("pageWindow shows up to 5 numbers with the current page in the middle where it can be", () => {
    expect(pageWindow(1, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(2, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(5, 10)).toEqual([3, 4, 5, 6, 7]);
    expect(pageWindow(9, 10)).toEqual([6, 7, 8, 9, 10]);
    expect(pageWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
});

test("pageWindow shows every page when there are five or fewer", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 5)).toEqual([1, 2, 3, 4, 5]);
});
