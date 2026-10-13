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

export type WithdrawalState = "sending" | "sent" | "failed";

export type WithdrawalView = {
    id: string;
    requestId: string;
    amount: UsdcAmount;
    to: string;
    state: WithdrawalState;
    txHash: Hex | null;
    createdAt: string;
    updatedAt: string;
};

/** A withdrawal with the account as the server holds it once the debit or refund is in. */
export type WithdrawalPlaced = WithdrawalView & { account: AccountView };

/** What a withdrawal may be right now: `max` is the smaller of the balance and what the treasury can pay. */
export type WithdrawLimits = { max: UsdcAmount; min: UsdcAmount };

/** What opening the account hands back: everything the sidebar shows. */
export type WalletSession = {
    account: AccountView;
    deposits: DepositPage;
    rules: DepositRules;
    /** Open bridge orders, newest first. */
    orders: DepositOrderView[];
    /** The 50 newest withdrawals, newest first. */
    withdrawals: WithdrawalView[];
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
    /** The position is already being sold under another request. */
    | "position_busy"
    | "trading_off"
    /** LI.FI has no route for the swap. */
    | "no_route"
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
    /** Asks for fresh swap holdings; within 15 s of the last read nothing happens and `read` is false. */
    "swap:holdings:refresh": (payload: Record<string, never>, ack: (result: Ack<{ read: boolean }>) => void) => void;
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
    /** What a swap would pay right now, with no order opened. */
    "swap:quote": (req: SwapRequest, ack: (result: Ack<SwapQuoteView>) => void) => void;
    /** Quotes again and opens a swap order; `reviewedMin` is the `toAmountMin` the person saw. */
    "swap:order": (
        req: SwapRequest & { reviewedMin: string },
        ack: (result: Ack<{ order: SwapOrderView; txs: SwapTxView[] }>) => void,
    ) => void;
    /** Reports the hashes of the transactions the wallet sent for a swap order, approvals first. */
    "swap:sent": (payload: { orderId: string; txHashes: string[] }, ack: (result: Ack<SwapOrderView>) => void) => void;
    /** What a withdrawal may be right now. */
    "withdraw:limits": (payload: Record<string, never>, ack: (result: Ack<WithdrawLimits>) => void) => void;
    /** Takes the amount off the balance and pays it to a linked EVM wallet; a repeated `requestId` is the same withdrawal. */
    "withdraw:create": (
        payload: { requestId: string; amount: string; to: string },
        ack: (result: Ack<WithdrawalPlaced>) => void,
    ) => void;
    /** What a prediction buy would cost and return right now, or with a `positionId` what selling the position would pay. */
    "prediction:quote": (
        payload: { eventId: string; tokenId: string; amountUSD: string } | { positionId: string },
        ack: (result: Ack<QuoteView | SellQuoteView>) => void,
    ) => void;
    /** Places a buy; the outcome follows as a `prediction:update`. A repeated `requestId` is the same order. */
    "prediction:order": (
        payload: { requestId: string; eventId: string; tokenId: string; amountUSD: string; quotedPrice: number },
        ack: (result: Ack<PredictionPlaced>) => void,
    ) => void;
    /** Sells a whole position; the outcome follows as a `prediction:update`. A repeated `requestId` is the same order. */
    "prediction:close": (
        payload: { requestId: string; positionId: string; quotedPrice: number },
        ack: (result: Ack<PredictionOrderView>) => void,
    ) => void;
};

export type ServerToClientEvents = {
    /** A withdrawal changed state. */
    "withdrawal:update": (payload: { withdrawal: WithdrawalView; account: AccountView }) => void;
    "deposit:credited": (payload: { deposit: DepositView; account: AccountView }) => void;
    /** The account's coin balances, pushed after `account:open` and whenever a read finishes. */
    balances: (payload: BalancesView) => void;
    /** The coins the account's wallets hold on the swap networks, pushed after `account:open` and whenever a read finishes. */
    "swap:holdings": (payload: SwapHoldingsView) => void;
    /** A swap order was opened or changed state. */
    "swap:update": (payload: { order: SwapOrderView }) => void;
    /** The account's open swap orders and those settled in the last 7 days, newest first, at most 50; pushed after `account:open`. */
    swaps: (payload: { orders: SwapOrderView[] }) => void;
    /** A bridge order changed state. */
    "deposit:progress": (payload: { order: DepositOrderView }) => void;
    /** The access token expired; the server disconnects next, and the client reconnects with a fresh one. */
    "session:expired": () => void;
    /** A prediction order settled or failed; carries the account's new balance. */
    "prediction:update": (payload: PredictionUpdate) => void;
    /** A position was paid or lost when its market resolved; carries the account's new balance. */
    "position:settled": (payload: PositionSettled) => void;
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
    /** What one share sells for, from the best bid, 0 to 1. */
    sellPrice: number;
    /** The smallest sale the book takes, in shares. */
    minShares: number;
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

/** One outcome's chance over the market's life, oldest first, as [unix ms, chance 0–1]; empty when Polymarket has none. */
export type OutcomeHistoryView = { tokenId: string; points: [number, number][] };

export type MarketHistoryView = {
    eventId: string;
    /** About how far apart the points are, in ms. */
    stepMs: number;
    /** In the order the tokens were asked for. */
    outcomes: OutcomeHistoryView[];
    /** When Polymarket was last read for the oldest of these lines (ISO 8601). */
    readAt: string;
};

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

/** The order as accepted, with the account as it stands once the amount is taken. */
export type PredictionPlaced = PredictionOrderView & { account: AccountView };

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

export type SellQuoteView = {
    positionId: string;
    side: "sell";
    /** The shares that would sell, floored to 0.01. */
    shares: string;
    proceedsUSD: UsdcAmount;
    avgPrice: number;
    worstPrice: number;
    feeUSD: UsdcAmount;
    /** The smallest sale the book takes, in shares. */
    minShares: number;
};

export type PositionSettled = { position: PositionView; account: AccountView };

export type PredictionUpdate = {
    requestId: string;
    order: PredictionOrderView;
    position: PositionView | null;
    account: AccountView;
};

/** A network swaps run on. */
export type SwapNetworkId =
    "ethereum" | "arbitrum" | "base" | "optimism" | "polygon" | "bnb" | "avalanche" | "arc" | "solana";

/** A swap coin as the picker shows it; `priceUSD` is null until LI.FI has priced it. */
export type SwapCoinView = {
    symbol: string;
    name: string;
    priceUSD: number | null;
    home: SwapNetworkId;
    networks: { network: SwapNetworkId; label?: string; wrapped?: boolean }[];
};

export type SwapCatalogView = {
    coins: SwapCoinView[];
    /** When the prices were read; null before the first read. */
    readAt: string | null;
};

/** How far back a price history reaches; its points are 15 minutes, 1 hour, 6 hours, 1 day and 1 day apart. */
export type PriceRange = "1d" | "7d" | "30d" | "90d" | "1y";

/** One coin's dollar price over a range, oldest first, as [unix ms, USD] pairs to 6 significant digits. Where DefiLlama has a gap, points are missing, not filled; empty when it has none. */
export type PriceSeriesView = { symbol: string; points: [number, number][] };

export type PriceHistoryView = {
    range: PriceRange;
    /** About how far apart the points are, in ms. */
    stepMs: number;
    coins: PriceSeriesView[];
    /** When DefiLlama was read (ISO 8601). It can be older than usual while DefiLlama can't be read. */
    readAt: string;
};

/** One coin a wallet holds on one network; `amount` is a decimal string in coin units and `usd` is null without a price. */
export type SwapHoldingRow = {
    wallet: string;
    network: SwapNetworkId;
    symbol: string;
    amount: string;
    usd: number | null;
};

/** Only the non-zero holdings of the account's linked wallets, as of `readAt` (ISO 8601), and the wallet and network pairs read at least once: any other pair is unread, not empty. */
export type SwapHoldingsView = {
    readAt: string;
    rows: SwapHoldingRow[];
    read: { wallet: string; network: SwapNetworkId }[];
};

/** One side of a swap: a coin symbol on a network. */
export type SwapSide = { token: string; network: SwapNetworkId };

/** `wallet` pays and signs; `receiver` is the person's own wallet on the receiving network's kind. */
export type SwapRequest = { from: SwapSide; to: SwapSide; amountUSD: string; wallet: string; receiver: string };

/** Amounts are decimal coin units. */
export type SwapQuoteView = {
    request: SwapRequest;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    fees: { name: string; usd: number }[];
    gasUSD: number;
    etaSeconds: number;
    tool: string;
    needsApproval: boolean;
};

/** One transaction the wallet signs: EVM ones name their chain, a Solana one is LI.FI's base64 transaction. */
export type SwapTxView =
    | {
          kind: "evm";
          purpose: "reset" | "approve" | "swap";
          chainId: number;
          to: string;
          data: string;
          /** Wei, as a decimal string. */
          value: string;
      }
    | { kind: "solana"; data: string };

export type SwapOrderState = "created" | "sent" | "done" | "partial" | "refunded" | "failed" | "expired";

export type SwapOrderView = {
    id: string;
    state: SwapOrderState;
    from: SwapSide & { amount: string };
    to: SwapSide & { amount: string; received: string | null; receivedSymbol: string | null };
    wallet: string;
    txHashes: string[];
    /** ISO 8601. */
    createdAt: string;
    updatedAt: string;
};
