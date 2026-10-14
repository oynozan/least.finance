import { parseStart } from "./labels";
import type { PnlRangeKey, PnlSeries, PnlUnit } from "@/server/src/protocol";

/** One bar of the Balance card, its amounts as numbers for display. */
export type Bar = {
    /** The bucket's first local date, YYYY-MM-DD. */
    start: string;
    /** Local midnight on `start`. */
    date: Date;
    /** At the end of the bucket. */
    balance: number;
    /** Realized PnL inside the bucket. */
    pnl: number;
    /** Deposits minus withdrawals inside the bucket. */
    net: number;
};

export type Chart = {
    unit: PnlUnit;
    bars: Bar[];
    /** The bars' PnL added up. */
    pnl: number;
    high: number;
    low: number;
    /** Every balance is zero. */
    empty: boolean;
};

/** A range of the server's series as the card draws it. */
export function chartOf(range: PnlSeries["ranges"][PnlRangeKey]): Chart {
    const bars = range.points.map((p): Bar => ({
        start: p.start,
        date: parseStart(p.start),
        balance: Number(p.balance),
        pnl: Number(p.pnl),
        net: Number(p.net),
    }));
    const balances = bars.map((bar) => bar.balance);
    return {
        unit: range.unit,
        bars,
        pnl: bars.reduce((sum, bar) => sum + bar.pnl, 0),
        high: bars.length ? Math.max(...balances) : 0,
        low: bars.length ? Math.min(...balances) : 0,
        empty: balances.every((balance) => balance === 0),
    };
}
