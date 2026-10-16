import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { PriceHistoryView, PriceRange } from "../protocol.ts";
import { COINS } from "../swaps/coins.ts";
import { LLAMA_IDS, LlamaError, MAX_POINTS, type DefiLlama, type PricePoint } from "./defillama.ts";
import type { PerpPriceHistory } from "./perp-history.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Each range's points per coin, the time between them, and how long a read is served before DefiLlama is asked again. */
export const RANGES: Record<PriceRange, { span: number; stepMs: number; ttlMs: number }> = {
    "1d": { span: 96, stepMs: 15 * MINUTE, ttlMs: 5 * MINUTE },
    "7d": { span: 168, stepMs: HOUR, ttlMs: 15 * MINUTE },
    "30d": { span: 120, stepMs: 6 * HOUR, ttlMs: HOUR },
    "90d": { span: 90, stepMs: DAY, ttlMs: 3 * HOUR },
    "1y": { span: 365, stepMs: DAY, ttlMs: 6 * HOUR },
};

export const PRICE_RANGES = Object.keys(RANGES) as [PriceRange, ...PriceRange[]];

/** Chart requests in flight at once, so a cold year (one coin a request) isn't a burst of 11. */
const CONCURRENCY = 3;
/** How long a range waits after a failed read before DefiLlama is asked again. */
const RETRY_MS = 30_000;
/** How often the background loop looks for ranges due a read. */
const SYNC_MS = 30_000;
/** The loop reads a range again once this share of its TTL has passed, so a request never finds it stale. */
const REFRESH_AT = 0.8;

const SYMBOLS = COINS.map((coin) => coin.symbol).filter((symbol) => symbol in LLAMA_IDS);

/** The swap coin a name stands for, ignoring case; any other name is a perp market or nothing. */
const swapCoin = (name: string) => [name, name.toUpperCase()].find((symbol) => Object.hasOwn(LLAMA_IDS, symbol));

const periodOf = (ms: number) =>
    ms % DAY === 0 ? `${ms / DAY}d` : ms % HOUR === 0 ? `${ms / HOUR}h` : `${ms / MINUTE}m`;

type Read = { coins: Map<string, PricePoint[]>; at: number };

type Deps = {
    llama: DefiLlama;
    /** Prices the perp markets DefiLlama has no id for; without it only the swap coins have history. */
    perps?: Pick<PerpPriceHistory, "market" | "series">;
    logger: Logger;
    /** The clock, for tests. */
    now?: () => number;
};

/**
 * The swap coins' dollar price history, read from DefiLlama. A background
 * loop reads every range for every coin at start and again before its TTL is
 * up, so requests are answered from memory; a range it hasn't read yet is
 * read on request, one read at a time. While DefiLlama fails, the last read
 * is served and DefiLlama is left alone for a while.
 */
export class PriceHistory {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #reads = new Map<PriceRange, Read>();
    readonly #reading = new Map<PriceRange, Promise<void>>();
    /** When each range may ask DefiLlama again after a failed read. */
    readonly #retryAt = new Map<PriceRange, number>();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    async #run(signal: AbortSignal) {
        while (!signal.aborted) {
            await this.tick(signal);
            await sleep(SYNC_MS, undefined, { signal }).catch(() => undefined);
        }
    }

    /** Reads each range that's due, one range at a time: never read, or most of its TTL gone, and not waiting out a failure. */
    async tick(signal?: AbortSignal): Promise<void> {
        for (const range of PRICE_RANGES) {
            if (signal?.aborted) return;
            const kept = this.#reads.get(range);
            const now = this.#now();
            if (kept && now - kept.at < RANGES[range].ttlMs * REFRESH_AT) continue;
            if (now < (this.#retryAt.get(range) ?? 0)) continue;
            await this.#shared(range);
        }
    }

    /**
     * The range for these coins, every swap coin by default, in the order asked.
     * A swap coin is DefiLlama's, and null means it has never been read and can't
     * be now; any other name is a perp market Hyperliquid lists, read from its
     * candles, or is left out. A perp market that can't be read has no points.
     */
    async view(range: PriceRange, symbols: readonly string[] = SYMBOLS): Promise<PriceHistoryView | null> {
        const perps = this.#deps.perps;
        // Each coin once by its own name, and whether DefiLlama is the one to ask
        const wanted = new Map<string, boolean>();
        for (const name of symbols) {
            const swap = swapCoin(name);
            const symbol = swap ?? perps?.market(name);
            if (symbol !== undefined) wanted.set(symbol, swap !== undefined);
        }

        const swap = [...wanted.values()].includes(true);
        const read = swap ? await this.#current(range) : null;
        if (swap && !read) return null;
        const markets = [...wanted].flatMap(([symbol, llama]) => (llama ? [] : [symbol]));
        const series = perps && markets.length > 0 ? await perps.series(range, markets) : new Map();

        const readAts = [...(read ? [read.at] : []), ...[...series.values()].map((one) => one.at)];
        return {
            range,
            stepMs: RANGES[range].stepMs,
            coins: [...wanted].map(([symbol, llama]) => ({
                symbol,
                points: (llama ? read!.coins.get(symbol) : series.get(symbol)?.points) ?? [],
            })),
            readAt: new Date(readAts.length > 0 ? Math.min(...readAts) : this.#now()).toISOString(),
        };
    }

    async #current(range: PriceRange): Promise<Read | null> {
        const kept = this.#reads.get(range);
        const now = this.#now();
        if (kept && now - kept.at < RANGES[range].ttlMs) return kept;
        if (now < (this.#retryAt.get(range) ?? 0)) return kept ?? null;
        await this.#shared(range);
        return this.#reads.get(range) ?? null;
    }

    /** The range's read in flight, or a new one; the loop and requests share it. */
    #shared(range: PriceRange): Promise<void> {
        let pending = this.#reading.get(range);
        if (!pending) {
            pending = this.#read(range).finally(() => this.#reading.delete(range));
            this.#reading.set(range, pending);
        }
        return pending;
    }

    /** Reads every coin in batches under DefiLlama's point cap; one failed batch fails the read. Never throws. */
    async #read(range: PriceRange): Promise<void> {
        const { span, stepMs } = RANGES[range];
        const at = this.#now();
        const perRequest = Math.max(1, Math.floor(MAX_POINTS / span));
        const batches: string[][] = [];
        for (let i = 0; i < SYMBOLS.length; i += perRequest) batches.push(SYMBOLS.slice(i, i + perRequest));

        const coins = new Map<string, PricePoint[]>();
        try {
            await inPool(batches, CONCURRENCY, async (batch) => {
                const found = await this.#deps.llama.chart({
                    ids: batch.map((symbol) => LLAMA_IDS[symbol]!),
                    end: Math.floor(at / 1000),
                    span,
                    period: periodOf(stepMs),
                });
                for (const symbol of batch) {
                    const points = found.get(LLAMA_IDS[symbol]!);
                    if (points)
                        coins.set(
                            symbol,
                            points.map(([time, usd]) => [time, Number(usd.toPrecision(6))]),
                        );
                }
            });
            const missing = SYMBOLS.filter((symbol) => !coins.has(symbol));
            // Not one coin priced is a changed API, not a quiet market
            if (missing.length === SYMBOLS.length) throw new LlamaError("DefiLlama priced none of the swap coins");
            if (missing.length > 0)
                this.#deps.logger.warn({ range, missing }, "DefiLlama has no prices for some coins");
            this.#reads.set(range, { coins, at });
            this.#retryAt.delete(range);
        } catch (error) {
            const wait = Math.max(RETRY_MS, error instanceof LlamaError ? (error.retryAfterMs ?? 0) : 0);
            this.#retryAt.set(range, this.#now() + wait);
            this.#deps.logger.warn(
                { err: error, range, retryInMs: wait },
                "Couldn't read price history from DefiLlama",
            );
        }
    }
}

/** Runs `work` over the items, `limit` at a time; the first failure stops new work and rejects. */
async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < items.length) {
            const item = items[next++]!;
            try {
                await work(item);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
