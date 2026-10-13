import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { PositionDoc, PositionState, PredictionOrderDoc } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { PredictionReconciler } from "../../src/predictions/reconciler.ts";
import { PredictionRedeemer } from "../../src/predictions/redeemer.ts";
import { withTimeouts } from "../../src/predictions/trader.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

const TEN_MINUTES = 600_000;
const HOUR = 3_600_000;
const SIX_HOURS = 21_600_000;
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
    // Redemptions left over from other tests would take the fake trader's one-shot failures
    await h.database.collections.predictionRedemptions.updateMany({}, { $set: { state: "confirmed" } });
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

test("a failed redemption is retried after 10 minutes, then logged at error from the 6th attempt, which waits an hour", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    const levels = () => logs.filter((l) => /redemption/i.test(l.msg)).map((l) => l.level);
    const before = levels().length;

    for (let attempt = 1; attempt <= 6; attempt++) {
        h.trader.failNextRedeem();
        await redeemer.tick();
        const row = await redemption(conditionId);
        expect(row).toMatchObject({ state: "failed", attempts: attempt });
        const wait = attempt < 6 ? TEN_MINUTES : HOUR;
        expect(row.nextAt.getTime()).toBe(clock + wait);

        // Not before its time
        const calls = h.trader.redeems.length;
        clock += wait - 1;
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

const MINUTE = 60_000;
const redeemsOf = (conditionId: string) => h.trader.redeems.filter((c) => c === conditionId);

/** A queued redemption whose condition the pool still holds tokens of. */
async function queueHeld(conditionId: string) {
    const tokenId = `tok-${unique()}`;
    await position(tokenId, 5_000_000n, "won", conditionId);
    h.trader.setHoldings([{ tokenId, sharesE6: 5_000_000n }]);
    await queue(conditionId);
    return tokenId;
}

/** Fails the redeem `count` times, moving the clock to each retry but the last. */
async function failRedeems(conditionId: string, count: number) {
    const waits: number[] = [];
    for (let i = 0; i < count; i++) {
        h.trader.failNextRedeem();
        await redeemer.tick();
        const row = await redemption(conditionId);
        waits.push(row.nextAt.getTime() - clock);
        if (i < count - 1) clock = row.nextAt.getTime();
    }
    return waits;
}

test("a submitted redemption pending for 30 minutes gets a fresh transaction", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queueHeld(conditionId);
    await redeemer.tick();
    const first = await redemption(conditionId);
    expect(first.state).toBe("submitted");
    expect(first.submittedAt?.getTime()).toBe(clock);

    clock += 29 * MINUTE;
    await redeemer.tick();
    expect((await redemption(conditionId)).transactionId).toBe(first.transactionId);

    clock += 2 * MINUTE;
    await redeemer.tick();
    const second = await redemption(conditionId);
    expect(redeemsOf(conditionId)).toHaveLength(2);
    expect(second).toMatchObject({ state: "submitted", attempts: 1, previousTransactions: [first.transactionId] });
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(second.submittedAt?.getTime()).toBe(clock);
});

test("an old transaction that lands after the abandon changes nothing", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queueHeld(conditionId);
    await redeemer.tick();
    const first = await redemption(conditionId);
    clock += 31 * MINUTE;
    await redeemer.tick();
    const second = await redemption(conditionId);

    h.trader.confirm(first.transactionId!);
    await redeemer.tick();
    expect((await redemption(conditionId)).state).toBe("submitted");

    h.trader.confirm(second.transactionId!);
    await redeemer.tick();
    await redeemer.tick();
    expect(await redemption(conditionId)).toMatchObject({ state: "confirmed", transactionId: second.transactionId });
    expect(redeemsOf(conditionId)).toHaveLength(2);
});

test("holdings showing the tokens gone confirm the redemption instead of resubmitting", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queueHeld(conditionId);
    await redeemer.tick();
    clock += 31 * MINUTE;
    h.trader.setHoldings([]);
    await redeemer.tick();
    const row = await redemption(conditionId);
    expect(row.state).toBe("confirmed");
    expect(row.lastError).toMatch(/^confirmed by holdings/);
    expect(redeemsOf(conditionId)).toHaveLength(1);
});

test("ten failed lookups in a row expire the transaction, and one good answer resets the count", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queueHeld(conditionId);
    await redeemer.tick();
    const first = await redemption(conditionId);

    h.trader.failTransactionCheck();
    for (let i = 0; i < 3; i++) await redeemer.tick();
    expect((await redemption(conditionId)).checkErrors).toBe(3);
    h.trader.failTransactionCheck(false);
    await redeemer.tick();
    expect((await redemption(conditionId)).checkErrors).toBe(0);

    h.trader.failTransactionCheck();
    for (let i = 0; i < 9; i++) await redeemer.tick();
    expect(await redemption(conditionId)).toMatchObject({ state: "submitted", checkErrors: 9 });
    await redeemer.tick();
    h.trader.failTransactionCheck(false);
    const row = await redemption(conditionId);
    expect(row).toMatchObject({ state: "submitted", attempts: 1, previousTransactions: [first.transactionId] });
    expect(row.transactionId).not.toBe(first.transactionId);
    expect(redeemsOf(conditionId)).toHaveLength(2);
});

test("a redeem that keeps failing backs off 10 min, 1 h, then 6 h", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    const waits = await failRedeems(conditionId, 10);
    expect(waits).toEqual([...Array(5).fill(TEN_MINUTES), ...Array(4).fill(HOUR), SIX_HOURS]);
});

test("the tenth failure moves the row to stuck and logs at error", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    await failRedeems(conditionId, 9);
    const ninth = await redemption(conditionId);
    expect(ninth.state).toBe("failed");
    clock = ninth.nextAt.getTime();
    const before = logs.length;
    h.trader.failNextRedeem();
    await redeemer.tick();
    const row = await redemption(conditionId);
    expect(row).toMatchObject({ state: "stuck", attempts: 10 });
    expect(row.stuckAt?.getTime()).toBe(clock);
    const stuck = logs.slice(before).filter((l) => l.msg === "Redemption stuck: needs an operator");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ level: ERROR, condition: conditionId, attempts: 10 });
});

test("a stuck redemption is retried every 6 hours and recovers to confirmed", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    await failRedeems(conditionId, 10);
    const stuckAt = (await redemption(conditionId)).stuckAt;
    expect(stuckAt).toBeTruthy();

    // Not before its time
    clock += SIX_HOURS - 1;
    await redeemer.tick();
    expect(redeemsOf(conditionId)).toHaveLength(0);
    clock += 1;

    const before = logs.length;
    h.trader.failNextRedeem();
    await redeemer.tick();
    const again = await redemption(conditionId);
    expect(again).toMatchObject({ state: "stuck", attempts: 11 });
    expect(again.stuckAt).toEqual(stuckAt);
    expect(again.nextAt.getTime()).toBe(clock + SIX_HOURS);
    expect(logs.slice(before).some((l) => l.level === ERROR && l.msg === "Redemption stuck: needs an operator")).toBe(
        true,
    );

    clock += SIX_HOURS;
    await redeemer.tick();
    const submitted = await redemption(conditionId);
    expect(submitted.state).toBe("submitted");
    h.trader.confirm(submitted.transactionId!);
    await redeemer.tick();
    expect(await redemption(conditionId)).toMatchObject({ state: "confirmed", stuckAt: null });
    expect(logs.some((l) => l.msg === "Redemption recovered")).toBe(true);
});

test("stuck redemptions are reported on each reconciler pass, and the redeemer logs them at most every 10 minutes", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    await failRedeems(conditionId, 10);
    h.trader.setHoldings([]);

    const before = logs.length;
    await reconciler.tick();
    await reconciler.tick();
    const reported = (msg: string) => logs.slice(before).filter((l) => l.level === ERROR && l.msg === msg);
    expect(reported("Redemptions are stuck")).toHaveLength(2);

    const mark = logs.length;
    await redeemer.tick();
    await redeemer.tick();
    expect(logs.slice(mark).filter((l) => l.msg === "Redemptions are stuck")).toHaveLength(0);
    clock += 11 * MINUTE;
    await redeemer.tick();
    await redeemer.tick();
    expect(logs.slice(mark).filter((l) => l.msg === "Redemptions are stuck")).toHaveLength(1);
});

test("two redeemer ticks in parallel submit once", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    await Promise.all([redeemer.tick(), redeemer.tick()]);
    expect(redeemsOf(conditionId)).toHaveLength(1);
    expect((await redemption(conditionId)).state).toBe("submitted");
});

test("a timed-out redeem is a failure, not a lost row", async () => {
    const conditionId = `0xcond-${unique()}`;
    await queue(conditionId);
    const bounded = new PredictionRedeemer({
        collections: h.database.collections,
        service: h.service,
        trader: () => withTimeouts(h.trader, 20),
        logger: pino({ level: "silent" }),
        intervalMs: 0,
        now: () => clock,
    });
    h.trader.hangNextRedeem();
    await bounded.tick();
    expect(await redemption(conditionId)).toMatchObject({
        state: "failed",
        attempts: 1,
        lastError: "redeem timed out",
    });
});
