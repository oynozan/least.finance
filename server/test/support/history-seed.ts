import { randomBytes, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { ARC_CHAIN_ID } from "../../src/chain/arc.ts";
import type {
    Collections,
    DepositDoc,
    PerpPositionDoc,
    PerpPositionState,
    PositionDoc,
    PositionState,
    PredictionOrderDoc,
    SwapOrderDoc,
    WithdrawalDoc,
} from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import type { SwapOrderState, WithdrawalState } from "../../src/protocol.ts";

export type SeedRow =
    | { kind: "deposit"; usdc: string; at: Date; txHash?: string; logIndex?: number }
    | { kind: "withdrawal"; usdc: string; at: Date; state?: WithdrawalState }
    | { kind: "swap"; at: Date; state?: SwapOrderState; sent?: boolean }
    | {
          kind: "prediction";
          state: PositionState;
          cost: string;
          proceeds?: string;
          payout?: string;
          openedAt: Date;
          settledAt?: Date;
      }
    | { kind: "sale"; cost: string; proceeds: string; at: Date }
    | {
          kind: "perp";
          state: PerpPositionState;
          collateral: string;
          proceeds?: string;
          openedAt: Date;
          settledAt?: Date;
      };

const ADDRESS = `0x${"1".repeat(40)}`;
const SHARES_E6 = 20_000_000n;

const wei = (usdc: string) => toDecimal(parseUnits(usdc, 18));
const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;

// Ids carry the row's own date, so id order follows date order like real data
function objectIdAt(at: Date) {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, Math.floor(at.getTime() / 1000));
    bytes.set(crypto.getRandomValues(new Uint8Array(8)), 4);
    return new ObjectId(bytes);
}

// An open perp is unique on (index, asset). Seeded perps start far above any index the app allocates, so a spec that opens perps through the app can't collide with them.
let perpIndex = 100_000;

function deposit(accountId: ObjectId, row: Extract<SeedRow, { kind: "deposit" }>): DepositDoc {
    return {
        _id: objectIdAt(row.at),
        accountId,
        chainId: ARC_CHAIN_ID,
        txHash: row.txHash ?? hex(32),
        logIndex: row.logIndex ?? 0,
        blockNumber: 0,
        blockHash: `0x${"0".repeat(64)}`,
        from: ADDRESS,
        to: ADDRESS,
        amount: wei(row.usdc),
        source: "scan",
        creditedAt: row.at,
    };
}

function withdrawal(accountId: ObjectId, row: Extract<SeedRow, { kind: "withdrawal" }>): WithdrawalDoc {
    return {
        _id: objectIdAt(row.at),
        accountId,
        requestId: randomUUID(),
        amount: wei(row.usdc),
        to: ADDRESS,
        state: row.state ?? "sent",
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        createdAt: row.at,
        updatedAt: row.at,
    };
}

function swap(accountId: ObjectId, row: Extract<SeedRow, { kind: "swap" }>): SwapOrderDoc {
    return {
        _id: objectIdAt(row.at),
        accountId,
        wallet: ADDRESS,
        receiver: ADDRESS,
        from: { token: "ETH", network: "ethereum", units: "1000000000000000", amount: "0.001" },
        to: { token: "USDC", network: "base", amount: "2", minAmount: "1.9", units: "2000000", minUnits: "1900000" },
        tool: "seed",
        toolName: "Seed",
        fees: [],
        gasUSD: 0,
        etaSeconds: 30,
        state: row.state ?? "done",
        txHashes: row.sent === false ? [] : [hex(32)],
        received: null,
        receivedSymbol: null,
        createdAt: row.at,
        updatedAt: row.at,
    };
}

// The market every seeded prediction and sale is on, with a fresh token per row
function market() {
    return {
        eventId: "evt-seed",
        marketId: "mkt-seed",
        tokenId: hex(16),
        conditionId: hex(32),
        question: "Will it rain?",
        outcome: "Yes",
    };
}

function prediction(accountId: ObjectId, row: Extract<SeedRow, { kind: "prediction" }>): PositionDoc {
    const live = row.state === "open" || row.state === "closing";
    const settledAt = live ? null : (row.settledAt ?? row.openedAt);
    return {
        _id: objectIdAt(row.openedAt),
        accountId,
        ...market(),
        shares: toDecimal(SHARES_E6),
        cost: wei(row.cost),
        state: row.state,
        proceeds: row.proceeds === undefined ? null : wei(row.proceeds),
        payout: row.payout === undefined ? null : wei(row.payout),
        openedAt: row.openedAt,
        settledAt,
        updatedAt: settledAt ?? row.openedAt,
    };
}

// A sell that left shares open carries what it sold, and it points at no position
function sale(accountId: ObjectId, row: Extract<SeedRow, { kind: "sale" }>): PredictionOrderDoc {
    return {
        _id: objectIdAt(row.at),
        accountId,
        requestId: randomUUID(),
        side: "sell",
        ...market(),
        amount: toDecimal(0n),
        shares: toDecimal(SHARES_E6),
        quotedPrice: 0.5,
        limitPrice: 0.5,
        positionId: null,
        orderHash: null,
        clobOrderId: null,
        signed: null,
        state: "filled",
        reason: null,
        filledShares: toDecimal(SHARES_E6),
        cost: null,
        soldPart: { cost: wei(row.cost), proceeds: wei(row.proceeds), at: row.at },
        postedAt: row.at,
        createdAt: row.at,
        updatedAt: row.at,
    };
}

function perp(accountId: ObjectId, row: Extract<SeedRow, { kind: "perp" }>): PerpPositionDoc {
    const live = row.state === "open" || row.state === "closing";
    const settledAt = live ? null : (row.settledAt ?? row.openedAt);
    return {
        _id: objectIdAt(row.openedAt),
        accountId,
        index: ++perpIndex,
        asset: "BTC",
        side: "long",
        leverage: 5,
        sizeCoin: "0.01",
        entryPx: "60000",
        collateral: wei(row.collateral),
        openedFee: toDecimal(0n),
        state: row.state,
        active: live,
        proceeds: row.proceeds === undefined ? null : wei(row.proceeds),
        realizedPnl: null,
        closeReason: null,
        openedAt: row.openedAt,
        settledAt,
        updatedAt: settledAt ?? row.openedAt,
    };
}

/** Writes complete documents, one per row, and returns their ids in order; no ledger rows and no balance change */
export function seedRows(collections: Collections, accountId: ObjectId, rows: SeedRow[]): Promise<ObjectId[]> {
    return Promise.all(
        rows.map(async (row) => {
            switch (row.kind) {
                case "deposit": {
                    const doc = deposit(accountId, row);
                    await collections.deposits.insertOne(doc);
                    return doc._id;
                }
                case "withdrawal": {
                    const doc = withdrawal(accountId, row);
                    await collections.withdrawals.insertOne(doc);
                    return doc._id;
                }
                case "swap": {
                    const doc = swap(accountId, row);
                    await collections.swapOrders.insertOne(doc);
                    return doc._id;
                }
                case "prediction": {
                    const doc = prediction(accountId, row);
                    await collections.positions.insertOne(doc);
                    return doc._id;
                }
                case "sale": {
                    const doc = sale(accountId, row);
                    await collections.predictionOrders.insertOne(doc);
                    return doc._id;
                }
                case "perp": {
                    const doc = perp(accountId, row);
                    await collections.perpPositions.insertOne(doc);
                    return doc._id;
                }
            }
        }),
    );
}
