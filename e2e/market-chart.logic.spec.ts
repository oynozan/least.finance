import { expect, test } from "@playwright/test";
import { chartedOutcomes, historyTokens, lineColor } from "@/lib/trade/market-lines";
import { chanceScale, chartDate, formatPts, valueAt, withLiveEnd } from "@/lib/trade/chance-chart";
import { drawable } from "@/components/trade/market-chart-card";
import { createMarketHistoryStore } from "@/components/trade/market-history-store";
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

test.describe("the market history store", () => {
    type Answer = { status?: number; body?: unknown };
    function setup(answer: (tokens: string[]) => Answer = (tokens) => ({ body: lines(tokens) })) {
        const urls: string[] = [];
        let time = 1_000_000;
        const fetch = (async (url: string) => {
            urls.push(url);
            const tokens = new URL(url).searchParams.get("outcomes")!.split(",");
            const { status = 200, body } = answer(tokens);
            return { ok: status === 200, status, json: async () => body };
        }) as unknown as typeof globalThis.fetch;
        const store = createMarketHistoryStore({ apiUrl: "http://api", fetch, now: () => time });
        return { store, urls, advance: (ms: number) => (time += ms) };
    }
    const lines = (
        tokens: string[],
        points: unknown[] = [
            [1, 0.2],
            [2, 0.3],
        ],
    ) => ({
        eventId: "1",
        stepMs: 1,
        readAt: "",
        outcomes: tokens.map((tokenId) => ({ tokenId, points })),
    });

    test("one request reads both tokens and tells listeners once", async () => {
        const { store, urls } = setup();
        let told = 0;
        store.subscribe(() => (told += 1));
        await store.want("1", ["a", "b"]);
        expect(urls).toEqual(["http://api/markets/1/history?outcomes=a,b"]);
        expect([...store.getSnapshot().lines.keys()]).toEqual(["a", "b"]);
        expect(told).toBe(1);
    });

    test("asks again only once a line is 3 minutes old", async () => {
        const { store, urls, advance } = setup();
        await store.want("1", ["a", "b"]);
        advance(179_999);
        await store.want("1", ["a", "b"]);
        expect(urls).toHaveLength(1);
        advance(1);
        await store.want("1", ["a", "b"]);
        expect(urls).toEqual([
            "http://api/markets/1/history?outcomes=a,b",
            "http://api/markets/1/history?outcomes=a,b",
        ]);
    });

    test("a token already being read isn't asked for again", async () => {
        const { store, urls } = setup();
        const first = store.want("1", ["a", "b"]);
        const second = store.want("1", ["a", "c"]);
        await Promise.all([first, second]);
        expect(urls).toEqual(["http://api/markets/1/history?outcomes=a,b", "http://api/markets/1/history?outcomes=c"]);
    });

    test("a failed read isn't asked again until 10 seconds have passed", async () => {
        const { store, urls, advance } = setup(() => ({ status: 503 }));
        await store.want("1", ["a"]);
        await store.want("1", ["a"]);
        advance(9_999);
        await store.want("1", ["a"]);
        expect(urls).toHaveLength(1);
        advance(1);
        await store.want("1", ["a"]);
        expect(urls).toHaveLength(2);
    });

    test("a 503 keeps the earlier lines and the next want after the pause tries again", async () => {
        let fail = false;
        const { store, urls, advance } = setup((tokens) => (fail ? { status: 503 } : { body: lines(tokens) }));
        await store.want("1", ["a"]);
        const before = store.getSnapshot();
        advance(180_000);
        fail = true;
        await store.want("1", ["a"]);
        expect(store.getSnapshot()).toBe(before);
        advance(10_000);
        await store.want("1", ["a"]);
        expect(urls).toHaveLength(3);
    });

    test("a bad point is skipped, not its line", async () => {
        const { store } = setup((tokens) => ({
            body: lines(tokens, [[1, 0.2], [2, 1.5], ["x", 0.3], [3], [4, Number.NaN], [5, 0.4]]),
        }));
        await store.want("1", ["a"]);
        expect(store.getSnapshot().lines.get("a")).toEqual([
            [1, 0.2],
            [5, 0.4],
        ]);
    });

    test("an answer that isn't a history changes nothing", async () => {
        const { store } = setup(() => ({ body: { outcomes: "nope" } }));
        const before = store.getSnapshot();
        await store.want("1", ["a"]);
        expect(store.getSnapshot()).toBe(before);
    });

    test("points keep the order the server sent", async () => {
        const { store } = setup((tokens) => ({
            body: lines(tokens, [
                [1, 0.1],
                [2, 0.5],
                [3, 0.2],
            ]),
        }));
        await store.want("1", ["a"]);
        expect(
            store
                .getSnapshot()
                .lines.get("a")!
                .map(([t]) => t),
        ).toEqual([1, 2, 3]);
    });
});

test.describe("chartDate", () => {
    const at = (text: string) => Date.parse(text);
    const utc = "UTC";

    test("a short span in one year shows the day and the hour", () => {
        expect(chartDate(at("2026-10-01T20:10:00Z"), at("2026-10-01T00:00:00Z"), at("2026-10-04T00:00:00Z"), utc)).toBe(
            "Oct 1, 8 PM",
        );
    });

    test("a span over 60 days in one year drops the hour", () => {
        expect(chartDate(at("2026-04-20T09:00:00Z"), at("2026-03-01T00:00:00Z"), at("2026-10-17T00:00:00Z"), utc)).toBe(
            "Apr 20",
        );
    });

    test("a span over two calendar years adds the year, and the hour goes past 60 days", () => {
        expect(chartDate(at("2026-04-20T09:00:00Z"), at("2025-12-20T00:00:00Z"), at("2026-10-17T00:00:00Z"), utc)).toBe(
            "Apr 20, 2026",
        );
    });

    test("a short span across New Year keeps the hour and adds the year", () => {
        expect(chartDate(at("2025-12-31T23:30:00Z"), at("2025-12-27T00:00:00Z"), at("2026-01-06T00:00:00Z"), utc)).toBe(
            "Dec 31, 2025, 11 PM",
        );
    });
});
