import { randomUUID } from "node:crypto";
import { Decimal128, ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import {
    connectDatabase,
    isDuplicateKey,
    type Database,
    type PoolRebalanceDoc,
    type PoolRebalanceState,
} from "../../src/db/mongo.ts";

let database: Database;
beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
});
afterAll(() => database.close());

const zero = Decimal128.fromString("0");

function row(state: PoolRebalanceState, active: boolean): PoolRebalanceDoc {
    const now = new Date();
    return {
        _id: new ObjectId(),
        kind: "move",
        direction: "arc_to_polygon",
        source: "operator",
        reason: "operator",
        amountE6: Decimal128.fromString("10000000"),
        maxFeeE6: zero,
        reservedE6: zero,
        ...(active ? { active: true as const } : {}),
        state,
        attempts: 0,
        nextAt: null,
        lastError: null,
        mintRecipient: null,
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        resolvedAt: null,
        arc: {
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: null,
        },
        polygon: {
            attemptedAt: null,
            relayerTransactionId: null,
            relayerFinalAt: null,
            burnTxHash: null,
            burnLogSeen: null,
            wrapAttemptedAt: null,
            wrapTransactionId: null,
            wrapSubmittedAt: null,
            wrapFinalAt: null,
            mintedE6: null,
            balanceBeforeE6: null,
        },
        iris: { checkedAt: null, forwardTxHash: null, feeExecutedE6: null, delayReason: null },
    };
}

test("a second active row is a duplicate key", async () => {
    const { poolRebalances } = database.collections;
    await poolRebalances.insertOne(row("queued", true));
    const second = poolRebalances.insertOne(row("queued", true));
    await expect(second).rejects.toSatisfy(isDuplicateKey);
    await expect(second).rejects.toThrow(/one_active/);
    expect(await poolRebalances.countDocuments({ active: true })).toBe(1);
});

test("rows without active never collide", async () => {
    const { poolRebalances } = database.collections;
    const before = await poolRebalances.countDocuments({ state: "done" });
    await poolRebalances.insertOne(row("done", false));
    await poolRebalances.insertOne(row("done", false));
    expect(await poolRebalances.countDocuments({ state: "done" })).toBe(before + 2);
});

test("unsetting active frees the slot", async () => {
    const { poolRebalances } = database.collections;
    await poolRebalances.deleteMany({ active: true });
    const first = row("queued", true);
    await poolRebalances.insertOne(first);
    await expect(poolRebalances.insertOne(row("queued", true))).rejects.toSatisfy(isDuplicateKey);

    await poolRebalances.updateOne({ _id: first._id }, { $set: { state: "failed" }, $unset: { active: "" } });
    await poolRebalances.insertOne(row("queued", true));
    expect(await poolRebalances.countDocuments({ active: true })).toBe(1);
});

test("the state and direction indexes exist", async () => {
    const names = (await database.collections.poolRebalances.indexes()).map((index) => index.name);
    expect(names).toEqual(expect.arrayContaining(["state_created", "direction_created", "one_active"]));
});
