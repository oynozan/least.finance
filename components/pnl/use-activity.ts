"use client";

import { useMemo, useSyncExternalStore } from "react";
import { isPendingPerp, toUsdc, type OptimisticTrade } from "@/lib/account/state";
import type { PerpsView, PositionsView } from "@/server/src/protocol";
import {
    byNewest,
    depositActivity,
    pendingBuyActivity,
    perpActivity,
    predictionActivity,
    saleActivity,
    swapActivity,
    withdrawalActivity,
    type Activity,
} from "@/lib/trade/activity";
import { QUOTE, type Catalog } from "@/lib/trade/catalog";
import { withdrawalEntries } from "@/components/history-entries";
import { useAccount } from "@/components/account-provider";
import { useTrade } from "@/components/trade/trade-provider";

export type ActivityState =
    | { status: "loading" }
    | { status: "signed-out"; connect: () => void }
    | { status: "ready"; activity: Activity[]; now: Date };

const MINUTE = 60_000;

const subscribeMinute = (onChange: () => void) => {
    const timer = setInterval(onChange, MINUTE);
    return () => clearInterval(timer);
};
/** The current minute, in the browser only: dates are relative to it, so the server leaves them out. */
export const useNow = () =>
    useSyncExternalStore(
        subscribeMinute,
        () => Math.floor(Date.now() / MINUTE) * MINUTE,
        () => null,
    );

/** A coin's price in USD from the catalog: 1 for the quote coin, null when it has none. */
export const priceIn = (catalog: Catalog) => (symbol: string) =>
    symbol === QUOTE ? 1 : (catalog.tokens.find((t) => t.symbol === symbol)?.priceUSD ?? null);

/** Positions as their rows, plus the part sales and the buys still on their way. */
function realPredictions({ positions, orders }: PositionsView, optimistic: readonly OptimisticTrade[]): Activity[] {
    const rows = positions.flatMap((p) => predictionActivity(p));
    const placed = new Set(orders.map((o) => o.requestId));
    for (const o of orders) {
        const sale = saleActivity(o);
        if (sale) rows.push(sale);
        if (o.side !== "buy" || (o.state !== "placing" && o.state !== "posted")) continue;
        rows.push(
            pendingBuyActivity({
                id: o.requestId,
                question: o.question,
                outcome: o.outcome,
                amountUSD: Number(o.amountUSD ?? 0),
                shares: o.shares ?? "",
                at: new Date(o.createdAt),
            }),
        );
    }
    for (const t of optimistic) {
        if (t.side !== "buy" || placed.has(t.requestId)) continue;
        rows.push(
            pendingBuyActivity({
                id: t.requestId,
                question: t.question,
                outcome: t.outcome,
                amountUSD: toUsdc(t.amountWei),
                shares: t.shares,
                at: new Date(t.at),
            }),
        );
    }
    return rows;
}

/** Perp positions as their rows; an open the server hasn't filled yet is pending. */
const realPerps = ({ positions }: PerpsView): Activity[] => positions.flatMap((p) => perpActivity(p, isPendingPerp(p)));

/**
 * Everything the account did, newest first: its deposits, withdrawals, swaps, predictions and perps,
 * as the server holds them, plus buys still on their way.
 */
export function useActivity(): ActivityState {
    const { wallet, catalog } = useTrade();
    const { history, predictions, perps, optimisticTrades, swaps, withdrawals, pendingWithdrawals } = useAccount();
    const nowMs = useNow();

    const now = useMemo(() => (nowMs === null ? null : new Date(nowMs)), [nowMs]);
    const activity = useMemo(() => {
        if (now === null) return null;
        const deposits = history.map((row) =>
            depositActivity({
                key: row.id ?? row.key,
                amountUSD: toUsdc(row.amount),
                at: row.at,
                pending: row.pending,
            }),
        );
        const payouts = withdrawalEntries(withdrawals, pendingWithdrawals)
            .filter((w) => w.state !== "failed")
            .map((w) =>
                withdrawalActivity({
                    id: w.key,
                    amountUSD: toUsdc(w.amount),
                    at: w.at,
                    pending: w.state === "sending",
                    to: w.to,
                }),
            );
        // A swap's size is what it paid at the coin's price, or nothing known without one.
        const priceOf = priceIn(catalog);
        const trades = swaps.map((order) => {
            const price = priceOf(order.from.token);
            return swapActivity(order, price === null ? null : Number(order.from.amount) * price);
        });
        return [
            ...deposits,
            ...payouts,
            ...trades,
            ...realPredictions(predictions, optimisticTrades),
            ...realPerps(perps),
        ].sort(byNewest);
    }, [now, history, predictions, perps, optimisticTrades, swaps, withdrawals, pendingWithdrawals, catalog]);

    if (wallet.status === "disconnected") return { status: "signed-out", connect: wallet.connect };
    if (wallet.status === "loading" || now === null || activity === null) return { status: "loading" };
    return { status: "ready", activity, now };
}
