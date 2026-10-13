import { CATALOG, TOKENS, type Catalog, type Outcome, type PredictionMarket, type Token } from "@/lib/trade/catalog";

/** The prices the fake LI.FI serves to the browser tests (SWAP_PRICES in server/test/support/stack.ts). */
export const PRICES: Readonly<Record<string, number>> = {
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

/** Every swap coin, priced as the swap catalog would price it. */
export const PRICED_TOKENS: Token[] = TOKENS.map((token) => ({ ...token, priceUSD: PRICES[token.symbol] ?? null }));

const no = (yes: number) => Math.round((1 - yes) * 100) / 100;

const yesNo = (yes: number): Outcome[] => [
    { id: "yes", label: "YES", price: yes, chance: yes, tone: "gain", minUSD: 1 },
    { id: "no", label: "NO", price: no(yes), chance: no(yes), tone: "loss", minUSD: 1 },
];

/** Four yes/no questions, as the trending list would hand them to the sentence. */
export const MARKETS: PredictionMarket[] = [
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

/** The app's catalog once the swap catalog and the trending questions have loaded. */
export const LOADED_CATALOG: Catalog = {
    ...CATALOG,
    tokens: PRICED_TOKENS,
    markets: MARKETS,
    findMarket: (id) => MARKETS.find((m) => m.id === id),
};

/** A wallet holding a little of several coins, in coin units. */
export const HOLDINGS: Readonly<Record<string, number>> = {
    ETH: 1.25,
    SOL: 42,
    BTC: 0.05,
    USDC: 2_400,
    LINK: 60,
    DOGE: 5_000,
};
