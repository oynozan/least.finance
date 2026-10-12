"use client";

import { useMemo, useSyncExternalStore } from "react";
import { toUsdc, type OptimisticTrade } from "@/lib/account/state";
import type { PositionsView } from "@/server/src/protocol";
import {
    byNewest,
    confirmedTrades,
    depositActivity,
    mockDeposits,
    mockTrades,
    pendingBuyActivity,
    predictionActivity,
    type Activity,
} from "@/lib/trade/activity";
import { useAccount } from "@/components/account-provider";
import { useTrade } from "@/components/trade/trade-provider";

export type ActivityState =
    | { status: "loading" }
    | { status: "signed-out"; connect: () => void }
    | { status: "ready"; activity: Activity[]; now: Date };

const NONE: Activity[] = [];
const MINUTE = 60_000;

const subscribeMinute = (onChange: () => void) => {
    const timer = setInterval(onChange, MINUTE);
    return () => clearInterval(timer);
};
/** The current minute, in the browser only: dates are relative to it, so the server leaves them out. */
const useNow = () =>
    useSyncExternalStore(
        subscribeMinute,
        () => Math.floor(Date.now() / MINUTE) * MINUTE,
        () => null,
    );

/** Positions as their rows, plus the buys still on their way. */
function realPredictions({ positions, orders }: PositionsView, optimistic: readonly OptimisticTrade[]): Activity[] {
    const rows = positions.flatMap((p) => predictionActivity(p));
    const placed = new Set(orders.map((o) => o.requestId));
    for (const o of orders) {
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

/**
 * Everything the account did, newest first: its deposits (the demo's are
 * mock), trades confirmed in Review this session, and mock trades until
 * trading is live.
 */
export function useActivity(): ActivityState {
    const { wallet } = useTrade();
    const { history, predictions, optimisticTrades } = useAccount();
    const confirmed = useSyncExternalStore(confirmedTrades.subscribe, confirmedTrades.get, () => NONE);
    const nowMs = useNow();

    const now = useMemo(() => (nowMs === null ? null : new Date(nowMs)), [nowMs]);
    const activity = useMemo(() => {
        if (now === null) return null;
        const deposits =
            wallet.status === "demo"
                ? mockDeposits(now)
                : history.map((row) =>
                      depositActivity({
                          key: row.key,
                          amountUSD: toUsdc(row.amount),
                          at: row.at,
                          pending: row.pending,
                      }),
                  );
        // Signed in, the person's real predictions stand in for the mock ones.
        const demo = wallet.status === "demo";
        const mock = demo ? mockTrades(now) : mockTrades(now).filter((t) => t.kind !== "predict");
        const real = demo ? [] : realPredictions(predictions, optimisticTrades);
        return [...deposits, ...confirmed, ...real, ...mock].sort(byNewest);
    }, [now, wallet.status, history, confirmed, predictions, optimisticTrades]);

    if (wallet.status === "disconnected") return { status: "signed-out", connect: wallet.connect };
    if (wallet.status === "loading" || now === null || activity === null) return { status: "loading" };
    return { status: "ready", activity, now };
}
