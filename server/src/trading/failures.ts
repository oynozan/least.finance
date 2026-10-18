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

/** Why a coin send failed: what is stored on the withdrawal, and what the person is told. */
export type SendFailure = {
    /** A short code that stays the same for the same cause. */
    reason: string;
    /** Our explanation or the network's own words, kept on the document. */
    detail: string;
    /** Shown to the person, also after a reload. */
    message: string;
    /** `error` when it is ours to fix (a coin we can't send, an empty wallet), `warn` when the network said no. */
    level: "warn" | "error";
};

/** The sentence that ends a failed send. */
export const sendBack = (symbol: string) => `Your ${symbol} is back in your holdings.`;

const json = (value: unknown) => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

/** A Solana transaction error (`InstructionError`, `InsufficientFundsForRent`) as a short text. */
export const solanaErr = (err: unknown) => json(err).slice(0, 200);

/** A send the network or cluster refused: the known refusals get a plain sentence, any other keeps the network's own words quoted. */
export function sendRefusal(error: unknown, ctx: { symbol: string; network: string }): SendFailure {
    const { symbol, network } = ctx;
    const refusal = error as { code?: unknown; data?: { err?: unknown } } | null;
    const solana = error instanceof Error && error.name === "SolanaRefusal";
    const raw = upstreamSaid(error);
    const err = solana ? refusal?.data?.err : undefined;
    const extra = [
        typeof refusal?.code === "number" ? `code ${refusal.code}` : null,
        err !== undefined && err !== null ? solanaErr(err) : null,
    ].filter((part) => part !== null);
    const detail = extra.length > 0 ? `${raw} (${extra.join(", ")})` : raw;
    const back = sendBack(symbol);
    const make = (reason: string, message: string, level: SendFailure["level"] = "warn"): SendFailure => ({
        reason,
        detail,
        message: `${message} ${back}`,
        level,
    });
    if (/InsufficientFundsForRent/i.test(detail))
        return make(
            "rent",
            `The send would leave a Solana account below its minimum balance, so ${network} refused it.`,
        );
    if (/BlockhashNotFound/i.test(detail))
        return make("expired", `${network} didn't recognise the send's recent block, so it was refused. Try again.`);
    if (/gas|fee/i.test(raw) && /insufficient funds/i.test(raw))
        return make("out_of_gas", `Our sending wallet is out of gas on ${network}, so the send was refused.`, "error");
    if (/transfer amount exceeds balance|exceeds (the )?balance/i.test(raw))
        return make(
            "inventory_short",
            `Our sending wallet doesn't hold enough ${symbol} on ${network} right now.`,
            "error",
        );
    if (/insufficient (funds|lamports)/i.test(raw))
        return make(
            "inventory_short",
            `Our sending wallet doesn't hold enough ${symbol} on ${network} right now.`,
            "error",
        );
    if (/underpriced|gas too low|intrinsic gas/i.test(raw))
        return make("fee_too_low", `${network} refused the send's fee: ${quoted(raw)}.`);
    if (/invalid address|invalid sender/i.test(raw))
        return make("bad_address", `${network} refused the address: ${quoted(raw)}.`);
    if (/execution reverted/i.test(raw)) return make("reverted", `${network} rejected the transfer: ${quoted(raw)}.`);
    return make("network_refused", `The ${network} network refused the send: ${quoted(raw)}.`);
}

/** Repeats of one failure that a worker meets every pass: the first is logged, then one line per interval that says how many were left out. */
export class RepeatGate {
    readonly #seen = new Map<string, { message: string; at: number; skipped: number }>();
    readonly #everyMs: number;
    readonly #now: () => number;

    constructor(everyMs: number, now: () => number = Date.now) {
        this.#everyMs = everyMs;
        this.#now = now;
    }

    /** Null while this failure repeats inside the interval; else how many times it was left out since the last line. */
    note(key: string, message: string): { skipped: number } | null {
        const at = this.#now();
        const seen = this.#seen.get(key);
        if (seen && seen.message === message && at - seen.at < this.#everyMs) {
            seen.skipped += 1;
            return null;
        }
        this.#seen.set(key, { message, at, skipped: 0 });
        return { skipped: seen?.message === message ? seen.skipped : 0 };
    }

    /** The failure is over, so the next one is a first. */
    clear(key: string) {
        this.#seen.delete(key);
    }
}

/** The words a person reads for one thing the network said, trimmed to one short quoted line. */
export const quoted = (text: string) => `"${text.replace(/\s+/g, " ").trim().replaceAll('"', "'").slice(0, 120)}"`;
