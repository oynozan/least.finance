import type { ObjectId } from "mongodb";
import { NOTHING_SPENT, orderRef, quote } from "../predictions/failures.ts";
import { HyperliquidRefused, TimedOut } from "./client.ts";
import { PERP_MIN_COLLATERAL_MESSAGE, PERP_MIN_POSITION_MESSAGE } from "./fee.ts";

export const STILL_OPEN = "Your position is still open.";

export const PERP_MESSAGES = {
    off: "Long and short are switched off for now.",
    restarting: "The server is restarting. Try again in a minute.",
    priceMoved: `The price moved, so your position didn't open. ${NOTHING_SPENT}`,
    minCollateral: PERP_MIN_COLLATERAL_MESSAGE,
    minPosition: PERP_MIN_POSITION_MESSAGE,
    thin: "This market is too thin for a position this size right now. Try a smaller amount.",
    closeRestarting: `The server is restarting. ${STILL_OPEN} Try again in a minute.`,
    closeNoFill: `Nobody on the book took your close at an acceptable price. ${STILL_OPEN} Try again in a moment.`,
    closeNeverSent: `The close never reached Hyperliquid. ${STILL_OPEN} Try again.`,
    tooSmall: `This position is under Hyperliquid's $10 minimum to close, so it can't be closed on its own. It stays open.`,
    restartedOpen: `The server restarted before your position opened. ${NOTHING_SPENT}`,
    unconfirmedOpen: `Hyperliquid never confirmed the order, so it was cancelled. ${NOTHING_SPENT}`,
};

/** Why an open or close failed: what the order keeps, what the person is told, and what the log says. */
export type PerpWhy = {
    /** A short name for the cause, kept on the order. */
    code: string;
    /** Shown to the person, also after a reload. */
    message: string;
    /** Stored on the order: the upstream's own words, or our explanation. */
    detail: string;
    /** The log message, naming what happened. */
    msg: string;
    /** `warn` for an expected refusal, `error` for a bug or something we don't recognise. */
    level: "warn" | "error";
    /** More for the log line: the upstream's code and message, the numbers. */
    fields?: Record<string, unknown>;
    err?: unknown;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A wait as a person says it: "1 second", "15 seconds". */
export const seconds = (ms: number) => {
    const n = Math.max(1, Math.round(ms / 1000));
    return `${n} second${n === 1 ? "" : "s"}`;
};

const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;

type Row = { test: RegExp; code: string; level: "warn" | "error"; say: (asset: string) => string };

/** Hyperliquid's refusals of an open that we know, by the words of its messages and the names of its order statuses; the first match wins. */
const OPEN: Row[] = [
    {
        test: /immediately match|iocCancel|marketOrderNoLiquidity/i,
        code: "price_moved",
        level: "warn",
        say: () => PERP_MESSAGES.priceMoved,
    },
    {
        test: /minimum value|minTradeNtl/i,
        code: "below_minimum",
        level: "error",
        say: () =>
            `Hyperliquid's minimum order is $10 and this one came in under it. Raise the collateral or the leverage. ${NOTHING_SPENT}`,
    },
    {
        test: /margin/i,
        code: "insufficient_margin",
        level: "warn",
        say: () => `Hyperliquid said the collateral doesn't cover this position at this leverage. ${NOTHING_SPENT}`,
    },
    {
        test: /open ?interest/i,
        code: "open_interest_cap",
        level: "warn",
        say: (asset) => `Hyperliquid has hit its limit for new ${asset} positions. Try again later. ${NOTHING_SPENT}`,
    },
    {
        test: /perpMaxPosition/i,
        code: "max_position",
        level: "warn",
        say: (asset) =>
            `That is above Hyperliquid's maximum ${asset} position at this leverage. Try a smaller amount. ${NOTHING_SPENT}`,
    },
    {
        test: /oracle/i,
        code: "oracle",
        level: "warn",
        say: () =>
            `Hyperliquid refused the price because it was too far from its reference price. Try again in a moment. ${NOTHING_SPENT}`,
    },
    {
        test: /tick/i,
        code: "tick",
        level: "error",
        say: () => `Hyperliquid refused the price step we sent. That's on our side. ${NOTHING_SPENT}`,
    },
];

/** Hyperliquid's refusals of a close that we know. */
const CLOSE: Row[] = [
    {
        test: /immediately match|iocCancel|marketOrderNoLiquidity|^no fill$/i,
        code: "no_fill",
        level: "warn",
        say: () => PERP_MESSAGES.closeNoFill,
    },
    {
        test: /minimum value|minTradeNtl|too small/i,
        code: "too_small",
        level: "error",
        say: () => PERP_MESSAGES.tooSmall,
    },
    {
        test: /reduce.?only/i,
        code: "reduce_only",
        level: "warn",
        say: () => `Hyperliquid refused the close because it would not reduce the position. ${STILL_OPEN}`,
    },
];

/** Hyperliquid turned an open down: a known refusal in plain words, an unknown one in its own. */
export function openRefused(
    raw: string,
    asset: string,
    fields: Record<string, unknown> = {},
    msg = "Hyperliquid refused a perp open",
): PerpWhy {
    const known = OPEN.find(({ test }) => test.test(raw));
    return {
        code: known?.code ?? "rejected",
        message: known?.say(asset) ?? `Hyperliquid refused the order: ${quote(raw)}. ${NOTHING_SPENT}`,
        detail: raw,
        msg,
        level: known?.level ?? "error",
        fields: { ...fields, upstreamMessage: raw },
    };
}

/** Hyperliquid turned a close down, or it didn't fill: the position stays open. */
export function closeRefused(raw: string, fields: Record<string, unknown> = {}): PerpWhy {
    const known = CLOSE.find(({ test }) => test.test(raw));
    return {
        code: known?.code ?? "rejected",
        message: known?.say("") ?? `Hyperliquid refused the close: ${quote(raw)}. ${STILL_OPEN}`,
        detail: raw,
        msg: raw === "no fill" ? "A perp close found no fill" : "Hyperliquid refused a perp close",
        level: known?.level ?? "error",
        fields: { ...fields, upstreamMessage: raw },
    };
}

/** A close that was recorded but never went out. */
export const closeNeverSent = (fields: Record<string, unknown> = {}): PerpWhy => ({
    code: "never_sent",
    message: PERP_MESSAGES.closeNeverSent,
    detail: "The close was recorded but never sent to Hyperliquid",
    msg: "A perp close never reached Hyperliquid",
    level: "warn",
    fields,
});

/** A step of an open that Hyperliquid or the state of the order refused, with what it said. */
export class OpenStepError extends Error {
    readonly step: "transfer" | "top_up" | "short" | "moved";
    readonly upstream: string | undefined;
    readonly raw: string | undefined;
    readonly shortE6: bigint | undefined;
    constructor(
        step: OpenStepError["step"],
        message: string,
        extra: { upstream?: string; raw?: string; shortE6?: bigint } = {},
    ) {
        super(message);
        this.name = "OpenStepError";
        this.step = step;
        this.upstream = extra.upstream;
        this.raw = extra.raw;
        this.shortE6 = extra.shortE6;
    }
}

/** Why an open failed before it posted. A refusal says what Hyperliquid said, a slow Hyperliquid says how long, anything else is ours and carries a reference. */
export function openFailed(order: { _id: ObjectId; asset: string }, error: unknown): PerpWhy {
    const text = errorText(error);
    const ref = orderRef(order._id);
    if (error instanceof OpenStepError && (error.step === "transfer" || error.step === "top_up")) {
        const raw = error.upstream ?? text;
        const ours = /insufficient balance/i.test(raw);
        return {
            code: "transfer_refused",
            message: ours
                ? `Our Hyperliquid balance can't cover this position right now. That's on our side, not yours. ${NOTHING_SPENT}`
                : `Hyperliquid refused to fund your position: ${quote(raw)}. ${NOTHING_SPENT}`,
            detail: raw,
            msg: `Hyperliquid refused to fund a perp open (${error.step === "top_up" ? "top-up" : "transfer"})`,
            level: "error",
            fields: { upstreamMessage: raw, upstreamRaw: error.raw },
            err: error,
        };
    }
    if (error instanceof OpenStepError && error.step === "short") {
        return {
            code: "funding_short",
            message: `Your funds didn't all reach your trading account on Hyperliquid. That's on our side (ref ${ref}). ${NOTHING_SPENT}`,
            detail: text,
            msg: "A perp open's funding arrived short on Hyperliquid",
            level: "error",
            fields: { ref, shortUSD: Number(error.shortE6 ?? 0n) / 1e6 },
            err: error,
        };
    }
    if (error instanceof OpenStepError) {
        return {
            code: "moved_on",
            message: `Something went wrong on our side (ref ${ref}). ${NOTHING_SPENT}`,
            detail: text,
            msg: "A perp open was settled by something else while it was being sent",
            level: "warn",
            fields: { ref },
            err: error,
        };
    }
    if (error instanceof HyperliquidRefused) {
        return {
            code: "leverage_refused",
            message: `Hyperliquid refused the leverage: ${quote(error.message)}. ${NOTHING_SPENT}`,
            detail: error.message,
            msg: "Hyperliquid refused a perp open's leverage",
            level: "error",
            fields: { upstreamMessage: error.message, upstreamRaw: error.raw },
            err: error,
        };
    }
    if (error instanceof TimedOut) {
        return {
            code: "timeout",
            message: `Hyperliquid didn't answer in ${seconds(error.ms)}. ${NOTHING_SPENT}`,
            detail: text,
            msg: `Hyperliquid didn't answer a perp open in ${seconds(error.ms)}`,
            level: "warn",
            fields: { timeoutMs: error.ms },
            err: error,
        };
    }
    if (RATE_LIMITED.test(text)) {
        return {
            code: "rate_limited",
            message: `Hyperliquid is limiting how fast we can send orders. Try again in a moment. ${NOTHING_SPENT}`,
            detail: text,
            msg: "Hyperliquid rate limited a perp open",
            level: "warn",
            err: error,
        };
    }
    const gone = /Hyperliquid has no (\S+) market|(\S+) is no longer offered/.exec(text);
    if (gone) {
        const asset = gone[1] ?? gone[2] ?? order.asset;
        return {
            code: "market_gone",
            message: `${asset} is no longer offered on Hyperliquid. ${NOTHING_SPENT}`,
            detail: text,
            msg: "A perp market was gone when its open was sent",
            level: "error",
            err: error,
        };
    }
    return {
        code: "internal",
        message: `Something went wrong on our side (ref ${ref}). ${NOTHING_SPENT}`,
        detail: text,
        msg: "A perp open failed unexpectedly",
        level: "error",
        fields: { ref },
        err: error,
    };
}

/** Reading a book failed: say whether Hyperliquid was slow, limiting us, or unreachable. */
export function bookUnreadable(error: unknown): string {
    const text = errorText(error);
    if (error instanceof TimedOut)
        return `Hyperliquid didn't answer in ${seconds(error.ms)}, so no position was opened. ${NOTHING_SPENT}`;
    if (RATE_LIMITED.test(text))
        return `Hyperliquid is limiting how fast we can ask. Try again in a moment. ${NOTHING_SPENT}`;
    return `Couldn't reach Hyperliquid (${text.replace(/\s+/g, " ").trim().slice(0, 80)}). ${NOTHING_SPENT}`;
}
