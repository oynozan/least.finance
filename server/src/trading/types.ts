/** The account-trading contract shared by the server and the app: Buy, Sell and Swap from the account balance, and sending held coins out. This file has no runtime imports. */

import type { AccountView } from "../protocol.ts";

/** A coin is held on its catalog `home` network; `symbol` is the catalog's symbol, such as "BNB". */
export type HoldingView = {
    symbol: string;
    /** Decimal string in coin units. */
    units: string;
    /** The network we hold it on. */
    network: string;
};

export type TradeVerb = "buy" | "sell" | "swap";

/**
 * buy: spend `amountUSD` of the balance on `symbol`.
 * sell: sell `units` of `symbol` for USDC to the balance.
 * swap: turn `units` of `symbol` into `toSymbol`.
 * `quotedPriceUSD` is the price of `symbol` the app showed; for a swap, `quotedToPriceUSD` is `toSymbol`'s.
 */
export type TradeOrderRequest = {
    requestId: string;
    verb: TradeVerb;
    symbol: string;
    toSymbol?: string;
    amountUSD?: string;
    units?: string;
    quotedPriceUSD: string;
    quotedToPriceUSD?: string;
};

export type TradeView = {
    id: string;
    requestId: string;
    verb: TradeVerb;
    /** What left: "USDC" for a buy. */
    paidSymbol: string;
    paidUnits: string;
    /** What arrived: "USDC" for a sell. */
    gotSymbol: string;
    gotUnits: string;
    /** The dollar value of the trade at the fill price. */
    usd: string;
    /** The PnL a sell or swap realized, in dollars; only on activity rows, and never on a buy. */
    realized?: string;
    at: string;
};

/** The answer to `trade:order`: the fill, the new balance and every holding after it. */
export type TradeResult = { trade: TradeView; balance: string; holdings: HoldingView[] };

export type CoinWithdrawalState = "sending" | "sent" | "failed";

export type CoinWithdrawRequest = { requestId: string; symbol: string; units: string; to: string };

export type CoinWithdrawalView = {
    id: string;
    requestId: string;
    symbol: string;
    units: string;
    network: string;
    to: string;
    state: CoinWithdrawalState;
    txHash: string | null;
    reason: string | null;
    at: string;
};

/** Socket events, merged into the protocol's event maps. */
export type TradingClientEvents = {
    "trade:order": (payload: TradeOrderRequest, ack: (result: TradingAck<TradeResult>) => void) => void;
    "holding:withdraw": (
        payload: CoinWithdrawRequest,
        ack: (result: TradingAck<{ withdrawal: CoinWithdrawalView; holdings: HoldingView[] }>) => void,
    ) => void;
};

export type TradingServerEvents = {
    "holdings:update": (payload: { holdings: HoldingView[] }) => void;
    /** The fill with the account it left, so a socket that didn't place it shows the new USDC balance too */
    "trade:filled": (payload: TradeView & { account: AccountView }) => void;
    "holding:withdrawal": (payload: CoinWithdrawalView) => void;
};

export type TradingErrorCode =
    | "unauthenticated"
    | "bad_request"
    | "unknown_coin"
    | "insufficient_balance"
    | "insufficient_holdings"
    | "price_moved"
    | "below_minimum"
    | "rate_limited"
    | "unavailable";

export type TradingAck<T> = ({ ok: true } & T) | { ok: false; code: TradingErrorCode; message: string };
