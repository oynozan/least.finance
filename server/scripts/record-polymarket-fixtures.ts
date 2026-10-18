/**
 * Records real Polymarket Gamma answers as the fixtures the shaping tests run on: the top 100 events by 24 hour
 * volume, one event found by search that isn't among them, and the IDs of events that exercise each shaping rule.
 * It only reads, and needs no key. Events are trimmed to the fields the schema reads and to 12 markets.
 *
 * Run it from server/ with `node scripts/record-polymarket-fixtures.ts`, then format the result from the repo
 * root with `npx prettier --write server/test/fixtures`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gammaEvent, type GammaEvent } from "../src/markets/gamma.ts";
import { isOffered, shapeEvent } from "../src/markets/shape.ts";

import "../src/polymarket-proxy.ts";

const GAMMA = "https://gamma-api.polymarket.com";
const MAX_MARKETS = 12;
const SEARCHES = ["aliens", "kraken", "fed", "senate"];
const EVENT_FIELDS = ["id", "title", "image", "icon", "endDate", "volume24hr"];
const MARKET_FIELDS = [
    "id",
    "active",
    "closed",
    "acceptingOrders",
    "enableOrderBook",
    "endDate",
    "bestBid",
    "bestAsk",
    "orderMinSize",
    "outcomes",
    "outcomePrices",
    "clobTokenIds",
    "groupItemTitle",
    "sportsMarketType",
    "image",
];

type Raw = Record<string, any>;

async function get(path: string): Promise<any> {
    const response = await fetch(`${GAMMA}${path}`);
    if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
    return response.json();
}

const pick = (source: Raw, fields: string[]) =>
    Object.fromEntries(fields.filter((f) => f in source).map((f) => [f, source[f]]));

const parse = (raw: Raw): GammaEvent => gammaEvent.parse(raw);

const now = new Date();

// Offered markets first, then the moneyline one, then the rest, so the shaping rules still see what they need
function trim(raw: Raw): Raw {
    const markets: Raw[] = raw.markets ?? [];
    const offeredIds = new Set(
        parse({ ...raw, markets })
            .markets.filter((m) => isOffered(m, raw.endDate, now))
            .map((m) => m.id),
    );
    const rank = (m: Raw) => (offeredIds.has(m.id) ? 0 : m.sportsMarketType === "moneyline" ? 1 : 2);
    const kept = markets
        .map((market, index) => ({ market, index }))
        .sort((a, b) => rank(a.market) - rank(b.market) || a.index - b.index)
        .slice(0, MAX_MARKETS)
        .sort((a, b) => a.index - b.index)
        .map(({ market }) => pick(market, MARKET_FIELDS));
    return { ...pick(raw, EVENT_FIELDS), markets: kept };
}

const top: Raw[] = (await get("/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100")).map(trim);
const topIds = new Set(top.map((event) => event.id));

let extra: Raw | undefined;
for (const query of SEARCHES) {
    const found: Raw = await get(`/public-search?q=${query}&events_status=active&limit_per_type=20`);
    extra = (found.events as Raw[])
        .filter((event) => !topIds.has(event.id))
        .map(trim)
        .find((event) => shapeEvent(parse(event), now));
    if (extra) break;
}
if (!extra) throw new Error("no searched event that shapes and isn't in the top 100");

const shaped = top.map((raw) => ({ raw, view: shapeEvent(parse(raw), now) }));
const hasMoneyline = (raw: Raw) => raw.markets.some((m: Raw) => m.sportsMarketType === "moneyline");
const isYesNo = (view: NonNullable<ReturnType<typeof shapeEvent>>) => view.outcomes[0]?.label === "YES";

const yesNo = shaped.find(
    ({ raw, view }) => view && isYesNo(view) && view.outcomes.length === 2 && raw.markets.length === 1,
);
const multi = shaped.find(
    ({ view }) => view && view.outcomes.length >= 3 && view.outcomes.every((o) => o.tone === "gain"),
);
const sportsEvents = shaped.filter(
    ({ raw, view }) => view && raw.markets.length > 1 && hasMoneyline(raw) && !isYesNo(view),
);
const sports = sportsEvents[0];
const skipped = shaped.find(({ view }) => view === null);
let named = shaped.find(
    ({ raw, view }) =>
        view && !hasMoneyline(raw) && view.outcomes.length === 2 && view.outcomes.every((o) => o.tone === "neutral"),
);
// Fixture-only trim: with no live event for rule 1 with named outcomes, a sports event cut to its moneyline market stands in
if (!named && sportsEvents[1]) {
    const stand = sportsEvents[1];
    top[top.findIndex((event) => event.id === stand.raw.id)] = {
        ...stand.raw,
        markets: stand.raw.markets.filter((m: Raw) => m.sportsMarketType === "moneyline"),
    };
    named = stand;
}

const samples = {
    yesNo: yesNo?.raw.id,
    named: named?.raw.id,
    multi: multi?.raw.id,
    sports: sports?.raw.id,
    skipped: skipped?.raw.id,
    extra: extra.id,
};
for (const [name, id] of Object.entries(samples)) {
    if (!id) throw new Error(`no event found for ${name}`);
    console.log(name, id);
}

const directory = new URL("../test/fixtures/polymarket/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(
    new URL("events.json", directory),
    `${JSON.stringify({ recordedAt: now.toISOString(), top, extra: [extra], samples }, null, 4)}\n`,
);
console.log("recorded polymarket/events.json");
