import type { ObjectId } from "mongodb";
import type { PredictionFailure } from "../db/mongo.ts";

export const NOTHING_SPENT = "Nothing was spent.";
const POSITION_BACK = "Your position is back.";

/** The sentence that ends a refusal: what happened to the person's money or position. */
export const kept = (side: "buy" | "sell") => (side === "sell" ? POSITION_BACK : NOTHING_SPENT);

/** The short reference a person can quote; it is the tail of the order id, so grepping the log for it finds the order. */
export const orderRef = (id: ObjectId) => id.toHexString().slice(-6);

/** Why an order failed: what is stored on it, what the person is told, and what the log says. */
export type Why = {
    reason: PredictionFailure;
    /** The log message, naming what happened. */
    msg: string;
    /** `warn` for an expected refusal, `error` for a bug or something we don't recognise. */
    level: "warn" | "error";
    /** Stored on the order: the upstream's own words, or our explanation. */
    detail: string;
    /** Shown to the person, also after a reload. */
    message: string;
    /** More for the log line: prices, the upstream's code and status. */
    fields?: Record<string, unknown>;
    err?: unknown;
};

type Side = "buy" | "sell";
type Order = { _id: ObjectId; side: Side };

/** One short quoted line of what an upstream said. */
const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim().replaceAll('"', "'").slice(0, 120)}"`;

const priceMovedText = (side: Side) =>
    side === "sell"
        ? `The price moved, so the sale didn't go through. ${POSITION_BACK}`
        : `The price moved, so your prediction didn't go through. ${NOTHING_SPENT}`;

/** The price moved past the limit, found before the order was sent or reported by the exchange. */
export const priceMoved = (order: Order, msg: string, detail: string, fields?: Record<string, unknown>): Why => ({
    reason: "price_moved",
    msg,
    level: "warn",
    detail,
    message: priceMovedText(order.side),
    fields,
});

type Known = { test: RegExp; level: "warn" | "error"; say: (side: Side) => string };

/** The exchange's refusals we know, by the words of the CLOB's messages and codes; the first match wins. */
const KNOWN: Known[] = [
    {
        test: /fully filled or killed|filled or killed|no orders found to match|no matching orders|fok_not_filled|fak_not_filled|^unmatched\b/i,
        level: "warn",
        say: priceMovedText,
    },
    {
        test: /not yet ready to process new orders|market_not_ready|market is closed|market (has )?closed|not accepting orders/i,
        level: "warn",
        say: (side) => `This market isn't taking orders right now. ${kept(side)}`,
    },
    {
        test: /restarting|post.only/i,
        level: "warn",
        say: (side) => `Polymarket is restarting its order system. Try again in a minute. ${kept(side)}`,
    },
    {
        test: /rate limit|too many requests|throttl/i,
        level: "warn",
        say: (side) => `Polymarket is limiting how fast we can place orders. Try again in a moment. ${kept(side)}`,
    },
    {
        test: /lower than the minimum|below the minimum|minimum (order )?size|min(imum)? size|invalid_order_min_size/i,
        level: "warn",
        say: (side) => `That's under Polymarket's minimum order for this market. ${kept(side)}`,
    },
    {
        test: /tick size|tick_size|invalid price|invalid_order_min_tick/i,
        level: "error",
        say: (side) =>
            `Polymarket refused the price we sent for this market's price steps. That's on our side. ${kept(side)}`,
    },
    {
        test: /not enough balance|allowance|insufficient_balance/i,
        level: "error",
        say: (side) =>
            `Our Polymarket balance can't cover this order right now. That's on our side, not yours. ${kept(side)}`,
    },
    {
        test: /region|geoblock|geo.block|restricted|not available in your|blocked/i,
        level: "error",
        say: (side) =>
            `Polymarket doesn't accept orders from our servers' region right now. That's on our side. ${kept(side)}`,
    },
    {
        test: /signature|api key|api_key|unauthorized|invalid (nonce|expiration)|credentials/i,
        level: "error",
        say: (side) => `Polymarket didn't accept our credentials. That's on our side. ${kept(side)}`,
    },
    {
        test: /duplicate/i,
        level: "error",
        say: (side) => `Polymarket saw this order twice. That's on our side. ${kept(side)}`,
    },
];

/** Polymarket turned an order down: a known refusal in plain words, an unknown one in Polymarket's own. */
export function polymarketRefused(
    order: Order,
    refusal: { reason: PredictionFailure; message: string; code?: string; status?: number },
    fields: Record<string, unknown> = {},
): Why {
    const known = KNOWN.find(({ test }) => test.test(`${refusal.code ?? ""} ${refusal.message}`));
    return {
        reason: refusal.reason,
        msg: "Polymarket refused a prediction",
        level: known?.level ?? "error",
        detail: refusal.message,
        message:
            known?.say(order.side) ?? `Polymarket refused the order: ${quote(refusal.message)}. ${kept(order.side)}`,
        fields: {
            ...fields,
            polymarketCode: refusal.code ?? null,
            polymarketMessage: refusal.message,
            ...(refusal.status !== undefined && { polymarketStatus: refusal.status }),
        },
    };
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Preparing an order threw: a slow or unreachable Polymarket is said so, anything else is ours and carries a reference. */
export function couldntPrepare(order: Order, error: unknown, fields?: Record<string, unknown>): Why {
    const text = errorText(error);
    const ref = orderRef(order._id);
    if (error instanceof Error && error.message === "The trader isn't ready")
        return {
            reason: "unavailable",
            msg: "Couldn't prepare a prediction: the Polymarket connection isn't ready",
            level: "warn",
            detail: text,
            message: `Predictions aren't connected to Polymarket right now. Try again shortly. ${kept(order.side)}`,
            fields,
            err: error,
        };
    if (/timed out after|TimeoutError|TransportError|ConnectionLostError/.test(`${errorName(error)} ${text}`))
        return {
            reason: "unavailable",
            msg: `Couldn't prepare a prediction: Polymarket didn't answer (${text})`,
            level: "warn",
            detail: text,
            message: `Polymarket didn't answer in time. ${kept(order.side)}`,
            fields,
            err: error,
        };
    if (errorName(error) === "RequestRejectedError")
        return {
            reason: "unavailable",
            msg: `Couldn't prepare a prediction: Polymarket refused to give the market (${text})`,
            level: "warn",
            detail: text,
            message: `Polymarket couldn't give us this market's prices: ${quote(text)}. ${kept(order.side)}`,
            fields,
            err: error,
        };
    return {
        reason: "unavailable",
        msg: `Couldn't prepare a prediction: ${text}`,
        level: "error",
        detail: text,
        message: `Something went wrong on our side (ref ${ref}). ${kept(order.side)}`,
        fields: { ...fields, ref },
        err: error,
    };
}

/** An unexpected throw while sending; the order never reached the exchange. */
export function couldntSend(order: Order, error: unknown): Why {
    const ref = orderRef(order._id);
    return {
        reason: "unavailable",
        msg: `Couldn't send a prediction: ${errorText(error)}`,
        level: "error",
        detail: errorText(error),
        message: `Something went wrong on our side (ref ${ref}). ${kept(order.side)}`,
        fields: { ref },
        err: error,
    };
}

/** An order that never left us or that Polymarket never confirmed, refunded by a sweep. */
export function unconfirmed(order: Order, msg: string, detail: string, fields?: Record<string, unknown>): Why {
    return {
        reason: "unavailable",
        msg,
        level: "warn",
        detail,
        message: `Polymarket didn't confirm the order, so it was cancelled. ${kept(order.side)}`,
        fields,
    };
}

/** What a failure with no reason given says, so an old call still leaves a trace. */
export function unexplained(order: Order, reason: PredictionFailure): Why {
    return {
        reason,
        msg: "A prediction failed without a recorded reason",
        level: "error",
        detail: "no reason was recorded",
        message: `Something went wrong on our side (ref ${orderRef(order._id)}). ${kept(order.side)}`,
        fields: { ref: orderRef(order._id) },
    };
}
