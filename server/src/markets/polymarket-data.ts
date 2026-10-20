import "../polymarket-proxy.ts";
import type { Logger } from "pino";
import { z } from "zod";
import { HourlyLog } from "../predictions/rebalance-log.ts";
import { gammaEvent, gammaMarket, issuesOf, skippedMarkets, type GammaEvent, type GammaMarket } from "./gamma.ts";
import { readBody, UpstreamError } from "./upstream.ts";

const TIMEOUT_MS = 5_000;
const HISTORY_TIMEOUT_MS = 8_000;

export type Book = { bestBid: number | null; bestAsk: number | null; minOrderSize: number | null };

export type HistoryQuery = { interval: "1d" | "max"; fidelity: number };
export type RawPoint = { t: number; p: number };

export interface PolymarketData {
    topEvents(): Promise<GammaEvent[]>;
    search(query: string): Promise<GammaEvent[]>;
    /** Null when Polymarket has no such event. */
    event(id: string): Promise<GammaEvent | null>;
    /** One market by ID, open or closed; null when Polymarket has no such market. */
    market(id: string): Promise<GammaMarket | null>;
    books(tokenIds: string[]): Promise<Map<string, Book>>;
    /** Each token's points as Polymarket answers them; a token it has nothing for is absent. */
    priceHistory(tokenIds: string[], query: HistoryQuery): Promise<Map<string, RawPoint[]>>;
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
const historyResponse = z.object({ history: z.record(z.string(), z.array(z.unknown())) });
const searchResponse = z.object({ events: z.array(z.unknown()).nullish() });

export function createPolymarketData(options: {
    gammaUrl: string;
    clobUrl: string;
    fetch?: typeof fetch;
    logger?: Logger;
}): PolymarketData {
    const { gammaUrl, clobUrl, fetch: call = fetch, logger } = options;
    const hourly = logger ? new HourlyLog(logger, Date.now) : null;

    // One odd event shouldn't cost the rest of the list
    function parseEvents(items: unknown[]): GammaEvent[] {
        const events: GammaEvent[] = [];
        const dropped: { id: unknown; issues: string }[] = [];
        for (const item of items) {
            const parsed = gammaEvent.safeParse(item);
            if (parsed.success) events.push(parsed.data);
            else dropped.push({ id: (item as { id?: unknown } | null)?.id ?? "?", issues: issuesOf(parsed.error) });
        }
        // Logged once an hour per first bad event, since a persistent one would repeat on every sync
        if (dropped.length)
            hourly?.once(
                `events:${dropped[0]!.id}`,
                "warn",
                { dropped: dropped.length, of: items.length, samples: dropped.slice(0, 3) },
                "Polymarket events failed our schema and were dropped",
            );
        // One line for the whole list, not one per event, since a few odd markets are on every sync
        const skippedBy = events.flatMap((event) => skippedMarkets(event).map((why) => ({ event: event.id, why })));
        if (skippedBy.length)
            hourly?.once(
                `markets:${skippedBy[0]!.event}:${skippedBy[0]!.why}`,
                "warn",
                {
                    skipped: skippedBy.length,
                    events: new Set(skippedBy.map((entry) => entry.event)).size,
                    samples: skippedBy.slice(0, 3),
                },
                "Polymarket markets failed our schema and were skipped",
            );
        return events;
    }

    /** Parses an answer, turning a schema failure into an error that says which call and what was wrong. */
    function shaped<T>(service: string, method: string, path: string, parse: () => T): T {
        try {
            return parse();
        } catch (error) {
            if (!(error instanceof z.ZodError)) throw error;
            throw new UpstreamError(
                "shape",
                `${service} answered ${method} ${path} in an unexpected shape: ${issuesOf(error)}`,
                { service, method, path },
                { cause: error },
            );
        }
    }

    async function send(
        base: string,
        path: string,
        init: RequestInit = {},
        allowMissing = false,
        timeoutMs = TIMEOUT_MS,
    ): Promise<unknown> {
        const service = base === clobUrl ? "Polymarket CLOB" : "Polymarket Gamma";
        const method = init.method ?? "GET";
        const shown = path.split("?")[0]!;
        const info = { service, method, path: shown };
        let response: Response;
        try {
            response = await call(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError")
                throw new UpstreamError(
                    "timeout",
                    `${service} didn't answer ${method} ${shown} within ${timeoutMs / 1000} s`,
                    info,
                    { timeoutMs, cause: error },
                );
            const code = (error as { cause?: { code?: string } }).cause?.code;
            throw new UpstreamError(
                "network",
                `Couldn't reach ${service} for ${method} ${shown}${code ? ` (${code})` : ""}`,
                info,
                { cause: error },
            );
        }
        if (response.status === 200) return response.json();
        if (allowMissing && response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        const body = await readBody(response);
        throw new UpstreamError(
            "status",
            `${service} answered ${response.status} to ${method} ${shown}${body ? `: "${body}"` : ""}`,
            info,
            { status: response.status, retryAfter: response.headers.get("retry-after"), body },
        );
    }

    return {
        async topEvents() {
            const body = await send(
                gammaUrl,
                "/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100",
            );
            return parseEvents(shaped("Polymarket Gamma", "GET", "/events", () => z.array(z.unknown()).parse(body)));
        },

        async search(query) {
            const params = new URLSearchParams({ q: query, events_status: "active", limit_per_type: "20" });
            const sent = await send(gammaUrl, `/public-search?${params}`);
            const body = shaped("Polymarket Gamma", "GET", "/public-search", () => searchResponse.parse(sent));
            return parseEvents(body.events ?? []);
        },

        async event(id) {
            const body = await send(gammaUrl, `/events/${encodeURIComponent(id)}`, {}, true);
            return body === null
                ? null
                : shaped("Polymarket Gamma", "GET", `/events/${id}`, () => gammaEvent.parse(body));
        },

        async market(id) {
            const body = await send(gammaUrl, `/markets/${encodeURIComponent(id)}`, {}, true);
            return body === null
                ? null
                : shaped("Polymarket Gamma", "GET", `/markets/${id}`, () => gammaMarket.parse(body));
        },

        async books(tokenIds) {
            const body = await send(clobUrl, "/books", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
            });
            const books = new Map<string, Book>();
            // Matched by asset_id, since the answer's order and length aren't promised
            for (const book of shaped("Polymarket CLOB", "POST", "/books", () => bookResponse.parse(body))) {
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

        async priceHistory(tokenIds, query) {
            const body = await send(
                clobUrl,
                "/batch-prices-history",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ markets: tokenIds, interval: query.interval, fidelity: query.fidelity }),
                },
                false,
                HISTORY_TIMEOUT_MS,
            );
            const histories = new Map<string, RawPoint[]>();
            for (const [token, items] of Object.entries(
                shaped("Polymarket CLOB", "POST", "/batch-prices-history", () => historyResponse.parse(body)).history,
            )) {
                const points: RawPoint[] = [];
                for (const item of items) {
                    const { t, p } = (item ?? {}) as { t?: unknown; p?: unknown };
                    if (typeof t === "number" && typeof p === "number") points.push({ t, p });
                }
                histories.set(token, points);
            }
            return histories;
        },
    };
}
