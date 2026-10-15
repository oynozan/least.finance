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
    priceUSD: string;
    toPriceUSD: string | null;
    /** True once the hedger has netted this trade into a market order. */
    hedged: boolean;
    createdAt: Date;
};

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
    txHash: string | null;
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
    txHash: string | null;
    nonce: number | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
};
