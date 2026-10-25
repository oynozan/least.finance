"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MotionConfig, motion, type Transition } from "motion/react";
import { failed, fetchPnl, fetchStats } from "@/lib/stats/client";
import { toPoints } from "@/lib/stats/chart";
import type { ApiError, StatsPnlView, StatsRange, StatsView } from "@/server/src/protocol";
import { BalancesCard } from "./balances-card";
import { FeesCard } from "./fees-card";
import { MoneyCard } from "./money-card";

const rise: Transition = { type: "spring", visualDuration: 0.45, bounce: 0.25 };
const REFRESH_MS = 60_000;

/** Our stats and the range's line, read again every minute while the page is open. */
function useStats(range: StatsRange) {
    const [stats, setStats] = useState<StatsView | null>(null);
    const [pnl, setPnl] = useState<StatsPnlView | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let live = true;
        const read = async () => {
            const [s, p] = await Promise.all([fetchStats(), fetchPnl(range)]);
            if (!live) return;
            if (failed(s)) setError(s);
            else {
                setStats(s);
                setError(null);
            }
            // A line that fails to load keeps the last one; the range's change comes with it.
            if (!failed(p)) setPnl(p);
        };
        void read();
        const timer = setInterval(read, REFRESH_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [range, tick]);

    const retry = useCallback(() => setTick((n) => n + 1), []);
    return { stats, pnl, error, retry };
}

/** Our money, every balance we hold and the fees we've earned. */
export function StatsScreen() {
    const [range, setRange] = useState<StatsRange>("30D");
    const { stats, pnl, error, retry } = useStats(range);
    // The last range's line never shows under the new selection.
    const shown = pnl?.range === range ? pnl : null;
    const points = useMemo(() => (shown ? toPoints(shown) : []), [shown]);

    return (
        <MotionConfig reducedMotion="user">
            <div className="relative h-dvh">
                <main className="h-full overflow-y-auto [scrollbar-width:none]">
                    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pt-[96px] pb-[136px]">
                        <h1 className="sr-only">Stats</h1>
                        {stats ? (
                            <>
                                <motion.div
                                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={rise}
                                >
                                    <MoneyCard
                                        equityUsd={Number(stats.equityUsd)}
                                        range={range}
                                        onRange={setRange}
                                        points={points}
                                        changeUsd={shown ? Number(shown.changeUsd) : 0}
                                    />
                                </motion.div>
                                <motion.div
                                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={{ ...rise, delay: 0.08 }}
                                >
                                    <BalancesCard wallets={stats.wallets} owed={stats.owed} />
                                </motion.div>
                                <motion.div
                                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={{ ...rise, delay: 0.16 }}
                                >
                                    <FeesCard fees={stats.fees[range]} />
                                </motion.div>
                            </>
                        ) : error ? (
                            <p className="mt-[12vh] text-center text-[17px] text-muted">
                                {"Couldn't load stats."}
                                <button type="button" className="ml-2 cursor-pointer underline" onClick={retry}>
                                    Try again
                                </button>
                            </p>
                        ) : (
                            <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
                                <div className="h-[420px] animate-pulse rounded-[34px] bg-panel" />
                                <div className="h-[380px] animate-pulse rounded-[34px] bg-panel" />
                                <div className="h-[140px] animate-pulse rounded-[34px] bg-panel" />
                            </div>
                        )}
                    </div>
                </main>
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b from-background to-transparent"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-background to-transparent"
                />
            </div>
        </MotionConfig>
    );
}
