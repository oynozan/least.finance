import { readFileSync } from "node:fs";
import { pino, type Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import { MarketService } from "../../src/markets/markets.ts";
import { createPolymarketData } from "../../src/markets/polymarket-data.ts";
import { describeUpstream, UpstreamError } from "../../src/markets/upstream.ts";

const reply = (status: number, body: string) => async () => new Response(body, { status });
const data = (call: typeof fetch, logger?: Logger) =>
    createPolymarketData({ gammaUrl: "http://gamma", clobUrl: "http://clob", fetch: call, logger });

describe("what Polymarket said", () => {
    test("a 429 keeps the service, call, status, Retry-After and Polymarket's own words", async () => {
        const call = (async () =>
            new Response(JSON.stringify({ error: "Too Many Requests" }), {
                status: 429,
                headers: { "retry-after": "30" },
            })) as unknown as typeof fetch;
        const error = await data(call)
            .search("fed")
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as Error).message).toBe(
            'Polymarket Gamma answered 429 to GET /public-search: "Too Many Requests"',
        );
        expect(describeUpstream(error)).toMatchObject({
            message: "Polymarket is rate limiting us right now. Try again in a minute.",
            level: "warn",
            fields: { upstream: "Polymarket Gamma", upstreamStatus: 429, retryAfter: "30" },
        });
    });

    test("an HTML error page is trimmed to one line of text, and a 502 says it can't be reached", async () => {
        const error = await data(
            reply(502, "<html><body><h1>Bad   Gateway</h1></body></html>") as unknown as typeof fetch,
        )
            .topEvents()
            .catch((e: unknown) => e);
        expect((error as UpstreamError).body).toBe("Bad Gateway");
        expect(describeUpstream(error).message).toBe("Polymarket isn't reachable right now. Try again in a minute.");
    });

    test("a timeout says how long it waited, and a refused connection says it couldn't connect", async () => {
        const slow = (async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as unknown as typeof fetch;
        const timeout = await data(slow)
            .books(["1"])
            .catch((e: unknown) => e);
        expect((timeout as Error).message).toBe("Polymarket CLOB didn't answer POST /books within 5 s");
        expect(describeUpstream(timeout).message).toBe("Polymarket didn't answer in 5 seconds.");

        const refused = (async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }) as unknown as typeof fetch;
        const network = await data(refused)
            .topEvents()
            .catch((e: unknown) => e);
        expect((network as Error).message).toBe("Couldn't reach Polymarket Gamma for GET /events (ECONNREFUSED)");
    });

    test("an unreadable answer is an error with a ref the log fields carry, the same one each time it is described", async () => {
        const error = await data(reply(200, JSON.stringify({ nothing: true })) as unknown as typeof fetch)
            .books(["1"])
            .catch((e: unknown) => e);
        expect((error as UpstreamError).kind).toBe("shape");
        const said = describeUpstream(error);
        expect(said.level).toBe("error");
        expect(said.message).toMatch(/^Polymarket sent something we couldn't read \(ref [0-9a-f]{6}\)\.$/);
        expect(said.fields.ref).toBe(said.message.match(/ref ([0-9a-f]{6})/)![1]);
        expect(describeUpstream(error)).toBe(said);
    });
});

describe("what is dropped from a good answer", () => {
    const market = (id: string, over: object = {}) => ({
        id,
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 5,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.5","0.5"]',
        clobTokenIds: '["1","2"]',
        ...over,
    });

    test("an event that fails the schema is named with where it is wrong", async () => {
        const logger = pino({ level: "silent" });
        const warn = vi.spyOn(logger, "warn");
        const call = reply(200, JSON.stringify([{ id: "77", title: 5, markets: [] }])) as unknown as typeof fetch;
        expect(await data(call, logger).topEvents()).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            {
                dropped: 1,
                of: 1,
                samples: [{ id: "77", issues: "title: Invalid input: expected string, received number" }],
            },
            "Polymarket events failed our schema and were dropped",
        );
    });

    test("a market that fails the schema is named with its field and the text, once an hour", async () => {
        const logger = pino({ level: "silent" });
        const warn = vi.spyOn(logger, "warn");
        const body = JSON.stringify([
            { id: "9", title: "T", markets: [market("a"), market("b", { outcomes: "Yes,No" })] },
        ]);
        const call = (async () => new Response(body)) as unknown as typeof fetch;
        const reader = data(call, logger);
        const [event] = await reader.topEvents();
        expect(event!.markets.map((m) => m.id)).toEqual(["a"]);
        await reader.topEvents();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            { event: "9", skipped: 1, samples: ["market b outcomes: outcomes is not JSON: Yes,No"] },
            "Polymarket markets failed our schema and were skipped",
        );
    });
});

describe("the trending list while Polymarket is down", () => {
    test("says why it is empty, logs the outage once, and logs when it ends", async () => {
        const logger = pino({ level: "silent" });
        const warn = vi.spyOn(logger, "warn");
        const info = vi.spyOn(logger, "info");
        let clock = 1_000_000;
        let up = false;
        const { top } = JSON.parse(
            readFileSync(new URL("../fixtures/polymarket/events.json", import.meta.url), "utf8"),
        );
        const call = (async () =>
            up
                ? new Response(JSON.stringify(top))
                : new Response("slow down", { status: 429 })) as unknown as typeof fetch;
        const markets = new MarketService({ data: data(call), logger, syncMs: 60_000, now: () => clock });

        await markets.tick();
        expect(markets.trending().unavailableReason).toBe(
            "Polymarket is rate limiting us right now. Try again in a minute.",
        );
        clock += 60_000;
        await markets.tick();
        expect(
            warn.mock.calls.filter(([, message]) => message === "Couldn't read Polymarket's top events"),
        ).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ upstreamStatus: 429, upstreamBody: "slow down", failingForSec: 0 }),
            "Couldn't read Polymarket's top events",
        );
        expect(warn).toHaveBeenCalledWith(
            { sinceBootSec: 0, lastError: "Polymarket is rate limiting us right now. Try again in a minute." },
            "Trending list still empty since the server started",
        );

        up = true;
        clock += 60_000;
        await markets.tick();
        expect(markets.trending().unavailableReason).toBeUndefined();
        expect(info).toHaveBeenCalledWith({ downForSec: 120 }, "Polymarket's top events can be read again");
    });
});
