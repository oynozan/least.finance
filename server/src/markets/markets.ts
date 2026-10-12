import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { MarketSearchView, MarketView, TrendingView } from "../protocol.ts";
import type { GammaEvent } from "./gamma.ts";
import type { Book, PolymarketData } from "./polymarket-data.ts";
import { shapeEvent } from "./shape.ts";

const TRENDING_COUNT = 50;
const SEARCH_RESULTS = 20;
const MIN_QUERY_LENGTH = 2;
const SEARCH_TTL_MS = 60_000;
const EVENT_TTL_MS = 60_000;
const BOOKS_TTL_MS = 5_000;
const REQUESTED_TTL_MS = 600_000;
/** Re-reads per sync, most recently requested first. */
const MAX_REREADS = 50;

type Deps = {
    data: PolymarketData;
    logger: Logger;
    syncMs: number;
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
            try {
                await this.tick(signal);
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Market sync failed");
            }
            await sleep(this.#deps.syncMs, undefined, { signal }).catch(() => undefined);
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
            if (markets.length === 0) this.#deps.logger.warn({ read: top.length }, "Polymarket's top events shaped to nothing");
            else this.#trending = { value: markets, at: now };
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't read Polymarket's top events");
        }

        for (const [id, requestedAt] of this.#requested) if (now - requestedAt > REQUESTED_TTL_MS) this.#requested.delete(id);
        const recent = [...this.#requested].sort((a, b) => b[1] - a[1]).slice(0, MAX_REREADS);
        for (const [id] of recent) {
            if (signal?.aborted) return;
            try {
                const event = await this.#deps.data.event(id);
                if (event) this.#events.set(id, { value: event, at: now });
                else this.#events.delete(id);
                if (!event || !shapeEvent(event, date)) this.#requested.delete(id);
            } catch (error) {
                this.#deps.logger.warn({ err: error, event: id }, "Couldn't re-read a requested event");
            }
        }
    }

    trending(): TrendingView {
        return {
            markets: this.#trending?.value ?? [],
            maxOrderUSD: null,
            readAt: this.#trending ? new Date(this.#trending.at).toISOString() : null,
        };
    }

    async search(query: string): Promise<MarketSearchView> {
        const key = query.trim().toLowerCase();
        if (key.length < MIN_QUERY_LENGTH) return { query: key, markets: [] };

        const now = this.#now();
        for (const [cached, read] of this.#searches) if (now - read.at >= SEARCH_TTL_MS) this.#searches.delete(cached);
        const hit = this.#searches.get(key);
        if (hit) return { query: key, markets: hit.value };

        const events = await this.#deps.data.search(key);
        const date = new Date(now);
        const markets = events
            .map((event) => shapeEvent(event, date))
            .filter((view) => view !== null)
            .slice(0, SEARCH_RESULTS);
        this.#searches.set(key, { value: markets, at: now });
        return { query: key, markets };
    }

    /** One event with its prices from the order books; null when it's gone or nothing in it can be bought. */
    event(id: string): Promise<MarketView | null> {
        const pending = this.#reading.get(id) ?? this.#read(id).finally(() => this.#reading.delete(id));
        this.#reading.set(id, pending);
        return pending;
    }

    async #read(id: string): Promise<MarketView | null> {
        const now = this.#now();
        let cached = this.#events.get(id);
        if (!cached || now - cached.at >= EVENT_TTL_MS) {
            const event = await this.#deps.data.event(id);
            if (!event) {
                this.#events.delete(id);
                this.#books.delete(id);
                this.#requested.delete(id);
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
        else this.#requested.delete(id);
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
            this.#deps.logger.warn({ err: error, event: event.id }, "Couldn't read an event's order books");
            return null;
        }
    }
}
