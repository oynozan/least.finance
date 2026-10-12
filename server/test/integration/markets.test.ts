import { pino } from "pino";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gammaEvent } from "../../src/markets/gamma.ts";
import { MarketService } from "../../src/markets/markets.ts";
import { createPolymarketData, type PolymarketData } from "../../src/markets/polymarket-data.ts";
import { shapeEvent } from "../../src/markets/shape.ts";
import { startFakePolymarket, type FakePolymarket } from "../support/fake-polymarket.ts";

let fake: FakePolymarket;
let clock: number;
let service: MarketService;
let warn: ReturnType<typeof vi.fn>;

afterEach(() => fake.stop());

const count = (prefix: string) => fake.requests.filter((r) => r.startsWith(prefix)).length;

// The fake keeps its hides and overrides, so each test gets a fresh one
beforeEach(async () => {
    fake = await startFakePolymarket({ now: () => clock });
    clock = Date.parse(fake.fixtures.recordedAt);
    const logger = pino({ level: "silent" });
    warn = vi.spyOn(logger, "warn") as unknown as ReturnType<typeof vi.fn>;
    service = new MarketService({
        data: createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url, logger }),
        logger,
        syncMs: 60_000,
        now: () => clock,
    });
});

const shapedTop = () =>
    fake.fixtures.top.map((raw) => shapeEvent(gammaEvent.parse(raw), new Date(clock))).filter((view) => view !== null);

test("trending is the first 50 events that shape, in volume order", async () => {
    await service.tick();
    const { markets, readAt } = service.trending();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(50);
    expect(markets[0]!.id).toBe(shapedTop()[0]!.id);
    expect(markets.map((m) => m.id)).toEqual(
        shapedTop()
            .slice(0, 50)
            .map((m) => m.id),
    );
    expect(readAt).toBe(new Date(clock).toISOString());
});

test("before the first sync, trending is empty with readAt null", () => {
    expect(service.trending()).toEqual({ markets: [], maxOrderUSD: null, readAt: null });
});

test("a failed sync keeps the last list", async () => {
    await service.tick();
    const before = service.trending();
    fake.failNext("/events");
    await service.tick();
    expect(service.trending()).toEqual(before);
    expect(warn).toHaveBeenCalled();
});

test("search shapes the results and caches each query for 60 s", async () => {
    const first = await service.search("  Fed ");
    expect(first.query).toBe("fed");
    expect(first.markets.length).toBeGreaterThan(0);
    await service.search("fed");
    expect(count("GET /public-search")).toBe(1);
    clock += 61_000;
    await service.search("fed");
    expect(count("GET /public-search")).toBe(2);
});

test("a one-character query asks Polymarket nothing", async () => {
    expect(await service.search("f")).toEqual({ query: "f", markets: [] });
    expect(fake.requests).toEqual([]);
});

test("event prices come from the books, cached for 5 s", async () => {
    const id = fake.fixtures.samples.yesNo;
    const token = shapedTop().find((m) => m.id === id)!.outcomes[0]!.tokenId;
    const before = (await service.event(id))!.outcomes[0]!.buyPrice;
    const ask = before === 0.5 ? 0.52 : 0.5;
    fake.setBook(token, { bid: ask - 0.02, ask });
    expect((await service.event(id))!.outcomes[0]!.buyPrice).toBe(before);
    clock += 5_000;
    expect((await service.event(id))!.outcomes[0]!.buyPrice).toBe(ask);
});

test("an event that's gone, or no longer shapes, is null", async () => {
    const { yesNo, named } = fake.fixtures.samples;
    fake.hide(named);
    expect(await service.event(named)).toBeNull();

    const raw = fake.fixtures.top.find((e) => e.id === yesNo)!;
    const token = JSON.parse(raw.markets[0].clobTokenIds)[0] as string;
    fake.setBook(token, { bid: 0.2, ask: 0.5 });
    expect(await service.event(yesNo)).toBeNull();
});

test("a requested event is re-read by the sync for 10 minutes", async () => {
    const id = fake.fixtures.samples.extra;
    await service.event(id);
    const reads = () => count(`GET /events/${id}`);
    expect(reads()).toBe(1);
    await service.tick();
    expect(reads()).toBe(2);
    clock += 600_000;
    await service.tick();
    expect(reads()).toBe(3);
    clock += 1;
    await service.tick();
    expect(reads()).toBe(3);
});

test("concurrent event() calls share one books request", async () => {
    const id = fake.fixtures.samples.yesNo;
    const views = await Promise.all([service.event(id), service.event(id), service.event(id)]);
    expect(views[0]).not.toBeNull();
    expect(views[1]).toEqual(views[0]);
    expect(count("POST /books")).toBe(1);
});

const TOP_REQUEST = "GET /events?active=true&closed=false&order=volume24hr&ascending=false&limit=100";

test("the sync and search send Polymarket's exact parameters", async () => {
    await service.tick();
    expect(fake.requests).toContain(TOP_REQUEST);
    await service.search(" Fed ");
    const search = fake.requests.find((r) => r.includes("/public-search"))!;
    const params = new URL(search.split(" ")[1]!, "http://x").searchParams;
    expect(Object.fromEntries(params)).toEqual({ q: "fed", events_status: "active", limit_per_type: "20" });
});

test("an unknown event is never re-read by the sync", async () => {
    expect(await service.event("999999")).toBeNull();
    await service.tick();
    expect(count("GET /events/999999")).toBe(1);
});

test("an event that starts 404ing stops being re-read", async () => {
    const id = fake.fixtures.samples.extra;
    expect(await service.event(id)).not.toBeNull();
    fake.hide(id);
    await service.tick();
    await service.tick();
    expect(count(`GET /events/${id}`)).toBe(2);
});

test("the sync re-reads at most the 50 most recently requested events", async () => {
    const real = createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url });
    const reads: string[] = [];
    // Every ID answers with the YES/NO sample, so each one shapes
    const data: PolymarketData = {
        ...real,
        event: async (id) => {
            reads.push(id);
            return real.event(fake.fixtures.samples.yesNo);
        },
    };
    const many = new MarketService({ data, logger: pino({ level: "silent" }), syncMs: 60_000, now: () => clock });
    for (let i = 0; i < 60; i++) {
        clock += 1;
        await many.event(`e${i}`);
    }
    reads.length = 0;
    await many.tick();
    expect(reads).toHaveLength(50);
    expect(reads).not.toContain("e0");
    expect(reads[0]).toBe("e59");
});

test("event() falls back to the event's own prices when the books fail", async () => {
    const id = fake.fixtures.samples.yesNo;
    fake.failNext("/books");
    const view = await service.event(id);
    // The fake rewrites end dates in full ISO form, so only the prices are compared
    expect(view!.outcomes).toEqual(shapedTop().find((m) => m.id === id)!.outcomes);
    expect(warn).toHaveBeenCalled();
});

test("event() throws when the event read itself fails", async () => {
    fake.failNext("/events/:id");
    await expect(service.event(fake.fixtures.samples.yesNo)).rejects.toThrow(/500/);
});

test("a failed search throws and isn't cached", async () => {
    fake.failNext("/public-search");
    await expect(service.search("fed")).rejects.toThrow(/500/);
    expect((await service.search("fed")).markets.length).toBeGreaterThan(0);
    expect(count("GET /public-search")).toBe(2);
});

test("stop() ends the loop", async () => {
    service.start();
    await vi.waitFor(() => expect(service.trending().readAt).not.toBeNull());
    await service.stop();
    const seen = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.requests.length).toBe(seen);
});

test("stop() doesn't wait for the remaining re-reads", async () => {
    const real = createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url });
    let reads = 0;
    let gate: Promise<void> = Promise.resolve();
    let release = () => {};
    const slow = new MarketService({
        data: {
            ...real,
            event: async (id) => {
                reads++;
                await gate;
                return real.event(id);
            },
        },
        logger: pino({ level: "silent" }),
        syncMs: 60_000,
        now: () => clock,
    });
    const { yesNo, named, extra } = fake.fixtures.samples;
    for (const id of [yesNo, named, extra]) await slow.event(id);
    gate = new Promise<void>((resolve) => (release = resolve));
    reads = 0;
    slow.start();
    await vi.waitFor(() => expect(reads).toBe(1));
    const stopped = slow.stop();
    release();
    await stopped;
    expect(reads).toBe(1);
});

test("a sync that shapes nothing keeps the last list and warns", async () => {
    await service.tick();
    const before = service.trending();
    fake.malformed();
    warn.mockClear();
    await service.tick();
    expect(service.trending()).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(2);
});

test("events that fail the schema are counted in a warning", async () => {
    fake.malformed();
    warn.mockClear();
    const logger = pino({ level: "silent" });
    const spy = vi.spyOn(logger, "warn");
    const data = createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url, logger });
    expect(await data.topEvents()).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dropped: 2 }), expect.any(String));
});

test("a tick that throws once doesn't stop the sync loop", async () => {
    const logger = pino({ level: "silent" });
    const logged = vi.spyOn(logger, "warn");
    const data = { topEvents: async () => [] } as unknown as PolymarketData;
    const looping = new MarketService({ data, logger, syncMs: 10 });
    const tick = vi.spyOn(looping, "tick").mockRejectedValueOnce(new Error("boom"));
    looping.start();
    await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2));
    await looping.stop();
    expect(logged).toHaveBeenCalled();
});

test("entries left alone for 10 minutes are swept by a tick", async () => {
    const id = fake.fixtures.samples.extra;
    await service.event(id);
    expect(count(`GET /events/${id}`)).toBe(1);
    // Past the requested window and the event TTL, the next tick drops the cached read
    clock += 600_001;
    await service.tick();
    await service.event(id);
    expect(count(`GET /events/${id}`)).toBe(2);
    clock += 600_001;
    await service.tick();
    clock += 1;
    await service.event(id);
    expect(count("POST /books")).toBe(3);
});

test("an unknown event is remembered as unknown for 60 s", async () => {
    expect(await service.event("999999")).toBeNull();
    expect(await service.event("999999")).toBeNull();
    expect(count("GET /events/999999")).toBe(1);
    clock += 60_000;
    expect(await service.event("999999")).toBeNull();
    expect(count("GET /events/999999")).toBe(2);
});

test("identical searches in flight share one request", async () => {
    const results = await Promise.all([service.search("fed"), service.search(" Fed "), service.search("fed")]);
    expect(results[1]).toEqual(results[0]);
    expect(count("GET /public-search")).toBe(1);
});

test("a crossed book from the CLOB makes the event unavailable", async () => {
    const id = fake.fixtures.samples.yesNo;
    const token = shapedTop().find((m) => m.id === id)!.outcomes[0]!.tokenId;
    fake.setBook(token, { bid: 0.6, ask: 0.5 });
    expect(await service.event(id)).toBeNull();
});
