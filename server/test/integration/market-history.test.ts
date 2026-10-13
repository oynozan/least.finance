import { afterAll, afterEach, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { MarketHistoryView } from "../../src/protocol.ts";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());
afterEach(() => vi.useRealTimers());

const get = async (path: string) => {
    const response = await fetch(`${stack.url}${path}`);
    return { status: response.status, headers: response.headers, json: (await response.json()) as any };
};

const tokensOf = async (eventId: string): Promise<string[]> =>
    (await get(`/markets/${eventId}`)).json.outcomes.map((o: { tokenId: string }) => o.tokenId);

const history = (eventId: string, tokens: string[]) => get(`/markets/${eventId}/history?outcomes=${tokens.join(",")}`);
const historyCalls = () => stack.polymarket.requests.filter((r) => r.startsWith("POST /batch-prices-history"));

describe("market history route", () => {
    // Token ranges are disjoint between tests, since a read stays cached for 3 minutes
    test("each event's age picks its resolution", async () => {
        const { yesNo, multi } = stack.polymarket.fixtures.samples;
        // The server keeps an event for a minute, so a minute on it reads the new opening time
        stack.polymarket.setOpened(yesNo, new Date(Date.now() - 2 * 3_600_000));
        stack.polymarket.setOpened(multi, new Date(Date.now() - 200 * 86_400_000));
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
        const [yes, no] = await tokensOf(yesNo);
        const [first] = await tokensOf(multi);

        const before = historyCalls().length;
        const young = await history(yesNo, [yes!, no!]);
        expect(young.status).toBe(200);
        expect(young.json.stepMs).toBe(300_000);
        expect(historyCalls().slice(before).join()).toContain('"interval":"1d"');

        const old = await history(multi, [first!]);
        expect(old.status).toBe(200);
        expect(old.json.stepMs).toBe(86_400_000);
    });

    test("a Yes/No event's two lines come back in the order asked, without a token", async () => {
        const { yesNo } = stack.polymarket.fixtures.samples;
        const [yes, no] = await tokensOf(yesNo);
        const { status, headers, json } = await history(yesNo, [no!, yes!]);
        const view = json as MarketHistoryView;

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(view.outcomes.map((o) => o.tokenId)).toEqual([no, yes]);
        for (const outcome of view.outcomes) {
            const times = outcome.points.map(([time]) => time);
            expect(outcome.points.length).toBeGreaterThan(1);
            expect(times).toEqual([...times].sort((a, b) => a - b));
            for (const [, chance] of outcome.points) expect(chance).toBeGreaterThanOrEqual(0);
            for (const [, chance] of outcome.points) expect(chance).toBeLessThanOrEqual(1);
        }
        expect(view).toMatchObject({ eventId: yesNo, stepMs: expect.any(Number), readAt: expect.any(String) });
    });

    test("a multi-outcome event serves up to five of its outcomes in one upstream call", async () => {
        const { multi } = stack.polymarket.fixtures.samples;
        const five = (await tokensOf(multi)).slice(1, 6);
        expect(five).toHaveLength(5);
        const before = historyCalls().length;
        const { status, json } = await history(multi, five);
        expect(status).toBe(200);
        expect(json.outcomes.map((o: { tokenId: string }) => o.tokenId)).toEqual(five);
        expect(historyCalls()).toHaveLength(before + 1);
    });

    test("errors", async () => {
        const { yesNo, multi } = stack.polymarket.fixtures.samples;
        const [yes] = await tokensOf(yesNo);
        const others = await tokensOf(multi);

        const foreign = await history(yesNo, [others[0]!]);
        expect(foreign.status).toBe(404);
        expect(foreign.json.error.code).toBe("not_found");
        expect((await history("999999999", [yes!])).status).toBe(404);

        for (const query of [`${others.slice(0, 6).join(",")}`, `${yes},${yes}`, "12ab", "", "1,,2"]) {
            const response = await get(`/markets/${multi}/history?outcomes=${query}`);
            expect(response.status, query).toBe(400);
            expect(response.json.error.code).toBe("bad_request");
        }
        expect((await get(`/markets/${multi}/history`)).status).toBe(400);
    });

    test("a second read within 3 minutes is answered from memory", async () => {
        const { multi } = stack.polymarket.fixtures.samples;
        const tokens = (await tokensOf(multi)).slice(6, 7);
        expect((await history(multi, tokens)).status).toBe(200);
        const before = historyCalls().length;
        expect((await history(multi, tokens)).status).toBe(200);
        expect(historyCalls()).toHaveLength(before);
    });

    test("concurrent reads share one upstream call", async () => {
        const { multi } = stack.polymarket.fixtures.samples;
        const tokens = (await tokensOf(multi)).slice(7, 8);
        const before = historyCalls().length;
        const [a, b] = await Promise.all([history(multi, tokens), history(multi, tokens)]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.json).toEqual(b.json);
        expect(historyCalls()).toHaveLength(before + 1);
    });

    test("a failure after a good read serves the cached lines; with nothing cached it is 503 unavailable", async () => {
        const { named } = stack.polymarket.fixtures.samples;
        const [good, fresh] = await tokensOf(named);
        const first = await history(named, [good!]);
        expect(first.status).toBe(200);

        // Four minutes on, the read is stale, so Polymarket is asked again and fails
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 4 * 60_000 });
        stack.polymarket.failNext("/batch-prices-history");
        const stale = await history(named, [good!]);
        expect(stale.status).toBe(200);
        expect(stale.json.outcomes).toEqual(first.json.outcomes);
        expect(stale.json.readAt).toBe(first.json.readAt);
        vi.useRealTimers();

        stack.polymarket.failNext("/batch-prices-history");
        const none = await history(named, [fresh!]);
        expect(none.status).toBe(503);
        expect(none.json.error.code).toBe("unavailable");
    });

    test("the route is rate-limited like the other market routes", async () => {
        const { yesNo } = stack.polymarket.fixtures.samples;
        const [yes] = await tokensOf(yesNo);
        const first = await history(yesNo, [yes!]);
        const left = Number(/"120-in-1min"; r=(\d+)/.exec(first.headers.get("ratelimit") ?? "")?.[1]);
        expect(first.headers.get("ratelimit-policy")).toContain("q=120");
        for (let i = 0; i < left; i++) expect((await history(yesNo, [yes!])).status).toBe(200);
        const over = await history(yesNo, [yes!]);
        expect(over.status).toBe(429);
        expect(over.json.error.code).toBe("rate_limited");
    });
});
