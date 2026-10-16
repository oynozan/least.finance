import { QUOTE } from "./catalog";
import { formatUnits, formatUsdShort } from "./format";
import type {
    ActivityItem,
    PerpPositionView,
    PositionView,
    PredictionOrderView,
    SwapOrderState,
    SwapOrderView,
} from "@/server/src/protocol";
import type { TradeView } from "@/server/src/trading/types";
import { networkName } from "./networks";
import { shortenAddress } from "@/components/wallet-data";
import { perpPositionUSD } from "@/lib/account/state";

export type ActivityKind = "deposit" | "withdrawal" | "swap" | "buy" | "sell" | "long" | "short" | "close" | "predict";

/** One thing the account did, as the PnL page lists it. */
export type Activity = {
    id: string;
    at: Date;
    kind: ActivityKind;
    /** "Deposit", "Yes on Will it rain?", "Sold Yes on Will it rain?" */
    title: string;
    /** A second line: "20 shares", "$12.50 back". */
    detail: string;
    /** Coins for the icon; two overlap. */
    symbols: string[];
    /** Its size, in USD; null while a swapped coin has no price. */
    amountUSD: number | null;
    /** What it did to the balance, in USD: a deposit adds itself, a withdrawal takes itself off, a close its realized PnL. */
    change: number;
    /** A deposit the server hasn't confirmed yet, or a buy it hasn't filled. */
    pending?: boolean;
};

export function depositActivity(deposit: { key: string; amountUSD: number; at: Date; pending?: boolean }): Activity {
    return {
        id: `deposit:${deposit.key}`,
        at: deposit.at,
        kind: "deposit",
        title: "Deposit",
        detail: `${QUOTE} on Arc`,
        symbols: [QUOTE],
        amountUSD: deposit.amountUSD,
        change: deposit.amountUSD,
        pending: deposit.pending,
    };
}

/** A withdrawal to a linked wallet, which takes its amount off the balance; `pending` until the server has paid it. */
export function withdrawalActivity(withdrawal: {
    id: string;
    amountUSD: number;
    at: Date;
    pending: boolean;
    to: string;
}): Activity {
    return {
        id: `withdrawal:${withdrawal.id}`,
        at: withdrawal.at,
        kind: "withdrawal",
        title: "Withdrawal",
        detail: `${QUOTE} to ${shortenAddress(withdrawal.to)}`,
        symbols: [QUOTE],
        amountUSD: withdrawal.amountUSD,
        change: -withdrawal.amountUSD,
        pending: withdrawal.pending || undefined,
    };
}

const SWAP_STATE: Record<SwapOrderState, string> = {
    created: "Waiting for your wallet",
    sent: "On its way",
    done: "Done",
    partial: "Partly done",
    refunded: "Refunded",
    failed: "Failed",
    expired: "Not sent",
};

/** A real swap, Buy or Sell: the networks and its state, with no change to the balance; `amountUSD` is its size when a price is known. */
export function swapActivity(order: SwapOrderView, amountUSD: number | null = null): Activity {
    return {
        id: `swap:${order.id}`,
        at: new Date(order.createdAt),
        kind: "swap",
        title: `Swap ${order.from.token} to ${order.to.token}`,
        detail: `${networkName(order.from.network)} to ${networkName(order.to.network)}, ${SWAP_STATE[order.state].toLowerCase()}`,
        symbols: [order.from.token, order.to.token],
        amountUSD,
        change: 0,
        pending: order.state === "created" || order.state === "sent" ? true : undefined,
    };
}

/**
 * The rows for a real prediction: its opening, which moves nothing, then what settling did.
 * `optimistic` marks a buy the server hasn't filled yet.
 */
export function predictionActivity(position: PositionView, optimistic = false): Activity[] {
    const cost = Number(position.costUSD);
    const name = `${position.outcome} on ${position.question}`;
    const base = { symbols: [QUOTE], amountUSD: cost };
    const rows: Activity[] = [
        {
            ...base,
            id: `prediction:${position.id}:open`,
            at: new Date(position.openedAt),
            kind: "predict",
            title: name,
            detail: formatUnits(Number(position.shares), "shares"),
            change: 0,
            pending: optimistic || undefined,
        },
    ];
    const settled = {
        closed: { prefix: "Sold", gross: Number(position.proceedsUSD ?? 0) },
        won: { prefix: "Won", gross: Number(position.payoutUSD ?? 0) },
        lost: { prefix: "Lost", gross: 0 },
    }[position.state as "closed" | "won" | "lost"];
    if (!optimistic && settled) {
        rows.push({
            ...base,
            id: `prediction:${position.id}:settle`,
            at: new Date(position.settledAt ?? position.updatedAt),
            kind: "close",
            title: `${settled.prefix} ${name}`,
            detail: position.state === "lost" ? "" : `${formatUsdShort(settled.gross)} back`,
            change: settled.gross - cost,
        });
    }
    return rows;
}

/**
 * The rows for a perp position: its opening, which moves nothing (the collateral stays part of the balance), then
 * what closing or a liquidation did. `optimistic` marks an open the server hasn't filled yet.
 */
export function perpActivity(position: PerpPositionView, optimistic = false): Activity[] {
    const collateral = Number(position.collateralUSD);
    const name = `${position.side === "long" ? "Long" : "Short"} ${position.asset} at ${position.leverage}x`;
    const base = { symbols: [position.asset], amountUSD: collateral };
    const rows: Activity[] = [
        {
            ...base,
            id: `perp:${position.id}:open`,
            at: new Date(position.openedAt),
            kind: position.side,
            title: name,
            detail: `${formatUsdShort(perpPositionUSD(position))} position`,
            change: 0,
            pending: optimistic || undefined,
        },
    ];
    if (position.state === "closed" || position.state === "liquidated") {
        const back = Number(position.proceedsUSD ?? 0);
        const liquidated = position.state === "liquidated";
        rows.push({
            ...base,
            id: `perp:${position.id}:settle`,
            at: new Date(position.settledAt ?? position.updatedAt),
            kind: "close",
            title: `${liquidated ? "Liquidated" : "Closed"} ${name}`,
            detail: back > 0 ? `${formatUsdShort(back)} back` : "",
            change: back - collateral,
        });
    }
    return rows;
}

/** The row for a sell that left its position open, or null for an order with no soldPart */
export function saleActivity(order: PredictionOrderView): Activity | null {
    const part = order.soldPart;
    if (!part) return null;
    const cost = Number(part.costUSD);
    const proceeds = Number(part.proceedsUSD);
    return {
        id: `sale:${order.id}`,
        at: new Date(part.at),
        kind: "close",
        title: `Sold part of ${order.outcome} on ${order.question}`,
        detail: `${formatUnits(Number(order.shares ?? 0), "shares")}, ${formatUsdShort(proceeds)} back`,
        symbols: [QUOTE],
        amountUSD: cost,
        change: proceeds - cost,
    };
}

/** A Buy, Sell or Swap from the balance: what was paid and what arrived, with the PnL a sell or swap realized as its change. */
export function tradeActivity(trade: TradeView): Activity {
    const paid = Number(trade.paidUnits);
    const got = Number(trade.gotUnits);
    const verbs = { buy: "Bought", sell: "Sold", swap: "Swapped" } as const;
    const coin = trade.verb === "buy" ? trade.gotSymbol : trade.paidSymbol;
    return {
        id: `trade:${trade.id}`,
        at: new Date(trade.at),
        kind: trade.verb,
        title:
            trade.verb === "swap"
                ? `Swapped ${trade.paidSymbol} to ${trade.gotSymbol}`
                : `${verbs[trade.verb]} ${coin}`,
        detail: `${formatUnits(paid, trade.paidSymbol)} for ${formatUnits(got, trade.gotSymbol)}`,
        symbols: trade.verb === "swap" ? [trade.paidSymbol, trade.gotSymbol] : [coin],
        amountUSD: Number(trade.usd),
        change: Number(trade.realized ?? 0),
    };
}

/** A buy the server hasn't filled yet. */
export function pendingBuyActivity(buy: {
    id: string;
    question: string;
    outcome: string;
    amountUSD: number;
    shares: string;
    at: Date;
}): Activity {
    return {
        id: `prediction:${buy.id}:open`,
        at: buy.at,
        kind: "predict",
        title: `${buy.outcome} on ${buy.question}`,
        detail: buy.shares ? formatUnits(Number(buy.shares), "shares") : "",
        symbols: [QUOTE],
        amountUSD: buy.amountUSD,
        change: 0,
        pending: true,
    };
}

/** The row of a position for one of its parts, or null when it has none */
const partOf = (rows: Activity[], part: "open" | "settle") => rows.find((r) => r.id.endsWith(`:${part}`)) ?? null;

const SWAP_PRICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The row for one item of a server history page, or null when the item has no such row */
export function activityFromItem(
    item: ActivityItem,
    ctx: { now: Date; priceOf: (symbol: string) => number | null },
): Activity | null {
    switch (item.kind) {
        case "deposit":
            return depositActivity({
                key: item.deposit.id,
                amountUSD: Number(item.deposit.amount),
                at: new Date(item.deposit.creditedAt),
            });
        case "withdrawal": {
            const w = item.withdrawal;
            return withdrawalActivity({
                id: w.requestId,
                amountUSD: Number(w.amount),
                at: new Date(w.createdAt),
                pending: w.state === "sending",
                to: w.to,
            });
        }
        case "swap": {
            // The order keeps no dollar size, so only a recent one is priced, at the coin's price now
            const recent = ctx.now.getTime() - Date.parse(item.order.createdAt) <= SWAP_PRICE_WINDOW_MS;
            const price = recent ? ctx.priceOf(item.order.from.token) : null;
            return swapActivity(item.order, price === null ? null : Number(item.order.from.amount) * price);
        }
        case "prediction":
            return partOf(predictionActivity(item.position), item.part);
        case "perp":
            return partOf(perpActivity(item.position), item.part);
        case "sale":
            return saleActivity(item.order);
        case "trade":
            return tradeActivity(item.trade);
    }
}

/** Newest first. */
export const byNewest = (a: Activity, b: Activity) => b.at.getTime() - a.at.getTime();
