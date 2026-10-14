import type { OptimisticTrade, PerpPositionView, PerpsView, PositionView, PositionsView } from "@/lib/account/state";
import { formatUnits, formatUsdShort } from "@/lib/trade/format";
import { isPendingPerp, toUsdc } from "@/lib/account/state";
import type { CoinSymbol } from "./coin-icons";

/** A prediction the server holds, or one on its way: any outcome label, with a live value once its market has a price. */
export type LivePredictionPosition = {
    id: string;
    kind: "prediction-live";
    /** The coin it follows, for the logo. */
    symbol: CoinSymbol;
    /** The stake, in USD. */
    size: number;
    /** Unrealized PnL in USD. */
    pnl: number;
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
/** A Hyperliquid position the server holds, or an open on its way; its worth comes from the last mark. */
export type LivePerpPosition = {
    id: string;
    kind: "perp-live";
    /** The asset, for the logo. */
    symbol: CoinSymbol;
    /** The collateral, in USD. */
    size: number;
    /** Unrealized PnL after funding, or the realized PnL once settled. */
    pnl: number;
    asset: string;
    side: "long" | "short";
    leverage: number;
    entryPx: string | null;
    liquidationPx: string | null;
    status: "pending" | "open" | "closing" | "closed" | "liquidated";
    /** USD returned, for a settled row. */
    payout: number | null;
    /** Why an open position couldn't be closed, from the server. */
    notice: string | null;
    position: PerpPositionView;
};

/** Swaps settle at once, so only predictions and perps stay open. */
export type Position = LivePredictionPosition | LivePerpPosition;

const perpName = (p: LivePerpPosition) => `${p.side === "long" ? "Long" : "Short"} ${p.asset} at ${p.leverage}x`;

/** The question a prediction bets on, or "Long BTC at 5x". */
export const positionTitle = (p: Position) => (p.kind === "perp-live" ? perpName(p) : p.question);

/** "YES, 26.32 shares", or just the outcome while a buy waits; "$500 position, entry $65,000, liquidates near $52,400" for a perp. */
export function positionDetail(p: Position) {
    if (p.kind === "perp-live") {
        const parts = [`${formatUsdShort(p.size * p.leverage)} position`];
        if (p.entryPx) parts.push(`entry ${formatUsdShort(Number(p.entryPx))}`);
        if (p.liquidationPx) parts.push(`liquidates near ${formatUsdShort(Number(p.liquidationPx))}`);
        return parts.join(", ");
    }
    return p.shares ? `${p.outcome}, ${formatUnits(Number(p.shares), "shares")}` : p.outcome;
}

/** The shares a sale takes: floored to 0.01, as the exchange quantizes, without going through a float. */
export function sellableShares(shares: string): number {
    const [whole = "0", fraction = ""] = shares.split(".");
    return Number(`${whole}.${fraction.slice(0, 2).padEnd(2, "0")}`);
}

/** What an open position is worth and what it has made: a prediction at the sell price (null without one), a perp at its last mark. */
export function liveValue(p: Position, sellPrice: number | null) {
    if (p.kind === "perp-live") {
        const pnl = Number(p.position.unrealizedPnlUSD) - Number(p.position.cumFundingUSD);
        return { value: p.size + pnl, pnl };
    }
    if (sellPrice === null || !p.shares) return null;
    const value = Number(p.shares) * sellPrice;
    return { value, pnl: value - p.size };
}

export const PERP_OPEN_PENDING = "Closing opens when the position is filled.";
export const PERP_CLOSING = "Closing now.";

/** Why a perp can't be closed now, or null when it can. */
export function perpCloseBlock(p: LivePerpPosition): string | null {
    if (p.status === "pending") return PERP_OPEN_PENDING;
    if (p.status === "closing") return PERP_CLOSING;
    return p.notice;
}

export const TOO_SMALL = "Too small to sell. It pays out when the market resolves.";
export const BUY_PENDING = "Selling opens when the buy is filled.";

const SETTLED_SHOWN_MS = 7 * 86_400_000;

/** The whole position in words, for its close button. */
export const positionName = (p: Position) => (p.kind === "perp-live" ? perpName(p) : `${p.outcome} on ${p.question}`);

/**
 * The rows for the person's predictions, oldest first: each
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

/** The position with its mark and unrealized PnL taken from the live mark; unchanged without a mark or an entry. */
function marked(p: PerpPositionView, marks: Record<string, number>): PerpPositionView {
    const mark = marks[p.asset];
    const entry = Number(p.entryPx);
    const size = Number(p.sizeCoin);
    if (p.state !== "open" && p.state !== "closing") return p;
    if (!mark || !Number.isFinite(mark) || !p.entryPx || !Number.isFinite(entry) || !Number.isFinite(size)) return p;
    const pnl = (p.side === "long" ? 1 : -1) * size * (mark - entry);
    return { ...p, markPx: String(mark), unrealizedPnlUSD: String(pnl) };
}

/** The rows for the person's perps: open and closing ones, an open on its way, and ones settled in the last week; `marks` are live prices by asset. */
export function livePerpRows(
    { positions }: PerpsView,
    now = Date.now(),
    marks: Record<string, number> = {},
): LivePerpPosition[] {
    return positions
        .map((p) => marked(p, marks))
        .filter(
            (p) =>
                p.state === "open" ||
                p.state === "closing" ||
                now - Date.parse(p.settledAt ?? p.updatedAt) < SETTLED_SHOWN_MS,
        )
        .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))
        .map((p) => {
            const collateral = Number(p.collateralUSD);
            const settled = p.state === "closed" || p.state === "liquidated";
            const payout = settled ? Number(p.proceedsUSD ?? 0) : null;
            return {
                id: p.id,
                kind: "perp-live",
                symbol: p.asset,
                size: collateral,
                pnl: payout === null ? Number(p.unrealizedPnlUSD) - Number(p.cumFundingUSD) : payout - collateral,
                asset: p.asset,
                side: p.side,
                leverage: p.leverage,
                entryPx: p.entryPx,
                liquidationPx: p.liquidationPx,
                status: isPendingPerp(p) ? "pending" : p.state,
                payout,
                notice: p.notice,
                position: p,
            };
        });
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatUsd = (value: number) => usd.format(value);

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

/** "now", "5m ago" and "3h ago" within a day, then "yesterday", "2 days ago", then a plain date past a week. */
export function formatWhen(date: Date, now = Date.now()) {
    const minutes = Math.floor((now - date.getTime()) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
    const days = Math.round((date.getTime() - now) / 86_400_000);
    if (days > -7) return relative.format(days, "day");
    return dateFormat.format(date);
}

export const shortenAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
