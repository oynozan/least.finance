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
    test("GET /prices/history?range=7d answers every swap coin hourly from memory, without a token", async () => {
        const before = stack.llama.charts.length;
        const { status, headers, json } = await get("/prices/history?range=7d");
        const view = json as PriceHistoryView;

        expect(status).toBe(200);
        // Read at start, so the request never waits on DefiLlama
        expect(stack.llama.charts).toHaveLength(before);
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
    });

    test("every range is read at start, in batches under DefiLlama's 500-point cap", async () => {
        // The fake refuses anything over 500 points, as DefiLlama does
        for (const chart of stack.llama.charts) expect(chart.ids.length * chart.span).toBeLessThanOrEqual(500);
        const before = stack.llama.charts.length;
        for (const range of ["1d", "7d", "30d", "90d", "1y"]) {
            const { status, json } = await get(`/prices/history?range=${range}&coins=btc,ETH`);
            expect(status, range).toBe(200);
            expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(["BTC", "ETH"]);
            expect(json.coins[0].points.length, range).toBeGreaterThan(0);
        }
        expect(stack.llama.charts).toHaveLength(before);
        const ids = stack.llama.charts.flatMap((chart) => chart.ids);
        expect(new Set(ids)).toEqual(new Set(Object.values(LLAMA_IDS)));
    });

    test("a bad range or coin is a 400", async () => {
        for (const query of ["", "?range=2y", "?range=7d&coins=XRP", "?range=7d&coins=", "?range=7d&coins=ETH,,BTC"]) {
            const { status, json } = await get(`/prices/history${query}`);
            expect(status, query).toBe(400);
            expect(json.error.code).toBe("bad_request");
        }
    });
});

describe("price history while DefiLlama can't be reached", () => {
    let down: Stack;
    beforeAll(async () => {
        // Nothing listens there, so every read since start has failed
        down = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { DEFILLAMA_COINS_URL: "http://127.0.0.1:9" },
        });
    });
    afterAll(() => down?.stop());

    test("a range never read is a 503, not cached", async () => {
        const response = await fetch(`${down.url}/prices/history?range=7d`);

        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
            error: { code: "unavailable", message: "Prices are unavailable right now. Try again shortly." },
        });
    });
});
