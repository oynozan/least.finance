import { MongoClient, MongoServerError, type Collection, type Db, type Decimal128, type ObjectId } from "mongodb";
import type { Hex, OrderState, SwapNetworkId, SwapOrderState, WithdrawalState } from "../protocol.ts";
import { mergeAccountsByPerson, type MigrationReport } from "./migrations.ts";

/** A person's account. Addresses are stored lowercase. */
export type AccountDoc = {
    _id: ObjectId;
    /** The Privy user (DID) the account belongs to. */
    privyUserId: string;
    /** BIP-44 address index of the deposit address, m/44'/60'/0'/0/{index}. Index 0 is kept for the operator. */
    depositIndex: number;
    depositAddress: string;
    /** Wei. */
    balance: Decimal128;
    /** Bumped on every balance change, so clients can tell a stale update from a new one. */
    version: number;
    /** The Arc block height when the account opened; nothing can arrive before it. */
    openedAtBlock: number;
    /** Deposit addresses of accounts merged into this one; USDC sent to them is still credited here. */
    formerDepositAddresses?: string[];
    createdAt: Date;
    updatedAt: Date;
};

export type DepositDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    chainId: number;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    from: string;
    to: string;
    /** Wei. */
    amount: Decimal128;
    /** Which path credited it first: the chain scan, or the client reporting its transaction. */
    source: "scan" | "report";
    creditedAt: Date;
    /** Set when a bridged order delivered it. */
    origin?: { coin: string; amount: string; txHash: string; orderId: ObjectId };
};

/** A coin from another chain, bridged to the account's address on Arc. */
export type DepositOrderDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The catalog key. */
    coin: string;
    /** In the coin's own units, as a decimal. */
    amount: string;
    /** The sending wallet: checksummed on EVM, base58 as the person linked it on Solana. */
    wallet: string;
    provider: string;
    /** The provider's id for the bridge. */
    ref: string;
    /** Wei of USDC on Arc. */
    usdcOut: Decimal128;
    etaSeconds: number;
    /** The account's deposit address, lowercase. */
    recipient: string;
    /** Where a failed bridge pays back: lowercase on EVM, the base58 wallet unchanged on Solana. */
    refundTo: string;
    state: OrderState;
    /** Lowercase hex on EVM, base58 signatures on Solana. */
    sourceTxHashes: string[];
    fillTxHash: string | null;
    depositId: ObjectId | null;
    createdAt: Date;
    updatedAt: Date;
};

/** Every change to a balance, so it can be audited and replayed. */
export type LedgerEntryDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    kind:
        | "deposit"
        | "merge_in"
        | "merge_out"
        | "prediction_buy"
        | "prediction_refund"
        | "prediction_sell"
        | "prediction_payout"
        | "withdrawal"
        | "withdrawal_refund"
        | "perp_open"
        | "perp_refund"
        | "perp_close";
    /** Signed wei. */
    amount: Decimal128;
    balanceAfter: Decimal128;
    /** The deposit (or, later, trade) the entry records. */
    refId: ObjectId;
    createdAt: Date;
};

export type PredictionOrderState = "placing" | "posted" | "filled" | "failed";
export type PredictionFailure = "price_moved" | "market_closed" | "unavailable" | "rejected";

/** A prediction order; a buy holds `amount` wei of the balance until it settles. */
export type PredictionOrderDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The client's UUID; a repeat of (accountId, requestId) is the same order. */
    requestId: string;
    side: "buy" | "sell";
    eventId: string;
    marketId: string;
    tokenId: string;
    conditionId: string;
    question: string;
    outcome: string;
    /** Wei held, for a buy. */
    amount: Decimal128;
    /** E6 pUSD a buy reserved from the pool's float; absent on orders from before the float document. */
    reservedE6?: Decimal128;
    /** E6 shares, for a sell. */
    shares: Decimal128 | null;
    /** The price the limit derives from: the less generous of the client's quote and the server's price. */
    quotedPrice: number;
    /** The client's own quote, kept for audit. */
    clientPrice?: number;
    limitPrice: number;
    /** The position a sell closes. */
    positionId: ObjectId | null;
    orderHash: string | null;
    clobOrderId: string | null;
    signed: unknown | null;
    state: PredictionOrderState;
    reason: PredictionFailure | null;
    /** E6 shares. */
    filledShares: Decimal128 | null;
    /** Wei. */
    cost: Decimal128 | null;
    postedAt: Date | null;
    /** When the post got no clear answer; the order is held, never refunded, for a while after. */
    postUnknownAt?: Date | null;
    /** Until when a refunded unknown post is still checked for a fill that lands late. */
    watchUntil?: Date | null;
    /** What became of a fill that landed after the refund: booked, or left with the pool for an operator. */
    lateFill?: "settled" | "orphaned";
    /** The ledger reference of the debit that took the cost back for a late fill. */
    lateRefId?: ObjectId;
    /** When a trade that can't be linked to the order was found; an operator decides, nothing is refunded. */
    needsReviewAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

/** The pool's pUSD float, one document: what the last read saw, what open buys hold, and what fills spent since. */
export type PoolFloatDoc = {
    _id: "polygon";
    /** E6 pUSD from the last CLOB read. */
    balanceE6: Decimal128;
    /** When that read finished. */
    balanceAt: Date;
    /** E6 reserved by buys that haven't settled or failed. */
    heldE6: Decimal128;
    /** E6 spent by fills that the last read may not show yet. */
    unreadFillsE6: Decimal128;
    updatedAt: Date;
};

/** A person's Hyperliquid account; index 0 of the same path is the master float, which has no row. */
export type PerpAccountDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The `perpIndex` the address derives from. */
    index: number;
    /** Lowercase. */
    address: string;
    activatedAt: Date | null;
    createdAt: Date;
};

export type PerpOrderState = "placing" | "funding" | "posted" | "sweeping" | "filled" | "rejected" | "done";

/** One open or close request; an open holds `collateral` wei of the balance until it settles. */
export type PerpOrderDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The client's UUID; a repeat of (accountId, requestId) is the same order. */
    requestId: string;
    kind: "open" | "close";
    /** The perp index of the address that trades. */
    index: number;
    asset: string;
    side: "long" | "short";
    leverage: number;
    /** Wei. */
    collateral: Decimal128;
    notionalE6: Decimal128;
    sizeCoin: string;
    /** 0x followed by 32 hex digits, derived from `_id`. */
    cloid: string;
    limitPx: string;
    state: PerpOrderState;
    /** Progress marks and the stored transfer nonces that make a restart repeat a step safely. */
    steps: Record<string, unknown>;
    fill: { sizeCoin: string; avgPx: string; feeE6: Decimal128 } | null;
    /** Wei put back on the balance. */
    credited: Decimal128 | null;
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export type PerpPositionState = "open" | "closing" | "closed" | "liquidated";

export type PerpPositionDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    index: number;
    asset: string;
    side: "long" | "short";
    leverage: number;
    sizeCoin: string;
    entryPx: string;
    /** Wei. */
    collateral: Decimal128;
    /** E6 entry fee Hyperliquid took. */
    openedFee: Decimal128;
    state: PerpPositionState;
    /** True while the state is `open` or `closing`; the unique open-position key rests on it. */
    active: boolean;
    /** Wei credited when the position settled. */
    proceeds: Decimal128 | null;
    /** E6. */
    realizedPnl: Decimal128 | null;
    closeReason: string | null;
    /** The last poll, for the sidebar. */
    snapshot?: {
        markPx: string;
        unrealizedPnlE6: Decimal128;
        liquidationPx: string | null;
        cumFundingE6: Decimal128;
        at: Date;
    };
    openedAt: Date;
    settledAt: Date | null;
    updatedAt: Date;
};

/** The master Hyperliquid float, one document, shaped like the pool's. */
export type PerpFloatDoc = {
    _id: "hyperliquid";
    /** E6 withdrawable from the last read. */
    balanceE6: Decimal128;
    balanceAt: Date;
    /** E6 reserved by orders that haven't moved their margin. */
    heldE6: Decimal128;
    /** E6 spent by fills that the last read may not show yet. */
    unreadFillsE6: Decimal128;
    updatedAt: Date;
};

/** Money moving between the Arc treasury and the master float, counted as ours while in flight. */
export type PerpRebalanceDoc = {
    _id: ObjectId;
    direction: "arc_to_hl" | "hl_to_arc";
    amountE6: Decimal128;
    state: "sent" | "arrived";
    txHash: string;
    createdAt: Date;
};

export type PositionState = "open" | "closing" | "closed" | "won" | "lost";

export type PositionDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    eventId: string;
    marketId: string;
    tokenId: string;
    conditionId: string;
    question: string;
    outcome: string;
    /** E6 shares. */
    shares: Decimal128;
    /** Wei. */
    cost: Decimal128;
    state: PositionState;
    /** Wei, once closed. */
    proceeds: Decimal128 | null;
    /** Wei, once the market resolved. */
    payout: Decimal128 | null;
    openedAt: Date;
    settledAt: Date | null;
    updatedAt: Date;
};

export type PredictionRedemptionState = "pending" | "submitted" | "confirmed" | "failed" | "stuck";

/** The pool's redemption of a resolved condition's tokens; one per condition. */
export type PredictionRedemptionDoc = {
    _id: ObjectId;
    conditionId: string;
    marketId: string;
    state: PredictionRedemptionState;
    transactionId: string | null;
    attempts: number;
    nextAt: Date;
    lastError: string | null;
    /** When the current transactionId was recorded. */
    submittedAt?: Date | null;
    /** Consecutive failed lookups of the current transaction; any answer resets it. */
    checkErrors?: number;
    /** The abandoned transaction ids, the last 10, for the operator. */
    previousTransactions?: string[];
    /** When the redemption first needed an operator. */
    stuckAt?: Date | null;
    /** When the redemption last confirmed; rows from before it was recorded fall back to updatedAt. */
    confirmedAt?: Date | null;
    /** 1 for the first redemption, plus one for each re-queue after later shares; rows from before it was recorded count as 1. */
    round?: number;
    createdAt: Date;
    updatedAt: Date;
};

/** USDC paid out of the treasury to one of the person's linked EVM wallets; `amount` wei left the balance when it was created. */
export type WithdrawalDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The client's UUID; a repeat of (accountId, requestId) is the same withdrawal. */
    requestId: string;
    amount: Decimal128;
    /** Lowercase EVM address, or the base58 wallet of a Solana withdrawal. */
    to: string;
    /** Missing means "arc". */
    network?: "arc" | "solana";
    state: WithdrawalState;
    /** Set with rawTx before the first broadcast, so a restart re-sends the same transaction. */
    nonce: number | null;
    rawTx: Hex | null;
    txHash: Hex | null;
    failure: string | null;
    /** What a Solana withdrawal needs beyond the Arc fields; the Arc nonce, rawTx and txHash are unused for it. */
    solana?: SolanaWithdrawal;
    createdAt: Date;
    updatedAt: Date;
};

/** The CCTP burn on Arc and its forward to Solana; wei amounts, null until each step has happened. */
export type SolanaWithdrawal = {
    wallet: string;
    /** The wallet's USDC token account, where the mint goes. */
    usdcAccount: string;
    /** True when the mint also creates that account. */
    setup: boolean;
    /** The quoted fee shown to the person. */
    fee: Decimal128;
    /** The most the burn lets Circle charge. */
    maxFee: Decimal128;
    approveNonce: number | null;
    approveRawTx: Hex | null;
    approveTxHash: Hex | null;
    burnNonce: number | null;
    burnRawTx: Hex | null;
    burnTxHash: Hex | null;
    forwardTxHash: string | null;
    irisCheckedAt: Date | null;
};

/** A swap through LI.FI, signed by the person's own wallet; amounts are decimal coin units and `units` are the integers LI.FI works in. */
export type SwapOrderDoc = {
    _id: ObjectId;
    accountId: ObjectId;
    /** The paying wallet, in the form Privy knows it. */
    wallet: string;
    /** The person's wallet on the receiving network. */
    receiver: string;
    from: { token: string; network: SwapNetworkId; units: string; amount: string };
    to: { token: string; network: SwapNetworkId; amount: string; minAmount: string; units: string; minUnits: string };
    /** LI.FI's key for the route's tool, which the status call needs. */
    tool: string;
    toolName: string;
    fees: { name: string; usd: number }[];
    gasUSD: number;
    etaSeconds: number;
    state: SwapOrderState;
    /** Approvals first, the swap last. */
    txHashes: string[];
    received: string | null;
    receivedSymbol: string | null;
    createdAt: Date;
    updatedAt: Date;
};

/** The IP an order was placed from, kept apart from the order and dropped after 30 days. */
export type SwapIpDoc = { _id: ObjectId; orderId: ObjectId; ip: string; expiresAt: Date };

/** How far a chain scan has got. */
export type CursorDoc = { _id: string; block: number; updatedAt: Date };

export type CounterDoc = { _id: string; seq: number };

export type Collections = {
    accounts: Collection<AccountDoc>;
    deposits: Collection<DepositDoc>;
    ledger: Collection<LedgerEntryDoc>;
    depositOrders: Collection<DepositOrderDoc>;
    predictionOrders: Collection<PredictionOrderDoc>;
    poolFloat: Collection<PoolFloatDoc>;
    perpAccounts: Collection<PerpAccountDoc>;
    perpOrders: Collection<PerpOrderDoc>;
    perpPositions: Collection<PerpPositionDoc>;
    perpFloat: Collection<PerpFloatDoc>;
    perpRebalances: Collection<PerpRebalanceDoc>;
    positions: Collection<PositionDoc>;
    predictionRedemptions: Collection<PredictionRedemptionDoc>;
    withdrawals: Collection<WithdrawalDoc>;
    swapOrders: Collection<SwapOrderDoc>;
    swapIps: Collection<SwapIpDoc>;
    cursors: Collection<CursorDoc>;
    counters: Collection<CounterDoc>;
};

export type Database = {
    client: MongoClient;
    db: Db;
    collections: Collections;
    migration: MigrationReport;
    close(): Promise<void>;
};

export async function connectDatabase(uri: string, dbName: string): Promise<Database> {
    const client = new MongoClient(uri, {
        appName: "least-finance-server",
        retryWrites: true,
        serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    try {
        const db = client.db(dbName);
        await assertTransactions(db);
        const collections: Collections = {
            accounts: db.collection("accounts"),
            deposits: db.collection("deposits"),
            ledger: db.collection("ledger"),
            depositOrders: db.collection("deposit_orders"),
            predictionOrders: db.collection("prediction_orders"),
            poolFloat: db.collection("pool_float"),
            perpAccounts: db.collection("perp_accounts"),
            perpOrders: db.collection("perp_orders"),
            perpPositions: db.collection("perp_positions"),
            perpFloat: db.collection("perp_float"),
            perpRebalances: db.collection("perp_rebalances"),
            positions: db.collection("positions"),
            predictionRedemptions: db.collection("prediction_redemptions"),
            withdrawals: db.collection("withdrawals"),
            swapOrders: db.collection("swap_orders"),
            swapIps: db.collection("swap_ips"),
            cursors: db.collection("cursors"),
            counters: db.collection("counters"),
        };
        const migration = await mergeAccountsByPerson(client, collections);
        await ensureIndexes(collections);
        return { client, db, collections, migration, close: () => client.close() };
    } catch (error) {
        await client.close();
        throw error;
    }
}

/** Crediting a deposit writes three documents at once, which needs a replica set (a single node is enough). */
async function assertTransactions(db: Db) {
    const hello = await db.admin().command({ hello: 1 });
    if (hello.setName || hello.msg === "isdbgrid") return;
    throw new Error(
        "MongoDB is running standalone, but deposits need transactions. Run it as a replica set (see server/README.md).",
    );
}

async function ensureIndexes({
    accounts,
    deposits,
    ledger,
    depositOrders,
    predictionOrders,
    positions,
    predictionRedemptions,
    withdrawals,
    swapOrders,
    swapIps,
    perpAccounts,
    perpOrders,
    perpPositions,
}: Collections) {
    await Promise.all([
        accounts.createIndexes([
            { key: { depositAddress: 1 }, name: "deposit_address_unique", unique: true },
            { key: { depositIndex: 1 }, name: "deposit_index_unique", unique: true },
            {
                key: { privyUserId: 1 },
                name: "privy_user_unique",
                unique: true,
                partialFilterExpression: { privyUserId: { $gt: "" } },
            },
            {
                key: { formerDepositAddresses: 1 },
                name: "former_deposit_addresses_unique",
                unique: true,
                partialFilterExpression: { formerDepositAddresses: { $exists: true } },
            },
            { key: { createdAt: 1 }, name: "created_at" },
        ]),
        deposits.createIndexes([
            // A log is credited once, however many paths report it.
            { key: { chainId: 1, txHash: 1, logIndex: 1 }, name: "log_unique", unique: true },
            { key: { accountId: 1, _id: -1 }, name: "account_history" },
        ]),
        ledger.createIndexes([
            { key: { kind: 1, refId: 1 }, name: "ref_unique", unique: true },
            { key: { accountId: 1, _id: -1 }, name: "account_history" },
        ]),
        depositOrders.createIndexes([
            { key: { accountId: 1, _id: -1 }, name: "account_orders" },
            { key: { state: 1, updatedAt: 1 }, name: "state_updated" },
        ]),
        predictionOrders.createIndexes([
            { key: { accountId: 1, requestId: 1 }, name: "request_unique", unique: true },
            { key: { state: 1, updatedAt: 1 }, name: "state_updated" },
            { key: { accountId: 1, _id: -1 }, name: "account_orders" },
        ]),
        positions.createIndexes([
            {
                key: { accountId: 1, tokenId: 1 },
                name: "open_unique",
                unique: true,
                partialFilterExpression: { state: { $in: ["open", "closing"] } },
            },
            { key: { accountId: 1, _id: -1 }, name: "account_positions" },
            { key: { state: 1, marketId: 1 }, name: "state_market" },
        ]),
        predictionRedemptions.createIndexes([
            { key: { conditionId: 1 }, name: "condition_unique", unique: true },
            { key: { state: 1, nextAt: 1 }, name: "state_next" },
        ]),
        withdrawals.createIndexes([
            { key: { accountId: 1, _id: -1 }, name: "account_withdrawals" },
            { key: { accountId: 1, requestId: 1 }, name: "request_unique", unique: true },
            { key: { state: 1, createdAt: 1 }, name: "state_created" },
        ]),
        swapOrders.createIndexes([
            { key: { accountId: 1, createdAt: -1 }, name: "account_orders" },
            { key: { state: 1, updatedAt: 1 }, name: "state_updated" },
        ]),
        swapIps.createIndexes([{ key: { expiresAt: 1 }, name: "expires", expireAfterSeconds: 0 }]),
        perpAccounts.createIndexes([
            { key: { index: 1 }, name: "index_unique", unique: true },
            { key: { address: 1 }, name: "address_unique", unique: true },
            { key: { accountId: 1 }, name: "account" },
        ]),
        perpOrders.createIndexes([
            { key: { accountId: 1, requestId: 1 }, name: "request_unique", unique: true },
            { key: { state: 1, updatedAt: 1 }, name: "state_updated" },
        ]),
        perpPositions.createIndexes([
            { key: { accountId: 1, openedAt: 1 }, name: "account_positions" },
            { key: { state: 1, updatedAt: 1 }, name: "state_updated" },
            {
                key: { index: 1, asset: 1 },
                name: "open_unique",
                unique: true,
                partialFilterExpression: { active: true },
            },
        ]),
    ]);
}

export const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;
