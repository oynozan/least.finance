import { formatUsd } from "@/lib/trade/format";
import type { PnlUnit } from "@/server/src/protocol";

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long" });

/** Local midnight on a bucket's `YYYY-MM-DD` start. */
export function parseStart(start: string): Date {
    const [year = 0, month = 1, day = 1] = start.split("-").map(Number);
    return new Date(year, month - 1, day);
}

/** A moment's local calendar date as YYYY-MM-DD, the form a bucket's start takes. */
export function localDate(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The Balance card's heading for a bucket: "Balance on Mar 3", "Balance, week of Mar 3", "Balance in March". */
export function headingFor(unit: PnlUnit, start: string): string {
    const date = parseStart(start);
    if (unit === "day") return `Balance on ${dayFormat.format(date)}`;
    if (unit === "week") return `Balance, week of ${dayFormat.format(date)}`;
    return `Balance in ${monthFormat.format(date)}`;
}

/** What a bucket is called in a sentence. */
export function nounFor(unit: PnlUnit): string {
    return `that ${unit}`;
}

/** The hover line under the PnL: "PnL that day", with the money moved in or out when there was any. */
export function hoverLine(unit: PnlUnit, net: number): string {
    const line = `PnL ${nounFor(unit)}`;
    if (Math.round(Math.abs(net) * 100) === 0) return line;
    return `${line}, and ${formatUsd(Math.abs(net))} ${net > 0 ? "deposited" : "withdrawn"}`;
}

/** The slider's spoken value for a bucket: "Mar 3: $500.00", "Week of Mar 3: $500.00", "March: $500.00". */
export function valueText(unit: PnlUnit, start: string, balance: number): string {
    const date = parseStart(start);
    const name =
        unit === "day"
            ? dayFormat.format(date)
            : unit === "week"
              ? `Week of ${dayFormat.format(date)}`
              : monthFormat.format(date);
    return `${name}: ${formatUsd(balance)}`;
}
