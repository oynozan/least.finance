import { randomUUID } from "node:crypto";
import { Decimal128, ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { ActivityFeed } from "../../src/pnl/feed.ts";
import { PnlService } from "../../src/pnl/pnl.ts";
import type { PnlPoint } from "../../src/protocol.ts";
import { seedRows } from "../support/history-seed.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const ago = (days: number) => new Date(NOW - days * DAY);

let database: Database;
let service: PnlService;
let feed: ActivityFeed;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const logger = pino({ level: "silent" });
    service = new PnlService({ collections: database.collections, logger, now: () => NOW });
    feed = new ActivityFeed({ collections: database.collections, logger, now: () => NOW });
});
afterAll(() => database.close());

/** `spread` is the dollars the fill gave up; trades filled before the spread have none, so most of these leave it out. */
type Fill = { spread?: string } & (
    | { verb: "buy"; symbol: string; usd: string; units: string; at: Date }
    | { verb: "sell"; symbol: string; units: string; usd: string; at: Date }
    | { verb: "swap"; symbol: string; units: string; toSymbol: string; toUnits: string; usd: string; at: Date }
);

async function fill(accountId: ObjectId, trade: Fill): Promise<ObjectId> {
    const dec = Decimal128.fromString;
    const paid =
        trade.verb === "buy" ? { symbol: "USDC", units: trade.usd } : { symbol: trade.symbol, units: trade.units };
    const got =
        trade.verb === "buy"
            ? { symbol: trade.symbol, units: trade.units }
            : trade.verb === "sell"
              ? { symbol: "USDC", units: trade.usd }
              : { symbol: trade.toSymbol, units: trade.toUnits };
    const { insertedId } = await database.collections.trades.insertOne({
        _id: new ObjectId(),
        accountId,
        requestId: randomUUID(),
        verb: trade.verb,
        symbol: trade.symbol,
        toSymbol: trade.verb === "swap" ? trade.toSymbol : null,
        paidSymbol: paid.symbol,
        paidUnits: dec(paid.units),
        gotSymbol: got.symbol,
        gotUnits: dec(got.units),
        usd: dec(trade.usd),
        priceUSD: "1",
        toPriceUSD: null,
        ...(trade.spread === undefined ? {} : { spreadUSD: dec(trade.spread) }),
        hedged: false,
        createdAt: trade.at,
    });
    return insertedId;
}

const days = async (accountId: ObjectId): Promise<PnlPoint[]> =>
    (await service.series(accountId, "UTC", NOW)).ranges["7D"].points;

test("a buy does not change the balance", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [{ kind: "deposit", usdc: "100", at: ago(6) }]);
    await fill(id, { verb: "buy", symbol: "BNB", usd: "40", units: "0.08", at: ago(2) });

    const points = await days(id);

    expect(points.map((point) => point.balance)).toEqual(Array(7).fill("100"));
    expect(points.map((point) => point.pnl)).toEqual(Array(7).fill("0"));
    expect(points.map((point) => point.net)).toEqual(["100", ...Array(6).fill("0")]);
});

test("a buy then a sell at a higher price shows the gain once, on the day of the sell", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [{ kind: "deposit", usdc: "100", at: ago(6) }]);
    await fill(id, { verb: "buy", symbol: "BNB", usd: "40", units: "0.08", at: ago(4) });
    await fill(id, { verb: "sell", symbol: "BNB", units: "0.08", usd: "50", at: ago(1) });

    const points = await days(id);

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "0", "0", "10", "0"]);
    expect(points.map((point) => point.balance)).toEqual(["100", "100", "100", "100", "100", "110", "110"]);
});

test("two buys at different prices average the basis", async () => {
    const id = new ObjectId();
    await fill(id, { verb: "buy", symbol: "BNB", usd: "10", units: "1", at: ago(5) });
    await fill(id, { verb: "buy", symbol: "BNB", usd: "30", units: "1", at: ago(4) });
    await fill(id, { verb: "sell", symbol: "BNB", units: "1", usd: "30", at: ago(1) });

    const points = await days(id);

    // The average cost is 20 a coin, so selling one for 30 gains 10
    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "0", "0", "10", "0"]);
});

test("a partial sell keeps the remaining basis for the next sell", async () => {
    const id = new ObjectId();
    await fill(id, { verb: "buy", symbol: "BNB", usd: "40", units: "4", at: ago(5) });
    await fill(id, { verb: "sell", symbol: "BNB", units: "1", usd: "15", at: ago(3) });
    await fill(id, { verb: "sell", symbol: "BNB", units: "3", usd: "36", at: ago(1) });

    const points = await days(id);

    // 15 against a basis of 10 gains 5, then 36 against the remaining 30 gains 6
    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "5", "0", "6", "0"]);
    expect(points.at(-1)!.balance).toBe("11");
});

test("a swap realizes the gain on the coin given up and starts the new coin at that value", async () => {
    const id = new ObjectId();
    await fill(id, { verb: "buy", symbol: "BNB", usd: "40", units: "0.08", at: ago(5) });
    await fill(id, {
        verb: "swap",
        symbol: "BNB",
        units: "0.08",
        toSymbol: "ETH",
        toUnits: "0.02",
        usd: "55",
        at: ago(3),
    });
    await fill(id, { verb: "sell", symbol: "ETH", units: "0.02", usd: "60", at: ago(1) });

    const points = await days(id);

    // The swap gains 55 - 40, and the ETH then sells for 5 over its 55 basis
    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "15", "0", "5", "0"]);
    expect(points.at(-1)!.balance).toBe("20");
});

test("activity rows carry the realized PnL of a sell or swap and nothing for a buy", async () => {
    const id = new ObjectId();
    const buy = await fill(id, { verb: "buy", symbol: "BNB", usd: "40", units: "0.08", at: ago(5) });
    const swap = await fill(id, {
        verb: "swap",
        symbol: "BNB",
        units: "0.04",
        toSymbol: "ETH",
        toUnits: "0.01",
        usd: "30",
        at: ago(3),
    });
    const sell = await fill(id, { verb: "sell", symbol: "BNB", units: "0.04", usd: "18", at: ago(1) });

    const page = await feed.page(id, {});
    const realized = new Map(
        page.items.flatMap((item) => (item.kind === "trade" ? [[item.trade.id, item.trade.realized]] : [])),
    );

    expect(realized.get(buy.toHexString())).toBeUndefined();
    expect(realized.get(swap.toHexString())).toBe("10");
    expect(realized.get(sell.toHexString())).toBe("-2");
});

test("a buy costs what was paid for the coins, so a round trip at an unchanged market price loses the spread", async () => {
    const id = new ObjectId();
    // BNB at $600 buys 0.1 coins for $60.18 at the ask and sells them for $59.82 at the bid
    const buy = await fill(id, { verb: "buy", symbol: "BNB", usd: "60.18", units: "0.1", spread: "0.18", at: ago(4) });
    const sell = await fill(id, {
        verb: "sell",
        symbol: "BNB",
        units: "0.1",
        usd: "59.82",
        spread: "0.18",
        at: ago(1),
    });

    const points = await days(id);
    const page = await feed.page(id, {});
    const realized = new Map(
        page.items.flatMap((item) => (item.kind === "trade" ? [[item.trade.id, item.trade.realized]] : [])),
    );

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "0", "0", "-0.36", "0"]);
    expect(realized.get(buy.toHexString())).toBeUndefined();
    expect(realized.get(sell.toHexString())).toBe("-0.36");
});

test("a swap realizes its net of the spread and starts the new coin at what the coin given up fetched", async () => {
    const id = new ObjectId();
    await fill(id, { verb: "buy", symbol: "BNB", usd: "60.18", units: "0.1", spread: "0.18", at: ago(5) });
    // Half the BNB, at its bid of $598.20, is $29.91 against a basis of $30.09
    const swap = await fill(id, {
        verb: "swap",
        symbol: "BNB",
        units: "0.05",
        toSymbol: "USDT",
        toUnits: "29.91",
        usd: "29.91",
        spread: "0.09",
        at: ago(3),
    });
    // The USDT sells at its own bid of $0.997 a coin: $29.82027 against that basis of $29.91
    const sell = await fill(id, {
        verb: "sell",
        symbol: "USDT",
        units: "29.91",
        usd: "29.82027",
        spread: "0.08973",
        at: ago(1),
    });

    const points = await days(id);
    const page = await feed.page(id, {});
    const realized = new Map(
        page.items.flatMap((item) => (item.kind === "trade" ? [[item.trade.id, item.trade.realized]] : [])),
    );

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "-0.18", "0", "-0.08973", "0"]);
    expect(realized.get(swap.toHexString())).toBe("-0.18");
    expect(realized.get(sell.toHexString())).toBe("-0.08973");
});
