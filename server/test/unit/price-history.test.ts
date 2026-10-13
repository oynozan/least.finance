import { pino } from "pino";
import { expect, test } from "vitest";
import type { PriceRange } from "../../src/protocol.ts";
import {
    LLAMA_IDS,
    LlamaError,
    type ChartRequest,
    type DefiLlama,
    type PricePoint,
} from "../../src/prices/defillama.ts";
import { PRICE_RANGES, PriceHistory } from "../../src/prices/history.ts";
import { COINS } from "../../src/swaps/coins.ts";

const logger = pino({ level: "silent" });
const SYMBOLS = COINS.map((coin) => coin.symbol);
const MINUTE = 60_000;

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
