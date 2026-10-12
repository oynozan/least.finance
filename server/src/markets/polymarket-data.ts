import type { Logger } from "pino";
import { z } from "zod";
import { gammaEvent, gammaMarket, type GammaEvent, type GammaMarket } from "./gamma.ts";

const TIMEOUT_MS = 5_000;

export type Book = { bestBid: number | null; bestAsk: number | null; minOrderSize: number | null };

export interface PolymarketData {
    topEvents(): Promise<GammaEvent[]>;
    search(query: string): Promise<GammaEvent[]>;
    /** Null when Polymarket has no such event. */
    event(id: string): Promise<GammaEvent | null>;
    /** One market by ID, open or closed; null when Polymarket has no such market. */
    market(id: string): Promise<GammaMarket | null>;
    books(tokenIds: string[]): Promise<Map<string, Book>>;
}

const level = z.object({ price: z.coerce.number().finite() });
const bookResponse = z.array(
    z.object({
        asset_id: z.string(),
        bids: z.array(level),
        asks: z.array(level),
        min_order_size: z.coerce.number().finite().nullish(),
    }),
);
const searchResponse = z.object({ events: z.array(z.unknown()).nullish() });

// One odd event shouldn't cost the rest of the list
function parseEvents(items: unknown[], logger?: Logger): GammaEvent[] {
    const events = items.flatMap((item) => {
        const parsed = gammaEvent.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
    if (events.length < items.length)
        logger?.warn({ dropped: items.length - events.length }, "Dropped events that failed the schema");
    return events;
}

export function createPolymarketData(options: {
    gammaUrl: string;
    clobUrl: string;
    fetch?: typeof fetch;
    logger?: Logger;
}): PolymarketData {
    const { gammaUrl, clobUrl, fetch: call = fetch, logger } = options;

    async function send(base: string, path: string, init: RequestInit = {}, allowMissing = false): Promise<unknown> {
        const response = await call(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.status === 200) return response.json();
        if (allowMissing && response.status === 404) return null;
        throw new Error(`Polymarket answered ${response.status} to ${path}`);
    }

    return {
        async topEvents() {
            const body = await send(
                gammaUrl,
                "/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100",
            );
            return parseEvents(z.array(z.unknown()).parse(body), logger);
        },

        async search(query) {
            const params = new URLSearchParams({ q: query, events_status: "active", limit_per_type: "20" });
            const body = searchResponse.parse(await send(gammaUrl, `/public-search?${params}`));
            return parseEvents(body.events ?? [], logger);
        },

        async event(id) {
            const body = await send(gammaUrl, `/events/${encodeURIComponent(id)}`, {}, true);
            return body === null ? null : gammaEvent.parse(body);
        },

        async market(id) {
            const body = await send(gammaUrl, `/markets/${encodeURIComponent(id)}`, {}, true);
            return body === null ? null : gammaMarket.parse(body);
        },

        async books(tokenIds) {
            const body = await send(clobUrl, "/books", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
            });
            const books = new Map<string, Book>();
            // Matched by asset_id, since the answer's order and length aren't promised
            for (const book of bookResponse.parse(body)) {
                const bids = book.bids.map((l) => l.price);
                const asks = book.asks.map((l) => l.price);
                books.set(book.asset_id, {
                    bestBid: bids.length ? Math.max(...bids) : null,
                    bestAsk: asks.length ? Math.min(...asks) : null,
                    minOrderSize: book.min_order_size ?? null,
                });
            }
            return books;
        },
    };
}
