/**
 * The coins and markets the trade sentence offers, before any live data.
 * Operations never import this directly: it reaches them through the trade
 * context, so the live catalog (and tests) can pass their own.
 */

import { COINS, type NetworkId } from "@/server/src/swaps/coins";

export type TokenNetwork = {
    network: NetworkId;
    /** What a wrapped or pegged form is called ("WBTC") */
    label?: string;
    wrapped?: true;
    /** Coin units kept out of the cap for gas */
    reserve?: number;
};

export type Token = {
    symbol: string;
    name: string;
    /** Null until the swap catalog (or its cache) has read it. */
    priceUSD: number | null;
    home: NetworkId;
    /** The networks the coin exists on, in the picker's order */
    networks: readonly TokenNetwork[];
};

/** Every swap coin, with no price until /swaps/catalog answers. */
export const TOKENS: Token[] = COINS.map((coin) => ({
    symbol: coin.symbol,
    name: coin.name,
    priceUSD: null,
    home: coin.home,
    networks: coin.entries.map(({ network, label, wrapped, reserve }) => ({
        network,
        ...(label && { label }),
        ...(wrapped && { wrapped }),
        ...(reserve && { reserve }),
    })),
}));

/** The stablecoin that pays for buys, perp collateral and predictions. */
export const QUOTE = "USDC";

/** A coin Long and Short offer, with the most leverage its picker allows. */
export type PerpMarket = {
    asset: string;
    maxLeverage: number;
    /** The market's last mark in dollars; the fallback list has none. */
    markPx?: number;
};

/** The fallback list, used until the server's markets load and in demo mode. */
export const PERP_MARKETS: PerpMarket[] = [
    { asset: "BTC", maxLeverage: 50 },
    { asset: "ETH", maxLeverage: 50 },
    { asset: "SOL", maxLeverage: 20 },
    { asset: "LINK", maxLeverage: 10 },
    { asset: "DOGE", maxLeverage: 10 },
];

export const LEVERAGE_STEPS = [2, 3, 5, 10, 20, 25, 50];

export type Outcome = {
    id: string;
    label: string;
    /** Price of one share in USD (0-1); a winning share pays $1. */
    price: number;
    /** What the market thinks the odds are (0-1); the price is what buying costs. */
    chance: number;
    tone: "gain" | "loss" | "neutral";
    /** The least a buy can be, in USD. */
    minUSD: number;
    image?: string;
};

export type PredictionMarket = {
    id: string;
    question: string;
    /** Short form for tight spots, e.g. the pill on a phone. */
    short: string;
    /** Underlying token, for the market's icon. */
    symbol: string;
    closes: string;
    image?: string;
    outcomes: Outcome[];
};

export type Catalog = {
    tokens: Token[];
    perps: PerpMarket[];
    markets: PredictionMarket[];
    /** A question by ID, listed or not: one picked earlier may have dropped off the list. */
    findMarket(id: string): PredictionMarket | undefined;
};

/** The questions come from Polymarket's trending list, so there are none until it loads. */
export const CATALOG: Catalog = {
    tokens: TOKENS,
    perps: PERP_MARKETS,
    markets: [],
    findMarket: () => undefined,
};
