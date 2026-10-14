import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits, type Address, type Hash } from "viem";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { NativeTransfer } from "../../src/chain/native-transfers.ts";
import type { AccountDoc, Collections, PerpPositionDoc, PositionDoc } from "../../src/db/mongo.ts";
import { formatUsdc, fromDecimal } from "../../src/db/money.ts";
import { createPolymarketData } from "../../src/markets/polymarket-data.ts";
import { PerpTracker } from "../../src/perps/tracker.ts";
import { PnlService } from "../../src/pnl/pnl.ts";
import { PredictionResolver } from "../../src/predictions/resolver.ts";
import { PredictionTracker } from "../../src/predictions/tracker.ts";
import type { PnlPoint, PnlRangeKey, PnlSeries } from "../../src/protocol.ts";
import { startFakePolymarket, type FakePolymarket } from "../support/fake-polymarket.ts";
import { seedRows } from "../support/history-seed.ts";
import { perpHarness, type PerpHarness } from "../support/perp-harness.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

const RANGES: PnlRangeKey[] = ["7D", "30D", "All"];
const logger = pino({ level: "silent" });

let h: Awaited<ReturnType<typeof predictionHarness>>;
let pnl: PnlService;
let fake: FakePolymarket;
let resolver: PredictionResolver;
let tracker: PredictionTracker;
beforeAll(async () => {
    h = await predictionHarness();
    await h.service.refreshFloat();
    pnl = new PnlService({ collections: h.database.collections, logger });
    fake = await startFakePolymarket();
    resolver = new PredictionResolver({
        collections: h.database.collections,
        ledger: h.ledger,
        data: createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url }),
        bus: h.bus,
        logger: h.logger,
        resolveMs: 0,
        needTrader: () => undefined,
    });
    tracker = new PredictionTracker({
        collections: h.database.collections,
        service: h.service,
        trader: () => h.trader,
        logger: h.logger,
        pollMs: 0,
    });
});
afterAll(async () => {
    await fake.stop();
    await h.database.close();
});

const perps: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(perps.splice(0).map((own) => own.close()));
});

type Owner = { database: { collections: Collections } };

/** The account's balance plus the cost of its prediction positions and the collateral of its perps still held */
async function cashPlusOpenCost(own: Owner, accountId: ObjectId): Promise<bigint> {
    const { accounts, positions, perpPositions } = own.database.collections;
    const account = await accounts.findOne({ _id: accountId });
    const held = await positions.find({ accountId, state: { $in: ["open", "closing"] } }).toArray();
    const margin = await perpPositions.find({ accountId, state: { $in: ["open", "closing"] } }).toArray();
    return (
        fromDecimal(account!.balance) +
        held.reduce((sum, position) => sum + fromDecimal(position.cost), 0n) +
        margin.reduce((sum, position) => sum + fromDecimal(position.collateral), 0n)
    );
}

const total = (points: PnlPoint[], key: "pnl" | "net") =>
    points.reduce((sum, point) => sum + parseUnits(point[key], 18), 0n);

/** Expects the last point of every range to be the account's cash plus its open cost, and returns the series */
async function expectSeriesAtLedger(service: PnlService, own: Owner, accountId: ObjectId): Promise<PnlSeries> {
    const expected = formatUsdc(await cashPlusOpenCost(own, accountId));
    const series = await service.series(accountId, "UTC");
    for (const range of RANGES) expect(series.ranges[range].points.at(-1)!.balance, range).toBe(expected);
    return series;
}

/** An account holding `usdc` with a matching deposit document, which the harness's ledger row alone does not give the series */
async function funded(own: Owner & { seedAccount: (usdc: string) => Promise<AccountDoc> }, usdc: string) {
    const account = await own.seedAccount(usdc);
    await seedRows(own.database.collections, account._id, [{ kind: "deposit", usdc, at: new Date() }]);
    return account;
}

const orderOf = (requestId: string) => h.database.collections.predictionOrders.findOne({ requestId });
const positionOf = (id: ObjectId) => h.database.collections.positions.findOne({ _id: id });
const settled = async (requestId: string) => {
    await until(async () => {
        const order = await orderOf(requestId);
        return order !== null && order.state !== "placing" && order.state !== "posted";
    });
    return (await orderOf(requestId))!;
};

/** A real buy that has filled, on the offered outcome unless another token is named */
async function buy(account: AccountDoc, usdc = "10", token?: { tokenId: string; marketId: string }) {
    const offered = h.offered.current!;
    if (token)
        h.offered.current = {
            ...offered,
            outcome: { ...offered.outcome, tokenId: token.tokenId },
            marketId: token.marketId,
        };
    try {
        const view = await h.service.place(account, {
            requestId: randomUUID(),
            eventId: EVENT,
            tokenId: token?.tokenId ?? TOKEN,
            amountUSD: usdc,
        });
        const order = await settled(view.requestId);
        expect(order.state).toBe("filled");
        return order;
    } finally {
        h.offered.current = offered;
    }
}

const heldPosition = async (account: AccountDoc, tokenId = TOKEN) =>
    (await h.database.collections.positions.findOne({ accountId: account._id, tokenId, state: "open" }))!;

const sell = (account: AccountDoc, position: PositionDoc) =>
    h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
        quotedPrice: 0.48,
    });

let next = 0;
/** A fresh market from the recording, so one test's resolution never reaches another's */
function market() {
    const all = [...fake.fixtures.top, ...fake.fixtures.extra].flatMap((event) => event.markets);
    const raw = all[next++]!;
    const [yes, no] = JSON.parse(raw.clobTokenIds) as string[];
    return { id: String(raw.id), yes: yes!, no: no! };
}

/** Moves a position onto a fresh market holding `side`'s token, resolves it for yes and lets the resolver settle it */
async function resolveFor(position: PositionDoc, side: "yes" | "no") {
    const m = market();
    await h.database.collections.positions.updateOne(
        { _id: position._id },
        { $set: { marketId: m.id, tokenId: side === "yes" ? m.yes : m.no, conditionId: `0xcondition-${m.id}` } },
    );
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();
}

test("buy then sell", async () => {
    const account = await funded(h, "100");
    await buy(account);
    const position = await heldPosition(account);
    await settled((await sell(account, position)).requestId);

    expect((await positionOf(position._id))!.state).toBe("closed");
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe("99.6");
    expect(total(series.ranges.All.points, "pnl")).toBe(wei("-0.4"));
});

test("buy then resolve won", async () => {
    const account = await funded(h, "100");
    await buy(account);
    const position = await heldPosition(account);
    await resolveFor(position, "yes");

    expect((await positionOf(position._id))!.state).toBe("won");
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe("110");
    expect(total(series.ranges.All.points, "pnl")).toBe(wei("10"));
});

test("buy then resolve lost", async () => {
    const account = await funded(h, "100");
    await buy(account);
    const position = await heldPosition(account);
    await resolveFor(position, "no");

    expect((await positionOf(position._id))!.state).toBe("lost");
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe("90");
    expect(total(series.ranges.All.points, "pnl")).toBe(wei("-10"));
});

async function freshPerp() {
    const own = await perpHarness();
    perps.push(own);
    own.fake.setMark("BTC", 65000);
    await own.markets.tick();
    await own.fundMaster("500");
    return own;
}

async function heldPerp(own: PerpHarness, account: AccountDoc) {
    const { order } = await own.place(account);
    await own.settled(order._id);
    return (await own.database.collections.perpPositions.findOne({ accountId: account._id }))! as PerpPositionDoc;
}

test("perp open then close", async () => {
    const own = await freshPerp();
    const service = new PnlService({ collections: own.database.collections, logger });
    const account = await funded(own, "1000");
    const position = await heldPerp(own, account);
    own.fake.setMark("BTC", 66000);

    const { order } = await own.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    await own.until(async () => (await own.orderOf(order._id)).state === "done");

    const closed = (await own.database.collections.perpPositions.findOne({ _id: position._id }))!;
    expect(closed.state).toBe("closed");
    const gain = fromDecimal(closed.proceeds!) - fromDecimal(closed.collateral);
    expect(gain).toBeGreaterThan(0n);
    const series = await expectSeriesAtLedger(service, own, account._id);
    expect(total(series.ranges.All.points, "pnl")).toBe(gain);
});

test("perp open then liquidation to zero", async () => {
    const own = await freshPerp();
    const service = new PnlService({ collections: own.database.collections, logger });
    const account = await funded(own, "1000");
    const position = await heldPerp(own, account);
    own.fake.liquidate(await own.addressOf(account._id), "BTC");
    await new PerpTracker({
        service: own.service,
        client: own.client,
        collections: own.database.collections,
        config: own.config,
        logger,
        bus: own.bus,
    }).pass(Date.now());

    const liquidated = (await own.database.collections.perpPositions.findOne({ _id: position._id }))!;
    expect(liquidated.state).toBe("liquidated");
    expect(fromDecimal(liquidated.proceeds!)).toBe(0n);
    const series = await expectSeriesAtLedger(service, own, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe(formatUsdc(wei("1000") - fromDecimal(position.collateral)));
    expect(total(series.ranges.All.points, "pnl")).toBe(-fromDecimal(position.collateral));
});

test("two buys, one sold: the balance is cash plus the cost of the one still open", async () => {
    const account = await funded(h, "100");
    await buy(account);
    await buy(account, "10", { tokenId: "tok-other", marketId: "mkt-other" });
    const sold = await heldPosition(account);
    await settled((await sell(account, sold)).requestId);

    const rest = await h.database.collections.positions.find({ accountId: account._id, state: "open" }).toArray();
    expect(rest.map((position) => position.tokenId)).toEqual(["tok-other"]);
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe("99.6");
});

/** A real $10 buy, a sell of it posted and held, a second $10 buy that fills while the sell is out, then the sell filling */
async function partialSale(account: AccountDoc) {
    await buy(account);
    const position = await heldPosition(account);
    h.trader.onNext(TOKEN, "delay");
    const view = await sell(account, position);
    await until(async () => (await orderOf(view.requestId))?.state === "posted");
    const posted = (await orderOf(view.requestId))!;
    await until(
        async () =>
            h.trader.posts.some((post) => post.orderHash === posted.orderHash) && !h.service.submitting(posted._id),
    );
    await buy(account);

    h.trader.settleDelayed(posted.orderHash!, "fill");
    await tracker.tick();
    return { position, order: (await orderOf(view.requestId))! };
}

test("a partial prediction sale: the balance is cash plus the remaining cost", async () => {
    const account = await funded(h, "100");
    const { position, order } = await partialSale(account);

    expect(order.soldPart).toBeDefined();
    expect((await positionOf(position._id))!.state).toBe("open");
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(series.ranges.All.points.at(-1)!.balance).toBe("99.6");
    expect(total(series.ranges.All.points, "pnl")).toBe(wei("-0.4"));
});

test("a partial sale and then a sale of the rest count each part once", async () => {
    const account = await funded(h, "100");
    const { position, order } = await partialSale(account);
    await settled((await sell(account, (await positionOf(position._id))!)).requestId);

    const closed = (await positionOf(position._id))!;
    expect(closed.state).toBe("closed");
    expect(await h.database.collections.positions.countDocuments({ accountId: account._id, state: "open" })).toBe(0);
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    const part = fromDecimal(order.soldPart!.proceeds) - fromDecimal(order.soldPart!.cost);
    const rest = fromDecimal(closed.proceeds!) - fromDecimal(closed.cost);
    expect(total(series.ranges.All.points, "pnl")).toBe(part + rest);
    expect(part + rest).toBe(wei("-0.8"));
    expect(series.ranges.All.points.at(-1)!.balance).toBe("99.2");
});

test("two deposits from one transaction each count once, and net equals the ledger's deposit entries", async () => {
    const account = await h.seedAccount("0");
    const txHash: Hash = `0x${"ab".repeat(32)}`;
    const transfer = (logIndex: number, usdc: string): NativeTransfer => ({
        txHash,
        logIndex,
        blockNumber: 1,
        blockHash: `0x${"cd".repeat(32)}`,
        from: `0x${"11".repeat(20)}`,
        to: account.depositAddress as Address,
        value: wei(usdc),
    });
    await h.ledger.credit(transfer(0, "7"), account._id, "scan");
    await h.ledger.credit(transfer(1, "5.5"), account._id, "scan");
    await h.ledger.credit(transfer(0, "7"), account._id, "scan");

    const { deposits, ledger } = h.database.collections;
    expect(await deposits.countDocuments({ accountId: account._id })).toBe(2);
    const entries = await ledger.find({ accountId: account._id, kind: "deposit" }).toArray();
    const series = await expectSeriesAtLedger(pnl, h, account._id);
    expect(total(series.ranges.All.points, "net")).toBe(
        entries.reduce((sum, row) => sum + fromDecimal(row.amount), 0n),
    );
    expect(total(series.ranges.All.points, "net")).toBe(wei("12.5"));
});
