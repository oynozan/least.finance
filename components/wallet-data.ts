import { PREDICTION_MARKETS } from "@/lib/trade/catalog";
import type { OptimisticTrade, PositionView, PositionsView } from "@/lib/account/state";
import { toUsdc } from "@/lib/account/state";
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
/** A prediction the server holds, or one on its way: any outcome label, with a live value once its market has a price. */
export type LivePredictionPosition = PositionBase & {
    kind: "prediction-live";
    eventId: string;
    tokenId: string;
    question: string;
    outcome: string;
    /** Empty while a buy is waiting for its fill. */
    shares: string;
    /** A buy still waiting; sells and settled rows have none. */
    pending: boolean;
    status: "pending" | "open" | "won" | "lost";
    /** USD paid out, for a settled row. */
    payout: number | null;
    /** What a sale would close; null while only a buy is waiting. */
    position: PositionView | null;
};
/** Swaps settle at once, so only leverage and predictions stay open. */
export type Position = PerpPosition | PredictionPosition | LivePredictionPosition;

/** "Long BTC", or the question a prediction bets on. */
export const positionTitle = (p: Position) =>
    p.kind === "perp" ? `${p.side === "long" ? "Long" : "Short"} ${p.symbol}` : p.question;

/** "10x · $4,200", "YES · $250", or "YES · 26.3 shares" for a live prediction. */
export const positionDetail = (p: Position) =>
    p.kind === "prediction-live"
        ? p.shares
            ? `${p.outcome} · ${p.shares} shares`
            : p.outcome
        : `${p.kind === "perp" ? `${p.leverage}x` : p.outcome} · ${formatSize(p.size)}`;

/** The shares a sale takes: floored to 0.01, as the exchange quantizes, without going through a float. */
export function sellableShares(shares: string): number {
    const [whole = "0", fraction = ""] = shares.split(".");
    return Number(`${whole}.${fraction.slice(0, 2).padEnd(2, "0")}`);
}

/** What an open prediction is worth at the sell price and what it has made, or null without a price. */
export function liveValue(p: LivePredictionPosition, sellPrice: number | null) {
    if (sellPrice === null || !p.shares) return null;
    const value = Number(p.shares) * sellPrice;
    return { value, pnl: value - p.size };
}

export const TOO_SMALL = "Too small to sell. It pays out when the market resolves.";
export const BUY_PENDING = "Selling opens when the buy is filled.";

const SETTLED_SHOWN_MS = 7 * 86_400_000;

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
    { id: "p-bnb", kind: "perp", symbol: "BNB", side: "long", leverage: 4, size: 780, pnl: 27.45 },
    { id: "p-btc-s", kind: "perp", symbol: "BTC", side: "short", leverage: 2, size: 1_900, pnl: -58.8 },
    { id: "p-eth-l", kind: "perp", symbol: "ETH", side: "long", leverage: 3, size: 1_350, pnl: 71.1 },
    { id: "p-sol-s", kind: "perp", symbol: "SOL", side: "short", leverage: 2, size: 540, pnl: -9.6 },
];

/**
 * The rows for the person's real predictions, oldest first like the mock list: each
 * open position, plus the buys the server hasn't filled yet, plus positions that resolved in the last week.
 * Rows for one token become one, and a position being sold is out of the list.
 */
export function livePredictionRows(
    { positions, orders }: PositionsView,
    optimistic: readonly OptimisticTrade[],
    now = Date.now(),
): LivePredictionPosition[] {
    type Row = LivePredictionPosition & { at: number };
    const rows = new Map<string, Row>();
    const add = (token: string, row: Row) => {
        const held = rows.get(token);
        if (!held) {
            rows.set(token, row);
            return;
        }
        // The shares and stake add up; the row stays pending only while nothing is open.
        const shares = Number(held.shares) + Number(row.shares);
        rows.set(token, {
            ...held,
            // Two buys still waiting have no shares to add up
            shares: held.shares || row.shares ? String(Number(shares.toFixed(6))) : "",
            size: held.size + row.size,
            pending: held.pending && row.pending,
            status: held.pending && row.pending ? "pending" : "open",
            position: held.position ?? row.position,
            id: held.position ? held.id : row.position ? row.id : held.id,
            at: Math.min(held.at, row.at),
        });
    };
    const placed = new Set(orders.map((o) => o.requestId));
    const selling = new Set(optimistic.flatMap((t) => (t.side === "sell" ? [t.positionId] : [])));
    const base = { kind: "prediction-live", symbol: "USDC", pnl: 0, payout: null } as const;
    for (const p of positions) {
        if (
            (p.state === "won" || p.state === "lost") &&
            p.settledAt &&
            now - Date.parse(p.settledAt) < SETTLED_SHOWN_MS
        ) {
            const payout = Number(p.payoutUSD ?? 0);
            rows.set(p.id, {
                ...base,
                id: p.id,
                eventId: p.eventId,
                tokenId: p.tokenId,
                question: p.question,
                outcome: p.outcome,
                shares: p.shares,
                size: Number(p.costUSD),
                pnl: payout - Number(p.costUSD),
                pending: false,
                status: p.state,
                payout,
                position: p,
                at: Date.parse(p.openedAt),
            });
            continue;
        }
        if (p.state !== "open" || selling.has(p.id)) continue;
        add(p.tokenId, {
            ...base,
            id: p.id,
            eventId: p.eventId,
            tokenId: p.tokenId,
            status: "open",
            position: p,
            question: p.question,
            outcome: p.outcome,
            shares: p.shares,
            size: Number(p.costUSD),
            pending: false,
            at: Date.parse(p.openedAt),
        });
    }
    for (const o of orders) {
        if (o.side !== "buy" || (o.state !== "placing" && o.state !== "posted")) continue;
        add(o.tokenId, {
            ...base,
            id: o.requestId,
            eventId: o.eventId,
            tokenId: o.tokenId,
            status: "pending",
            position: null,
            question: o.question,
            outcome: o.outcome,
            shares: o.shares ?? "",
            size: Number(o.amountUSD ?? 0),
            pending: true,
            at: Date.parse(o.createdAt),
        });
    }
    for (const t of optimistic) {
        if (t.side !== "buy" || placed.has(t.requestId)) continue;
        add(t.tokenId, {
            ...base,
            id: t.requestId,
            eventId: t.eventId,
            tokenId: t.tokenId,
            status: "pending",
            position: null,
            question: t.question,
            outcome: t.outcome,
            shares: t.shares,
            size: toUsdc(t.amountWei),
            pending: true,
            at: t.at,
        });
    }
    return [...rows.values()]
        .sort((a, b) => a.at - b.at)
        .map((row) => {
            const live: LivePredictionPosition & { at?: number } = { ...row };
            delete live.at;
            return live;
        });
}

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
