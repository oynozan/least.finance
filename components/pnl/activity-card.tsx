"use client";

import { useState } from "react";
import { motion, type Transition } from "motion/react";
import { bodyState } from "@/lib/pnl/activity-pages";
import type { Activity } from "@/lib/trade/activity";
import { formatUsd } from "@/lib/trade/format";
import type { ActivityFilter } from "@/server/src/protocol";
import { CoinIcon } from "@/components/coin-icons";
import { Segmented } from "@/components/segmented";
import { formatPnl, trendOf } from "@/components/wallet-data";
import { useActivityFeed } from "./use-activity-feed";

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

/** Every operation, newest first, with what it did to the balance: the live rows over the server's pages, older ones on request. */
export function ActivityCard({ live }: { live: readonly Activity[] }) {
    const [filter, setFilter] = useState<ActivityFilter>("all");
    const { rows, loaded, more, loadingMore, loadMore, failure, retry } = useActivityFeed(filter, live);
    const body = bodyState({ filter, loaded, more, rows: rows.length });

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
                                                {a.amountUSD === null ? "—" : formatUsd(a.amountUSD)},{" "}
                                            </span>
                                            {a.detail}
                                            <span className="md:hidden">, {when.format(a.at)}</span>
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
            {/* Why the newest page can't be read, instead of waiting in silence */}
            {failure?.kind === "first" && !loaded && (
                <p role="status" className="px-[18px] py-10 text-center text-[15px] text-muted">
                    {`Couldn't load your activity. ${failure.message}`}
                    {failure.auto ? (
                        " Trying again\u2026"
                    ) : (
                        <>
                            {" "}
                            <button
                                type="button"
                                onClick={retry}
                                className="cursor-pointer underline underline-offset-3 hover:text-foreground"
                            >
                                Try again
                            </button>
                        </>
                    )}
                </p>
            )}
            {/* The message's own height with no text, while history may still come */}
            {body === "busy" && !(failure?.kind === "first" && !loaded) && (
                <p aria-busy="true" className="px-[18px] py-10 text-center text-[15px] text-muted">
                    {"\u00a0"}
                </p>
            )}
            {/* Gone at once when rows come, so it never sits under them while they rise in */}
            {(body === "nothing" || body === "no-deposits") && (
                <motion.p
                    className="px-[18px] py-10 text-center text-[15px] text-muted"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                >
                    {body === "no-deposits" ? "No deposits yet" : "Nothing here yet"}
                </motion.p>
            )}
            {failure?.kind === "more" && (
                <p role="status" className="px-[18px] pb-1 text-center text-[15px] text-muted">
                    {`Couldn't load older activity. ${failure.message}`}
                </p>
            )}
            {more && (
                <button
                    type="button"
                    className="mx-auto mt-1 mb-2 block h-10 cursor-pointer rounded-full px-5 text-[15px] font-medium text-muted outline-2 outline-offset-2 outline-transparent transition-colors duration-150 hover:text-foreground focus-visible:outline-solid disabled:cursor-default disabled:opacity-60 disabled:hover:text-muted"
                    disabled={loadingMore}
                    onClick={loadMore}
                >
                    {failure?.kind === "more" ? "Try again" : "Show older"}
                </button>
            )}
            {failure?.kind === "more" && (
                <p role="status" className="px-[18px] pb-3 text-center text-[14px] text-muted">
                    {`Couldn't load older history. ${failure.message}`}
                </p>
            )}
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
    // Gains and realized losses carry their tone; a fee or a withdrawal stays quiet.
    const tone = a.kind === "deposit" || a.kind === "close" ? trendOf(change) : "flat";
    return <span className={RESULT_TONE[tone]}>{formatPnl(change)}</span>;
}

/** One coin, or a swap's two overlapping in the same square, so every row's text starts at one edge. */
function Coins({ symbols }: { symbols: string[] }) {
    if (symbols.length < 2) return <CoinIcon symbol={symbols[0]} className="size-10 shrink-0" />;
    return (
        <span className="relative flex size-10 shrink-0">
            <CoinIcon symbol={symbols[0]} className="absolute top-0 left-0 size-7" />
            <CoinIcon symbol={symbols[1]} className="absolute right-0 bottom-0 size-7" />
        </span>
    );
}
