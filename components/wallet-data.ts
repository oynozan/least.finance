import type { CoinSymbol } from "./coin-icons";

export type Position = {
    id: string;
    symbol: CoinSymbol;
    /** Notional size in USD. */
    size: number;
    /** Unrealized PnL in USD. */
    pnl: number;
};

// Mock content until trading is live.
/** Oldest first; the list renders it bottom-up, so the newest sits on top. */
export const MOCK_POSITIONS: Position[] = [
    { id: "p-btc", symbol: "BTC", size: 4_200, pnl: 312.4 },
    { id: "p-eth", symbol: "ETH", size: 2_850, pnl: -96.12 },
    { id: "p-sol", symbol: "SOL", size: 1_200, pnl: 0 },
    { id: "p-doge", symbol: "DOGE", size: 640, pnl: 48.9 },
    { id: "p-link", symbol: "LINK", size: 900, pnl: -12.35 },
    { id: "p-avax", symbol: "AVAX", size: 1_150, pnl: 64.2 },
    { id: "p-arb", symbol: "ARB", size: 480, pnl: -22.75 },
    { id: "p-op", symbol: "OP", size: 720, pnl: 15.6 },
    { id: "p-xrp", symbol: "XRP", size: 1_600, pnl: -140.3 },
    { id: "p-ada", symbol: "ADA", size: 350, pnl: 0 },
    { id: "p-dot", symbol: "DOT", size: 560, pnl: 9.85 },
    { id: "p-uni", symbol: "UNI", size: 820, pnl: -31.4 },
    { id: "p-aave", symbol: "AAVE", size: 1_380, pnl: 122.15 },
    { id: "p-atom", symbol: "ATOM", size: 410, pnl: -5.6 },
    { id: "p-near", symbol: "NEAR", size: 690, pnl: 27.3 },
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
