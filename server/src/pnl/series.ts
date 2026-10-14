import { formatUsdc } from "../db/money.ts";
import type { PnlPoint, PnlSeries, PnlUnit } from "../protocol.ts";

export type DayTotals = { net: bigint; pnl: bigint };

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_BARS = 90;

/* Calendar numbers, whole days since 1970-01-01 */

function dayNumber(date: string): number {
    const match = DATE.exec(date);
    if (!match) throw new Error(`Not a date: ${date}`);
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

const dateOfNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export const addDays = (date: string, n: number) => dateOfNumber(dayNumber(date) + n);

// 1970-01-01 was a Thursday, so n + 3 counts days since a Monday
const mondayOnOrBefore = (n: number) => n - ((((n + 3) % 7) + 7) % 7);

function bucketStart(n: number, unit: PnlUnit): number {
    if (unit === "day") return n;
    if (unit === "week") return mondayOnOrBefore(n);
    const date = new Date(n * DAY_MS);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS;
}

function nextStart(start: number, unit: PnlUnit): number {
    if (unit === "day") return start + 1;
    if (unit === "week") return start + 7;
    const date = new Date(start * DAY_MS);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
}

/* Buckets */

function allUnit(first: number, today: number): PnlUnit {
    if (today - first + 1 <= MAX_BARS) return "day";
    const weeks = (mondayOnOrBefore(today) - mondayOnOrBefore(first)) / 7 + 1;
    return weeks <= MAX_BARS ? "week" : "month";
}

type Entry = [day: number, totals: DayTotals];

// The balance starts from every entry before first, then each bucket adds its own
function roll(entries: Entry[], first: number, today: number, unit: PnlUnit): PnlPoint[] {
    let next = 0;
    const take = (before: number): DayTotals => {
        const sum = { net: 0n, pnl: 0n };
        for (let entry = entries[next]; entry && entry[0] < before; entry = entries[++next]) {
            sum.net += entry[1].net;
            sum.pnl += entry[1].pnl;
        }
        return sum;
    };
    const opening = take(first);
    let balance = opening.net + opening.pnl;
    const points: PnlPoint[] = [];
    for (let start = bucketStart(first, unit); start <= today; start = nextStart(start, unit)) {
        const { net, pnl } = take(nextStart(start, unit));
        balance += net + pnl;
        points.push({
            start: dateOfNumber(start),
            balance: formatUsdc(balance),
            pnl: formatUsdc(pnl),
            net: formatUsdc(net),
        });
    }
    return points;
}

/** The three ranges from per-day totals keyed by local date, where every event has a key even when it sums to zero */
export function buildRanges(days: ReadonlyMap<string, DayTotals>, today: string): PnlSeries["ranges"] {
    const todayN = dayNumber(today);
    const folded = new Map<number, DayTotals>();
    for (const [date, totals] of days) {
        // An event dated after today counts in today's bar
        const n = Math.min(dayNumber(date), todayN);
        const sum = folded.get(n);
        folded.set(n, { net: (sum?.net ?? 0n) + totals.net, pnl: (sum?.pnl ?? 0n) + totals.pnl });
    }
    const entries: Entry[] = [...folded].sort((a, b) => a[0] - b[0]);
    const earliest = entries[0]?.[0] ?? todayN;
    const first = Math.min(earliest, todayN - 6);
    const unit = allUnit(first, todayN);
    return {
        "7D": { unit: "day", points: roll(entries, todayN - 6, todayN, "day") },
        "30D": { unit: "day", points: roll(entries, todayN - 29, todayN, "day") },
        All: { unit, points: roll(entries, first, todayN, unit) },
    };
}
