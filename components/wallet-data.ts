import { PREDICTION_MARKETS } from "@/lib/trade/catalog";
import type { CoinSymbol } from "./coin-icons";

type PositionBase = {
    id: string;
    /** The coin it follows, for the logo. */
    symbol: CoinSymbol;
    /** In USD: the notional for a perp, the stake for a prediction. */
    size: number;
    /** Unrealized PnL in USD. */
    pnl: number;
};

export type PerpPosition = PositionBase & { kind: "perp"; side: "long" | "short"; leverage: number };
export type PredictionPosition = PositionBase & { kind: "prediction"; question: string; outcome: "YES" | "NO" };
/** Swaps settle at once, so only leverage and predictions stay open. */
export type Position = PerpPosition | PredictionPosition;

/** "Long BTC", or the question a prediction bets on. */
export const positionTitle = (p: Position) =>
    p.kind === "perp" ? `${p.side === "long" ? "Long" : "Short"} ${p.symbol}` : p.question;

/** "10x · $4,200", or "YES · $250". */
export const positionDetail = (p: Position) =>
    `${p.kind === "perp" ? `${p.leverage}x` : p.outcome} · ${formatSize(p.size)}`;

/** The whole position in words, for its close button. */
export const positionName = (p: Position) =>
    p.kind === "perp" ? `${positionTitle(p)} ${p.leverage}x` : `${p.outcome} on ${p.question}`;

const prediction = (
    id: string,
    marketId: string,
    outcome: PredictionPosition["outcome"],
    size: number,
    pnl: number,
): PredictionPosition => {
    const market = PREDICTION_MARKETS.find((m) => m.id === marketId)!;
    return { id, kind: "prediction", symbol: market.symbol, question: market.question, outcome, size, pnl };
};

// Mock content until trading is live.
/** Oldest first; the list renders it bottom-up, so the newest sits on top. */
export const MOCK_POSITIONS: Position[] = [
    { id: "p-btc", kind: "perp", symbol: "BTC", side: "long", leverage: 10, size: 4_200, pnl: 312.4 },
    { id: "p-eth", kind: "perp", symbol: "ETH", side: "short", leverage: 5, size: 2_850, pnl: -96.12 },
    { id: "p-sol", kind: "perp", symbol: "SOL", side: "long", leverage: 3, size: 1_200, pnl: 0 },
    prediction("p-btc-150k", "btc-150k-2026", "YES", 250, 18.4),
    { id: "p-doge", kind: "perp", symbol: "DOGE", side: "short", leverage: 2, size: 640, pnl: 48.9 },
    prediction("p-eth-5k", "eth-5k-2026", "NO", 400, -22.75),
    { id: "p-link", kind: "perp", symbol: "LINK", side: "long", leverage: 5, size: 900, pnl: -12.35 },
    { id: "p-avax", kind: "perp", symbol: "AVAX", side: "long", leverage: 3, size: 1_150, pnl: 64.2 },
    prediction("p-sol-ath", "sol-ath-2026", "YES", 150, 9.85),
    { id: "p-arb", kind: "perp", symbol: "ARB", side: "short", leverage: 2, size: 480, pnl: -22.75 },
    { id: "p-op", kind: "perp", symbol: "OP", side: "long", leverage: 5, size: 720, pnl: 15.6 },
    prediction("p-doge-1", "doge-1-2026", "NO", 300, 4.2),
    { id: "p-xrp", kind: "perp", symbol: "XRP", side: "short", leverage: 3, size: 1_600, pnl: -140.3 },
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
});

export const formatUsd = (value: number) => usd.format(value);
export const formatSize = (value: number) => usdWhole.format(value);

/** "+$312.40", "−$96.12" (a true minus sign) or "$0.00". */
export function formatPnl(value: number) {
    const amount = usd.format(Math.abs(value));
    if (value > 0) return `+${amount}`;
    if (value < 0) return `−${amount}`;
    return amount;
}

export type Trend = "gain" | "loss" | "flat";

export const trendOf = (pnl: number): Trend => (pnl > 0 ? "gain" : pnl < 0 ? "loss" : "flat");

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "today", "2 days ago", then a plain date past a week. */
export function formatWhen(date: Date) {
    const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
    if (days > -7) return relative.format(days, "day");
    return dateFormat.format(date);
}

export const shortenAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
