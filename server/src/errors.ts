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

    constructor(code: ErrorCode, message: string, options?: { cause?: unknown; logged?: boolean }) {
        super(message, options);
        this.logged = options?.logged ?? false;
        this.name = "AppError";
        this.code = code;
        this.status = STATUS[code];
    }
}

/** A short reference for one unexpected failure; the person is shown it and the log line carries it, so it can be found. */
export const newRef = () => randomBytes(3).toString("hex");

export const wentWrong = (ref: string) => `Something went wrong on our side (ref ${ref}).`;

/** What the client sees for any error; anything unexpected becomes "internal", with `ref` when the caller logged it under one. */
export function toApiError(error: unknown, ref?: string): ApiError {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    return { code: "internal", message: ref ? wentWrong(ref) : "Something went wrong on our side." };
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
