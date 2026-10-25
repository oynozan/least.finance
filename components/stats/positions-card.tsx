"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { failed, fetchPositions } from "@/lib/stats/client";
import type { StatsPositionRow, StatsPositionsPage } from "@/server/src/protocol";
import { Segmented } from "@/components/segmented";
import { formatPnl, formatUsd, trendOf } from "@/components/wallet-data";
import { Pager } from "./pager";

const STATES = [
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
] as const;
const KINDS = [
    { value: "all", label: "All" },
    { value: "predictions", label: "Predictions" },
    { value: "perps", label: "Perps" },
    { value: "coins", label: "Coins" },
] as const;

type State = (typeof STATES)[number]["value"];
type Kind = (typeof KINDS)[number]["value"];

const TONE = { gain: "text-gain", loss: "text-loss", flat: "text-muted" } as const;
const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const cell = "py-2.5 transition-colors duration-150 group-hover:bg-pill";

/** One page of positions; the one before stays up while the next is read. */
function usePositions(state: State, kind: Kind) {
    const [page, setPage] = useState(1);
    const [data, setData] = useState<StatsPositionsPage | null>(null);
    const [error, setError] = useState(false);
    const [tick, setTick] = useState(0);
    const latest = useRef(0);

    // A filter change starts again from the first page.
    const [filters, setFilters] = useState({ state, kind });
    if (filters.state !== state || filters.kind !== kind) {
        setFilters({ state, kind });
        setPage(1);
    }

    useEffect(() => {
        const mine = ++latest.current;
        void fetchPositions({ page, state, kind }).then((reply) => {
            if (mine !== latest.current) return;
            if (failed(reply)) setError(true);
            else {
                setData(reply);
                setError(false);
            }
        });
    }, [page, state, kind, tick]);

    const retry = useCallback(() => setTick((n) => n + 1), []);
    return { page, setPage, data, error, retry };
}

/** Everyone's predictions, perps and held coins, newest first, filtered and paged. */
export function PositionsCard() {
    const [state, setState] = useState<State>("all");
    const [kind, setKind] = useState<Kind>("all");
    const { page, setPage, data, error, retry } = usePositions(state, kind);

    return (
        <section aria-labelledby="positions-title" className="rounded-[34px] bg-panel p-2.5 sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] pt-3 pb-3 sm:px-5">
                <h2 id="positions-title" className="text-base font-medium tracking-[-0.01em] text-muted">
                    Positions
                </h2>
                <div className="flex flex-wrap gap-2">
                    <Segmented label="State" options={STATES} value={state} onChange={setState} />
                    <Segmented label="Kind" options={KINDS} value={kind} onChange={setKind} />
                </div>
            </div>
            {error ? (
                <p className="px-[18px] py-10 text-center text-[15px] text-muted">
                    {"Couldn't load positions."}
                    <button type="button" className="ml-2 cursor-pointer underline" onClick={retry}>
                        Try again
                    </button>
                </p>
            ) : data && data.items.length === 0 ? (
                <p className="px-[18px] py-10 text-center text-[15px] text-muted">No positions.</p>
            ) : (
                <table className="w-full table-fixed border-separate border-spacing-0">
                    <thead>
                        <tr className="text-[13px] font-semibold tracking-[0.04em] text-muted uppercase">
                            <th scope="col" className="w-[84px] px-[18px] pb-2 text-left font-semibold">
                                Person
                            </th>
                            <th scope="col" className="pb-2 text-left font-semibold">
                                Position
                            </th>
                            <th scope="col" className="w-[176px] pb-2 text-right font-semibold max-sm:hidden">
                                Size
                            </th>
                            <th scope="col" className="w-[100px] pb-2 text-right font-semibold max-md:hidden">
                                Value
                            </th>
                            <th scope="col" className="w-[100px] pb-2 text-right font-semibold max-sm:pr-[18px]">
                                PnL
                            </th>
                            <th scope="col" className="w-[150px] pr-[18px] pb-2 text-right font-semibold max-sm:hidden">
                                Opened
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {data?.items.map((row) => (
                            <Row key={row.id} row={row} />
                        ))}
                    </tbody>
                </table>
            )}
            {!error && data && <Pager page={page} pages={data.pages} onPage={setPage} />}
        </section>
    );
}

function Row({ row }: { row: StatsPositionRow }) {
    const pnl = row.pnlUsd === null ? null : Number(row.pnlUsd);
    return (
        <tr className="group" data-id={row.id} data-kind={row.kind} data-state={row.state}>
            <td
                className={`${cell} rounded-l-[24px] pr-2 pl-[18px] font-mono text-[14px] tracking-[-0.01em] text-muted`}
            >
                {row.account}
            </td>
            <td className={cell}>
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[17px] leading-snug font-medium tracking-[-0.01em]">
                        {row.title}
                    </span>
                    {row.detail && (
                        <span className="truncate text-[14px] leading-snug text-muted" title={row.detail}>
                            {row.detail}
                        </span>
                    )}
                </div>
            </td>
            <td className={`${cell} truncate text-right text-[15px] tabular-nums max-sm:hidden`}>{row.size}</td>
            <td className={`${cell} text-right text-[16px] tabular-nums max-md:hidden`}>
                {row.valueUsd === null ? "—" : formatUsd(Number(row.valueUsd))}
            </td>
            <td
                className={`${cell} text-right text-[16px] font-medium tabular-nums max-sm:rounded-r-[24px] max-sm:pr-[18px] ${
                    pnl === null ? "text-muted" : TONE[trendOf(pnl)]
                }`}
            >
                {pnl === null ? "—" : formatPnl(pnl)}
            </td>
            <td className={`${cell} rounded-r-[24px] pr-[18px] text-right text-[14px] text-muted max-sm:hidden`}>
                {when.format(new Date(row.openedAt))}
            </td>
        </tr>
    );
}
