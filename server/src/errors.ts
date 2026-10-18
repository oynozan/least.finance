import { randomBytes } from "node:crypto";
import type { ApiError, ErrorCode } from "./protocol.ts";

const STATUS: Record<ErrorCode, number> = {
    bad_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    rate_limited: 429,
    wallet_not_connected: 409,
    tx_not_found: 404,
    tx_reverted: 422,
    no_deposit: 422,
    below_minimum: 422,
    unavailable: 503,
    insufficient_funds: 409,
    market_closed: 409,
    price_moved: 409,
    float_short: 409,
    position_busy: 409,
    trading_off: 503,
    no_route: 422,
    quote_changed: 409,
    internal: 500,
};

/** An error that's safe to show the client: its code and message go over the wire as they are. */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    /** The thrower already logged this refusal with its own numbers, so the socket layer doesn't log it again. */
    readonly logged: boolean;
    /** Why, for the log and never the client: the upstream's own words or what we found, e.g. "no_token". */
    readonly detail: string | undefined;

    constructor(code: ErrorCode, message: string, options?: { cause?: unknown; logged?: boolean; detail?: string }) {
        super(message, options);
        this.logged = options?.logged ?? false;
        this.detail = options?.detail;
        this.name = "AppError";
        this.code = code;
        this.status = STATUS[code];
    }
}

/** A short reference for one unexpected failure; the person is shown it and the log line carries it, so it can be found. */
export const newRef = () => randomBytes(3).toString("hex");

/** One short quoted line of what an upstream said, for the log field and the person's sentence. */
export const quoted = (text: string) => `"${text.replace(/\s+/g, " ").trim().replaceAll('"', "'").slice(0, 120)}"`;

/** `Polymarket refused: "invalid order size"`, for an upstream refusal we have no better sentence for. */
export const upstreamSaid = (service: string, text: string) => `${service} refused: ${quoted(text)}`;

export const wentWrong = (ref: string) => `Something went wrong on our side (ref ${ref}).`;

/** What the client sees for any error; anything unexpected becomes "internal", with `ref` when the caller logged it under one. */
export function toApiError(error: unknown, ref?: string): ApiError {
    if (error instanceof AppError) {
        // An internal error can say what it was doing ("We couldn't open your account"); the ref ends the sentence
        if (error.code === "internal" && ref) {
            return { code: error.code, message: `${error.message.replace(/[.\s]+$/, "")} (ref ${ref}).` };
        }
        return { code: error.code, message: error.message };
    }
    return { code: "internal", message: ref ? wentWrong(ref) : "Something went wrong on our side." };
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

/** A one-line, trimmed copy of an upstream's words, for a log field or a quoted sentence. */
export function brief(text: unknown, max = 160): string {
    const line = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The last six hex digits of an id (the counter part of an ObjectId, so two orders rarely share one): a reference the person can quote and the log carries. */
export const refOf = (id: string | { toHexString(): string }): string =>
    (typeof id === "string" ? id : id.toHexString()).slice(-6);

/** A wallet address or hash shortened for a sentence: 0x12ab…9f3c. */
export const shortOf = (value: string): string =>
    value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

/** The host of an RPC URL, never the URL itself, which can carry an API key. */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "unknown host";
    }
}
