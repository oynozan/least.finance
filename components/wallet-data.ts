import type { OptimisticTrade, PerpPositionView, PerpsView, PositionView, PositionsView } from "@/lib/account/state";
import { formatPrice, formatUsdShort } from "@/lib/trade/format";
import { isPendingPerp, perpPositionUSD, toUsdc } from "@/lib/account/state";
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
    /** A buy still waiting; sells have none. */
    pending: boolean;
    status: "pending" | "open";
    /** When it was bought, in ms; the first buy for a row that holds several. */
    openedAt: number;
    /** What a sale would close; null while only a buy is waiting. */
    position: PositionView | null;
};
/** A Hyperliquid position the server holds, or an open on its way; its worth comes from the last mark. */
export type LivePerpPosition = {
    id: string;
    /** The row's key: an open keeps one from its pending stand-in to its filled position, so the fill updates the row in place. */
    rowKey: string;
    kind: "perp-live";
    /** The asset, for the logo. */
    symbol: CoinSymbol;
    /** The collateral, in USD. */
    size: number;
    /** Unrealized PnL after funding and the opening fees. */
    pnl: number;
    asset: string;
    side: "long" | "short";
    leverage: number;
    entryPx: string | null;
    liquidationPx: string | null;
    status: "pending" | "open" | "closing";
    /** When it was opened, in ms. */
    openedAt: number;
    /** Why an open position couldn't be closed, from the server. */
    notice: string | null;
    position: PerpPositionView;
};

/** Swaps settle at once, so only predictions and perps stay open. */
export type Position = LivePredictionPosition | LivePerpPosition;

const perpName = (p: LivePerpPosition) => `${p.side === "long" ? "Long" : "Short"} ${p.asset} at ${p.leverage}x`;

/** The question a prediction bets on, or "Long BTC at 5x". */
export const positionTitle = (p: Position) => (p.kind === "perp-live" ? perpName(p) : p.question);

const shareCount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** What a position's row shows when it opens, a fact to a line: what a prediction bet on and paid, or a perp's size and prices. */
export function positionFacts(p: Position): [label: string, value: string][] {
    if (p.kind === "perp-live") {
        const facts: [string, string][] = [["Position", formatUsdShort(perpPositionUSD(p.position))]];
        if (p.entryPx) facts.push(["Entry price", formatPrice(Number(p.entryPx))]);
        if (p.position.markPx && p.status !== "pending") facts.push(["Price now", formatPrice(Number(p.position.markPx))]);
        if (p.liquidationPx) facts.push(["Liquidation price", formatPrice(Number(p.liquidationPx))]);
        return facts;
    }
    const facts: [string, string][] = [["Outcome", p.outcome]];
    // A buy waiting for its fill doesn't know its shares yet
    if (p.shares) facts.push(["Shares", shareCount.format(Number(p.shares))]);
    facts.push(["Paid", formatUsd(p.size)]);
    return facts;
}

/** Newest first, so a position just opened is at the top. */
export const newestFirst = (a: Position, b: Position) => b.openedAt - a.openedAt;

/** The shares a sale takes: floored to 0.01, as the exchange quantizes, without going through a float. */
export function sellableShares(shares: string): number {
    const [whole = "0", fraction = ""] = shares.split(".");
    return Number(`${whole}.${fraction.slice(0, 2).padEnd(2, "0")}`);
}

/** What an open perp has made: its unrealized PnL less the funding paid and the fees already taken on opening, so a fresh position starts a little down. */
const openPerpPnl = (p: PerpPositionView) =>
    Number(p.unrealizedPnlUSD) - Number(p.cumFundingUSD) - Number(p.feesUSD ?? 0);

/** What an open position is worth and what it has made: a prediction at the sell price (null without one), a perp at its last mark. */
export function liveValue(p: Position, sellPrice: number | null) {
    if (p.kind === "perp-live") {
        const pnl = openPerpPnl(p.position);
        return { value: p.size + pnl, pnl };
    }
    if (sellPrice === null || !p.shares) return null;
    const value = Number(p.shares) * sellPrice;
    return { value, pnl: value - p.size };
}

export const PERP_OPEN_PENDING = "You can close this once it has filled.";
export const PERP_CLOSING = "Closing now.";

/** Why a perp can't be closed now, or null when it can. */
export function perpCloseBlock(p: LivePerpPosition): string | null {
    if (p.status === "pending") return PERP_OPEN_PENDING;
    if (p.status === "closing") return PERP_CLOSING;
    // Only a refusal that asking again can't fix blocks the button; any other leaves its reason on the row and a retry open
    return p.position.closeBlocked === false ? null : p.notice;
}

export const TOO_SMALL = "Too small to sell. It pays out when the market resolves.";
export const BUY_PENDING = "Selling opens when the buy is filled.";

/** The whole position in words, for its close button. */
export const positionName = (p: Position) => (p.kind === "perp-live" ? perpName(p) : `${p.outcome} on ${p.question}`);

/**
 * The rows for the person's open predictions, newest first: each open
 * position, plus the buys the server hasn't filled yet. Rows for one token
 * become one, and a position being sold is out of the list; a resolved one
 * is in the PnL activity instead.
 */
export function livePredictionRows(
    { positions, orders }: PositionsView,
    optimistic: readonly OptimisticTrade[],
): LivePredictionPosition[] {
    type Row = LivePredictionPosition;
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
            openedAt: Math.min(held.openedAt, row.openedAt),
        });
    };
    const placed = new Set(orders.map((o) => o.requestId));
    const selling = new Set(optimistic.flatMap((t) => (t.side === "sell" ? [t.positionId] : [])));
    const base = { kind: "prediction-live", symbol: "USDC", pnl: 0 } as const;
    for (const p of positions) {
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
            openedAt: Date.parse(p.openedAt),
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
            openedAt: Date.parse(o.createdAt),
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
            openedAt: t.at,
        });
    }
    return [...rows.values()].sort(newestFirst);
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

/** The rows for the person's perps, newest first: open and closing ones and an open on its way; a settled one is in the PnL activity instead. `marks` are live prices by asset. */
export function livePerpRows({ positions, orders }: PerpsView, marks: Record<string, number> = {}): LivePerpPosition[] {
    const openedBy = new Map(
        orders.filter((o) => o.kind === "open" && o.positionId).map((o) => [o.positionId, o.requestId]),
    );
    const rowKey = (p: PerpPositionView) =>
        `perp:${isPendingPerp(p) ? p.id.slice("pending:".length) : (openedBy.get(p.id) ?? p.id)}`;
    return positions
        .flatMap((p) => (p.state === "open" || p.state === "closing" ? [marked(p, marks)] : []))
        .map((p): LivePerpPosition => ({
            id: p.id,
            rowKey: rowKey(p),
            kind: "perp-live",
            symbol: p.asset,
            size: Number(p.collateralUSD),
            pnl: openPerpPnl(p),
            asset: p.asset,
            side: p.side,
            leverage: p.leverage,
            entryPx: p.entryPx,
            liquidationPx: p.liquidationPx,
            status: isPendingPerp(p) ? "pending" : p.state === "closing" ? "closing" : "open",
            openedAt: Date.parse(p.openedAt),
            notice: p.notice,
            position: p,
        }))
        .sort(newestFirst);
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
