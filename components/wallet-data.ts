import type { CoinSymbol } from "./coin-icons";

export type Position = {
  id: string;
  symbol: CoinSymbol;
  /** Notional size in USD. */
  size: number;
  /** Unrealized PnL in USD. */
  pnl: number;
};

export type Deposit = {
  id: string;
  symbol: CoinSymbol;
  /** USD value at the time of deposit. */
  amount: number;
  at: Date;
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

// Mock content until positions and deposits come from the backend.
export const MOCK_BALANCE = 12_480.52;

/** Oldest first; the list renders it bottom-up, so the newest sits on top. */
export const MOCK_POSITIONS: Position[] = [
  { id: "p-btc", symbol: "BTC", size: 4_200, pnl: 312.4 },
  { id: "p-eth", symbol: "ETH", size: 2_850, pnl: -96.12 },
  { id: "p-sol", symbol: "SOL", size: 1_200, pnl: 0 },
  { id: "p-doge", symbol: "DOGE", size: 640, pnl: 48.9 },
  { id: "p-link", symbol: "LINK", size: 900, pnl: -12.35 },
];

/** Newest first. */
export const MOCK_DEPOSITS: Deposit[] = [
  { id: "d-4", symbol: "USDC", amount: 2_500, at: daysAgo(2) },
  { id: "d-3", symbol: "ETH", amount: 1_840.25, at: daysAgo(9) },
  { id: "d-2", symbol: "USDC", amount: 5_000, at: daysAgo(23) },
  { id: "d-1", symbol: "USDC", amount: 3_000, at: daysAgo(41) },
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
