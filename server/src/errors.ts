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
    float_short: 409,
    trading_off: 503,
    internal: 500,
};

/** An error that's safe to show the client: its code and message go over the wire as they are. */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly status: number;

    constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "AppError";
        this.code = code;
        this.status = STATUS[code];
    }
}

/** What the client sees for any error; anything unexpected becomes a generic "internal". */
export function toApiError(error: unknown): ApiError {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    return { code: "internal", message: "Something went wrong on our side." };
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
