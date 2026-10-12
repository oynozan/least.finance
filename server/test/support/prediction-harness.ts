import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { inject } from "vitest";
import type { Config } from "../../src/config.ts";
import { connectDatabase, type AccountDoc, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import type { MarketService } from "../../src/markets/markets.ts";
import { PredictionService } from "../../src/predictions/predictions.ts";
import type { Book } from "../../src/predictions/trader.ts";
import { FakeTrader } from "./fake-trader.ts";

export const wei = (usdc: string) => parseUnits(usdc, 18);
export const TOKEN = "tok-yes";
export const EVENT = "evt-1";

export const BOOK: Book = {
    bids: [{ price: 0.48, size: 1000 }],
    asks: [{ price: 0.5, size: 1000 }],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
};

type Offered = Awaited<ReturnType<MarketService["outcome"]>>;

/** The service, a fake trader and an offered outcome over a throwaway database. */
export async function predictionHarness(o: { trading?: "on" | "off"; now?: () => number; feeRate?: number } = {}) {
    const database: Database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const logger = pino({ level: "silent" });
    const bus = new Bus();
    const ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger,
        minDeposit: 0n,
    });
    const trader = new FakeTrader({
        bookOf: () => BOOK,
        balanceE6: 1_000_000_000n,
        ...(o.feeRate && {
            metaOf: (_t, book) => ({
                conditionId: "0xcondition",
                negRisk: book.negRisk,
                tickSize: book.tickSize,
                feeRate: o.feeRate!,
                feeExponent: 1,
            }),
        }),
    });
    const offered: { current: Offered } = {
        current: {
            outcome: {
                tokenId: TOKEN,
                label: "YES",
                buyPrice: 0.5,
                sellPrice: 0.49,
                minShares: 5,
                chance: 0.49,
                tone: "gain",
                minUSD: 1,
                image: null,
            },
            marketId: "mkt-1",
            question: "Will it rain?",
        },
    };
    const markets = { outcome: async () => offered.current } as unknown as MarketService;
    const config = { PREDICTIONS_TRADING: o.trading ?? "on", POLYMARKET_FLOAT_USD: 100 } as Config;
    const service = new PredictionService({
        collections: database.collections,
        ledger,
        markets,
        trader: () => trader,
        bus,
        logger,
        config,
        ...(o.now && { now: o.now }),
    });

    let nextIndex = 1;
    async function seedAccount(usdc: string): Promise<AccountDoc> {
        const _id = new ObjectId();
        const now = new Date();
        const index = nextIndex++;
        const account: AccountDoc = {
            _id,
            privyUserId: `did:privy:${randomUUID()}`,
            depositIndex: index,
            depositAddress: `0x${index.toString(16).padStart(40, "0")}`,
            balance: toDecimal(wei(usdc)),
            version: 1,
            openedAtBlock: 0,
            createdAt: now,
            updatedAt: now,
        };
        await database.collections.accounts.insertOne(account);
        await database.collections.ledger.insertOne({
            _id: new ObjectId(),
            accountId: _id,
            kind: "deposit",
            amount: toDecimal(wei(usdc)),
            balanceAfter: toDecimal(wei(usdc)),
            refId: new ObjectId(),
            createdAt: now,
        });
        return account;
    }

    async function state(accountId: ObjectId) {
        const account = await database.collections.accounts.findOne({ _id: accountId });
        const rows = await database.collections.ledger.find({ accountId }).toArray();
        const sum = rows.reduce((total, row) => total + fromDecimal(row.amount), 0n);
        return { balance: fromDecimal(account!.balance), rows, sum };
    }

    return { database, bus, ledger, trader, service, offered, seedAccount, state, config, logger };
}

export async function until(check: () => Promise<boolean>, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out");
}
