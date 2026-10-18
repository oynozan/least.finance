import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const get = async (path: string) => {
    const response = await fetch(`${stack.url}${path}`);
    return { status: response.status, headers: response.headers, json: (await response.json()) as any };
};

describe("market routes", () => {
    test("GET /markets/trending answers without a token", async () => {
        const { status, headers, json } = await get("/markets/trending");
        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(json.markets.length).toBeGreaterThan(0);
    });

    test("GET /markets/search?q=fed returns shaped events", async () => {
        const { status, headers, json } = await get("/markets/search?q=fed");
        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(json.query).toBe("fed");
        expect(json.markets.length).toBeGreaterThan(0);
        expect(json.markets[0].id).toEqual(expect.any(String));
        expect((await get(`/markets/search?q=${"a".repeat(101)}`)).status).toBe(400);
    });

    test("GET /markets/:eventId answers a shaped event", async () => {
        const id = stack.polymarket.fixtures.samples.yesNo;
        const { status, headers, json } = await get(`/markets/${id}`);
        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(json.id).toBe(id);
    });

    test("a failing Polymarket answers 503 unavailable, not 500", async () => {
        stack.polymarket.failNext("/public-search");
        const search = await get("/markets/search?q=unreadable");
        expect(search.status).toBe(503);
        expect(search.json.error).toEqual({
            code: "unavailable",
            message: "Polymarket isn't reachable right now. Try again in a minute.",
        });

        stack.polymarket.failNext("/events/:id");
        const event = await get(`/markets/${stack.polymarket.fixtures.samples.extra}`);
        expect(event.status).toBe(503);
        expect(event.json.error.code).toBe("unavailable");
    });

    test("GET /markets/:eventId is 404 for a hidden event and 400 for a non-numeric id", async () => {
        const hidden = stack.polymarket.fixtures.samples.extra;
        stack.polymarket.hide(hidden);
        const gone = await get(`/markets/${hidden}`);
        expect(gone.status).toBe(404);
        expect(gone.json.error.code).toBe("not_found");

        expect((await get("/markets/abc")).status).toBe(400);
        expect((await get("/markets/1234567890123")).status).toBe(400);
    });

    test("the search route is rate-limited at 60 a minute per IP", async () => {
        const first = await get("/markets/search?q=fed");
        const left = Number(/"60-in-1min"; r=(\d+)/.exec(first.headers.get("ratelimit") ?? "")?.[1]);
        expect(first.headers.get("ratelimit-policy")).toContain("q=60");
        // Earlier tests in this file already spent some of the 60
        for (let i = 0; i < left; i++) expect((await get("/markets/search?q=fed")).status).toBe(200);
        const over = await get("/markets/search?q=fed");
        expect(over.status).toBe(429);
        expect(over.json.error.code).toBe("rate_limited");
        expect(over.headers.get("cache-control")).toBe("no-store");
    });
});
