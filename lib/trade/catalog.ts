/**
 * Mock market data until prices, balances and markets come from a backend.
 * Operations never import this directly: it reaches them through the trade
 * context, so tests (and later live data) can pass their own.
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
    priceUSD: number;
    home: NetworkId;
    /** The networks the coin exists on, in the picker's order */
    networks: readonly TokenNetwork[];
};

const PRICES: Readonly<Record<string, number>> = {
    ETH: 3_210.4,
    SOL: 147.2,
    BTC: 97_300,
    USDC: 1,
    USDT: 1,
    BNB: 600,
    LINK: 18.45,
    DOGE: 0.182,
    AVAX: 32.1,
    ARB: 0.74,
    OP: 1.8,
};

export const TOKENS: Token[] = COINS.map((coin) => ({
    symbol: coin.symbol,
    name: coin.name,
    priceUSD: PRICES[coin.symbol] ?? 0,
    home: coin.home,
    networks: coin.entries.map(({ network, label, wrapped, reserve }) => ({
        network,
        ...(label && { label }),
        ...(wrapped && { wrapped }),
        ...(reserve && { reserve }),
    })),
}));

/** What the demo wallet holds (no Privy app ID), in coin units; a signed-in person has only their real coins. */
export const MOCK_HOLDINGS: Record<string, number> = {
    ETH: 1.25,
    SOL: 42,
    BTC: 0.05,
    USDC: 2_400,
    LINK: 60,
    DOGE: 5_000,
};

/** The stablecoin that pays for buys, perp collateral and predictions. */
export const QUOTE = "USDC";

export type PerpMarket = {
    asset: string;
    maxLeverage: number;
    /** Fraction of position value kept as maintenance margin. */
    maintenanceMargin: number;
};

export const PERP_MARKETS: PerpMarket[] = [
    { asset: "BTC", maxLeverage: 50, maintenanceMargin: 0.005 },
    { asset: "ETH", maxLeverage: 50, maintenanceMargin: 0.005 },
    { asset: "SOL", maxLeverage: 20, maintenanceMargin: 0.01 },
    { asset: "LINK", maxLeverage: 10, maintenanceMargin: 0.02 },
    { asset: "DOGE", maxLeverage: 10, maintenanceMargin: 0.02 },
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

const no = (yes: number) => Math.round((1 - yes) * 100) / 100;

const yesNo = (yes: number): Outcome[] => [
    { id: "yes", label: "YES", price: yes, chance: yes, tone: "gain", minUSD: 1 },
    { id: "no", label: "NO", price: no(yes), chance: no(yes), tone: "loss", minUSD: 1 },
];

export const PREDICTION_MARKETS: PredictionMarket[] = [
    {
        id: "btc-150k-2026",
        question: "Will BTC reach $150K?",
        short: "BTC $150K?",
        symbol: "BTC",
        closes: "Dec 31",
        outcomes: yesNo(0.38),
    },
    {
        id: "eth-5k-2026",
        question: "Will ETH flip $5K?",
        short: "ETH $5K?",
        symbol: "ETH",
        closes: "Dec 31",
        outcomes: yesNo(0.27),
    },
    {
        id: "sol-ath-2026",
        question: "Will SOL set a new all-time high?",
        short: "SOL new high?",
        symbol: "SOL",
        closes: "Nov 30",
        outcomes: yesNo(0.44),
    },
    {
        id: "doge-1-2026",
        question: "Will DOGE hit $1?",
        short: "DOGE $1?",
        symbol: "DOGE",
        closes: "Dec 31",
        outcomes: yesNo(0.06),
    },
];

export type Catalog = {
    tokens: Token[];
    perps: PerpMarket[];
    markets: PredictionMarket[];
    /** A question by ID, listed or not: one picked earlier may have dropped off the list. */
    findMarket(id: string): PredictionMarket | undefined;
};

export const CATALOG: Catalog = {
    tokens: TOKENS,
    perps: PERP_MARKETS,
    markets: PREDICTION_MARKETS,
    findMarket: (id) => PREDICTION_MARKETS.find((m) => m.id === id),
};
