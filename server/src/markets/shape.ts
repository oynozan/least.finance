import type { MarketOutcomeView, MarketView } from "../protocol.ts";
import type { GammaEvent, GammaMarket } from "./gamma.ts";

const MAX_SPREAD = 0.1;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const MIN_TIME_LEFT_MS = 60 * 60 * 1000;
/** Polymarket's smallest order, in dollars */
export const MIN_ORDER_USD = 1;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Whether a market can be traded now: open, with a book, a tight spread and more than an hour to go. */
export function isOffered(market: GammaMarket, eventEndDate: string | null | undefined, now: Date): boolean {
    if (!market.active || market.closed || !market.acceptingOrders || !market.enableOrderBook) return false;
    if (market.bestBid == null || market.bestAsk == null) return false;
    if (market.bestAsk < market.bestBid) return false;
    if (market.outcomes.length !== 2 || market.clobTokenIds.length !== 2) return false;
    if (round4(market.bestAsk - market.bestBid) > MAX_SPREAD) return false;
    const end = Date.parse(market.endDate ?? eventEndDate ?? "");
    return end - now.getTime() > MIN_TIME_LEFT_MS;
}

function label(text: string): string {
    const lower = text.toLowerCase();
    return lower === "yes" ? "YES" : lower === "no" ? "NO" : text;
}

const isYesNo = (market: GammaMarket) => market.outcomes.map(label).join() === "YES,NO";

// bestBid and bestAsk are for the first token, so the second one buys at one minus the bid
function outcomes(market: GammaMarket, imageOf: (market: GammaMarket) => string | null): MarketOutcomeView[] {
    const bid = market.bestBid!;
    const ask = market.bestAsk!;
    const sides = [
        { buy: ask, sell: bid, chance: (bid + ask) / 2 },
        { buy: 1 - bid, sell: 1 - ask, chance: 1 - (bid + ask) / 2 },
    ];
    const views: MarketOutcomeView[] = [];
    sides.forEach((side, index) => {
        const buyPrice = round4(side.buy);
        if (buyPrice < MIN_PRICE || buyPrice > MAX_PRICE) return;
        const text = label(market.outcomes[index]!);
        views.push({
            tokenId: market.clobTokenIds[index]!,
            label: text,
            buyPrice,
            sellPrice: round4(side.sell),
            minShares: market.orderMinSize,
            chance: round4(side.chance),
            tone: text === "YES" ? "gain" : text === "NO" ? "loss" : "neutral",
            minUSD: Math.max(MIN_ORDER_USD, Math.ceil(market.orderMinSize * buyPrice * 100 - 1e-9) / 100),
            image: imageOf(market),
        });
    });
    return views;
}

/** Turns an event into one question, or null when no rule fits or nothing in it can be bought. */
export function shapeEvent(event: GammaEvent, now: Date): MarketView | null {
    const offered = event.markets.filter((market) => isOffered(market, event.endDate, now));
    const none = () => null;
    let picked: MarketOutcomeView[] = [];

    const moneyline = offered.find((market) => market.sportsMarketType === "moneyline");
    // Only an event's sole market is a plain question, a lone survivor of several still needs its own name
    if (offered.length === 1 && event.markets.length === 1) {
        picked = outcomes(offered[0]!, none);
    } else if (offered.length > 0 && offered.every(isYesNo)) {
        picked = offered
            .map((market) => {
                const yes = outcomes(market, (m) => m.image ?? null).find((outcome) => outcome.label === "YES");
                return yes && { ...yes, label: market.groupItemTitle || market.outcomes[0]! };
            })
            .filter((outcome) => outcome !== undefined)
            .sort((a, b) => b.chance - a.chance);
    } else if (moneyline) {
        picked = outcomes(moneyline, none);
    }
    if (picked.length === 0) return null;

    return {
        id: event.id,
        title: event.title,
        image: event.image ?? event.icon ?? null,
        endDate: event.endDate ?? "",
        volume24hUSD: event.volume24hr ?? 0,
        outcomes: picked,
    };
}
