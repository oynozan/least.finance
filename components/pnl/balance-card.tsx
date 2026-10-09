"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { balanceHistory, daysSince, type Activity } from "@/lib/trade/activity";
import { formatUsd } from "@/lib/trade/format";
import { Segmented } from "@/components/segmented";
import { formatPnl, trendOf } from "@/components/wallet-data";

type Range = "7D" | "30D" | "All";

const RANGES = [
    { value: "7D", label: "7D" },
    { value: "30D", label: "30D" },
    { value: "All", label: "All" },
] as const;

/** "All" reaches back to the first activity, within these bounds. */
const MIN_DAYS = 7;
const MAX_DAYS = 90;

const grow: Transition = { type: "spring", visualDuration: 0.5, bounce: 0.25 };
const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.35 };

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const TONE = { gain: "bg-gain/15 text-gain", loss: "bg-loss/15 text-loss", flat: "bg-pill text-muted" } as const;
const BAR = { gain: "bg-gain", loss: "bg-loss", flat: "bg-foreground/25" } as const;

/**
 * The balance, and a bar for each day under it. Pointing at a bar (or
 * arrowing through them) rolls the figures to that day.
 */
export function BalanceCard({ activity, now }: { activity: readonly Activity[]; now: Date }) {
    const [range, setRange] = useState<Range>("30D");
    const [active, setActive] = useState<number | null>(null);
    const chart = useRef<HTMLDivElement>(null);

    const days =
        range === "7D" ? 7 : range === "30D" ? 30 : Math.min(Math.max(daysSince(activity, now), MIN_DAYS), MAX_DAYS);
    const history = useMemo(() => balanceHistory(activity, days, now), [activity, days, now]);

    const balances = history.map((d) => d.balance);
    const high = Math.max(...balances);
    const low = Math.min(...balances);
    // A raised floor, so a day's PnL shows against a balance that is mostly deposits.
    const floor = high > low ? Math.max(0, low - (high - low) * 0.6) : 0;
    const heightOf = (balance: number) => (high > floor ? Math.max(4, ((balance - floor) / (high - floor)) * 100) : 4);

    const day = active !== null ? history[active] : null;
    const shown = day ?? history[history.length - 1];
    const pnl = day ? day.pnl : history.reduce((sum, d) => sum + d.pnl, 0);
    const trend = trendOf(Math.round(pnl * 100) / 100);
    const empty = high === 0 && low === 0;

    const point = (clientX: number) => {
        const rect = chart.current?.getBoundingClientRect();
        if (!rect) return;
        setActive(
            Math.min(
                history.length - 1,
                Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * history.length)),
            ),
        );
    };

    const onKeyDown = (event: KeyboardEvent) => {
        const last = history.length - 1;
        const at = active ?? last;
        const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setActive(Math.min(last, Math.max(0, next)));
    };

    return (
        <section aria-labelledby="balance-title" className="rounded-[34px] bg-panel p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                    <h2 id="balance-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                        {day ? `Balance on ${dayFormat.format(day.day)}` : "Balance"}
                    </h2>
                    <p className="text-[clamp(40px,1.5rem+3vw,60px)] leading-none font-medium tracking-[-0.03em]">
                        <NumberFlow value={shown.balance} format={{ style: "currency", currency: "USD" }} willChange />
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
                            {day
                                ? day.deposited
                                    ? `PnL that day, and ${formatUsd(day.deposited)} deposited`
                                    : "PnL that day"
                                : range === "All"
                                  ? "PnL so far"
                                  : `PnL over ${range === "7D" ? "7 days" : "30 days"}`}
                        </span>
                    </p>
                </div>
                <Segmented
                    label="Range"
                    options={RANGES}
                    value={range}
                    onChange={(next) => {
                        setRange(next);
                        setActive(null);
                    }}
                />
            </div>

            <div
                ref={chart}
                role="slider"
                tabIndex={0}
                aria-label="Balance by day"
                aria-valuemin={1}
                aria-valuemax={history.length}
                aria-valuenow={(active ?? history.length - 1) + 1}
                aria-valuetext={`${dayFormat.format(shown.day)}: ${formatUsd(shown.balance)}`}
                className="relative mt-8 flex h-[clamp(160px,28vh,260px)] touch-pan-y items-end justify-between gap-[3px] rounded-[18px] outline-2 outline-offset-4 outline-transparent focus-visible:outline-solid sm:gap-1.5"
                onPointerMove={(event) => point(event.clientX)}
                onPointerDown={(event) => point(event.clientX)}
                onPointerLeave={(event) => event.pointerType === "mouse" && setActive(null)}
                onKeyDown={onKeyDown}
                onBlur={() => setActive(null)}
            >
                <AnimatePresence>
                    {empty && (
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
                {history.map((d, i) => {
                    const tone = trendOf(Math.round(d.realized * 100) / 100);
                    return (
                        <motion.span
                            // A new range grows its bars in again.
                            key={`${range}:${i}`}
                            aria-hidden="true"
                            className={`max-w-11 min-w-[3px] flex-1 rounded-full ${BAR[tone]}`}
                            initial={{ height: "0%", opacity: 0 }}
                            animate={{
                                height: `${heightOf(d.balance)}%`,
                                opacity: active === null || active === i ? 1 : 0.4,
                            }}
                            transition={{
                                height: { ...grow, delay: Math.min(i, 40) * 0.012 },
                                opacity: { duration: 0.15 },
                            }}
                        />
                    );
                })}
            </div>
        </section>
    );
}
