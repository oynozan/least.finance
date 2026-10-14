import { describe, expect, it } from "vitest";
import type { PnlSeries } from "../../src/protocol.ts";
import { addDays, buildRanges, type DayTotals } from "../../src/pnl/series.ts";

const TODAY = "2026-10-14";

const usdc = (n: number) => BigInt(n) * 10n ** 18n;
const day = (net: number, pnl = 0): DayTotals => ({ net: usdc(net), pnl: usdc(pnl) });
const ago = (n: number, today = TODAY) => {
    const [year = 0, month = 1, date = 1] = today.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, date - n)).toISOString().slice(0, 10);
};
const ranges = (entries: [string, DayTotals][], today = TODAY): PnlSeries["ranges"] =>
    buildRanges(new Map(entries), today);
const starts = (points: { start: string }[]) => points.map((point) => point.start);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe("addDays", () => {
    it.each([
        ["2026-10-14", 1, "2026-10-15"],
        ["2026-10-14", 0, "2026-10-14"],
        ["2026-10-14", -14, "2026-09-30"],
        ["2026-12-31", 1, "2027-01-01"],
        ["2024-02-28", 1, "2024-02-29"],
        ["2025-02-28", 1, "2025-03-01"],
        ["2026-03-08", 1, "2026-03-09"],
        ["2026-11-01", -1, "2026-10-31"],
        ["2026-10-14", -400, "2025-09-09"],
    ])("%s plus %i days is %s", (date, n, expected) => {
        expect(addDays(date, n)).toBe(expected);
    });

    it("refuses a string that is not a date", () => {
        expect(() => addDays("2026-10", 1)).toThrow(/Not a date/);
        expect(() => addDays("tomorrow", 1)).toThrow(/Not a date/);
    });
});

describe("buildRanges", () => {
    it("no events give 7, 30 and 7 zero points ending on today", () => {
        const result = ranges([]);
        expect(result["7D"].points).toHaveLength(7);
        expect(result["30D"].points).toHaveLength(30);
        expect(result.All.points).toHaveLength(7);
        for (const key of ["7D", "30D", "All"] as const) {
            const { unit, points } = result[key];
            expect(unit).toBe("day");
            expect(points.at(-1)?.start).toBe(TODAY);
            for (const point of points) {
                expect(point.balance).toBe("0");
                expect(point.pnl).toBe("0");
                expect(point.net).toBe("0");
            }
        }
    });

    it("7D and 30D start from every earlier event", () => {
        const result = ranges([
            [ago(40), day(500)],
            [ago(35), day(0, -100)],
        ]);
        for (const point of result["7D"].points) expect(point.balance).toBe("400");
        expect(result["30D"].points[0]?.balance).toBe("400");
        expect(result["30D"].points.every((point) => point.pnl === "0" && point.net === "0")).toBe(true);
        expect(result.All.points[0]?.start).toBe(ago(40));
        expect(result.All.points[0]?.balance).toBe("500");
        expect(result.All.points.at(-1)?.balance).toBe("400");
    });

    it("quiet days carry the running balance", () => {
        const result = ranges([[ago(3), day(10, 2)]]);
        const seven = result["7D"].points;
        expect(seven.map((point) => point.balance)).toEqual(["0", "0", "0", "12", "12", "12", "12"]);
        expect(seven.map((point) => point.net)).toEqual(["0", "0", "0", "10", "0", "0", "0"]);
        expect(seven.map((point) => point.pnl)).toEqual(["0", "0", "0", "2", "0", "0", "0"]);
    });

    it("7D and 30D have exactly 7 and 30 points, all days", () => {
        const result = ranges([]);
        expect(result["7D"].unit).toBe("day");
        expect(result["30D"].unit).toBe("day");
        expect(starts(result["7D"].points)).toEqual([
            "2026-10-08",
            "2026-10-09",
            "2026-10-10",
            "2026-10-11",
            "2026-10-12",
            "2026-10-13",
            "2026-10-14",
        ]);
        const thirty = starts(result["30D"].points);
        expect(thirty).toHaveLength(30);
        expect(thirty[0]).toBe("2026-09-15");
        expect(thirty.at(-1)).toBe(TODAY);
        thirty.forEach((start, index) => {
            if (index > 0) expect(start).toBe(addDays(thirty[index - 1] ?? "", 1));
        });
    });

    it("All is never fewer than 7 points, even for an event today", () => {
        const result = ranges([[TODAY, day(10)]]);
        expect(result.All.unit).toBe("day");
        expect(result.All.points).toHaveLength(7);
        expect(result.All.points[0]?.start).toBe("2026-10-08");
        expect(result.All.points.at(-1)?.balance).toBe("10");
    });

    it("an event whose net and pnl are 0 still sets where All starts", () => {
        const result = ranges([
            ["2026-07-17", { net: 0n, pnl: 0n }],
            [TODAY, day(10)],
        ]);
        expect(result.All.unit).toBe("day");
        expect(result.All.points).toHaveLength(90);
        expect(result.All.points[0]?.start).toBe("2026-07-17");
    });

    it.each([
        ["2026-07-17", "day", 90],
        ["2026-07-16", "week", 14],
        [ago(400), "week", 58],
        ["2025-01-27", "week", 90],
        ["2025-01-26", "month", 22],
        ["2018-07-28", "month", 100],
    ])("the All unit follows the aligned counts: first event %s is %s with %i points", (first, unit, count) => {
        const result = ranges([[first, day(1)]]);
        expect(result.All.unit).toBe(unit);
        expect(result.All.points).toHaveLength(count);
        expect(result.All.points.at(-1)?.balance).toBe("1");
    });

    it("week starts are Mondays and month starts are the 1st, each a valid date", () => {
        const weeks = ranges([["2025-01-27", day(1)]]).All.points;
        expect(weeks).toHaveLength(90);
        weeks.forEach((point, index) => {
            expect(new Date(`${point.start}T00:00:00Z`).toISOString().slice(0, 10)).toBe(point.start);
            expect(weekday(point.start)).toBe(1);
            if (index > 0) expect(point.start).toBe(addDays(weeks[index - 1]?.start ?? "", 7));
        });
        expect(weeks[0]?.start).toBe("2025-01-27");
        expect(weeks.at(-1)?.start).toBe("2026-10-12");

        const months = ranges([["2018-07-28", day(1)]]).All.points;
        expect(months[0]?.start).toBe("2018-07-01");
        expect(months.at(-1)?.start).toBe("2026-10-01");
        months.forEach((point) => {
            expect(new Date(`${point.start}T00:00:00Z`).toISOString().slice(0, 10)).toBe(point.start);
            expect(point.start.endsWith("-01")).toBe(true);
        });
        expect(new Set(starts(months)).size).toBe(months.length);
    });

    it("a first event in mid-week starts its week bar on the Monday before it", () => {
        const result = ranges([["2025-01-29", day(1)]]);
        expect(result.All.unit).toBe("week");
        expect(result.All.points[0]?.start).toBe("2025-01-27");
        expect(result.All.points[0]?.balance).toBe("1");
    });

    it("week and month buckets sum net and pnl", () => {
        const week = ranges([
            ["2025-01-27", day(100)],
            ["2025-01-29", day(50, -20)],
            ["2025-02-02", day(0, 5)],
            ["2025-02-03", day(7)],
        ]).All.points;
        expect(week[0]).toEqual({ start: "2025-01-27", balance: "135", pnl: "-15", net: "150" });
        expect(week[1]).toEqual({ start: "2025-02-03", balance: "142", pnl: "0", net: "7" });
        expect(week[2]).toEqual({ start: "2025-02-10", balance: "142", pnl: "0", net: "0" });

        const month = ranges([
            ["2018-07-28", day(100)],
            ["2018-07-31", day(0, -30)],
            ["2018-08-01", day(7)],
        ]).All.points;
        expect(month[0]).toEqual({ start: "2018-07-01", balance: "70", pnl: "-30", net: "100" });
        expect(month[1]).toEqual({ start: "2018-08-01", balance: "77", pnl: "0", net: "7" });
        expect(month[2]).toEqual({ start: "2018-09-01", balance: "77", pnl: "0", net: "0" });
    });

    it("the last balance is the total in 7D, 30D and All", () => {
        for (const first of [ago(3), ago(20), ago(70), ago(300), ago(2000)]) {
            const result = ranges([
                [first, day(1000)],
                [ago(1), day(0, -250)],
                [TODAY, day(40, 10)],
            ]);
            const total = "800";
            expect(result["7D"].points.at(-1)?.balance).toBe(total);
            expect(result["30D"].points.at(-1)?.balance).toBe(total);
            expect(result.All.points.at(-1)?.balance).toBe(total);
        }
    });

    it("an event dated after today lands in today's bar", () => {
        const base = ranges([[ago(2), day(5)]]);
        const result = ranges([
            [ago(2), day(5)],
            ["2026-10-15", day(10)],
        ]);
        for (const key of ["7D", "30D", "All"] as const) {
            const { points } = result[key];
            expect(points.at(-1)?.start).toBe(TODAY);
            expect(points.at(-1)?.balance).toBe("15");
            expect(points.at(-1)?.net).toBe("10");
            expect(points.slice(0, -1)).toEqual(base[key].points.slice(0, -1));
        }
    });

    it("an event dated after today and nothing else still gives today's bar and a 7 day All", () => {
        const result = ranges([["2027-01-01", day(10)]]);
        expect(result.All.points).toHaveLength(7);
        expect(result.All.points[0]?.start).toBe("2026-10-08");
        expect(result.All.points.at(-1)?.balance).toBe("10");
    });

    it.each([
        [
            "2026-03-10",
            ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
        ],
        [
            "2026-11-03",
            ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
        ],
    ])("a 7D range ending %s over a daylight saving day has 7 points", (today, expected) => {
        const result = ranges([], today);
        expect(starts(result["7D"].points)).toEqual(expected);
        expect(result["30D"].points).toHaveLength(30);
    });
});
