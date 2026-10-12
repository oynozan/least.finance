import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { gammaEvent } from "../../src/markets/gamma.ts";
import { shapeEvent } from "../../src/markets/shape.ts";

type Raw = Record<string, any>;

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/polymarket/events.json", import.meta.url), "utf8")) as {
    recordedAt: string;
    top: Raw[];
    extra: Raw[];
    samples: Record<"yesNo" | "named" | "multi" | "sports" | "skipped" | "extra", string>;
};
const now = new Date(fixtures.recordedAt);
const { samples } = fixtures;

const raw = (id: string): Raw => structuredClone([...fixtures.top, ...fixtures.extra].find((e) => e.id === id)!);
const event = (id: string) => gammaEvent.parse(raw(id));

// The single YES/NO sample with its market edited
function edited(changes: Raw) {
    const source = raw(samples.yesNo);
    Object.assign(source.markets[0], changes);
    return shapeEvent(gammaEvent.parse(source), now);
}

test("a single YES/NO market keeps YES and NO, YES in the gain tone", () => {
    const view = shapeEvent(event(samples.yesNo), now)!;
    expect(view.outcomes.map((o) => [o.label, o.tone])).toEqual([
        ["YES", "gain"],
        ["NO", "loss"],
    ]);
});

test("a single named market keeps its own labels, neutral", () => {
    const view = shapeEvent(event(samples.named), now)!;
    expect(view.outcomes).toHaveLength(2);
    expect(view.outcomes.map((o) => o.tone)).toEqual(["neutral", "neutral"]);
    const market = event(samples.named).markets[0]!;
    expect(view.outcomes.map((o) => o.label)).toEqual(market.outcomes);
    expect(view.outcomes.map((o) => o.tokenId)).toEqual(market.clobTokenIds);
});

test("several YES/NO markets become one outcome each, by chance", () => {
    const source = event(samples.multi);
    const view = shapeEvent(source, now)!;
    expect(view.outcomes.length).toBeGreaterThan(2);
    const chances = view.outcomes.map((o) => o.chance);
    expect(chances).toEqual([...chances].sort((a, b) => b - a));
    for (const outcome of view.outcomes) {
        const market = source.markets.find((m) => m.groupItemTitle === outcome.label)!;
        expect(outcome.tokenId).toBe(market.clobTokenIds[0]);
        expect(outcome.tone).toBe("gain");
        expect(outcome.image).toBe(market.image ?? null);
    }
});

test("a sports event keeps only its moneyline market", () => {
    const source = event(samples.sports);
    expect(source.markets.length).toBeGreaterThan(1);
    const view = shapeEvent(source, now)!;
    const moneyline = source.markets.find((m) => m.sportsMarketType === "moneyline")!;
    expect(view.outcomes).toHaveLength(2);
    expect(view.outcomes.map((o) => o.tokenId)).toEqual(moneyline.clobTokenIds);
});

test("an event no rule fits is left out", () => {
    expect(shapeEvent(event(samples.skipped), now)).toBeNull();
});

test("the event supplies the title, image, close date and volume", () => {
    const source = raw(samples.yesNo);
    const view = shapeEvent(gammaEvent.parse(source), now)!;
    expect(view).toMatchObject({
        id: source.id,
        title: source.title,
        image: source.image ?? source.icon ?? null,
        endDate: source.endDate,
        volume24hUSD: Number(source.volume24hr ?? 0),
    });
});

test("prices: YES buys at the ask, NO at 1 − bid, chance is the midpoint", () => {
    const view = edited({ bestBid: 0.83, bestAsk: 0.84 })!;
    const [yes, no] = view.outcomes as [(typeof view.outcomes)[number], (typeof view.outcomes)[number]];
    expect([yes.buyPrice, yes.chance]).toEqual([0.84, 0.835]);
    expect([no.buyPrice, no.chance]).toEqual([0.17, 0.165]);
});

test("a market with a spread over 10¢, or closing within the hour, isn't offered", () => {
    expect(edited({ bestBid: 0.5, bestAsk: 0.65 })).toBeNull();
    expect(edited({ bestBid: 0.3, bestAsk: 0.4 })).not.toBeNull();
    expect(edited({ bestBid: 0.18, bestAsk: 0.28 })).not.toBeNull();
    expect(edited({ bestBid: 0.5, bestAsk: 0.6 })).not.toBeNull();
    expect(edited({ endDate: new Date(now.getTime() + 30 * 60_000).toISOString() })).toBeNull();
    expect(edited({ endDate: new Date(now.getTime() + 90 * 60_000).toISOString() })).not.toBeNull();
});

test("an outcome priced under 1¢ or over 99¢ isn't offered", () => {
    expect(edited({ bestBid: 0.99, bestAsk: 0.995 })!.outcomes.map((o) => o.label)).toEqual(["NO"]);
    expect(edited({ bestBid: 0.005, bestAsk: 0.01 })!.outcomes.map((o) => o.label)).toEqual(["YES"]);
    expect(edited({ bestBid: 0.001, bestAsk: 0.002 })).toBeNull();
});

test("minUSD is the minimum size times the price, rounded up to the cent, at least $1", () => {
    expect(edited({ orderMinSize: 5, bestBid: 0.83, bestAsk: 0.84 })!.outcomes[0]!.minUSD).toBe(4.2);
    expect(edited({ orderMinSize: 5, bestBid: 0.09, bestAsk: 0.1 })!.outcomes[0]!.minUSD).toBe(1);
    expect(edited({ orderMinSize: 5, bestBid: 0.83, bestAsk: 0.833 })!.outcomes[0]!.minUSD).toBe(4.17);
});

test("a market with malformed clobTokenIds or no bestBid is skipped, the event still shapes", () => {
    const source = raw(samples.multi);
    const before = shapeEvent(gammaEvent.parse(source), now)!;
    source.markets[0].clobTokenIds = "not json";
    source.markets[1].bestBid = null;
    const after = shapeEvent(gammaEvent.parse(source), now)!;
    expect(after).not.toBeNull();
    expect(after.outcomes.length).toBeLessThan(before.outcomes.length);
    expect(gammaEvent.parse(source).markets).toHaveLength(source.markets.length - 1);
});
