import { formatUnits18 } from "./units.ts";

/** A scaled dollar amount as a person reads it: cents above a dollar, more places below. */
export function dollars(scaled: bigint): string {
    const n = Number(formatUnits18(scaled));
    if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (n >= 0.01) return `$${n.toFixed(4).replace(/0{1,2}$/, "")}`;
    return n === 0 ? "$0" : `$${n.toPrecision(3)}`;
}

/** Coin units without the 18-place tail: at most eight places. */
export function amountOf(scaled: bigint): string {
    const [whole = "0", fraction = ""] = formatUnits18(scaled).split(".");
    const places = fraction.slice(0, 8).replace(/0+$/, "");
    return places ? `${whole}.${places}` : whole;
}

/** How long ago, in the unit a person reads. */
export function ago(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

/** A client's raw field, short and quoted, for a sentence that says what it sent. */
export const echoed = (raw: unknown) => `'${String(raw ?? "").slice(0, 40)}'`;

/** What the person is told about their money or coins at the end of a refusal. */
export const KEPT = {
    buy: "Nothing was spent.",
    sell: "Nothing was sold.",
    swap: "Nothing was swapped.",
    send: "Nothing was sent.",
} as const;

export type Action = keyof typeof KEPT;

const UPSTREAM_LIMIT = 300;

/** An error's own words for a log or a stored detail: the library's summary and the node's details, with any URL (it can carry an API key) cut down to its host. */
export function upstreamSaid(error: unknown): string {
    const e = error as { shortMessage?: unknown; details?: unknown; message?: unknown } | null;
    const first = (text: unknown) =>
        String(text ?? "")
            .split("\n")[0]!
            .trim();
    const parts = [e?.shortMessage ?? first(e?.message ?? error), e?.details]
        .map((part) => first(part))
        .filter((part, index, all) => part !== "" && all.indexOf(part) === index);
    return hideUrls(parts.join(": ")).slice(0, UPSTREAM_LIMIT);
}

/** Replaces every URL in a text by its origin, since the path and query are where providers put API keys. */
export function hideUrls(text: string): string {
    return text.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
        try {
            return new URL(url).origin;
        } catch {
            return "[url]";
        }
    });
}

/** The words a person reads for one thing the network said, trimmed to one short quoted line. */
export const quoted = (text: string) => `"${text.replace(/\s+/g, " ").trim().replaceAll('"', "'").slice(0, 120)}"`;
