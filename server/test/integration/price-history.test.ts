import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import type { PriceHistoryView } from "../../src/protocol.ts";
import { LLAMA_IDS } from "../../src/prices/defillama.ts";
import { COINS } from "../../src/swaps/coins.ts";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const get = async (path: string) => {
    const response = await fetch(`${stack.url}${path}`);
    return { status: response.status, headers: response.headers, json: (await response.json()) as any };
};

describe("price history route", () => {
    test("GET /prices/history?range=7d answers every swap coin hourly, without a token", async () => {
        const before = stack.llama.charts.length;
        const { status, headers, json } = await get("/prices/history?range=7d");
        const view = json as PriceHistoryView;

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("public, max-age=60");
        expect(view).toMatchObject({ range: "7d", stepMs: 3_600_000, readAt: expect.any(String) });
        expect(view.coins.map((coin) => coin.symbol)).toEqual(COINS.map((coin) => coin.symbol));
        for (const coin of view.coins) {
            expect(coin.points).toHaveLength(168);
            const times = coin.points.map(([time]) => time);
            expect(times).toEqual([...times].sort((a, b) => a - b));
            const [time, usd] = coin.points.at(-1)!;
            expect(usd).toBe(Number(stack.llama.priceAt(coin.symbol, time / 1000).toPrecision(6)));
        }
        // Batched under the cap: the fake refuses anything over 500 points, as DefiLlama does
        const charts = stack.llama.charts.slice(before);
        expect(charts.length).toBeGreaterThan(1);
        for (const chart of charts) expect(chart.ids.length * chart.span).toBeLessThanOrEqual(500);
        expect(charts.flatMap((chart) => chart.ids).sort()).toEqual(Object.values(LLAMA_IDS).sort());
    });

    test("a range read moments ago is served without asking DefiLlama", async () => {
        await get("/prices/history?range=30d");
        const before = stack.llama.charts.length;

        const { status, json } = await get("/prices/history?range=30d&coins=btc,ETH");

        expect(status).toBe(200);
        expect(stack.llama.charts).toHaveLength(before);
        expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(["BTC", "ETH"]);
    });

    test("a bad range or coin is a 400", async () => {
        for (const query of ["", "?range=2y", "?range=7d&coins=XRP", "?range=7d&coins=", "?range=7d&coins=ETH,,BTC"]) {
            const { status, json } = await get(`/prices/history${query}`);
            expect(status, query).toBe(400);
            expect(json.error.code).toBe("bad_request");
        }
    });

    test("DefiLlama failing before a range was ever read is a 503, not cached", async () => {
        stack.llama.failNext(500);

        const { status, headers, json } = await get("/prices/history?range=90d");

        expect(status).toBe(503);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(json.error).toEqual({
            code: "unavailable",
            message: "Prices are unavailable right now. Try again shortly.",
        });
    });
});
