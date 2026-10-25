import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterEach, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { readFees } from "../../src/stats/fees.ts";
import { toUnitsDecimal } from "../../src/trading/units.ts";

const open: Database[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
});

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 25, 12);
const cents = (n: number) => toUnitsDecimal(BigInt(Math.round(n * 100)) * 10n ** 16n);

async function fresh() {
    const database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    open.push(database);
    return database;
}

const trade = (requestId: string, at: number, spread?: number) =>
    ({
        _id: new ObjectId(),
        accountId: new ObjectId(),
        requestId,
        verb: "buy",
        symbol: "ETH",
        toSymbol: null,
        paidSymbol: "USDC",
        paidUnits: cents(1),
        gotSymbol: "ETH",
        gotUnits: cents(1),
        usd: cents(1),
        priceUSD: "1",
        toPriceUSD: null,
        ...(spread === undefined ? {} : { spreadUSD: cents(spread) }),
        hedged: false,
        createdAt: new Date(at),
    }) as never;

const position = (at: number, ourFee?: bigint) =>
    ({
        _id: new ObjectId(),
        accountId: new ObjectId(),
        index: 1,
        asset: "BTC",
        side: "long",
        leverage: 2,
        sizeCoin: "1",
        entryPx: "1",
        collateral: toDecimal(0n),
        openedFee: toDecimal(0n),
        ...(ourFee === undefined ? {} : { ourFee: toDecimal(ourFee) }),
        state: "open",
        active: false,
        proceeds: null,
        realizedPnl: null,
        closeReason: null,
        openedAt: new Date(at),
        createdAt: new Date(at),
        updatedAt: new Date(at),
    }) as never;

test("fees add up by range from spread and perp fees", async () => {
    const { collections } = await fresh();
    await collections.trades.insertMany([
        trade("a", now - DAY, 0.3),
        trade("b", now - 40 * DAY, 0.6),
        trade("c", now - DAY),
    ]);
    await collections.perpPositions.insertMany([position(now - DAY, 1_000_000n), position(now - DAY)]);
    const fees = await readFees({ collections, now });
    expect(fees["7D"]).toEqual({ totalUsd: 1.3, spreadUsd: 0.3, perpUsd: 1 });
    expect(fees["30D"]).toEqual({ totalUsd: 1.3, spreadUsd: 0.3, perpUsd: 1 });
    expect(fees.All).toEqual({ totalUsd: 1.9, spreadUsd: 0.9, perpUsd: 1 });
});

test("no fees is zero in every range", async () => {
    const { collections } = await fresh();
    const zero = { totalUsd: 0, spreadUsd: 0, perpUsd: 0 };
    expect(await readFees({ collections, now })).toEqual({ "7D": zero, "30D": zero, All: zero });
});
