import type { ObjectId } from "mongodb";
import type { PredictionFailure } from "../db/mongo.ts";
import { quoted } from "../errors.ts";

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
export const quote = quoted;

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

type Known = {
    test: RegExp;
    level: "warn" | "error";
    say: (side: Side, said: string) => string;
    /** The log line when it says more than that Polymarket refused, such as how to fix it. */
    log?: string;
};

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
        say: (side, said) => {
            const minimum = /minimum[^\d]{0,20}(\d+(?:\.\d+)?)/i.exec(said)?.[1];
            return `That's under Polymarket's minimum ${minimum ? `of ${minimum} shares` : "order"} for this market. ${kept(side)}`;
        },
    },
    {
        test: /tick size|tick_size|invalid price|invalid_order_min_tick/i,
        level: "error",
        say: (side) =>
            `Polymarket refused the price we sent for this market's price steps. That's on our side. ${kept(side)}`,
    },
    {
        // The CLOB says both "balance / allowance" every time; this part names which one ran out
        test: /the allowance is not enough/i,
        level: "error",
        say: (side) =>
            `Our Polymarket account isn't set up to trade this kind of market yet. That's on our side, not yours. ${kept(side)}`,
        log: "Polymarket refused a prediction: the pool wallet hasn't approved the spender Polymarket named. Run scripts/polymarket-setup.ts",
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
        msg: known?.log ?? "Polymarket refused a prediction",
        level: known?.level ?? "error",
        detail: refusal.message,
        message:
            known?.say(order.side, refusal.message) ??
            `Polymarket refused the order: ${quote(refusal.message)}. ${kept(order.side)}`,
        fields: {
            ...fields,
            polymarketCode: refusal.code ?? null,
            polymarketMessage: refusal.message,
            ...(refusal.status !== undefined && { polymarketStatus: refusal.status }),
        },
    };
}

const UPSTREAM = /timed out after|TimeoutError|TransportError|ConnectionLostError|RequestRejectedError|RateLimitError/;

/** An error that means Polymarket (or the network to it) didn't answer, as opposed to a bug of ours. */
export const isUpstreamFailure = (error: unknown) => UPSTREAM.test(`${errorName(error)} ${errorText(error)}`);

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

/** Polymarket's status for an order it cancelled or marked invalid, in plain words and with the reason it is stored under. */
export function cancelled(order: Order, status: string | undefined, fields?: Record<string, unknown>): Why {
    const said = status ?? "CANCELED";
    const base = { fields: { ...fields, polymarketStatus: said } };
    if (said === "CANCELED_MARKET_RESOLVED")
        return {
            ...base,
            reason: "market_closed",
            msg: "Polymarket cancelled a prediction because its market resolved",
            level: "warn",
            detail: `Polymarket cancelled the order (${said})`,
            message: `The market resolved before the order filled. ${kept(order.side)}`,
        };
    if (said === "INVALID")
        return {
            ...base,
            reason: "rejected",
            msg: "Polymarket marked a prediction's order invalid",
            level: "error",
            detail: `Polymarket marked the order invalid (${said})`,
            message: `Polymarket marked the order invalid. That's on our side. ${kept(order.side)}`,
        };
    if (said === "CANCELED_BY_USER")
        return {
            ...base,
            reason: "unavailable",
            msg: "Polymarket shows a prediction's order cancelled by the account, which we never do",
            level: "error",
            detail: `Polymarket shows the order cancelled by the account (${said})`,
            message: `Polymarket cancelled the order. That's on our side (ref ${orderRef(order._id)}). ${kept(order.side)}`,
        };
    return {
        ...priceMoved(
            order,
            "Polymarket cancelled a prediction's order without filling it",
            `Polymarket cancelled the order unfilled (${said})`,
            base.fields,
        ),
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
