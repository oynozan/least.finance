import { TRADE_SPREAD_BPS } from "@/server/src/trading/spread";

/** The spread as a share of the price: "0.3%". */
export const SPREAD_PERCENT = `${TRADE_SPREAD_BPS / 100}%`;

/** The title of a trade's preview: the one cost of a trade, and that the network costs are ours. */
export const SPREAD_TITLE = `Includes a ${SPREAD_PERCENT} spread. We cover network costs.`;

/** What a buyer pays for a coin shown at this market price, as the server fills it. */
export const askOf = (price: number) => (price * (10_000 + TRADE_SPREAD_BPS)) / 10_000;

/** What a sale of this many market-price dollars pays: the value less the spread, as the server fills a sell or the coin a swap gives up. */
export const lessSpread = (usd: number) => (usd * (10_000 - TRADE_SPREAD_BPS)) / 10_000;
