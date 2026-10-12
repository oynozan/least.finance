import { MongoClient, MongoServerError, type Collection, type Db, type Decimal128, type ObjectId } from "mongodb";
import type { OrderState } from "../protocol.ts";
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
    /** The sending wallet, checksummed. */
    wallet: string;
    provider: string;
    /** The provider's id for the bridge. */
    ref: string;
    /** Wei of USDC on Arc. */
    usdcOut: Decimal128;
    etaSeconds: number;
    /** The account's deposit address, lowercase. */
    recipient: string;
    /** Where a failed bridge pays back, lowercase. */
    refundTo: string;
    state: OrderState;
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
    kind: "deposit" | "merge_in" | "merge_out";
    /** Signed wei. */
    amount: Decimal128;
    balanceAfter: Decimal128;
    /** The deposit (or, later, trade) the entry records. */
    refId: ObjectId;
    createdAt: Date;
};

/** How far a chain scan has got. */
export type CursorDoc = { _id: string; block: number; updatedAt: Date };

export type CounterDoc = { _id: string; seq: number };

export type Collections = {
    accounts: Collection<AccountDoc>;
    deposits: Collection<DepositDoc>;
    ledger: Collection<LedgerEntryDoc>;
    depositOrders: Collection<DepositOrderDoc>;
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

async function ensureIndexes({ accounts, deposits, ledger, depositOrders }: Collections) {
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
    ]);
}

export const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;
