"use client";

import { useState } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import type { Activity } from "@/lib/trade/activity";
import { formatUsd } from "@/lib/trade/format";
import { CoinIcon } from "@/components/coin-icons";
import { Segmented } from "@/components/segmented";
import { formatPnl, trendOf } from "@/components/wallet-data";

type Filter = "all" | "trades" | "deposits";

const FILTERS = [
    { value: "all", label: "All" },
    { value: "trades", label: "Trades" },
    { value: "deposits", label: "Deposits" },
] as const;

const rise: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.25 };
/** Only the first rows take part in the stagger; the rest land at once, below the fold. */
const STAGGERED = 12;

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const RESULT_TONE = { gain: "text-gain", loss: "text-loss", flat: "text-muted" } as const;

/** Every operation, newest first, with what it did to the balance. */
export function ActivityCard({ activity }: { activity: readonly Activity[] }) {
    const [filter, setFilter] = useState<Filter>("all");
    const rows = activity.filter((a) =>
        filter === "all" ? true : filter === "deposits" ? a.kind === "deposit" : a.kind !== "deposit",
    );

    return (
        <section aria-labelledby="activity-title" className="rounded-[34px] bg-panel p-2.5 sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] pt-3 pb-3 sm:px-5">
                <h2 id="activity-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                    Activity
                </h2>
                <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
            </div>
            <table className="w-full table-fixed border-separate border-spacing-0">
                <thead>
                    <tr className="text-[13px] font-semibold tracking-[0.04em] text-muted uppercase">
                        <th scope="col" className="px-[18px] pb-2 text-left font-semibold">
                            Operation
                        </th>
                        <th scope="col" className="w-[130px] pb-2 text-right font-semibold max-sm:hidden">
                            Amount
                        </th>
                        <th scope="col" className="w-[120px] pb-2 text-right font-semibold max-md:pr-[18px]">
                            Result
                        </th>
                        <th scope="col" className="w-[170px] pr-[18px] pb-2 text-right font-semibold max-md:hidden">
                            Date
                        </th>
                    </tr>
                </thead>
                <tbody key={filter}>
                    {rows.map((a, i) => (
                        <motion.tr
                            key={a.id}
                            className="group"
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ ...rise, delay: i < STAGGERED ? 0.04 + i * 0.03 : 0 }}
                        >
                            <td className="rounded-l-[24px] py-2.5 pl-3 transition-colors duration-150 group-hover:bg-pill">
                                <div className="flex min-w-0 items-center gap-3">
                                    <Coins symbols={a.symbols} />
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate text-[17px] leading-snug font-medium tracking-[-0.01em]">
                                            {a.title}
                                        </span>
                                        <span className="truncate text-[14px] leading-snug text-muted">
                                            <span className="sm:hidden">
                                                {a.amountUSD === null ? "—" : formatUsd(a.amountUSD)} ·{" "}
                                            </span>
                                            {a.detail}
                                            <span className="md:hidden"> · {when.format(a.at)}</span>
                                        </span>
                                    </div>
                                </div>
                            </td>
                            <td className="py-2.5 text-right text-[16px] tabular-nums transition-colors duration-150 group-hover:bg-pill max-sm:hidden">
                                {a.amountUSD === null ? "—" : formatUsd(a.amountUSD)}
                            </td>
                            <td className="py-2.5 text-right text-[16px] font-medium tabular-nums transition-colors duration-150 group-hover:bg-pill max-md:rounded-r-[24px] max-md:pr-[18px]">
                                <Result activity={a} />
                            </td>
                            <td className="rounded-r-[24px] py-2.5 pr-[18px] text-right text-[14px] text-muted transition-colors duration-150 group-hover:bg-pill max-md:hidden">
                                {when.format(a.at)}
                            </td>
                        </motion.tr>
                    ))}
                </tbody>
            </table>
            <AnimatePresence>
                {rows.length === 0 && (
                    <motion.p
                        className="px-[18px] py-10 text-center text-[15px] text-muted"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                    >
                        {filter === "deposits" ? "No deposits yet" : "Nothing here yet"}
                    </motion.p>
                )}
            </AnimatePresence>
        </section>
    );
}

function Result({ activity: a }: { activity: Activity }) {
    if (a.pending) {
        return (
            <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="size-2 animate-pulse rounded-full bg-muted" aria-hidden="true" />
                Pending
            </span>
        );
    }
    const change = Math.round(a.change * 100) / 100;
    if (change === 0) return <span className="text-muted">—</span>;
    // Gains and realized losses carry their tone; a fee alone stays quiet.
    const tone = a.kind === "deposit" || a.kind === "close" ? trendOf(change) : "flat";
    return <span className={RESULT_TONE[tone]}>{formatPnl(change)}</span>;
}

/** One coin, or a swap's two overlapping. */
function Coins({ symbols }: { symbols: string[] }) {
    if (symbols.length < 2) return <CoinIcon symbol={symbols[0]} className="size-10 shrink-0" />;
    return (
        <span className="relative flex h-10 w-[52px] shrink-0">
            <CoinIcon symbol={symbols[0]} className="absolute top-0 left-0 size-8" />
            <CoinIcon symbol={symbols[1]} className="absolute right-0 bottom-0 size-8" />
        </span>
    );
}
