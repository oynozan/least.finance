/**
 * Spends about $1 of the pool's real pUSD to check what the plan could not confirm offline: that the CLOB's order ID is
 * the order hash we compute, the units of the post amounts, whether a sell's proceeds are net of the fee, and the
 * words an order lookup answers with. Run it once after polymarket-setup.ts and before turning PREDICTIONS_TRADING on.
 *
 * Run it from server/ with `node --env-file=.env scripts/polymarket-live-check.ts --yes-spend-real-money`.
 */
import { pino } from "pino";
import { loadConfig } from "../src/config.ts";
import { createPolymarketData } from "../src/markets/polymarket-data.ts";
import { createPolymarketTrader } from "../src/predictions/polymarket-trader.ts";
import { limitBuyPrice, limitSellPrice, quoteBuy, quoteSell } from "../src/predictions/pricing.ts";

if (!process.argv.includes("--yes-spend-real-money")) {
    console.error("This buys and sells about $1 of real pUSD on Polymarket. Pass --yes-spend-real-money to run it.");
    process.exit(1);
}

const SPEND_E6 = 1_000_000n;
const dollars = (e6: bigint) =>
    `${e6 < 0n ? "-" : ""}${(e6 < 0n ? -e6 : e6) / 1_000_000n}.${((e6 < 0n ? -e6 : e6) % 1_000_000n).toString().padStart(6, "0")}`;
const verdicts: Array<[string, boolean | null, string]> = [];
const verdict = (name: string, ok: boolean | null, detail: string) => {
    verdicts.push([name, ok, detail]);
    console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};

const config = loadConfig();
const logger = pino({ level: "warn" });
const trader = await createPolymarketTrader(config, logger);
const data = createPolymarketData({ gammaUrl: config.POLYMARKET_GAMMA_URL, clobUrl: config.POLYMARKET_CLOB_URL });

// 1. the most liquid trending question with an offered YES under 0.9
const events = await data.topEvents();
const picks = events
    .flatMap((event) => event.markets.map((market) => ({ event, market })))
    .filter(({ market }) => {
        const yes = market.clobTokenIds[0];
        return (
            yes !== undefined &&
            market.active &&
            !market.closed &&
            market.acceptingOrders &&
            market.enableOrderBook &&
            market.bestAsk != null &&
            market.bestAsk < 0.9
        );
    })
    .sort((a, b) => (b.event.volume24hr ?? 0) - (a.event.volume24hr ?? 0));
const pick = picks[0];
if (!pick) {
    console.error("No trending question with a YES under 0.9 was found.");
    process.exit(1);
}
const tokenId = pick.market.clobTokenIds[0]!;
console.log(
    `Question: ${pick.event.title} (${pick.market.groupItemTitle ?? pick.market.outcomes[0]}), YES token ${tokenId}`,
);

const balanceBefore = await trader.balanceE6();
console.log(`balanceE6 before: ${balanceBefore} (${dollars(balanceBefore)})`);

// 2. quote a $1 buy
const [book, meta] = await Promise.all([trader.book(tokenId), trader.meta(tokenId)]);
const buyQuote = quoteBuy(book, meta, SPEND_E6);
if (!buyQuote) {
    console.error("The book cannot fill a $1 buy.");
    process.exit(1);
}
console.log(
    `Buy quote: ${buyQuote.sharesE6} shares e6, cost ${buyQuote.costE6}, fee ${buyQuote.feeE6}, worst ${buyQuote.worstPrice}`,
);

// 3, 4. sign and post
const buy = await trader.signBuy({
    tokenId,
    spendE6: SPEND_E6,
    maxPrice: limitBuyPrice(buyQuote.worstPrice, meta.tickSize),
});
console.log(`Computed order hash: ${buy.orderHash}`);
const bought = await trader.post(buy);
console.log(
    `Buy post: ${JSON.stringify(bought, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}`,
);
if (bought.kind !== "filled" && bought.kind !== "delayed") {
    console.error("The buy did not fill, so there is nothing more to check.");
    process.exit(1);
}

// 5. order ID and amounts
verdict(
    "orderId == hash",
    bought.orderId.toLowerCase() === buy.orderHash.toLowerCase(),
    `${bought.orderId} vs ${buy.orderHash}`,
);
if (bought.kind === "filled") {
    const sharesRatio = Number(bought.takingE6) / Number(buyQuote.sharesE6);
    const costRatio = Number(bought.makingE6) / Number(buyQuote.costE6 + buyQuote.feeE6);
    console.log(`Buy amounts parsed: making ${bought.makingE6} e6, taking ${bought.takingE6} e6`);
    verdict(
        "post amounts are decimal dollars/shares",
        sharesRatio > 0.5 && sharesRatio < 1.5 && costRatio > 0.5 && costRatio < 1.5,
        `taking is ${sharesRatio.toFixed(3)}x the quoted shares, making is ${costRatio.toFixed(3)}x the quoted cost`,
    );
} else {
    verdict("post amounts are decimal dollars/shares", null, "the buy was delayed, so no amounts came back");
}

// 6. look the order up
const looked = await trader.lookup({ orderHash: buy.orderHash, clobOrderId: bought.orderId, tokenId });
console.log(
    `Lookup: ${JSON.stringify(looked, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}`,
);
verdict("fetchOrder status words", looked.kind === "filled", `the lookup answered ${looked.kind}`);
if (looked.kind !== "filled") {
    console.error("The buy is not settled yet, so the shares were not sold; check the wallet on Polymarket.");
    process.exit(1);
}
const sharesE6 = looked.takingE6;

// 7. sell everything at the bid
const [sellBook, sellMeta] = await Promise.all([trader.book(tokenId), trader.meta(tokenId)]);
const sellQuote = quoteSell(sellBook, sellMeta, sharesE6);
if (!sellQuote) {
    console.error(`The bids cannot absorb ${sharesE6} shares e6; sell them by hand.`);
    process.exit(1);
}
const sell = await trader.signSell({
    tokenId,
    sharesE6,
    minPrice: limitSellPrice(sellQuote.worstPrice, sellMeta.tickSize),
});
const sold = await trader.post(sell);
console.log(
    `Sell post: ${JSON.stringify(sold, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}`,
);

// 8. proceeds against the computed fee
if (sold.kind === "filled") {
    const gross = sellQuote.proceedsE6 + sellQuote.feeE6;
    const received = sold.takingE6;
    console.log(
        `Sell proceeds: ${received} e6; computed gross ${gross}, fee ${sellQuote.feeE6}, net ${sellQuote.proceedsE6}`,
    );
    const tolerance = 10_000n;
    const diff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
    if (sellQuote.feeE6 === 0n) verdict("sell fee is netted", null, "this market charges no fee");
    else
        verdict(
            "sell fee is netted",
            diff(received, sellQuote.proceedsE6) <= tolerance && diff(received, gross) > tolerance,
            `received ${received} against net ${sellQuote.proceedsE6} and gross ${gross}`,
        );
} else {
    verdict("sell fee is netted", null, `the sell came back ${sold.kind}`);
}

// 9. balance after
const balanceAfter = await trader.balanceE6();
console.log(
    `balanceE6 after: ${balanceAfter} (${dollars(balanceAfter)}), change ${dollars(balanceAfter - balanceBefore)}`,
);

const failed = verdicts.filter(([, ok]) => ok === false);
console.log(
    failed.length === 0
        ? "All checked assumptions held."
        : `${failed.length} assumption(s) failed; do not turn PREDICTIONS_TRADING on yet.`,
);
process.exit(failed.length === 0 ? 0 : 1);
