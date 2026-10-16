import type { Decimal128, ObjectId } from "mongodb";
import type { CoinWithdrawalState, TradeVerb } from "./types.ts";

/** What an account holds of one coin; `units` is a decimal in coin units, rounded down to the coin's decimals. */
export type HoldingDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    symbol: string;
    units: Decimal128;
    /** The coin's home network. */
    network: string;
    updatedAt: Date;
};

/** One fill against our inventory; a repeat of (accountId, requestId) is the same trade. */
export type TradeDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    requestId: string;
    verb: TradeVerb;
    symbol: string;
    toSymbol: string | null;
    paidSymbol: string;
    paidUnits: Decimal128;
    gotSymbol: string;
    gotUnits: Decimal128;
    /** Dollars at the fill price, as a decimal. */
    usd: Decimal128;
    /** The price the person got: the ask for a buy, the bid of the coin sold for a sell or swap. */
    priceUSD: string;
    /** The swap's second coin at its market price. */
    toPriceUSD: string | null;
    /** The dollars the spread came to: the trade at the market price less the trade at the fill price. Trades filled before the spread have none. */
    spreadUSD?: Decimal128;
    /** True once the hedger has netted this trade into a market order. */
    hedged: boolean;
    createdAt: Date;
};

/** One signed transaction for a nonce with the fees it pays, so a replacement can outbid it */
export type SendAttempt = { hash: string; maxFeePerGas: string; maxPriorityFeePerGas: string };

export type HedgeState = "planned" | "sending" | "sent" | "done" | "failed";

/** The market order that nets a batch of trades in one coin. */
export type HedgeDoc = {
    _id: ObjectId;
    symbol: string;
    side: "buy" | "sell";
    units: Decimal128;
    usd: Decimal128;
    tradeIds: ObjectId[];
    state: HedgeState;
    /** The latest attempt's hash, or the mined one once it is known */
    txHash: string | null;
    /** The nonce the sell was signed on, so a sell that never landed is signed again on it */
    nonce?: number | null;
    /** The transaction signed on the nonce, which a resend signs again paying more */
    tx?: { to: string; data: string; value: string } | null;
    /** Every transaction signed on the nonce, since any of them may be the one that mines */
    attempts?: SendAttempt[];
    tool: string | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
};

/** A held coin sent to the person's own wallet; `units` left the holding when it was created. */
export type CoinWithdrawalDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    requestId: string;
    symbol: string;
    units: Decimal128;
    network: string;
    to: string;
    state: CoinWithdrawalState;
    /** The latest attempt's hash, or the mined one once it is known */
    txHash: string | null;
    nonce: number | null;
    /** Every transaction signed on the nonce, since any of them may be the one that mines */
    attempts?: SendAttempt[];
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
};
