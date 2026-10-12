import { pino } from "pino";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gammaEvent } from "../../src/markets/gamma.ts";
import { MarketService } from "../../src/markets/markets.ts";
import { createPolymarketData } from "../../src/markets/polymarket-data.ts";
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
        data: createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url }),
        logger,
        syncMs: 60_000,
        now: () => clock,
    });
});

const shapedTop = () =>
    fake.fixtures.top
        .map((raw) => shapeEvent(gammaEvent.parse(raw), new Date(clock)))
        .filter((view) => view !== null);

test("trending is the first 50 events that shape, in volume order", async () => {
    await service.tick();
    const { markets, readAt } = service.trending();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.length).toBeLessThanOrEqual(50);
    expect(markets[0]!.id).toBe(shapedTop()[0]!.id);
    expect(markets.map((m) => m.id)).toEqual(shapedTop().slice(0, 50).map((m) => m.id));
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
