import { pino } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { Candle, HyperliquidClient } from "../../src/perps/client.ts";
import type { PriceRange } from "../../src/protocol.ts";
import {
    LLAMA_IDS,
    LlamaError,
    type ChartRequest,
    type DefiLlama,
    type PricePoint,
} from "../../src/prices/defillama.ts";
import { PRICE_RANGES, PriceHistory } from "../../src/prices/history.ts";
import { PerpPriceHistory } from "../../src/prices/perp-history.ts";
import { COINS } from "../../src/swaps/coins.ts";

const logger = pino({ level: "silent" });
const SYMBOLS = COINS.map((coin) => coin.symbol);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Each id at 100.1234567 for every point asked for, a minute apart. */
const everyPoint = (request: ChartRequest) =>
    new Map<string, PricePoint[]>(
        request.ids.map((id) => [
            id,
            Array.from({ length: request.span }, (_, i): PricePoint => [
                (request.end - (request.span - 1 - i) * 60) * 1000,
                100.1234567,
            ]),
        ]),
    );

type Answer = (request: ChartRequest) => Map<string, PricePoint[]> | Promise<Map<string, PricePoint[]>>;

function setup(answer: Answer = everyPoint) {
    let now = Date.parse("2026-10-13T12:00:00Z");
    const requests: ChartRequest[] = [];
    let respond = answer;
    const llama: DefiLlama = {
        async chart(request) {
            requests.push(request);
            return respond(request);
        },
    };
    const history = new PriceHistory({ llama, logger, now: () => now });
    return {
        history,
        llama,
        requests,
        answer: (next: Answer) => void (respond = next),
        advance: (ms: number) => void (now += ms),
        now: () => now,
    };
}

const failing: Answer = () => {
    throw new LlamaError("DefiLlama answered 500", { status: 500 });
};

const EXPECTED: Record<PriceRange, { span: number; period: string; stepMs: number; requests: number }> = {
    "1d": { span: 96, period: "15m", stepMs: 15 * MINUTE, requests: 3 },
    "7d": { span: 168, period: "1h", stepMs: 60 * MINUTE, requests: 6 },
    "30d": { span: 120, period: "6h", stepMs: 360 * MINUTE, requests: 3 },
    "90d": { span: 90, period: "1d", stepMs: 1440 * MINUTE, requests: 3 },
    "1y": { span: 365, period: "1d", stepMs: 1440 * MINUTE, requests: 11 },
};

test.each(PRICE_RANGES)("%s reads every coin once, in requests under DefiLlama's 500-point cap", async (range) => {
    const { history, requests, now } = setup();
    const expected = EXPECTED[range];

    const view = await history.view(range);

    expect(requests).toHaveLength(expected.requests);
    for (const request of requests) {
        expect(request.ids.length * request.span).toBeLessThanOrEqual(500);
        expect(request).toMatchObject({ span: expected.span, period: expected.period, end: Math.floor(now() / 1000) });
    }
    expect(requests.flatMap((request) => request.ids).sort()).toEqual(Object.values(LLAMA_IDS).sort());
    expect(view).toMatchObject({ range, stepMs: expected.stepMs, readAt: new Date(now()).toISOString() });
    expect(view!.coins.map((coin) => coin.symbol)).toEqual(SYMBOLS);
    for (const coin of view!.coins) {
        expect(coin.points).toHaveLength(expected.span);
        // Six significant digits are plenty for a chart
        expect(coin.points[0]![1]).toBe(100.123);
    }
});

test("a read is served for its TTL, then read again", async () => {
    const { history, requests, advance } = setup();

    const first = await history.view("1d");
    await history.view("1d");
    advance(5 * MINUTE - 1);
    await history.view("1d");
    expect(requests).toHaveLength(3);

    advance(1);
    const second = await history.view("1d");
    expect(requests).toHaveLength(6);
    expect(Date.parse(second!.readAt)).toBe(Date.parse(first!.readAt) + 5 * MINUTE);
});

test("requests at the same time share one read", async () => {
    const { history, requests } = setup();

    const views = await Promise.all([history.view("7d"), history.view("7d"), history.view("7d", ["ETH"])]);

    expect(requests).toHaveLength(6);
    expect(views[2]!.coins.map((coin) => coin.symbol)).toEqual(["ETH"]);
    expect(views[2]!.readAt).toBe(views[0]!.readAt);
});

test("coins come back in the order asked", async () => {
    const { history } = setup();

    const view = await history.view("7d", ["BTC", "ETH", "USDC"]);

    expect(view!.coins.map((coin) => coin.symbol)).toEqual(["BTC", "ETH", "USDC"]);
});

test("a failed read serves the last one, and DefiLlama is left alone for 30 s", async () => {
    const { history, requests, answer, advance } = setup();
    const first = await history.view("1d");
    advance(5 * MINUTE);
    answer(failing);

    const stale = await history.view("1d");
    expect(stale).toEqual(first);
    const asked = requests.length;

    advance(30_000 - 1);
    expect(await history.view("1d")).toEqual(first);
    expect(requests).toHaveLength(asked);

    answer(everyPoint);
    advance(1);
    const fresh = await history.view("1d");
    expect(requests.length).toBeGreaterThan(asked);
    expect(fresh!.readAt).not.toBe(first!.readAt);
});

test("with nothing read yet a failure is null, and a 429's Retry-After holds DefiLlama off longer", async () => {
    const { history, requests, answer, advance } = setup(() => {
        throw new LlamaError("DefiLlama answered 429", { status: 429, retryAfterMs: 120_000 });
    });

    expect(await history.view("90d")).toBeNull();
    const asked = requests.length;
    answer(everyPoint);
    advance(60_000);
    expect(await history.view("90d")).toBeNull();
    expect(requests).toHaveLength(asked);

    advance(60_000);
    expect(await history.view("90d")).not.toBeNull();
});

test("one failed batch fails the whole read", async () => {
    const { history } = setup((request) => {
        if (request.ids.includes(LLAMA_IDS.BTC!)) throw new LlamaError("DefiLlama answered 502", { status: 502 });
        return everyPoint(request);
    });

    expect(await history.view("7d")).toBeNull();
});

test("a coin DefiLlama doesn't price has no points, and none priced fails the read", async () => {
    const { history, answer, advance } = setup((request) => {
        const found = everyPoint(request);
        found.delete(LLAMA_IDS.DOGE!);
        return found;
    });

    const view = await history.view("7d");
    expect(view!.coins.find((coin) => coin.symbol === "DOGE")!.points).toEqual([]);
    expect(view!.coins.find((coin) => coin.symbol === "ETH")!.points).toHaveLength(168);

    answer(() => new Map());
    advance(15 * MINUTE);
    // Served from the last read, since nothing priced is taken for a failure
    expect((await history.view("7d"))!.readAt).toBe(view!.readAt);
    expect(await history.view("1d")).toBeNull();
});

test("the loop's tick reads every range, then each again once most of its TTL is gone", async () => {
    const { history, requests, advance } = setup();

    await history.tick();
    expect(requests).toHaveLength(26);
    await history.tick();
    expect(requests).toHaveLength(26);

    // 80% of 1d's 5 minutes
    advance(4 * MINUTE);
    await history.tick();
    expect(requests).toHaveLength(29);
    expect(new Set(requests.slice(26).map((request) => request.period))).toEqual(new Set(["15m"]));

    // So a request finds every range already read
    const asked = requests.length;
    await Promise.all(PRICE_RANGES.map((range) => history.view(range)));
    expect(requests).toHaveLength(asked);
});

test("the loop leaves a failing range alone until its retry", async () => {
    const { history, requests, answer, advance } = setup(failing);

    await history.tick();
    const asked = requests.length;
    answer(everyPoint);
    advance(30_000 - 1);
    await history.tick();
    expect(requests).toHaveLength(asked);

    advance(1);
    await history.tick();
    expect(requests).toHaveLength(asked + 26);
});

describe("perp coins", () => {
    const asked: string[] = [];
    const candles: HyperliquidClient["candles"] = async (asset, _interval, startMs, endMs) => {
        asked.push(asset);
        if (asset === "BROKEN") throw new Error("Hyperliquid answered 500");
        const found: Candle[] = [];
        for (let open = Math.ceil(startMs / HOUR) * HOUR; open <= endMs; open += HOUR)
            found.push({ openMs: open, close: 0.0041234567 });
        return found;
    };

    function withPerps(answer: Answer = everyPoint) {
        asked.length = 0;
        const base = setup(answer);
        const perps = new PerpPriceHistory({
            client: { candles },
            assets: () => ["BTC", "ETH", "kPEPE", "HYPE", "S", "0G", "BROKEN"],
            logger,
            now: base.now,
        });
        const history = new PriceHistory({ llama: base.llama, logger, now: base.now, perps });
        return { ...base, history };
    }

    test("a perp coin is read from Hyperliquid, a swap coin from DefiLlama, in the order asked", async () => {
        const { history, requests } = withPerps();

        const view = await history.view("7d", ["kPEPE", "ETH", "HYPE"]);

        expect(view!.coins.map((coin) => coin.symbol)).toEqual(["kPEPE", "ETH", "HYPE"]);
        expect(view).toMatchObject({ range: "7d", stepMs: 60 * MINUTE });
        expect(view!.coins[0]!.points.length).toBeGreaterThan(100);
        expect(view!.coins[0]!.points[0]![1]).toBe(0.00412346);
        expect(view!.coins[1]!.points).toHaveLength(168);
        expect(view!.coins[1]!.points[0]![1]).toBe(100.123);
        // Hyperliquid never prices a coin DefiLlama does
        expect(asked.sort()).toEqual(["HYPE", "kPEPE"]);
        expect(requests.flatMap((request) => request.ids)).toContain(LLAMA_IDS.ETH);
    });

    test("perp coins alone don't wait on DefiLlama", async () => {
        const { history, requests } = withPerps(failing);

        const view = await history.view("7d", ["S", "0G"]);

        expect(view!.coins.map((coin) => coin.symbol)).toEqual(["S", "0G"]);
        expect(view!.coins[0]!.points.length).toBeGreaterThan(100);
        expect(requests).toHaveLength(0);
        // But a swap coin does
        expect(await history.view("7d", ["ETH", "S"])).toBeNull();
    });

    test("a name Hyperliquid doesn't list is left out, and one it does is matched ignoring case", async () => {
        const { history } = withPerps();

        const view = await history.view("7d", ["XRP", "kpepe", "constructor", "KPEPE"]);

        expect(view!.coins.map((coin) => coin.symbol)).toEqual(["kPEPE"]);
        expect(asked).toEqual(["kPEPE"]);

        const nothing = await history.view("7d", ["XRP"]);
        expect(nothing).toMatchObject({ range: "7d", coins: [] });
    });

    test("the swap coins alone are the default, and none of them is read from Hyperliquid", async () => {
        const { history } = withPerps();

        const view = await history.view("7d");
        await history.view("7d", ["BTC", "eth"]);

        expect(view!.coins.map((coin) => coin.symbol)).toEqual(SYMBOLS);
        expect(asked).toEqual([]);
    });

    test("a perp coin that can't be read comes back without points", async () => {
        const { history } = withPerps();

        const view = await history.view("7d", ["BROKEN", "kPEPE"]);

        expect(view!.coins.map((coin) => [coin.symbol, coin.points.length > 0])).toEqual([
            ["BROKEN", false],
            ["kPEPE", true],
        ]);
    });

    test("it was read when the oldest of what it answers was read", async () => {
        const { history, advance, now } = withPerps();
        const first = now();
        await history.view("7d", ["kPEPE"]);
        advance(10 * MINUTE);

        const view = await history.view("7d", ["ETH", "kPEPE", "HYPE"]);

        expect(view!.readAt).toBe(new Date(first).toISOString());
        const later = await history.view("7d", ["HYPE"]);
        expect(later!.readAt).toBe(new Date(first + 10 * MINUTE).toISOString());
    });
});

test("an outage is logged once an hour per range and status, with the status and Retry-After", async () => {
    const quiet = pino({ level: "silent" });
    const warn = vi.spyOn(quiet, "warn");
    let now = Date.parse("2026-10-13T12:00:00Z");
    const llama: DefiLlama = {
        async chart() {
            throw new LlamaError("DefiLlama answered 429", { status: 429, retryAfterMs: 120_000 });
        },
    };
    const history = new PriceHistory({ llama, logger: quiet, now: () => now });
    await history.tick();
    now += 10 * MINUTE;
    await history.tick();
    const lines = warn.mock.calls.filter(([, message]) => message === "Couldn't read price history from DefiLlama");
    expect(lines.length).toBe(PRICE_RANGES.length);
    expect(lines[0]![0]).toMatchObject({ status: 429, retryAfterMs: 120_000, retryInMs: 120_000 });
});

test("one line says DefiLlama is readable again after an outage, and none for ranges that never failed", async () => {
    const quiet = pino({ level: "silent" });
    const info = vi.spyOn(quiet, "warn");
    let now = Date.parse("2026-10-13T12:00:00Z");
    let up = false;
    const llama: DefiLlama = {
        async chart(request) {
            if (!up) throw new LlamaError("DefiLlama answered 500", { status: 500 });
            return everyPoint(request);
        },
    };
    const history = new PriceHistory({ llama, logger: quiet, now: () => now });
    await history.tick();
    up = true;
    now += 31_000;
    await history.tick();
    await history.tick();
    const lines = info.mock.calls.filter(([, message]) => message === "Price history from DefiLlama is readable again");
    expect(lines.length).toBe(PRICE_RANGES.length);
    expect(lines[0]![0]).toMatchObject({ range: expect.any(String) });
});

test("one line says Hyperliquid candles are readable again after a failed read", async () => {
    const quiet = pino({ level: "silent" });
    const info = vi.spyOn(quiet, "warn");
    let now = Date.parse("2026-10-13T12:00:00Z");
    let up = false;
    const perps = new PerpPriceHistory({
        client: {
            candles: async (_asset, _interval, startMs, endMs) => {
                if (!up) throw new Error("Hyperliquid answered 500");
                const found: Candle[] = [];
                for (let open = Math.ceil(startMs / HOUR) * HOUR; open <= endMs; open += HOUR)
                    found.push({ openMs: open, close: 1 });
                return found;
            },
        },
        assets: () => ["BTC"],
        logger: quiet,
        now: () => now,
    });
    await perps.series("7d", ["BTC"]);
    up = true;
    now += 31_000;
    await perps.series("7d", ["BTC"]);
    await perps.series("7d", ["BTC"]);
    const lines = info.mock.calls.filter(([, message]) => message === "Price history from Hyperliquid is readable again");
    expect(lines.length).toBe(1);
    expect(lines[0]![0]).toMatchObject({ asset: "BTC", range: "7d" });
});
