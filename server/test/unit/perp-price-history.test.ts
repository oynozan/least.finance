import { pino } from "pino";
import { expect, test } from "vitest";
import type { Candle, CandleInterval } from "../../src/perps/client.ts";
import type { PriceRange } from "../../src/protocol.ts";
import { PRICE_RANGES, RANGES } from "../../src/prices/history.ts";
import { PerpPriceHistory } from "../../src/prices/perp-history.ts";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WIDTH: Record<CandleInterval, number> = { "15m": 15 * MINUTE, "1h": HOUR, "2h": 2 * HOUR, "1d": DAY };
/** Seven minutes into a quarter hour, so the current candle of every width is still forming. */
const NOW = Date.parse("2026-10-13T12:07:00Z");

/** A candle's close names its place on its interval's grid, so a point says which candle it came from. */
const closeOf = (openMs: number, interval: CandleInterval) => ((openMs / WIDTH[interval]) % 100_000) + 1;

type Answer = (asset: string, interval: CandleInterval, startMs: number, endMs: number) => Candle[] | Promise<Candle[]>;

/** Every candle opening in the window, as Hyperliquid answers. */
const everyCandle: Answer = (_asset, interval, startMs, endMs) => {
    const candles: Candle[] = [];
    for (let open = Math.ceil(startMs / WIDTH[interval]) * WIDTH[interval]; open <= endMs; open += WIDTH[interval])
        candles.push({ openMs: open, close: closeOf(open, interval) });
    return candles;
};

const failing: Answer = () => {
    throw new Error("Hyperliquid answered 500");
};

type Options = { listed?: string[]; maxEntries?: number; weightPerMinute?: number };

function setup(answer: Answer = everyCandle, options: Options = {}) {
    let now = NOW;
    let listed = options.listed ?? ["BTC", "kPEPE", "HYPE", "S", "0G", "TRUMP"];
    let respond = answer;
    const reads: { asset: string; interval: CandleInterval; startMs: number; endMs: number }[] = [];
    const client = {
        async candles(asset: string, interval: CandleInterval, startMs: number, endMs: number) {
            reads.push({ asset, interval, startMs, endMs });
            return respond(asset, interval, startMs, endMs);
        },
    };
    const history = new PerpPriceHistory({
        client,
        assets: () => listed,
        logger,
        now: () => now,
        ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
        ...(options.weightPerMinute === undefined ? {} : { weightPerMinute: options.weightPerMinute }),
    });
    return {
        history,
        reads,
        answer: (next: Answer) => void (respond = next),
        advance: (ms: number) => void (now += ms),
        list: (...names: string[]) => void (listed = names),
    };
}

/** How each range is read: candles of this width, every `stride`th one counting back from the newest. */
const PLAN: Record<PriceRange, { interval: CandleInterval; stride: number }> = {
    "1d": { interval: "15m", stride: 1 },
    "7d": { interval: "1h", stride: 1 },
    "30d": { interval: "2h", stride: 3 },
    "90d": { interval: "1d", stride: 1 },
    "1y": { interval: "1d", stride: 1 },
};

test.each(PRICE_RANGES)("%s reads one candle window and lines its points up with the range's step", async (range) => {
    const { history, reads } = setup();
    const { interval, stride } = PLAN[range];
    const { span, stepMs } = RANGES[range];
    const width = WIDTH[interval];

    const series = (await history.series(range, ["kPEPE"])).get("kPEPE")!;

    expect(width * stride).toBe(stepMs);
    expect(reads).toEqual([{ asset: "kPEPE", interval, startMs: NOW - (span * stride + 1) * width, endMs: NOW }]);
    expect(series.at).toBe(NOW);
    expect(series.points).toHaveLength(span);
    // The candle forming now, then every step back from it
    const newest = Math.floor(NOW / width) * width;
    const opens = Array.from({ length: span }, (_, i) => newest - (span - 1 - i) * stepMs);
    expect(series.points.map(([, usd]) => usd)).toEqual(opens.map((open) => closeOf(open, interval)));
    // A candle's price is the price at its end; the forming one is priced now
    expect(series.points.map(([time]) => time)).toEqual(opens.map((open) => Math.min(open + width, NOW)));
    expect(series.points.at(-1)![0]).toBe(NOW);
});

test("a close is kept to six significant digits", async () => {
    const { history } = setup((_asset, _interval, startMs) => [
        { openMs: Math.ceil(startMs / HOUR) * HOUR, close: 0.0041234567 },
    ]);

    const series = (await history.series("7d", ["kPEPE"])).get("kPEPE")!;

    expect(series.points.map(([, usd]) => usd)).toEqual([0.00412346]);
});

test.each(PRICE_RANGES)("%s is served for the same TTL as DefiLlama's, then read again", async (range) => {
    const { history, reads, advance } = setup();
    const { ttlMs } = RANGES[range];

    const first = (await history.series(range, ["HYPE"])).get("HYPE")!;
    advance(ttlMs - 1);
    await history.series(range, ["HYPE"]);
    expect(reads).toHaveLength(1);

    advance(1);
    const second = (await history.series(range, ["HYPE"])).get("HYPE")!;
    expect(reads).toHaveLength(2);
    expect(second.at).toBe(first.at + ttlMs);
});

test("each coin and range is its own read", async () => {
    const { history, reads } = setup();

    await history.series("7d", ["kPEPE", "HYPE"]);
    await history.series("1d", ["kPEPE"]);

    expect(reads.map((read) => [read.asset, read.interval])).toEqual([
        ["kPEPE", "1h"],
        ["HYPE", "1h"],
        ["kPEPE", "15m"],
    ]);
});

test("requests at the same time share one read", async () => {
    const { history, reads } = setup();

    const [a, b, c] = await Promise.all([
        history.series("7d", ["kPEPE"]),
        history.series("7d", ["kPEPE", "HYPE"]),
        history.series("7d", ["kpepe"]),
    ]);

    expect(reads.map((read) => read.asset).sort()).toEqual(["HYPE", "kPEPE"]);
    expect(a.get("kPEPE")).toBe(b.get("kPEPE"));
    expect(c.get("kPEPE")).toBe(a.get("kPEPE"));
});

test("a failed read leaves the coin out, and Hyperliquid alone for 30 s", async () => {
    const { history, reads, answer, advance } = setup(failing);

    expect((await history.series("7d", ["kPEPE"])).size).toBe(0);
    expect(reads).toHaveLength(1);

    answer(everyCandle);
    advance(30_000 - 1);
    expect((await history.series("7d", ["kPEPE"])).size).toBe(0);
    expect(reads).toHaveLength(1);

    // Another coin or range isn't held back by it
    expect((await history.series("7d", ["HYPE"])).size).toBe(1);
    expect((await history.series("1d", ["kPEPE"])).size).toBe(1);

    advance(1);
    expect((await history.series("7d", ["kPEPE"])).size).toBe(1);
});

test("while Hyperliquid fails, the last read is served", async () => {
    const { history, reads, answer, advance } = setup();
    const first = (await history.series("7d", ["kPEPE"])).get("kPEPE")!;
    advance(RANGES["7d"].ttlMs);
    answer(failing);

    const stale = (await history.series("7d", ["kPEPE"])).get("kPEPE");
    expect(stale).toBe(first);
    expect(reads).toHaveLength(2);

    advance(30_000 - 1);
    expect((await history.series("7d", ["kPEPE"])).get("kPEPE")).toBe(first);
    expect(reads).toHaveLength(2);

    answer(everyCandle);
    advance(1);
    expect((await history.series("7d", ["kPEPE"])).get("kPEPE")!.at).toBe(NOW + RANGES["7d"].ttlMs + 30_000);
    expect(reads).toHaveLength(3);
});

test("a name Hyperliquid doesn't list is ignored, and never reaches Hyperliquid", async () => {
    const { history, reads, list } = setup();

    const found = await history.series("7d", ["XRP", "constructor", "__proto__", "kPEPE"]);
    expect([...found.keys()]).toEqual(["kPEPE"]);
    expect(reads.map((read) => read.asset)).toEqual(["kPEPE"]);

    // Once it's no longer listed, even a series already read isn't served
    list("BTC");
    expect((await history.series("7d", ["kPEPE"])).size).toBe(0);
    expect(reads).toHaveLength(1);
});

test("a listed market is matched ignoring case, and answers under its own name", async () => {
    const { history, reads } = setup();

    expect(history.market("kPEPE")).toBe("kPEPE");
    expect(history.market("KPEPE")).toBe("kPEPE");
    expect(history.market("hype")).toBe("HYPE");
    expect(history.market("s")).toBe("S");
    expect(history.market("0g")).toBe("0G");
    expect(history.market("XRP")).toBeUndefined();
    expect(history.market("constructor")).toBeUndefined();

    const found = await history.series("7d", ["kpepe", "KPEPE"]);
    expect([...found.keys()]).toEqual(["kPEPE"]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.asset).toBe("kPEPE");
});

test("a candle Hyperliquid has no trades for is a missing point, not a filled one", async () => {
    const quiet = new Set([NOW - 3 * HOUR, NOW - 40 * HOUR].map((time) => Math.floor(time / HOUR) * HOUR));
    const { history } = setup(async (...args) => (await everyCandle(...args)).filter((c) => !quiet.has(c.openMs)));

    const series = (await history.series("7d", ["kPEPE"])).get("kPEPE")!;

    expect(series.points).toHaveLength(166);
    const times = series.points.map(([time]) => time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const open of quiet) expect(times).not.toContain(open + HOUR);
});

test("the 30d range keeps every third 2-hour candle, and a gap off that grid costs nothing", async () => {
    const newest = Math.floor(NOW / (2 * HOUR)) * 2 * HOUR;
    const onGrid = newest - 3 * 6 * HOUR;
    const offGrid = newest - 4 * HOUR;
    const { history } = setup(async (...args) =>
        (await everyCandle(...args)).filter((c) => c.openMs !== onGrid && c.openMs !== offGrid),
    );

    const series = (await history.series("30d", ["kPEPE"])).get("kPEPE")!;

    const opens = Array.from({ length: 120 }, (_, i) => newest - (119 - i) * 6 * HOUR).filter(
        (open) => open !== onGrid,
    );
    expect(series.points.map(([time]) => time)).toEqual(opens.map((open) => Math.min(open + 2 * HOUR, NOW)));
});

test("when the current candle has no trade yet, the points step back from the newest one", async () => {
    const current = Math.floor(NOW / HOUR) * HOUR;
    const { history } = setup(async (...args) => (await everyCandle(...args)).filter((c) => c.openMs !== current));

    const series = (await history.series("7d", ["kPEPE"])).get("kPEPE")!;

    expect(series.points).toHaveLength(168);
    // The last full hour ended at the start of this one
    expect(series.points.at(-1)).toEqual([current, closeOf(current - HOUR, "1h")]);
    expect(series.points.at(-2)![0]).toBe(current - HOUR);
});

test("a close that isn't a positive number is dropped", async () => {
    const { history } = setup((_asset, _interval, startMs) => {
        const first = Math.ceil(startMs / HOUR) * HOUR;
        return [
            { openMs: first, close: 0 },
            { openMs: first + HOUR, close: Number.NaN },
            { openMs: first + 2 * HOUR, close: -1 },
            { openMs: first + 3 * HOUR, close: 2.5 },
        ];
    });

    expect((await history.series("7d", ["kPEPE"])).get("kPEPE")!.points.map(([, usd]) => usd)).toEqual([2.5]);
});

test("a market with no candles is a read all the same, kept for its TTL", async () => {
    const { history, reads } = setup(() => []);

    expect((await history.series("7d", ["kPEPE"])).get("kPEPE")!.points).toEqual([]);
    await history.series("7d", ["kPEPE"]);

    expect(reads).toHaveLength(1);
});

test("the series kept are bounded, the least recently used going first", async () => {
    const { history, reads } = setup(everyCandle, { maxEntries: 2 });

    await history.series("7d", ["kPEPE"]);
    await history.series("7d", ["HYPE"]);
    // kPEPE is used again, so HYPE is the one to go
    await history.series("7d", ["kPEPE"]);
    await history.series("7d", ["TRUMP"]);
    expect(reads).toHaveLength(3);

    await history.series("7d", ["kPEPE"]);
    await history.series("7d", ["TRUMP"]);
    expect(reads).toHaveLength(3);
    await history.series("7d", ["HYPE"]);
    expect(reads).toHaveLength(4);
});

test("no more than two reads are in flight at once", async () => {
    let active = 0;
    let peak = 0;
    const { history, reads } = setup(async (...args) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return everyCandle(...args);
    });

    const found = await history.series("7d", ["kPEPE", "HYPE", "S", "0G", "TRUMP"]);

    expect(found.size).toBe(5);
    expect(reads).toHaveLength(5);
    expect(peak).toBe(2);
});

test("reads are held to a weight a minute, and a read refused for it isn't a failure", async () => {
    // Hyperliquid weighs a candle read 20, and 1 more for every 60 candles it returns
    const week = 20 + Math.ceil((168 + 2) / 60);
    const { history, reads, advance } = setup(everyCandle, { weightPerMinute: 2 * week });

    const found = await history.series("7d", ["kPEPE", "HYPE", "S"]);
    expect(found.size).toBe(2);
    expect(reads).toHaveLength(2);

    // The refused one isn't waiting out a back-off: it reads as soon as the minute has room
    advance(MINUTE - 1);
    expect((await history.series("7d", ["S"])).size).toBe(0);
    expect(reads).toHaveLength(2);
    advance(1);
    expect((await history.series("7d", ["S"])).size).toBe(1);
    expect(reads).toHaveLength(3);
});
