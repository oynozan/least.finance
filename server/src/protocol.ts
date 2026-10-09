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
    symbol: string;
    chainName: string;
    chainId: number;
    decimals: number;
    /** In the coin's own units, as a decimal. */
    amount: string;
    /** `amount` less what's kept back for gas, floored at 0. */
    spendable: string;
    /** Null when the coin's price is unknown. */
    usd: number | null;
};

/** What opening the account hands back: everything the sidebar shows. */
export type WalletSession = {
    account: AccountView;
    deposits: DepositPage;
    rules: DepositRules;
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
};

export type ServerToClientEvents = {
    "deposit:credited": (payload: { deposit: DepositView; account: AccountView }) => void;
    /** The access token expired; the server disconnects next, and the client reconnects with a fresh one. */
    "session:expired": () => void;
};

/** What the socket handshake carries in `auth`. */
export type HandshakeAuth = { token: string };
