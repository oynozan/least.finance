/**
 * The wire contract between the server and the web client, over both
 * HTTP and socket.io. The client imports this file as types only, so it
 * must stay free of imports and runtime code.
 */

export type Hex = `0x${string}`;

/**
 * An exact USDC amount as a decimal string, such as "12.5". Arc's native
 * USDC has 18 decimals, and amounts keep all of them.
 */
export type UsdcAmount = string;

/** A person's account on the server. */
export type AccountView = {
    /** The account's own address on Arc: USDC sent here is credited to it. */
    depositAddress: Hex;
    balance: UsdcAmount;
    /** Goes up with every balance change: an update with a lower version than one already shown is stale. */
    version: number;
};

export type DepositView = {
    id: string;
    txHash: Hex;
    logIndex: number;
    from: Hex;
    amount: UsdcAmount;
    blockNumber: number;
    /** ISO 8601. */
    creditedAt: string;
    /** Set when a bridged order delivered it: what the person sent. */
    origin?: DepositOrigin;
};

/** The coin a bridged deposit came from. */
export type DepositOrigin = { coin: string; amount: string; txHash: Hex };

export type OrderState = "created" | "sent" | "in_block" | "bridging" | "delivered" | "refunded" | "failed" | "expired";

/** What a coin would pay out in USDC on Arc, without opening an order. */
export type DepositQuoteView = {
    coin: string;
    amount: string;
    usdcOut: UsdcAmount;
    etaSeconds: number;
    provider: string;
};

/** One transaction the person's wallet signs on the coin's chain. */
export type SourceTxView = { chainId: number; to: Hex; data: Hex; value: Hex };

export type DepositOrderView = {
    id: string;
    /** The catalog key, like "ethereum:ETH". */
    coin: string;
    /** In the coin's own units, as a decimal. */
    amount: string;
    /** The sending wallet, which a failed bridge refunds. */
    wallet: string;
    usdcOut: UsdcAmount;
    etaSeconds: number;
    state: OrderState;
    sourceTxHashes: Hex[];
    /** The credited deposit once delivered. */
    depositId: string | null;
    /** ISO 8601. */
    createdAt: string;
    updatedAt: string;
};

/** Newest first. `next` is the cursor for older deposits, null on the last page. */
export type DepositPage = { items: DepositView[]; next: string | null };

export type DepositRules = {
    chainId: number;
    /** Transfers below this aren't credited. */
    minDeposit: UsdcAmount;
};

/** One coin in a wallet on one chain, as the deposit form lists it. */
export type CoinBalance = {
    /** The catalog key, like "ethereum:ETH". */
    coin: string;
    chain: "ethereum" | "bnb" | "arc" | "solana";
    /** Null for Solana. */
    chainId: number | null;
    chainName: string;
    symbol: string;
    decimals: number;
    /** The address it was read for: EVM checksummed, Solana as given. */
    wallet: string;
    /** In the coin's own units, as a decimal; null when this read failed or never happened. */
    amount: string | null;
    /** `amount` less what's kept back for gas, floored at 0; null like `amount`. */
    spendable: string | null;
    /** Null when the price or the amount is unknown. */
    usd: number | null;
};

/** Every coin in every wallet linked to the person, as of `readAt`. */
export type BalancesView = {
    /** ISO 8601: when the last full read started its 30 s window. */
    readAt: string;
    rows: CoinBalance[];
};

/** What opening the account hands back: everything the sidebar shows. */
export type WalletSession = {
    account: AccountView;
    deposits: DepositPage;
    rules: DepositRules;
    /** Open bridge orders, newest first. */
    orders: DepositOrderView[];
};

/** The outcome of a deposit transaction the client reported. */
export type DepositReceipt = {
    txHash: Hex;
    /** What the transaction credited; several when a contract forwarded value to the account more than once. */
    deposits: DepositView[];
    account: AccountView;
};

export type ErrorCode =
    | "bad_request"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "rate_limited"
    | "wallet_not_connected"
    /** The transaction wasn't found on Arc in time; it may have been dropped. */
    | "tx_not_found"
    | "tx_reverted"
    /** The transaction sent nothing to this account's deposit address. */
    | "no_deposit"
    | "below_minimum"
    | "unavailable"
    | "insufficient_funds"
    | "market_closed"
    /** The book moved past the price limit before the order could fill. */
    | "price_moved"
    /** The pool can't cover an order this size right now. */
    | "float_short"
    | "trading_off"
    | "internal";

export type ApiError = { code: ErrorCode; message: string };

/** Every socket acknowledgement, and every HTTP error body as `{ error }`. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type ClientToServerEvents = {
    /** Binds the socket to the signed-in Privy user's account, opening it on first use. */
    "account:open": (payload: Record<string, never>, ack: (result: Ack<WalletSession>) => void) => void;
    "deposits:list": (payload: { before?: string; limit?: number }, ack: (result: Ack<DepositPage>) => void) => void;
    /** Reports a deposit transaction so it's credited without waiting for the chain scan. */
    "deposit:submit": (payload: { txHash: string }, ack: (result: Ack<DepositReceipt>) => void) => void;
    /** Asks for fresh balances; within 30 s of the last read nothing happens and `read` is false. */
    "balances:refresh": (payload: Record<string, never>, ack: (result: Ack<{ read: boolean }>) => void) => void;
    /** What a coin in one of the person's wallets would pay out on Arc. */
    "deposit:quote": (
        payload: { coin: string; amount: string; wallet: string },
        ack: (result: Ack<DepositQuoteView>) => void,
    ) => void;
    /** Opens a bridge order and hands back the transactions the wallet signs. */
    "deposit:order": (
        payload: { coin: string; amount: string; wallet: string },
        ack: (result: Ack<{ order: DepositOrderView; txs: SourceTxView[] }>) => void,
    ) => void;
    /** Reports the hashes of the transactions the wallet sent for an order. */
    "deposit:source": (
        payload: { orderId: string; txHashes: string[] },
        ack: (result: Ack<DepositOrderView>) => void,
    ) => void;
    /** What a prediction buy would cost and return right now. */
    "prediction:quote": (
        payload: { eventId: string; tokenId: string; amountUSD: string },
        ack: (result: Ack<QuoteView>) => void,
    ) => void;
    /** Places a buy; the outcome follows as a `prediction:update`. A repeated `requestId` is the same order. */
    "prediction:order": (
        payload: { requestId: string; eventId: string; tokenId: string; amountUSD: string; quotedPrice: number },
        ack: (result: Ack<PredictionOrderView>) => void,
    ) => void;
};

export type ServerToClientEvents = {
    "deposit:credited": (payload: { deposit: DepositView; account: AccountView }) => void;
    /** The account's coin balances, pushed after `account:open` and whenever a read finishes. */
    balances: (payload: BalancesView) => void;
    /** A bridge order changed state. */
    "deposit:progress": (payload: { order: DepositOrderView }) => void;
    /** The access token expired; the server disconnects next, and the client reconnects with a fresh one. */
    "session:expired": () => void;
    /** A prediction order settled or failed; carries the account's new balance. */
    "prediction:update": (payload: PredictionUpdate) => void;
    /** The account's positions and in-flight orders, pushed after `account:open`. */
    positions: (payload: PositionsView) => void;
};

/** What the socket handshake carries in `auth`. */
export type HandshakeAuth = { token: string };

export type MarketOutcomeView = {
    /** The CLOB token ID that buying this outcome buys. */
    tokenId: string;
    label: string;
    /** What one share costs to buy, from the best ask, 0 to 1. */
    buyPrice: number;
    /** The midpoint, 0 to 1. */
    chance: number;
    tone: "gain" | "loss" | "neutral";
    minUSD: number;
    image: string | null;
};

export type MarketView = {
    /** Polymarket's event ID. */
    id: string;
    title: string;
    image: string | null;
    endDate: string;
    volume24hUSD: number;
    outcomes: MarketOutcomeView[];
};

export type TrendingView = { markets: MarketView[]; maxOrderUSD: number | null; readAt: string | null };
export type MarketSearchView = { query: string; markets: MarketView[] };

export type PredictionFailure = "price_moved" | "market_closed" | "unavailable" | "rejected";

export type PredictionOrderView = {
    id: string;
    requestId: string;
    side: "buy" | "sell";
    state: "placing" | "posted" | "filled" | "failed";
    reason: PredictionFailure | null;
    eventId: string;
    tokenId: string;
    question: string;
    outcome: string;
    amountUSD: UsdcAmount | null;
    shares: string | null;
    positionId: string | null;
    createdAt: string;
    updatedAt: string;
};

export type PositionView = {
    id: string;
    eventId: string;
    marketId: string;
    tokenId: string;
    question: string;
    outcome: string;
    shares: string;
    costUSD: UsdcAmount;
    state: "open" | "closing" | "closed" | "won" | "lost";
    proceedsUSD: UsdcAmount | null;
    payoutUSD: UsdcAmount | null;
    openedAt: string;
    settledAt: string | null;
    updatedAt: string;
};

export type PositionsView = { positions: PositionView[]; orders: PredictionOrderView[] };

export type QuoteView = {
    eventId: string;
    tokenId: string;
    side: "buy";
    amountUSD: UsdcAmount;
    shares: string;
    avgPrice: number;
    worstPrice: number;
    feeUSD: UsdcAmount;
    payoutUSD: UsdcAmount;
    minUSD: number;
};

export type PredictionUpdate = {
    requestId: string;
    order: PredictionOrderView;
    position: PositionView | null;
    account: AccountView;
};
