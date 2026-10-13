import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Raw = Record<string, any>;

export type Fixtures = {
    recordedAt: string;
    top: Raw[];
    extra: Raw[];
    samples: Record<"yesNo" | "named" | "multi" | "sports" | "skipped" | "extra", string>;
};

export type FakePolymarket = {
    url: string;
    fixtures: Fixtures;
    /** Every request served, as "METHOD /path?query". */
    requests: string[];
    /** The book as /books serves it, or null for an unknown token. */
    book(
        tokenId: string,
    ): { bids: { price: string }[]; asks: { price: string }[]; min_order_size: string; tick_size: string } | null;
    setBook(tokenId: string, book: { bid: number | null; ask: number | null }): void;
    /** Closes the market and sets its result; `uma` is the resolution status it shows (default "resolved"). */
    resolve(marketId: string, outcomePrices: string[], options?: { uma?: string | null }): void;
    /** Gone from the top list, from search and from /events/:id (404). */
    hide(eventId: string): void;
    /** Sets when an event opened (shifted with the clock like endDate); null removes startDate and createdAt. Default: 20 days before now. */
    setOpened(eventId: string, at: Date | null): void;
    /** Serves these points for a token instead of the generated ones; null restores them. */
    setHistory(tokenId: string, points: { t: number; p: number }[] | null): void;
    /** Answers the next request to this path with a 500. */
    failNext(
        path: "/events" | "/events/:id" | "/markets/:id" | "/public-search" | "/books" | "/batch-prices-history",
    ): void;
    /** Makes the top list answer events that fail any schema. */
    malformed(): void;
    stop(): Promise<void>;
};

const readFixtures = (): Fixtures =>
    JSON.parse(readFileSync(new URL("../fixtures/polymarket/events.json", import.meta.url), "utf8"));

/**
 * Stands in for Polymarket's Gamma and CLOB APIs, serving the recorded events.
 * End dates move with the clock, so the recording never goes stale.
 */
export async function startFakePolymarket(options: { now?: () => number } = {}): Promise<FakePolymarket> {
    const now = options.now ?? Date.now;
    const fixtures = readFixtures();
    const recordedAt = Date.parse(fixtures.recordedAt);
    const hidden = new Set<string>();
    const overrides = new Map<string, { bid: number | null; ask: number | null }>();
    const failing = new Set<string>();
    const resolved = new Map<string, Raw>();
    let broken = false;
    const opened = new Map<string, Date | null>();
    const histories = new Map<string, { t: number; p: number }[]>();

    // Every token and the first-outcome book its market recorded
    const tokens = new Map<string, { market: Raw; first: boolean }>();
    for (const event of [...fixtures.top, ...fixtures.extra]) {
        for (const market of event.markets) {
            const ids = JSON.parse(market.clobTokenIds) as string[];
            ids.forEach((id, index) => tokens.set(id, { market, first: index === 0 }));
        }
    }

    const DAY = 86_400_000;
    const openedOf = (eventId: string) => (opened.has(eventId) ? opened.get(eventId)! : new Date(now() - 20 * DAY));

    const shifted = (event: Raw): Raw => {
        const move = (date: unknown) =>
            typeof date === "string" ? new Date(Date.parse(date) + (now() - recordedAt)).toISOString() : date;
        const copy = structuredClone(event);
        copy.endDate = move(copy.endDate);
        for (const market of copy.markets) market.endDate = move(market.endDate);
        const at = openedOf(String(event.id));
        copy.startDate = at?.toISOString() ?? null;
        copy.createdAt = at?.toISOString() ?? null;
        return copy;
    };
    const visible = (events: Raw[]) => events.filter((event) => !hidden.has(event.id)).map(shifted);

    const mirror = (value: number | null) => (value === null ? null : Math.round((1 - value) * 10_000) / 10_000);

    const bookOf = (tokenId: string) => {
        const token = tokens.get(tokenId);
        if (!token) return null;
        // The recorded bid and ask are the first token's; the other side's book mirrors them
        const firstId = (JSON.parse(token.market.clobTokenIds) as string[])[0]!;
        const first = overrides.get(firstId) ?? {
            bid: token.market.bestBid ?? null,
            ask: token.market.bestAsk ?? null,
        };
        const side =
            overrides.get(tokenId) ?? (token.first ? first : { bid: mirror(first.ask), ask: mirror(first.bid) });
        return {
            asset_id: tokenId,
            bids: side.bid === null ? [] : [{ price: String(side.bid), size: "100" }],
            asks: side.ask === null ? [] : [{ price: String(side.ask), size: "100" }],
            min_order_size: String(token.market.orderMinSize),
            tick_size: "0.01",
        };
    };

    // The event each token belongs to
    const eventOf = new Map<string, string>();
    for (const event of [...fixtures.top, ...fixtures.extra]) {
        for (const market of event.markets) {
            for (const id of JSON.parse(market.clobTokenIds) as string[]) eventOf.set(id, String(event.id));
        }
    }

    // A deterministic wave that ends at the token's current midpoint
    const historyOf = (tokenId: string, interval: string, fidelity: number) => {
        const set = histories.get(tokenId);
        if (set) return set;
        const book = bookOf(tokenId)!;
        const bid = book.bids[0] ? Number(book.bids[0].price) : null;
        const ask = book.asks[0] ? Number(book.asks[0].price) : null;
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask ?? 0.5);
        const openedAt = openedOf(eventOf.get(tokenId)!);
        const end = now();
        const window =
            interval === "1d" ? end - DAY : interval === "max" && fidelity < 720 ? end - 30 * DAY : -Infinity;
        const start = Math.max(window, openedAt?.getTime() ?? -Infinity);
        const step = fidelity * 60_000;
        const count = Math.min(5000, Math.max(1, Math.floor((end - start) / step)) + 1);
        const seed = Number(BigInt(tokenId) % 97n);
        return Array.from({ length: count }, (_, i) => {
            const left = 1 - i / Math.max(1, count - 1);
            const p = mid + 0.12 * left * Math.sin(i / 9 + seed);
            return {
                t: Math.floor((end - (count - 1 - i) * step) / 1000),
                p: i === count - 1 ? mid : Math.round(Math.min(0.99, Math.max(0.01, p)) * 10_000) / 10_000,
            };
        });
    };

    const server = createServer((req, res) => {
        const send = (status: number, body: unknown) =>
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const url = new URL(req.url ?? "/", "http://localhost");
        fake.requests.push(`${req.method} ${req.url}`);

        const market = /^\/markets\/([^/]+)$/.exec(url.pathname);
        if (failing.delete(market ? "/markets/:id" : url.pathname)) return send(500, { error: "Unavailable" });
        if (req.method === "GET" && market) {
            const id = decodeURIComponent(market[1]!);
            const raw = [...fixtures.top, ...fixtures.extra].flatMap((e) => e.markets).find((m) => m.id === id);
            return raw ? send(200, { ...raw, ...resolved.get(id) }) : send(404, { error: "not found" });
        }

        const one = /^\/events\/([^/]+)$/.exec(url.pathname);
        if (failing.delete(one ? "/events/:id" : url.pathname)) return send(500, { error: "Unavailable" });

        if (req.method === "GET" && url.pathname === "/events") {
            return send(200, broken ? [{ unexpected: true }, { id: 7 }] : visible(fixtures.top));
        }

        if (req.method === "GET" && one) {
            const id = decodeURIComponent(one[1]!);
            const event = visible([...fixtures.top, ...fixtures.extra]).find((e) => e.id === id);
            return event ? send(200, event) : send(404, { error: "not found" });
        }

        if (req.method === "GET" && url.pathname === "/public-search") {
            const query = (url.searchParams.get("q") ?? "").toLowerCase();
            const events = visible([...fixtures.top, ...fixtures.extra])
                .filter((event) => String(event.title).toLowerCase().includes(query))
                .slice(0, Number(url.searchParams.get("limit_per_type") ?? 20));
            return send(200, { events, pagination: { hasMore: false, totalResults: events.length } });
        }

        if (req.method === "POST" && url.pathname === "/books") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                const asked = JSON.parse(body) as { token_id: string }[];
                send(
                    200,
                    asked.map(({ token_id }) => bookOf(token_id)).filter((book) => book !== null),
                );
            });
            return;
        }

        if (req.method === "POST" && url.pathname === "/batch-prices-history") {
            let body = "";
            const logged = fake.requests.length - 1;
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                // The request log keeps the body, so tests can see the interval asked
                fake.requests[logged] += ` ${body}`;
                const { markets, interval, fidelity } = JSON.parse(body) as {
                    markets?: string[];
                    interval?: string;
                    fidelity?: number;
                };
                if (!Array.isArray(markets) || markets.length > 20 || !interval) {
                    return send(400, { error: "Invalid request" });
                }
                const history: Record<string, { t: number; p: number }[]> = {};
                for (const token of markets) {
                    if (tokens.has(token)) history[token] = historyOf(token, interval, fidelity ?? 1);
                }
                send(200, { history });
            });
            return;
        }
        send(404, { error: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakePolymarket = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        fixtures,
        requests: [],
        book: (tokenId) => bookOf(tokenId),
        setBook: (tokenId, book) => overrides.set(tokenId, book),
        resolve: (marketId, outcomePrices, { uma = "resolved" } = {}) =>
            resolved.set(marketId, {
                closed: true,
                acceptingOrders: false,
                umaResolutionStatus: uma,
                outcomePrices: JSON.stringify(outcomePrices),
                conditionId: `0xcondition-${marketId}`,
            }),
        setOpened: (eventId, at) => void opened.set(eventId, at),
        setHistory: (tokenId, points) => void (points ? histories.set(tokenId, points) : histories.delete(tokenId)),
        hide: (eventId) => hidden.add(eventId),
        failNext: (path) => failing.add(path),
        malformed: () => {
            broken = true;
        },
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return fake;
}
