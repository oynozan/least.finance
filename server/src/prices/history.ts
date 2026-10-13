import type { Logger } from "pino";
import type { PriceHistoryView, PriceRange } from "../protocol.ts";
import { COINS } from "../swaps/coins.ts";
import { LLAMA_IDS, LlamaError, MAX_POINTS, type DefiLlama, type PricePoint } from "./defillama.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Each range's points per coin, the time between them, and how long a read is served before DefiLlama is asked again. */
const RANGES: Record<PriceRange, { span: number; stepMs: number; ttlMs: number }> = {
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

const SYMBOLS = COINS.map((coin) => coin.symbol).filter((symbol) => symbol in LLAMA_IDS);

const periodOf = (ms: number) =>
    ms % DAY === 0 ? `${ms / DAY}d` : ms % HOUR === 0 ? `${ms / HOUR}h` : `${ms / MINUTE}m`;

type Read = { coins: Map<string, PricePoint[]>; at: number };

type Deps = {
    llama: DefiLlama;
    logger: Logger;
    /** The clock, for tests. */
    now?: () => number;
};

/**
 * The swap coins' dollar price history, read from DefiLlama. A range is read
 * for every coin at once on the first request after its TTL, one read at a
 * time; while DefiLlama fails, the last read is served and DefiLlama is left
 * alone for a while.
 */
export class PriceHistory {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #reads = new Map<PriceRange, Read>();
    readonly #reading = new Map<PriceRange, Promise<void>>();
    /** When each range may ask DefiLlama again after a failed read. */
    readonly #retryAt = new Map<PriceRange, number>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** The range for these coins, every swap coin by default; null when it has never been read and can't be now. */
    async view(range: PriceRange, symbols: readonly string[] = SYMBOLS): Promise<PriceHistoryView | null> {
        const read = await this.#current(range);
        if (!read) return null;
        return {
            range,
            stepMs: RANGES[range].stepMs,
            coins: symbols.map((symbol) => ({ symbol, points: read.coins.get(symbol) ?? [] })),
            readAt: new Date(read.at).toISOString(),
        };
    }

    async #current(range: PriceRange): Promise<Read | null> {
        const kept = this.#reads.get(range);
        const now = this.#now();
        if (kept && now - kept.at < RANGES[range].ttlMs) return kept;
        if (now < (this.#retryAt.get(range) ?? 0)) return kept ?? null;
        let pending = this.#reading.get(range);
        if (!pending) {
            pending = this.#read(range).finally(() => this.#reading.delete(range));
            this.#reading.set(range, pending);
        }
        await pending;
        return this.#reads.get(range) ?? null;
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
