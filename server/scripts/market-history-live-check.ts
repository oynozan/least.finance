/**
 * Reads real price history from Polymarket for three trending events of different ages and checks the lines are usable.
 * It is read-only (GETs to Gamma and POSTs to batch-prices-history) and needs no .env.
 *
 * Run it from server/ with `node scripts/market-history-live-check.ts`.
 */
import { pino } from "pino";
import { MarketHistory, historyQuery } from "../src/markets/history.ts";
import { MarketService } from "../src/markets/markets.ts";
import { createPolymarketData } from "../src/markets/polymarket-data.ts";

const DAY = 86_400_000;
const logger = pino({ level: "warn" });
const data = createPolymarketData({
    gammaUrl: "https://gamma-api.polymarket.com",
    clobUrl: "https://clob.polymarket.com",
    logger,
});
const markets = new MarketService({ data, logger, syncMs: 60_000 });
await markets.tick();
const history = new MarketHistory({ data, markets, logger });

const aged = markets
    .trending()
    .markets.flatMap((market) => {
        const openedAt = markets.openedAt(market.id);
        return openedAt ? [{ market, openedAt }] : [];
    })
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
if (aged.length === 0) {
    console.error("No trending event has an opening time.");
    process.exit(1);
}
const picks = [...new Set([aged[0]!, aged[Math.floor((aged.length - 1) / 2)]!, aged[aged.length - 1]!])];

let failed = false;
const fail = (message: string) => {
    failed = true;
    console.log(`  FAIL ${message}`);
};

for (const { market, openedAt } of picks) {
    const now = Date.now();
    const age = now - openedAt.getTime();
    const { interval, fidelity } = historyQuery(openedAt, now);
    console.log(
        `${market.id}  ${market.title}  age ${(age / DAY).toFixed(1)} d (opened ${openedAt.toISOString()})  interval=${interval} fidelity=${fidelity}`,
    );
    // The event read carries the outcomes offered now, which can differ from the trending list's
    const offered = await markets.event(market.id);
    const outcomes = (offered ?? market).outcomes.slice(0, 4);
    const view = await history.view(
        market.id,
        outcomes.map((o) => o.tokenId),
    );
    if (!view) {
        fail("the history view was null");
        continue;
    }
    const starts: number[] = [];
    view.outcomes.forEach(({ points }, i) => {
        const label = outcomes[i]?.label ?? "?";
        const first = points[0];
        const last = points[points.length - 1];
        console.log(
            `  ${label}: ${points.length} points, ${first ? new Date(first[0]).toISOString() : "-"} to ${last ? new Date(last[0]).toISOString() : "-"}, last chance ${last ? last[1] : "-"}`,
        );
        if (points.length < 2) fail(`${label} has fewer than 2 points`);
        if (first) starts.push(first[0]);
    });
    // Outcomes can start trading later, so only the earliest line has to reach back to the opening; points sit on a grid, so two steps of slack
    const earliest = Math.min(...starts);
    if (age < 30 * DAY && earliest - openedAt.getTime() > 2 * view.stepMs)
        fail(
            `the earliest line starts ${((earliest - openedAt.getTime()) / 3_600_000).toFixed(1)} h after the opening`,
        );
}
process.exit(failed ? 1 : 0);
