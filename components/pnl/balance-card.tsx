"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { chartOf, type Chart } from "@/lib/pnl/chart";
import { headingFor, hoverLine, valueText } from "@/lib/pnl/labels";
import { Segmented } from "@/components/segmented";
import { formatPnl, trendOf } from "@/components/wallet-data";
import { usePnlSeries } from "./use-pnl-series";

type Range = "7D" | "30D" | "All";

const RANGES = [
    { value: "7D", label: "7D" },
    { value: "30D", label: "30D" },
    { value: "All", label: "All" },
] as const;

const grow: Transition = { type: "spring", visualDuration: 0.5, bounce: 0.25 };
const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.35 };

const TONE = { gain: "bg-gain/15 text-gain", loss: "bg-loss/15 text-loss", flat: "bg-pill text-muted" } as const;
const BAR = { gain: "bg-gain", loss: "bg-loss", flat: "bg-foreground/25" } as const;

/** A bar's height in percent, against a raised floor so a bucket's PnL shows on a balance that is mostly deposits. */
function heightOf({ high, low }: Chart, balance: number) {
    const floor = high > low ? Math.max(0, low - (high - low) * 0.6) : 0;
    return high > floor ? Math.max(4, ((balance - floor) / (high - floor)) * 100) : 4;
}

/**
 * The balance, and a bar for each day, week or month under it. Pointing at a bar
 * (or arrowing through them) rolls the figures to that bar.
 */
export function BalanceCard() {
    const { series, failed, error, retry } = usePnlSeries();
    const [range, setRange] = useState<Range>("30D");
    const [pointed, setPointed] = useState<number | null>(null);
    const track = useRef<HTMLDivElement>(null);
    const chart = useMemo(() => (series ? chartOf(series.ranges[range]) : null), [series, range]);

    if (!chart && !failed) {
        return (
            <div
                aria-busy="true"
                aria-label="Loading balance"
                className="h-[420px] animate-pulse rounded-[34px] bg-panel"
            />
        );
    }

    const bars = chart?.bars ?? [];
    // A fresher series can have fewer bars than the one being pointed at.
    const active = pointed !== null && pointed < bars.length ? pointed : null;
    const bar = active !== null ? bars[active] : undefined;
    const shown = bar ?? bars.at(-1);
    const pnl = bar ? bar.pnl : (chart?.pnl ?? 0);
    const trend = trendOf(Math.round(pnl * 100) / 100);

    const point = (clientX: number) => {
        const rect = track.current?.getBoundingClientRect();
        if (!rect || bars.length === 0) return;
        setPointed(
            Math.min(bars.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * bars.length))),
        );
    };

    const onKeyDown = (event: KeyboardEvent) => {
        const last = bars.length - 1;
        const at = active ?? last;
        const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setPointed(Math.min(last, Math.max(0, next)));
    };

    return (
        <section aria-labelledby="balance-title" className="rounded-[34px] bg-panel p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                    <h2 id="balance-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                        {chart && bar ? headingFor(chart.unit, bar.start) : "Balance"}
                    </h2>
                    {chart && (
                        <>
                            <p className="text-[clamp(40px,1.5rem+3vw,60px)] leading-none font-medium tracking-[-0.03em]">
                                <NumberFlow
                                    value={shown?.balance ?? 0}
                                    format={{ style: "currency", currency: "USD" }}
                                    willChange
                                />
                            </p>
                            <p className="mt-1 flex items-center gap-2">
                                <motion.span
                                    key={trend}
                                    className={`inline-flex h-8 items-center rounded-full px-3 text-[15px] font-medium ${TONE[trend]}`}
                                    initial={{ scale: 0.85, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    transition={pop}
                                >
                                    {formatPnl(pnl)}
                                </motion.span>
                                <span className="text-[15px] text-muted">
                                    {bar
                                        ? hoverLine(chart.unit, bar.net)
                                        : range === "All"
                                          ? "PnL so far"
                                          : `PnL over ${range === "7D" ? "7 days" : "30 days"}`}
                                </span>
                            </p>
                        </>
                    )}
                </div>
                <Segmented
                    label="Range"
                    options={RANGES}
                    value={range}
                    onChange={(next) => {
                        setRange(next);
                        setPointed(null);
                    }}
                />
            </div>

            {chart ? (
                <div
                    ref={track}
                    role="slider"
                    tabIndex={0}
                    aria-label="Balance by day"
                    aria-valuemin={1}
                    aria-valuemax={bars.length}
                    aria-valuenow={(active ?? bars.length - 1) + 1}
                    aria-valuetext={shown ? valueText(chart.unit, shown.start, shown.balance) : undefined}
                    className="relative mt-8 flex h-[clamp(160px,28vh,260px)] touch-pan-y items-end justify-between rounded-[18px] outline-2 outline-offset-4 outline-transparent focus-visible:outline-solid"
                    onPointerMove={(event) => point(event.clientX)}
                    onPointerDown={(event) => point(event.clientX)}
                    onPointerLeave={(event) => event.pointerType === "mouse" && setPointed(null)}
                    onKeyDown={onKeyDown}
                    onBlur={() => setPointed(null)}
                >
                    <AnimatePresence>
                        {chart.empty && (
                            <motion.p
                                className="absolute inset-0 grid place-items-center text-[15px] text-muted"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                            >
                                No balance yet
                            </motion.p>
                        )}
                    </AnimatePresence>
                    {bars.map((b, i) => {
                        const tone = trendOf(Math.round(b.pnl * 100) / 100);
                        return (
                            // The gap between bars is cut from each slot, so a crowded chart narrows its gaps with its bars.
                            <span
                                // A new range grows its bars in again.
                                key={`${range}:${i}`}
                                aria-hidden="true"
                                className="flex h-full max-w-11 min-w-0 flex-1 items-end justify-center"
                            >
                                <motion.span
                                    className={`w-[max(1px,calc(100%-3px))] rounded-full sm:w-[max(1px,calc(100%-6px))] ${BAR[tone]}`}
                                    initial={{ height: "0%", opacity: 0 }}
                                    animate={{
                                        height: `${heightOf(chart, b.balance)}%`,
                                        opacity: active === null || active === i ? 1 : 0.4,
                                    }}
                                    transition={{
                                        height: { ...grow, delay: Math.min(i, 40) * 0.012 },
                                        opacity: { duration: 0.15 },
                                    }}
                                />
                            </span>
                        );
                    })}
                </div>
            ) : (
                <div className="mt-8 grid h-[clamp(160px,28vh,260px)] place-items-center text-center text-[15px] text-muted">
                    <p>
                        {"Couldn't load your history."} {error?.message}
                        <button type="button" className="ml-2 underline" onClick={retry}>
                            Try again
                        </button>
                    </p>
                </div>
            )}
        </section>
    );
}
