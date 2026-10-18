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
        for (const query of [
            "",
            "?range=2y",
            "?range=7d&coins=",
            "?range=7d&coins=ETH,,BTC",
            "?range=7d&coins=DOGE-PERP",
            "?range=7d&coins=xyz:AAPL",
        ]) {
            const { status, json } = await get(`/prices/history${query}`);
            expect(status, query).toBe(400);
            expect(json.error.code).toBe("bad_request");
        }
    });
});

describe("price history of perp coins", () => {
    const HOUR = 3_600_000;
    const candleReads = () => stack.hyperliquid.candleReads;

    beforeAll(async () => {
        for (const [name, markPx] of [
            ["kPEPE", 0.0041],
            ["S", 0.45],
            ["0G", 1.2],
        ] as const)
            stack.hyperliquid.listMarket({ name, szDecimals: 0, maxLeverage: 10, markPx });
        await stack.server.services.perpMarkets.tick();
    });

    test("kPEPE, S and 0G answer a week of hourly Hyperliquid candles, in the order asked", async () => {
        const before = candleReads().length;
        const { status, headers, json } = await get("/prices/history?range=7d&coins=kPEPE,S,0G");
        const view = json as PriceHistoryView;

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("public, max-age=60");
        expect(view).toMatchObject({ range: "7d", stepMs: HOUR, readAt: expect.any(String) });
        expect(view.coins.map((coin) => coin.symbol)).toEqual(["kPEPE", "S", "0G"]);
        expect(
            candleReads()
                .slice(before)
                .map((read) => [read.coin, read.interval])
                .sort(),
        ).toEqual([
            ["0G", "1h"],
            ["S", "1h"],
            ["kPEPE", "1h"],
        ]);
        for (const coin of view.coins) {
            expect(coin.points).toHaveLength(168);
            const times = coin.points.map(([time]) => time);
            expect(times).toEqual([...times].sort((a, b) => a - b));
            // The last point is now, the one before the end of the hour before it
            expect(Math.abs(times.at(-1)! - Date.now())).toBeLessThan(10_000);
            expect(times.at(-2)! % HOUR).toBe(0);
            // A candle's close, to six significant digits
            const [time, usd] = coin.points.at(-2)!;
            const expected = stack.hyperliquid.candleClose(coin.symbol, time - HOUR);
            expect(usd).toBe(Number(expected.toPrecision(6)));
        }
        expect(view.coins[0]!.points.at(-1)![1]).toBeLessThan(0.01);
    });

    test("a coin is read once for the range's TTL, and a name is matched ignoring case", async () => {
        await get("/prices/history?range=7d&coins=kPEPE");
        const before = candleReads().length;

        const { json } = await get("/prices/history?range=7d&coins=kpepe,KPEPE");

        expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(["kPEPE"]);
        expect(candleReads()).toHaveLength(before);
    });

    test("a name Hyperliquid doesn't list is left out and never asked for", async () => {
        const before = candleReads().length;

        const { status, json } = await get("/prices/history?range=1d&coins=XRP,constructor,S");

        expect(status).toBe(200);
        expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(["S"]);
        expect(
            candleReads()
                .slice(before)
                .map((read) => read.coin),
        ).toEqual(["S"]);
        expect((await get("/prices/history?range=1d&coins=XRP")).json.coins).toEqual([]);
    });

    test("an answer with fewer coins than were asked for is cached 5 s, so the browser's retry gets through", async () => {
        const cached = async (query: string) =>
            (await get(`/prices/history?range=7d&coins=${query}`)).headers.get("cache-control");

        // A market the server doesn't list (yet), alone or among coins it does
        expect(await cached("NOSUCHCOIN")).toBe("public, max-age=5");
        expect(await cached("ETH,NOSUCHCOIN")).toBe("public, max-age=5");
        expect(await cached("S,NOSUCHCOIN,kPEPE")).toBe("public, max-age=5");
        // Every name answered, however its case was spelled or how often it was asked for
        expect(await cached("S")).toBe("public, max-age=60");
        expect(await cached("ETH,kPEPE")).toBe("public, max-age=60");
        expect(await cached("kpepe,KPEPE")).toBe("public, max-age=60");
        expect(await cached("eth,ETH")).toBe("public, max-age=60");
    });

    test("swap coins and perp coins mix, the swap coins staying with DefiLlama", async () => {
        const before = candleReads().length;

        const { json } = await get("/prices/history?range=7d&coins=ETH,kPEPE");

        expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(["ETH", "kPEPE"]);
        expect(json.coins[0].points).toHaveLength(168);
        expect(
            candleReads()
                .slice(before)
                .map((read) => read.coin),
        ).not.toContain("ETH");
    });

    test("without coins it is still the swap coins alone", async () => {
        const before = candleReads().length;

        const { json } = await get("/prices/history?range=30d");

        expect(json.coins.map((coin: { symbol: string }) => coin.symbol)).toEqual(COINS.map((coin) => coin.symbol));
        expect(candleReads()).toHaveLength(before);
    });

    test("the 30d range reads 2-hour candles and answers 6-hour steps", async () => {
        const { json } = await get("/prices/history?range=30d&coins=S");

        expect(candleReads().at(-1)).toMatchObject({ coin: "S", interval: "2h" });
        expect(json.stepMs).toBe(6 * HOUR);
        const times = json.coins[0].points.map(([time]: [number]) => time);
        expect(times).toHaveLength(120);
        expect(times.slice(1, -1).map((time: number, i: number) => time - times[i])).toEqual(
            Array(times.length - 2).fill(6 * HOUR),
        );
    });

    test("Hyperliquid failing leaves the coin without points, not the request failed", async () => {
        stack.hyperliquid.listMarket({ name: "TRUMP", szDecimals: 1, maxLeverage: 10, markPx: 12 });
        await stack.server.services.perpMarkets.tick();
        stack.hyperliquid.failCandles(true);
        try {
            const { status, headers, json } = await get("/prices/history?range=7d&coins=TRUMP");
            expect(status).toBe(200);
            expect(json.coins).toEqual([{ symbol: "TRUMP", points: [] }]);
            // Empty because the read failed, so the browser asks again soon
            expect(headers.get("cache-control")).toBe("public, max-age=5");
        } finally {
            stack.hyperliquid.failCandles(false);
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
            error: {
                code: "unavailable",
                message: "The price source hasn't answered yet, so this chart isn't ready. It retries on its own.",
            },
        });
    });
});
