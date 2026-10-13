import { QUOTE } from "./catalog";
import { formatUnits, formatUsdShort } from "./format";
import type { PositionView, SwapOrderState, SwapOrderView } from "@/server/src/protocol";
import { networkName } from "./networks";
import { shortenAddress } from "@/components/wallet-data";

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

const DAY = 86_400_000;

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

/** Newest first. */
export const byNewest = (a: Activity, b: Activity) => b.at.getTime() - a.at.getTime();

export type BalanceDay = {
    /** Midnight, local time. */
    day: Date;
    /** At the end of the day. */
    balance: number;
    /** Realized PnL and fees that day; deposits and withdrawals aren't PnL. */
    pnl: number;
    /** Just the PnL of positions closed that day, which says how the day went; fees alone don't. */
    realized: number;
    deposited: number;
};

/** The balance at the end of each of the last `days` days, today last. */
export function balanceHistory(activity: readonly Activity[], days: number, now: Date): BalanceDay[] {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const first = today.getTime() - (days - 1) * DAY;
    let balance = 0;
    for (const a of activity) if (a.at.getTime() < first) balance += a.change;
    const out: BalanceDay[] = [];
    for (let i = 0; i < days; i++) {
        const start = first + i * DAY;
        let pnl = 0;
        let realized = 0;
        let deposited = 0;
        for (const a of activity) {
            const t = a.at.getTime();
            if (t < start || t >= start + DAY) continue;
            if (a.kind === "deposit" || a.kind === "withdrawal") deposited += a.change;
            else pnl += a.change;
            if (a.kind === "close") realized += a.change;
        }
        balance += pnl + deposited;
        out.push({ day: new Date(start), balance, pnl, realized, deposited });
    }
    return out;
}

/** Days back to the oldest activity, today included. */
export function daysSince(activity: readonly Activity[], now: Date) {
    const oldest = Math.min(...activity.map((a) => a.at.getTime()), now.getTime());
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return Math.max(1, Math.ceil((today.getTime() - oldest) / DAY) + 1);
}
