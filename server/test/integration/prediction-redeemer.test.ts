import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { PositionDoc, PositionState, PredictionOrderDoc } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { PredictionReconciler } from "../../src/predictions/reconciler.ts";
import { PredictionRedeemer } from "../../src/predictions/redeemer.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

const TEN_MINUTES = 600_000;
let clock = 1_000_000;
let h: Awaited<ReturnType<typeof predictionHarness>>;
let redeemer: PredictionRedeemer;
let reconciler: PredictionReconciler;
const logs: { level: number; msg: string; tokenId?: string; ledgerE6?: number; poolE6?: number }[] = [];
const WARN = 40;
const ERROR = 50;

beforeAll(async () => {
    h = await predictionHarness({ now: () => clock });
    const logger = pino({ level: "debug" }, { write: (line: string) => void logs.push(JSON.parse(line)) });
    redeemer = new PredictionRedeemer({
        collections: h.database.collections,
        service: h.service,
        trader: () => h.trader,
        logger,
        intervalMs: 0,
        now: () => clock,
    });
    reconciler = new PredictionReconciler({
        collections: h.database.collections,
        trader: () => h.trader,
        logger,
        intervalMs: 0,
    });
});
afterAll(() => h.database.close());

let counter = 0;
const unique = () => `${Date.now()}${counter++}`;

async function queue(conditionId: string) {
    const now = new Date(clock);
    await h.database.collections.predictionRedemptions.insertOne({
        _id: new ObjectId(),
        conditionId,
        marketId: "mkt-1",
        state: "pending",
        transactionId: null,
        attempts: 0,
        nextAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
    });
}
const redemption = (conditionId: string) =>
    h.database.collections.predictionRedemptions.findOne({ conditionId }).then((row) => row!);

async function position(tokenId: string, sharesE6: bigint, state: PositionState, conditionId = `0xc-${tokenId}`) {
    const now = new Date();
    const doc: PositionDoc = {
        _id: new ObjectId(),
        accountId: new ObjectId(),
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId,
        conditionId,
        question: "Will it rain?",
        outcome: "YES",
        shares: toDecimal(sharesE6),
        cost: toDecimal(wei("1")),
        state,
        proceeds: null,
        payout: null,
        openedAt: now,
        settledAt: null,
        updatedAt: now,
    };
    await h.database.collections.positions.insertOne(doc);
    return doc;
}

const mismatches = (tokenId: string) => logs.filter((l) => l.level === ERROR && l.tokenId === tokenId);

test("a pending redemption is submitted, then confirmed", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);

    await redeemer.tick();
    const submitted = await redemption(conditionId);
    expect(submitted.state).toBe("submitted");
    expect(submitted.transactionId).toBeTruthy();
    expect(h.trader.redeems).toEqual(expect.arrayContaining([conditionId]));

    // Still waiting on the relayer
    await redeemer.tick();
    expect((await redemption(conditionId)).state).toBe("submitted");

    h.trader.confirm(submitted.transactionId!);
    await redeemer.tick();
    expect((await redemption(conditionId)).state).toBe("confirmed");
    expect(h.trader.redeems.filter((c) => c === conditionId)).toHaveLength(1);
});

test("a failed redemption is retried after 10 minutes, then logged at error from the 6th attempt", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    const levels = () => logs.filter((l) => /redemption/i.test(l.msg)).map((l) => l.level);
    const before = levels().length;

    for (let attempt = 1; attempt <= 6; attempt++) {
        h.trader.failNextRedeem();
        await redeemer.tick();
        const row = await redemption(conditionId);
        expect(row).toMatchObject({ state: "failed", attempts: attempt });
        expect(row.nextAt.getTime()).toBe(clock + TEN_MINUTES);

        // Not before its time
        const calls = h.trader.redeems.length;
        clock += TEN_MINUTES - 1;
        await redeemer.tick();
        expect(h.trader.redeems).toHaveLength(calls);
        clock += 1;
    }
    expect(levels().slice(before)).toEqual([WARN, WARN, WARN, WARN, WARN, ERROR]);

    await redeemer.tick();
    const retried = await redemption(conditionId);
    expect(retried.state).toBe("submitted");
    h.trader.confirm(retried.transactionId!);
    await redeemer.tick();
    expect((await redemption(conditionId)).state).toBe("confirmed");
});

test("a transaction the relayer fails is retried the same way", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    await redeemer.tick();
    const submitted = await redemption(conditionId);
    h.trader.failTransaction(submitted.transactionId!);
    await redeemer.tick();
    expect(await redemption(conditionId)).toMatchObject({ state: "failed", attempts: 1 });
    expect((await redemption(conditionId)).nextAt.getTime()).toBe(clock + TEN_MINUTES);
});

test("reconciliation logs a mismatch and stays quiet within 0.1 share", async () => {
    const token = `tok-${unique()}`;
    await position(token, 10_000_000n, "open");
    await position(token, 5_000_000n, "closing");
    // Closed, won and lost positions are not in the ledger
    await position(token, 7_000_000n, "closed");

    h.trader.setHoldings([{ tokenId: token, sharesE6: 15_000_000n }]);
    await reconciler.tick();
    h.trader.setHoldings([{ tokenId: token, sharesE6: 15_100_000n }]);
    await reconciler.tick();
    h.trader.setHoldings([{ tokenId: token, sharesE6: 14_900_000n }]);
    await reconciler.tick();
    // Under the Data API's dust floor a token is missing from the holdings altogether
    const dust = `tok-${unique()}`;
    await position(dust, 50_000n, "open");
    await reconciler.tick();
    expect(mismatches(token)).toHaveLength(0);
    expect(mismatches(dust)).toHaveLength(0);

    h.trader.setHoldings([{ tokenId: token, sharesE6: 15_100_001n }]);
    await reconciler.tick();
    expect(mismatches(token)).toHaveLength(1);
    expect(mismatches(token)[0]).toMatchObject({ tokenId: token, ledgerE6: 15_000_000, poolE6: 15_100_001 });

    // Tokens nobody holds a position in are a mismatch too
    const stray = `tok-${unique()}`;
    h.trader.setHoldings([{ tokenId: stray, sharesE6: 3_000_000n }]);
    await reconciler.tick();
    expect(mismatches(stray)).toHaveLength(1);
});

test("reconciliation skips tokens with an in-flight order or an unconfirmed redemption", async () => {
    const busy = `tok-${unique()}`;
    await position(busy, 10_000_000n, "open");
    const now = new Date();
    const order: PredictionOrderDoc = {
        _id: new ObjectId(),
        accountId: new ObjectId(),
        requestId: `req-${unique()}`,
        side: "buy",
        eventId: EVENT,
        marketId: "mkt-1",
        tokenId: busy,
        conditionId: `0xc-${busy}`,
        question: "Will it rain?",
        outcome: "YES",
        amount: toDecimal(wei("1")),
        shares: null,
        quotedPrice: 0.5,
        limitPrice: 0.52,
        positionId: null,
        orderHash: null,
        clobOrderId: null,
        signed: null,
        state: "posted",
        reason: null,
        filledShares: null,
        cost: null,
        postedAt: now,
        createdAt: now,
        updatedAt: now,
    };
    await h.database.collections.predictionOrders.insertOne(order);

    const won = `tok-${unique()}`;
    const conditionId = `0xcond-${unique()}`;
    await position(won, 10_000_000n, "won", conditionId);
    await queue(conditionId);

    h.trader.setHoldings([
        { tokenId: busy, sharesE6: 20_000_000n },
        { tokenId: won, sharesE6: 10_000_000n },
    ]);
    await reconciler.tick();
    expect(mismatches(busy)).toHaveLength(0);
    expect(mismatches(won)).toHaveLength(0);

    await h.database.collections.predictionOrders.updateOne({ _id: order._id }, { $set: { state: "filled" } });
    await h.database.collections.predictionRedemptions.updateOne({ conditionId }, { $set: { state: "confirmed" } });
    h.trader.setHoldings([
        { tokenId: busy, sharesE6: 20_000_000n },
        { tokenId: won, sharesE6: 10_000_000n },
    ]);
    await reconciler.tick();
    expect(mismatches(busy)).toHaveLength(1);
    expect(mismatches(won)).toHaveLength(1);
});

test("the dust a sell leaves with the pool does not trip reconciliation, however many positions leave it", async () => {
    await h.service.refreshFloat();
    const account = await h.seedAccount("90");
    const sold = await position(TOKEN, 20_123_456n, "open", "0xcondition");
    await h.database.collections.positions.updateOne({ _id: sold._id }, { $set: { accountId: account._id } });
    const view = await h.service.close(account, {
        requestId: crypto.randomUUID(),
        positionId: sold._id.toHexString(),
        quotedPrice: 0.48,
    });
    await until(async () => {
        const order = await h.database.collections.predictionOrders.findOne({ requestId: view.requestId });
        return order?.state === "filled";
    });
    expect((await h.database.collections.positions.findOne({ _id: sold._id }))!.state).toBe("closed");

    // The 0.003456 of the sold position stays with the pool, next to a position still open
    await position(TOKEN, 8_000_000n, "open", "0xcondition");
    h.trader.setHoldings([{ tokenId: TOKEN, sharesE6: 8_003_456n }]);
    await reconciler.tick();
    expect(mismatches(TOKEN)).toHaveLength(0);

    // Eleven more sells each leave nearly 0.01, and together they pass the 0.1 floor
    for (let i = 0; i < 11; i++) await position(TOKEN, 5_009_999n, "closed", "0xcondition");
    h.trader.setHoldings([{ tokenId: TOKEN, sharesE6: 8_003_456n + 11n * 9_999n }]);
    await reconciler.tick();
    expect(mismatches(TOKEN)).toHaveLength(0);

    h.trader.setHoldings([{ tokenId: TOKEN, sharesE6: 8_003_456n + 11n * 9_999n + 100_001n }]);
    await reconciler.tick();
    expect(mismatches(TOKEN)).toHaveLength(1);
});
