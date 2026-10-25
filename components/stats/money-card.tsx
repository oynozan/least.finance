"use client";

import { useState } from "react";
import NumberFlow from "@number-flow/react";
import { motion, type Transition } from "motion/react";
import { Segmented } from "@/components/segmented";
import { formatPnl, trendOf } from "@/components/wallet-data";
import type { StatsPoint } from "@/lib/stats/chart";
import type { StatsRange } from "@/server/src/protocol";
import { formatAt, LineChart } from "./line-chart";

const RANGES = [
    { value: "7D", label: "7D" },
    { value: "30D", label: "30D" },
    { value: "All", label: "All" },
] as const;

const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.35 };
const TONE = { gain: "bg-gain/15 text-gain", loss: "bg-loss/15 text-loss", flat: "bg-pill text-muted" } as const;

type MoneyCardProps = {
    /** What we hold less what we owe, now. */
    equityUsd: number;
    range: StatsRange;
    onRange: (range: StatsRange) => void;
    points: StatsPoint[];
    /** The range's change, or null while that range's line is still on its way. */
    changeUsd: number | null;
    /** Some wallets couldn't be read, so the total leans on their last known amounts. */
    estimated?: boolean;
};

const ESTIMATED = "Some wallets couldn't be read, so their last known amounts are used.";

/** Our money: the total, the range's change, and the equity line under them. Scrubbing rolls the total to that point. */
export function MoneyCard({ equityUsd, range, onRange, points, changeUsd, estimated = false }: MoneyCardProps) {
    const [pointed, setPointed] = useState<number | null>(null);
    // A fresher series can have fewer points than the one being pointed at.
    const active = pointed !== null && pointed < points.length ? pointed : null;
    const total = active !== null ? points[active]!.usd : equityUsd;
    const loading = changeUsd === null;
    const change = Math.round((changeUsd ?? 0) * 100) / 100;
    const trend = trendOf(change);

    return (
        <section aria-labelledby="money-title" className="overflow-hidden rounded-[34px] bg-panel">
            <div className="flex flex-col gap-4 p-6 pb-8 sm:flex-row sm:items-start sm:justify-between sm:p-8 sm:pb-10">
                <div className="flex min-w-0 flex-col gap-2">
                    <h2 id="money-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                        Our money
                    </h2>
                    <div className="flex items-center gap-3">
                        <p
                            data-total={total}
                            className="text-[clamp(40px,1.5rem+3vw,60px)] leading-none font-medium tracking-[-0.03em]"
                        >
                            <NumberFlow value={total} format={{ style: "currency", currency: "USD" }} willChange />
                        </p>
                        {estimated && (
                            <span
                                tabIndex={0}
                                data-estimated=""
                                className="group relative grid size-6 shrink-0 cursor-default place-items-center rounded-full outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid"
                            >
                                <span aria-hidden="true" className="size-2.5 rounded-full bg-muted" />
                                <span
                                    role="tooltip"
                                    className="pointer-events-none absolute top-full left-0 z-10 mt-1 w-[min(18rem,70vw)] rounded-2xl bg-pill px-3 py-2 text-[13px] leading-snug font-normal tracking-normal text-foreground opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
                                >
                                    {ESTIMATED}
                                </span>
                            </span>
                        )}
                    </div>
                    <p className="mt-1 flex h-8 items-center">
                        {loading ? null : active !== null ? (
                            <span className="text-[15px] text-muted tabular-nums">{formatAt(points[active]!.at)}</span>
                        ) : (
                            <motion.span
                                key={trend}
                                className={`inline-flex h-8 items-center rounded-full px-3 text-[15px] font-medium ${TONE[trend]}`}
                                initial={{ scale: 0.85, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={pop}
                            >
                                {formatPnl(change)}
                            </motion.span>
                        )}
                    </p>
                </div>
                <div className="flex self-start">
                    <Segmented
                        label="Range"
                        options={RANGES}
                        value={range}
                        onChange={(next) => {
                            onRange(next);
                            setPointed(null);
                        }}
                    />
                </div>
            </div>
            {loading ? (
                <div aria-hidden="true" className="h-[clamp(160px,28vh,260px)] animate-pulse bg-pill/40" />
            ) : (
                <LineChart
                    label="Equity over time"
                    points={points}
                    changeUsd={changeUsd}
                    active={active}
                    onScrub={setPointed}
                />
            )}
        </section>
    );
}
