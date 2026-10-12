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
    setBook(tokenId: string, book: { bid: number | null; ask: number | null }): void;
    /** Gone from the top list, from search and from /events/:id (404). */
    hide(eventId: string): void;
    /** Answers the next request to this path with a 500. */
    failNext(path: "/events" | "/public-search" | "/books"): void;
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

    // Every token and the first-outcome book its market recorded
    const tokens = new Map<string, { market: Raw; first: boolean }>();
    for (const event of [...fixtures.top, ...fixtures.extra]) {
        for (const market of event.markets) {
            const ids = JSON.parse(market.clobTokenIds) as string[];
            ids.forEach((id, index) => tokens.set(id, { market, first: index === 0 }));
        }
    }

    const shifted = (event: Raw): Raw => {
        const move = (date: unknown) =>
            typeof date === "string" ? new Date(Date.parse(date) + (now() - recordedAt)).toISOString() : date;
        const copy = structuredClone(event);
        copy.endDate = move(copy.endDate);
        for (const market of copy.markets) market.endDate = move(market.endDate);
        return copy;
    };
    const visible = (events: Raw[]) => events.filter((event) => !hidden.has(event.id)).map(shifted);

    const mirror = (value: number | null) => (value === null ? null : Math.round((1 - value) * 10_000) / 10_000);

    const bookOf = (tokenId: string) => {
        const token = tokens.get(tokenId);
        if (!token) return null;
        // The recorded bid and ask are the first token's; the other side's book mirrors them
        const firstId = (JSON.parse(token.market.clobTokenIds) as string[])[0]!;
        const first = overrides.get(firstId) ?? { bid: token.market.bestBid ?? null, ask: token.market.bestAsk ?? null };
        const side = overrides.get(tokenId) ?? (token.first ? first : { bid: mirror(first.ask), ask: mirror(first.bid) });
        return {
            asset_id: tokenId,
            bids: side.bid === null ? [] : [{ price: String(side.bid), size: "100" }],
            asks: side.ask === null ? [] : [{ price: String(side.ask), size: "100" }],
            min_order_size: String(token.market.orderMinSize),
            tick_size: "0.01",
        };
    };

    const server = createServer((req, res) => {
        const send = (status: number, body: unknown) =>
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const url = new URL(req.url ?? "/", "http://localhost");
        fake.requests.push(`${req.method} ${req.url}`);

        if (failing.delete(url.pathname)) return send(500, { error: "Unavailable" });

        if (req.method === "GET" && url.pathname === "/events") return send(200, visible(fixtures.top));

        const one = /^\/events\/([^/]+)$/.exec(url.pathname);
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
        send(404, { error: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakePolymarket = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        fixtures,
        requests: [],
        setBook: (tokenId, book) => overrides.set(tokenId, book),
        hide: (eventId) => hidden.add(eventId),
        failNext: (path) => failing.add(path),
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return fake;
}
