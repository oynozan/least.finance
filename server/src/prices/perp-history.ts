import type { Logger } from "pino";
import type { Candle, CandleInterval, HyperliquidClient } from "../perps/client.ts";
import type { PriceRange } from "../protocol.ts";
import type { PricePoint } from "./defillama.ts";
import { RANGES } from "./history.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The candles that make each range's points: one point per `stride` candles
 * counting back from the newest, so points sit a range's `stepMs` apart.
 * Hyperliquid has no 6-hour candle, so 30d reads 2-hour ones and keeps every third.
 */
const CANDLES: Record<PriceRange, { interval: CandleInterval; widthMs: number; stride: number }> = {
    "1d": { interval: "15m", widthMs: 15 * MINUTE, stride: 1 },
    "7d": { interval: "1h", widthMs: HOUR, stride: 1 },
    "30d": { interval: "2h", widthMs: 2 * HOUR, stride: 3 },
    "90d": { interval: "1d", widthMs: DAY, stride: 1 },
    "1y": { interval: "1d", widthMs: DAY, stride: 1 },
};

/** Series kept at once, across all coins and ranges; the least recently used goes first. */
const MAX_ENTRIES = 400;
/** How long a coin's range waits after a failed read before Hyperliquid is asked again. */
const RETRY_MS = 30_000;
/** Candle reads in flight at once. */
const CONCURRENCY = 2;
/**
 * What candle reads may weigh in a minute. Hyperliquid allows an IP 1200 a minute
 * across everything, and the markets sync, quotes and trades spend the rest.
 */
const WEIGHT_PER_MINUTE = 300;

/** What Hyperliquid weighs a candle read: 20, and 1 more for every 60 candles it returns. */
const weightOf = (candles: number) => 20 + Math.ceil(candles / 60);

/** One coin's prices over a range, oldest first, and when they were read. */
export type PerpSeries = { points: PricePoint[]; at: number };

type Deps = {
    client: Pick<HyperliquidClient, "candles">;
    /** The markets Hyperliquid lists now; no other name is ever asked for. */
    assets: () => readonly string[];
    logger: Logger;
    /** The clock, for tests. */
    now?: () => number;
    maxEntries?: number;
    weightPerMinute?: number;
};

/**
 * Price history for the perp markets DefiLlama has no id for, read from
 * Hyperliquid's candles the first time a coin is asked for and kept as long as
 * DefiLlama's ranges are. Reads share one flight per coin and range, at most
 * two run at once within a weight a minute, and a failed one is left alone for
 * a while while the last read is served.
 */
export class PerpPriceHistory {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #maxEntries: number;
    readonly #budget: number;
    /** Oldest use first. */
    readonly #kept = new Map<string, PerpSeries>();
    readonly #reading = new Map<string, Promise<void>>();
    /** When each coin's range may ask Hyperliquid again after a failed read. */
    readonly #retryAt = new Map<string, number>();
    readonly #spent: { at: number; weight: number }[] = [];
    #active = 0;
    readonly #waiting: (() => void)[] = [];

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#maxEntries = deps.maxEntries ?? MAX_ENTRIES;
        this.#budget = deps.weightPerMinute ?? WEIGHT_PER_MINUTE;
    }

    /** The listed market a name stands for, matched ignoring case; undefined when Hyperliquid doesn't list it. */
    market(name: string): string | undefined {
        const assets = this.#deps.assets();
        const lower = name.toLowerCase();
        return assets.find((asset) => asset === name) ?? assets.find((asset) => asset.toLowerCase() === lower);
    }

    /** The range for each listed market among these names, by market name; a name not listed, or a coin never read and unreadable now, is left out. */
    async series(range: PriceRange, names: readonly string[]): Promise<Map<string, PerpSeries>> {
        const assets = new Set<string>();
        for (const name of names) {
            const asset = this.market(name);
            if (asset !== undefined) assets.add(asset);
        }
        const found = new Map<string, PerpSeries>();
        await Promise.all(
            [...assets].map(async (asset) => {
                const series = await this.#current(range, asset);
                if (series) found.set(asset, series);
            }),
        );
        return found;
    }

    async #current(range: PriceRange, asset: string): Promise<PerpSeries | null> {
        const key = `${asset}|${range}`;
        const kept = this.#kept.get(key);
        const now = this.#now();
        if (kept && now - kept.at < RANGES[range].ttlMs) return this.#used(key, kept);
        if (now < (this.#retryAt.get(key) ?? 0)) return kept ? this.#used(key, kept) : null;
        let pending = this.#reading.get(key);
        if (!pending) {
            pending = this.#read(key, range, asset).finally(() => this.#reading.delete(key));
            this.#reading.set(key, pending);
        }
        await pending;
        const read = this.#kept.get(key);
        return read ? this.#used(key, read) : null;
    }

    #used(key: string, series: PerpSeries): PerpSeries {
        this.#kept.delete(key);
        this.#kept.set(key, series);
        while (this.#kept.size > this.#maxEntries) this.#kept.delete(this.#kept.keys().next().value!);
        return series;
    }

    /** Reads the coin's candles when a slot and weight allow. Never throws. */
    async #read(key: string, range: PriceRange, asset: string): Promise<void> {
        const { span } = RANGES[range];
        const { interval, widthMs, stride } = CANDLES[range];
        await this.#slot();
        try {
            const at = this.#now();
            // The window reaches one candle past the points, for when the newest candle has no trade yet
            const wanted = span * stride + 1;
            if (!this.#affordable(at, weightOf(wanted + 1))) {
                this.#deps.logger.debug({ asset, range }, "Hyperliquid candle reads are at their weight, skipping one");
                return;
            }
            const candles = await this.#deps.client.candles(asset, interval, at - wanted * widthMs, at);
            this.#used(key, { points: pointsOf(candles, range, at), at });
            this.#retryAt.delete(key);
        } catch (error) {
            this.#retryAt.set(key, this.#now() + RETRY_MS);
            this.#deps.logger.warn(
                { err: error, asset, range, retryInMs: RETRY_MS },
                "Couldn't read price history from Hyperliquid",
            );
        } finally {
            this.#release();
        }
    }

    /** Counts the weight against the minute when it fits. */
    #affordable(at: number, weight: number): boolean {
        while (this.#spent.length > 0 && at - this.#spent[0]!.at >= MINUTE) this.#spent.shift();
        const used = this.#spent.reduce((sum, spent) => sum + spent.weight, 0);
        if (used + weight > this.#budget) return false;
        this.#spent.push({ at, weight });
        return true;
    }

    async #slot(): Promise<void> {
        if (this.#active < CONCURRENCY) {
            this.#active += 1;
            return;
        }
        // A released slot is handed straight on, so the count stays
        await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    #release(): void {
        const next = this.#waiting.shift();
        if (next) next();
        else this.#active -= 1;
    }
}

/** A range's points: the closes of the newest candle and of each `stride`th one before it; a candle Hyperliquid has no trade for is a missing point. */
function pointsOf(candles: readonly Candle[], range: PriceRange, at: number): PricePoint[] {
    const { span } = RANGES[range];
    const { widthMs, stride } = CANDLES[range];
    const closes = new Map<number, number>();
    for (const { openMs, close } of candles) {
        if (Number.isFinite(openMs) && Number.isFinite(close) && close > 0) closes.set(openMs, close);
    }
    if (closes.size === 0) return [];
    const newest = [...closes.keys()].reduce((a, b) => Math.max(a, b));
    const points: PricePoint[] = [];
    for (let back = span - 1; back >= 0; back--) {
        const open = newest - back * stride * widthMs;
        const close = closes.get(open);
        // A candle's close is the price at its end; the one still forming is priced now
        if (close !== undefined) points.push([Math.min(open + widthMs, at), Number(close.toPrecision(6))]);
    }
    return points;
}
