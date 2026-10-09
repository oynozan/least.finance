"use client";

import { useMemo, useSyncExternalStore } from "react";
import { toUsdc } from "@/lib/account/state";
import {
    byNewest,
    confirmedTrades,
    depositActivity,
    mockDeposits,
    mockTrades,
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

/**
 * Everything the account did, newest first: its deposits (the demo's are
 * mock), trades confirmed in Review this session, and mock trades until
 * trading is live.
 */
export function useActivity(): ActivityState {
    const { wallet } = useTrade();
    const { history } = useAccount();
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
        return [...deposits, ...confirmed, ...mockTrades(now)].sort(byNewest);
    }, [now, wallet.status, history, confirmed]);

    if (wallet.status === "disconnected") return { status: "signed-out", connect: wallet.connect };
    if (wallet.status === "loading" || now === null || activity === null) return { status: "loading" };
    return { status: "ready", activity, now };
}
