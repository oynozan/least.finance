import { expect, test } from "@playwright/test";
import { chartedOutcomes, historyTokens, lineColor } from "@/lib/trade/market-lines";
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
