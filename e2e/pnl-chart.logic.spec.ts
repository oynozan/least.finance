import { expect, test } from "@playwright/test";
import { chartOf } from "@/lib/pnl/chart";
import { parseStart } from "@/lib/pnl/labels";
import type { PnlPoint, PnlSeries, PnlRangeKey } from "@/server/src/protocol";

const point = (start: string, balance: string, pnl = "0", net = "0"): PnlPoint => ({ start, balance, pnl, net });

const range = (points: PnlPoint[], unit: PnlSeries["ranges"][PnlRangeKey]["unit"] = "day") => ({ unit, points });

test("the headline PnL is the sum of the bars' pnl", () => {
    const chart = chartOf(
        range([
            point("2026-03-01", "100", "10.5"),
            point("2026-03-02", "106", "-4"),
            point("2026-03-03", "106.25", "0.25"),
        ]),
    );
    expect(chart.pnl).toBe(6.75);
});

test("a loss over the whole range is a negative headline PnL", () => {
    const chart = chartOf(range([point("2026-03-01", "90", "-10"), point("2026-03-02", "75", "-15")]));
    expect(chart.pnl).toBe(-25);
});

test("empty is true only when every balance is zero", () => {
    expect(chartOf(range([point("2026-03-01", "0"), point("2026-03-02", "0.000000")])).empty).toBe(true);
    expect(chartOf(range([point("2026-03-01", "0"), point("2026-03-02", "0.000001")])).empty).toBe(false);
    expect(chartOf(range([point("2026-03-01", "0"), point("2026-03-02", "-5")])).empty).toBe(false);
    expect(chartOf(range([point("2026-03-01", "12")])).empty).toBe(false);
});

test("a range with no bars is empty and has no extremes to draw", () => {
    const chart = chartOf(range([]));
    expect(chart).toMatchObject({ bars: [], pnl: 0, high: 0, low: 0, empty: true });
});

test("bars keep the server's order and parse the amounts", () => {
    const points = [
        point("2026-03-02", "500.5", "0", "500.5"),
        point("2026-03-03", "460.25", "-10.25", "-30"),
        point("2026-03-04", "470.125", "10", "0"),
    ];
    const chart = chartOf(range(points, "week"));
    expect(chart.unit).toBe("week");
    expect(chart.bars.map((bar) => bar.start)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    expect(chart.bars.map((bar) => bar.balance)).toEqual([500.5, 460.25, 470.125]);
    expect(chart.bars.map((bar) => bar.pnl)).toEqual([0, -10.25, 10]);
    expect(chart.bars.map((bar) => bar.net)).toEqual([500.5, -30, 0]);
    expect(chart.bars.map((bar) => bar.date)).toEqual(points.map((p) => parseStart(p.start)));
});

test("high and low come from the balances", () => {
    const chart = chartOf(
        range([
            point("2026-03-01", "100", "0", "100"),
            point("2026-03-02", "340.5", "240.5"),
            point("2026-03-03", "20", "-320.5"),
            point("2026-03-04", "75"),
        ]),
    );
    expect(chart.high).toBe(340.5);
    expect(chart.low).toBe(20);
});

test("high and low also hold with a balance below zero", () => {
    const chart = chartOf(range([point("2026-03-01", "-12.5"), point("2026-03-02", "4"), point("2026-03-03", "0")]));
    expect(chart.high).toBe(4);
    expect(chart.low).toBe(-12.5);
});
