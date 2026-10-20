import { setTimeout as sleep } from "node:timers/promises";
import { loopWatch } from "../loop-watch.ts";
import type { Logger } from "pino";
import { HourlyLog } from "../predictions/rebalance-log.ts";
import type { MarketOutcomeView, MarketSearchView, MarketView, PoolState, TrendingView } from "../protocol.ts";
import type { GammaEvent } from "./gamma.ts";
import type { Book, PolymarketData } from "./polymarket-data.ts";
import { shapeEvent } from "./shape.ts";
import { describeUpstream } from "./upstream.ts";

const TRENDING_COUNT = 50;
const SEARCH_RESULTS = 20;
const MIN_QUERY_LENGTH = 2;
const SEARCH_TTL_MS = 60_000;
const EVENT_TTL_MS = 60_000;
const BOOKS_TTL_MS = 5_000;
const REQUESTED_TTL_MS = 600_000;
const UNKNOWN_TTL_MS = 60_000;
/** Cached reads nobody asked for lately are dropped, so public routes can't grow the maps. */
const KEEP_MS = 600_000;
/** Re-reads per sync, most recently requested first. */
const MAX_REREADS = 50;

type Deps = {
    data: PolymarketData;
    logger: Logger;
    syncMs: number;
    /** The largest order the pool can cover now; null when predictions aren't live. */
    maxOrderUSD?: () => number | null;
    /** The pool's state and, when paused, why in plain words. */
    pool?: () => { state: PoolState; message?: string };
    /** The clock, for tests. */
    now?: () => number;
};

type Read<T> = { value: T; at: number };

/** Keeps Polymarket's top events fresh and serves them shaped into questions. */
export class MarketService {
    readonly #deps: Deps;
    readonly #now: () => number;
    #trending: Read<MarketView[]> | null = null;
    readonly #events = new Map<string, Read<GammaEvent>>();
    readonly #books = new Map<string, Read<Map<string, Book>>>();
    readonly #searches = new Map<string, Read<MarketView[]>>();
    /** When each event was last asked for, so the sync keeps it fresh. */
    readonly #requested = new Map<string, number>();
    readonly #reading = new Map<string, Promise<MarketView | null>>();
    readonly #searching = new Map<string, Promise<MarketView[]>>();
    /** When each unknown event ID was last found missing. */
    readonly #unknown = new Map<string, number>();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    /** Repeated failures log once an hour per read, so an outage doesn't fill the log. */
    readonly #hourly: HourlyLog;
    readonly #startedAt: number;
    /** When the top-events read began failing, until it next works. */
    #downSince: number | null = null;
    /** Why the last top-events read gave nothing, in the words the picker shows. */
    #lastError: string | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#hourly = new HourlyLog(deps.logger, this.#now);
        this.#startedAt = this.#now();
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
        const watch = loopWatch(this.#deps.logger, "market sync");
        while (!signal.aborted) {
            let waitMs = this.#deps.syncMs;
            try {
                await this.tick(signal);
                watch.ok();
            } catch (error) {
                // tick catches every read itself, so reaching this is a bug in the sync
                waitMs = watch.failed(error, this.#deps.syncMs);
            }
            await sleep(waitMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One sync: the top events, then each recently requested event by ID; a failure leaves what was kept. */
    async tick(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return;
        const now = this.#now();
        const date = new Date(now);
        try {
            const top = await this.#deps.data.topEvents();
            const markets: MarketView[] = [];
            for (const event of top) {
                this.#events.set(event.id, { value: event, at: now });
                const view = shapeEvent(event, date);
                if (view && markets.length < TRENDING_COUNT) markets.push(view);
            }
            // An empty answer is more likely a changed schema than a quiet market
            if (markets.length === 0) {
                this.#lastError = "Polymarket's list came back with nothing we can show.";
                this.#hourly.once(
                    "top-empty",
                    "warn",
                    { read: top.length },
                    "Polymarket's top events shaped to nothing",
                );
            } else {
                this.#trending = { value: markets, at: now };
                this.#lastError = null;
                if (this.#downSince !== null)
                    this.#deps.logger.warn(
                        { downForSec: Math.round((now - this.#downSince) / 1000) },
                        "Polymarket's top events can be read again",
                    );
                this.#downSince = null;
            }
        } catch (error) {
            const { message, fields } = describeUpstream(error);
            this.#downSince ??= now;
            this.#lastError = message;
            this.#hourly.once(
                "top-read",
                "warn",
                {
                    ...fields,
                    err: error,
                    failingForSec: Math.round((now - this.#downSince) / 1000),
                    trendingAgeSec: this.#trending ? Math.round((now - this.#trending.at) / 1000) : null,
                },
                "Couldn't read Polymarket's top events",
            );
            if (!this.#trending)
                this.#hourly.once(
                    "trending-empty",
                    "warn",
                    { sinceBootSec: Math.round((now - this.#startedAt) / 1000), lastError: message },
                    "Trending list still empty since the server started",
                );
        }

        for (const [id, requestedAt] of this.#requested)
            if (now - requestedAt > REQUESTED_TTL_MS) this.#requested.delete(id);
        const recent = [...this.#requested].sort((a, b) => b[1] - a[1]).slice(0, MAX_REREADS);
        for (const [id] of recent) {
            if (signal?.aborted) return;
            try {
                const event = await this.#deps.data.event(id);
                if (event) this.#events.set(id, { value: event, at: now });
                else this.#events.delete(id);
                if (!event || !shapeEvent(event, date)) this.#requested.delete(id);
            } catch (error) {
                this.#hourly.once(
                    `reread:${id}`,
                    "warn",
                    { ...describeUpstream(error).fields, err: error, event: id },
                    "Couldn't re-read a requested event",
                );
            }
        }
        this.sweep();
    }

    /** Drops cached reads that are stale and neither requested nor trending, and expired searches and unknown IDs. */
    sweep(): void {
        const now = this.#now();
        const trending = new Set(this.#trending?.value.map((view) => view.id));
        for (const cache of [this.#events, this.#books]) {
            for (const [id, read] of cache) {
                if (now - read.at > KEEP_MS && !this.#requested.has(id) && !trending.has(id)) cache.delete(id);
            }
        }
        for (const [key, read] of this.#searches) if (now - read.at >= SEARCH_TTL_MS) this.#searches.delete(key);
        for (const [id, at] of this.#unknown) if (now - at >= UNKNOWN_TTL_MS) this.#unknown.delete(id);
    }

    trending(): TrendingView {
        return {
            markets: this.#trending?.value ?? [],
            maxOrderUSD: this.#deps.maxOrderUSD?.() ?? null,
            ...this.#poolView(),
            readAt: this.#trending ? new Date(this.#trending.at).toISOString() : null,
            // Only while there is nothing to show: why, so the picker can say it instead of waiting
            ...(!this.#trending && this.#lastError && { unavailableReason: this.#lastError }),
        };
    }

    #poolView(): { poolState?: PoolState; poolMessage?: string } {
        const pool = this.#deps.pool?.();
        return pool ? { poolState: pool.state, ...(pool.message && { poolMessage: pool.message }) } : {};
    }

    async search(query: string): Promise<MarketSearchView> {
        const key = query.trim().toLowerCase();
        if (key.length < MIN_QUERY_LENGTH) return { query: key, markets: [] };

        const now = this.#now();
        const hit = this.#searches.get(key);
        if (hit && now - hit.at < SEARCH_TTL_MS) return { query: key, markets: hit.value };

        const pending = this.#searching.get(key) ?? this.#find(key, now).finally(() => this.#searching.delete(key));
        this.#searching.set(key, pending);
        return { query: key, markets: await pending };
    }

    async #find(key: string, now: number): Promise<MarketView[]> {
        const events = await this.#deps.data.search(key);
        const date = new Date(now);
        const markets = events
            .map((event) => shapeEvent(event, date))
            .filter((view) => view !== null)
            .slice(0, SEARCH_RESULTS);
        this.#searches.set(key, { value: markets, at: now });
        return markets;
    }

    /** One event with its prices from the order books; null when it's gone or nothing in it can be bought. */
    event(id: string): Promise<MarketView | null> {
        const pending = this.#reading.get(id) ?? this.#read(id).finally(() => this.#reading.delete(id));
        this.#reading.set(id, pending);
        return pending;
    }

    /** One offered outcome of an event, at most 5 s fresh; null when the event or the outcome is no longer offered. */
    async outcome(
        eventId: string,
        tokenId: string,
    ): Promise<{ outcome: MarketOutcomeView; marketId: string; question: string } | null> {
        const view = await this.event(eventId);
        const outcome = view?.outcomes.find((o) => o.tokenId === tokenId);
        const market = this.#events.get(eventId)?.value.markets.find((m) => m.clobTokenIds.includes(tokenId));
        if (!view || !outcome || !market) return null;
        return { outcome, marketId: market.id, question: view.title };
    }

    /** Every outcome token of the cached event, offered now or not; null when it isn't cached. */
    tokensOf(eventId: string): ReadonlySet<string> | null {
        const event = this.#events.get(eventId)?.value;
        return event ? new Set(event.markets.flatMap((market) => market.clobTokenIds)) : null;
    }

    /** When the cached event opened: its startDate, else createdAt, else null (also null when it isn't cached). */
    openedAt(eventId: string): Date | null {
        const event = this.#events.get(eventId)?.value;
        for (const text of [event?.startDate, event?.createdAt]) {
            const date = text ? new Date(text) : null;
            if (date && !Number.isNaN(date.getTime())) return date;
        }
        return null;
    }

    async #read(id: string): Promise<MarketView | null> {
        const now = this.#now();
        const missing = this.#unknown.get(id);
        if (missing !== undefined && now - missing < UNKNOWN_TTL_MS) return null;
        let cached = this.#events.get(id);
        if (!cached || now - cached.at >= EVENT_TTL_MS) {
            const event = await this.#deps.data.event(id);
            if (!event) {
                this.#events.delete(id);
                this.#books.delete(id);
                this.#requested.delete(id);
                this.#unknown.set(id, now);
                return null;
            }
            cached = { value: event, at: now };
            this.#events.set(id, cached);
        }

        const raw = cached.value;
        const books = await this.#booksOf(raw, now);
        const patched: GammaEvent = {
            ...raw,
            markets: raw.markets.map((market) => {
                const book = books?.get(market.clobTokenIds[0] ?? "");
                if (!book) return market;
                return {
                    ...market,
                    bestBid: book.bestBid,
                    bestAsk: book.bestAsk,
                    orderMinSize: book.minOrderSize ?? market.orderMinSize,
                };
            }),
        };
        const view = shapeEvent(patched, new Date(now));
        // Only an event that can be shown is kept fresh, so unknown IDs cost nothing
        if (view) this.#requested.set(id, now);
        else {
            this.#requested.delete(id);
            this.#unknown.set(id, now);
        }
        return view;
    }

    // Falls back to the event's own prices when the books can't be read
    async #booksOf(event: GammaEvent, now: number): Promise<Map<string, Book> | null> {
        const cached = this.#books.get(event.id);
        if (cached && now - cached.at < BOOKS_TTL_MS) return cached.value;
        const tokens = event.markets.flatMap((market) => market.clobTokenIds.slice(0, 1));
        if (tokens.length === 0) return null;
        try {
            const books = await this.#deps.data.books(tokens);
            this.#books.set(event.id, { value: books, at: now });
            return books;
        } catch (error) {
            this.#hourly.once(
                `books:${event.id}`,
                "warn",
                { ...describeUpstream(error).fields, err: error, event: event.id, tokens: tokens.length },
                "Couldn't read an event's order books",
            );
            return null;
        }
    }
}
