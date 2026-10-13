import { expect, test } from "@playwright/test";
import { chartedOutcomes, historyTokens, lineColor } from "@/lib/trade/market-lines";
import { chanceScale, formatPts, valueAt, withLiveEnd } from "@/lib/trade/chance-chart";
import { drawable } from "@/components/trade/market-chart-card";
import type { Outcome, PredictionMarket } from "@/lib/trade/catalog";

function outcome(label: string, chance: number): Outcome {
    return {
        id: `tok-${label}`,
        label,
        price: chance,
        chance,
        tone: "neutral",
        minUSD: 1,
    };
}

function market(outcomes: Outcome[]): PredictionMarket {
    return { id: "m", question: "Q?", short: "Q", symbol: "BTC", closes: "", outcomes };
}

const names = ["A", "B", "C", "D", "E", "F", "G"];
const event = market(names.map((n, i) => outcome(n, 0.4 - i * 0.05)));
const shuffled = market([...event.outcomes].reverse());

test.describe("a Yes/No question", () => {
    const yes = outcome("Yes", 0.3);
    const no = outcome("no", 0.7);
    const m = market([no, yes]);

    test("draws YES alone, even when NO is more likely", () => {
        expect(chartedOutcomes(m)).toEqual({ drawn: [yes], more: 0 });
    });

    test("needs both tokens when NO is picked", () => {
        expect(historyTokens(m, no.id)).toEqual([yes.id, no.id]);
    });

    test("colors YES gain and NO loss", () => {
        expect(lineColor(m, yes.id)).toBe("--gain");
        expect(lineColor(m, no.id)).toBe("--loss");
    });
});

test("two named sides are both drawn, by chance", () => {
    const a = outcome("Lakers", 0.4);
    const b = outcome("Celtics", 0.6);
    expect(chartedOutcomes(market([a, b]))).toEqual({ drawn: [b, a], more: 0 });
});

test.describe("a 7-outcome event", () => {
    test("draws the 4 most likely in order and counts the rest", () => {
        const { drawn, more } = chartedOutcomes(shuffled);
        expect(drawn.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
        expect(more).toBe(3);
    });

    test("adds the picked outcome only when it is not charted", () => {
        const seventh = event.outcomes[6];
        const tokens = historyTokens(event, seventh.id);
        expect(tokens).toHaveLength(5);
        expect(tokens[4]).toBe(seventh.id);
        expect(historyTokens(event, event.outcomes[1].id)).toHaveLength(4);
        expect(historyTokens(event, null)).toHaveLength(4);
    });

    test("ties keep the market's order", () => {
        const tied = market(names.map((n) => outcome(n, 0.1)));
        expect(chartedOutcomes(tied).drawn.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
    });

    test("colors by rank, and an undrawn outcome gets chart-1", () => {
        expect(lineColor(event, event.outcomes[2].id)).toBe("--chart-3");
        expect(lineColor(event, event.outcomes[6].id)).toBe("--chart-1");
    });
});

test.describe("withLiveEnd", () => {
    test("appends the live chance at now", () => {
        expect(withLiveEnd([[1, 0.2]], 0.3, 5)).toEqual([
            [1, 0.2],
            [5, 0.3],
        ]);
    });

    test("replaces a last point at or after now", () => {
        expect(
            withLiveEnd(
                [
                    [1, 0.2],
                    [5, 0.25],
                ],
                0.3,
                5,
            ),
        ).toEqual([
            [1, 0.2],
            [5, 0.3],
        ]);
    });
});

test.describe("chanceScale", () => {
    test("never spans under 0.2, centred on the values", () => {
        const { floor, span } = chanceScale([0.5, 0.52]);
        expect(span).toBeCloseTo(0.2);
        expect(floor + span / 2).toBeCloseTo(0.51);
    });

    test("stays inside 0 to 1 at the bottom", () => {
        const { floor, span } = chanceScale([0.01, 0.05]);
        expect(floor).toBe(0);
        expect(span).toBeCloseTo(0.2);
    });

    test("fits a wide range", () => {
        const { floor, span } = chanceScale([0.1, 0.9]);
        expect(floor).toBeCloseTo(0.1);
        expect(span).toBeCloseTo(0.8);
    });

    test("stays inside 0 to 1 at the top", () => {
        expect(chanceScale([0.95, 0.99]).floor).toBeCloseTo(0.8);
    });
});

test.describe("valueAt", () => {
    const points = [
        [10, 0.2],
        [20, 0.4],
    ] as const;

    test("is null before the line starts", () => expect(valueAt(points, 5)).toBeNull());
    test("holds the earlier value between points", () => expect(valueAt(points, 15)).toBe(0.2));
    test("holds the last value after the end", () => expect(valueAt(points, 99)).toBe(0.4));
});

test.describe("formatPts", () => {
    test("whole points from 10 up", () => expect(formatPts(0.12)).toEqual({ text: "+12 pts", trend: "gain" }));
    test("one decimal under 10, with a true minus", () =>
        expect(formatPts(-0.035)).toEqual({ text: "\u22123.5 pts", trend: "loss" }));
    test("flat under half a point", () => expect(formatPts(0.004)).toEqual({ text: "0 pts", trend: "flat" }));
    test("9.5 keeps its decimal", () => expect(formatPts(0.095)).toEqual({ text: "+9.5 pts", trend: "gain" }));
});

test.describe("drawable", () => {
    const line = (n: number) => Array.from({ length: n }, (_, i) => [i, 0.5] as const);
    test("one point is not a line", () => expect(drawable([line(1)])).toBe(false));
    test("some line with two points is", () => expect(drawable([line(1), line(2)])).toBe(true));
    test("no lines draw nothing", () => expect(drawable([])).toBe(false));
});
