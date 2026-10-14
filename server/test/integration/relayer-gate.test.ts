import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, expect, inject, test } from "vitest";
import {
    connectDatabase,
    type Collections,
    type Database,
    type PoolRebalanceDoc,
    type PredictionRedemptionDoc,
} from "../../src/db/mongo.ts";
import { GATE_SHUT_MS, RelayerGate } from "../../src/predictions/relayer-gate.ts";
import { poolRebalanceRow } from "../support/pool-rebalance-row.ts";

const MINUTE = 60_000;
let clock = Date.parse("2026-10-14T12:00:00Z");
let database: Database;
let gate: RelayerGate;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
});
afterAll(() => database.close());
beforeEach(async () => {
    await database.collections.poolRebalances.deleteMany({});
    await database.collections.predictionRedemptions.deleteMany({});
    gate = new RelayerGate({ collections: database.collections, now: () => clock });
});

async function rebalance(kind: PoolRebalanceDoc["kind"], polygon: Partial<PoolRebalanceDoc["polygon"]>) {
    const doc = poolRebalanceRow({ kind, now: new Date(clock), polygon });
    await database.collections.poolRebalances.insertOne(doc);
    return doc;
}

async function redemption(state: PredictionRedemptionDoc["state"]) {
    const now = new Date(clock);
    await database.collections.predictionRedemptions.insertOne({
        _id: new ObjectId(),
        conditionId: `0xcond-${randomUUID()}`,
        marketId: "mkt-1",
        state,
        transactionId: state === "submitted" ? "tx-1" : null,
        attempts: 0,
        nextAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
    });
}

const ago = (minutes: number) => new Date(clock - minutes * MINUTE);

/** Runs a submission that records that it ran. */
async function attempt(from: "redeemer" | "rebalancer") {
    let ran = false;
    const result = await gate.run(
        async () => {
            ran = true;
            return "sent";
        },
        { from },
    );
    return { result, ran };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a free gate runs the submission and returns its value", async () => {
    for (const from of ["redeemer", "rebalancer"] as const) {
        expect(await attempt(from)).toEqual({ result: { ran: true, value: "sent" }, ran: true });
    }
});

test("two submissions started at the same instant never overlap", async () => {
    const events: string[] = [];
    const submit = (name: string, ms: number) => async () => {
        events.push(`enter ${name}`);
        await delay(ms);
        events.push(`exit ${name}`);
        return name;
    };
    const [first, second, third] = await Promise.all([
        gate.run(submit("redeemer", 40), { from: "redeemer" }),
        gate.run(submit("rebalancer", 5), { from: "rebalancer" }),
        gate.run(submit("redeemer again", 0), { from: "redeemer" }),
    ]);
    expect(events).toEqual([
        "enter redeemer",
        "exit redeemer",
        "enter rebalancer",
        "exit rebalancer",
        "enter redeemer again",
        "exit redeemer again",
    ]);
    expect([first, second, third]).toEqual([
        { ran: true, value: "redeemer" },
        { ran: true, value: "rebalancer" },
        { ran: true, value: "redeemer again" },
    ]);
});

test("a submission that throws rejects its caller and frees the gate for the next one", async () => {
    const failing = gate.run(
        async () => {
            throw new Error("the relayer is busy");
        },
        { from: "redeemer" },
    );
    const waiting = attempt("rebalancer");
    await expect(failing).rejects.toThrow("the relayer is busy");
    expect((await waiting).ran).toBe(true);
});

test("a failing Mongo read rejects the run, runs nothing and frees the gate", async () => {
    const broken = {
        poolRebalances: {
            countDocuments: async () => {
                throw new Error("mongo is down");
            },
        },
        predictionRedemptions: { countDocuments: async () => 0 },
    } as unknown as Collections;
    const unreadable = new RelayerGate({ collections: broken, now: () => clock });
    let ran = false;
    const refused = unreadable.run(async () => void (ran = true), { from: "rebalancer" });
    await expect(refused).rejects.toThrow("mongo is down");
    await expect(unreadable.run(async () => void (ran = true), { from: "redeemer" })).rejects.toThrow("mongo is down");
    expect(ran).toBe(false);
});

test("a rebalance row with a relayer id and no relayerFinalAt blocks the redeemer", async () => {
    await rebalance("move", { attemptedAt: ago(30), relayerTransactionId: "tx-drain" });
    const blocked = await attempt("redeemer");
    expect(blocked).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    expect((await attempt("rebalancer")).result).toEqual({ ran: false, reason: "unconfirmed" });
});

test("a wrap id with no wrapFinalAt blocks it", async () => {
    await rebalance("move", { wrapAttemptedAt: ago(40), wrapTransactionId: "tx-wrap", wrapSubmittedAt: ago(40) });
    expect(await attempt("redeemer")).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    await rebalance("wrap_idle", { wrapTransactionId: "tx-idle", wrapSubmittedAt: ago(1) });
    expect((await attempt("redeemer")).result).toEqual({ ran: false, reason: "unconfirmed" });
});

test("an attempt 5 minutes old with no id blocks it and one 12 minutes old does not", async () => {
    const drain = await rebalance("move", { attemptedAt: ago(5) });
    expect(await attempt("redeemer")).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    await database.collections.poolRebalances.updateOne(
        { _id: drain._id },
        { $set: { "polygon.attemptedAt": ago(12) } },
    );
    expect(await attempt("redeemer")).toEqual({ result: { ran: true, value: "sent" }, ran: true });

    const wrap = await rebalance("move", { wrapAttemptedAt: ago(5) });
    expect(await attempt("redeemer")).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    await database.collections.poolRebalances.updateOne(
        { _id: wrap._id },
        { $set: { "polygon.wrapAttemptedAt": ago(12) } },
    );
    expect((await attempt("redeemer")).ran).toBe(true);
});

test("an attempt exactly 11 minutes old no longer blocks", async () => {
    await rebalance("move", { attemptedAt: ago(11) });
    expect((await attempt("redeemer")).ran).toBe(true);
    await database.collections.poolRebalances.deleteMany({});
    await rebalance("move", { attemptedAt: new Date(clock - GATE_SHUT_MS + 1) });
    expect((await attempt("redeemer")).ran).toBe(false);
});

test("a drain row with relayerFinalAt set and an id no longer blocks", async () => {
    await rebalance("move", { attemptedAt: ago(30), relayerTransactionId: "tx-drain", relayerFinalAt: ago(1) });
    expect((await attempt("redeemer")).ran).toBe(true);
    expect((await attempt("rebalancer")).ran).toBe(true);
});

test("a refused drain batch with relayerFinalAt set and a young attempt no longer blocks", async () => {
    await rebalance("move", { attemptedAt: ago(1), relayerFinalAt: ago(0) });
    expect((await attempt("redeemer")).ran).toBe(true);
});

test("a wrap whose id and attempt were cleared, or whose batch is final, does not block", async () => {
    await rebalance("move", { wrapAttemptedAt: null, wrapTransactionId: null, wrapSubmittedAt: ago(1) });
    await rebalance("move", { wrapAttemptedAt: ago(40), wrapTransactionId: "tx-wrap", wrapFinalAt: ago(2) });
    await rebalance("wrap_idle", { wrapAttemptedAt: ago(1), wrapFinalAt: ago(0) });
    expect((await attempt("redeemer")).ran).toBe(true);
    expect((await attempt("rebalancer")).ran).toBe(true);
});

test("a row that never sent a batch does not block", async () => {
    await rebalance("move", {});
    expect((await attempt("redeemer")).ran).toBe(true);
});

test("the rebalancer's own row with a young attempt and no id blocks the rebalancer too", async () => {
    const own = await rebalance("move", { attemptedAt: ago(2) });
    expect(await attempt("rebalancer")).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    await database.collections.poolRebalances.updateOne(
        { _id: own._id },
        { $set: { "polygon.attemptedAt": ago(11.5) } },
    );
    expect((await attempt("rebalancer")).ran).toBe(true);
});

test("a redemption in submitted blocks the rebalancer and not the redeemer", async () => {
    await redemption("submitted");
    expect(await attempt("rebalancer")).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
    expect(await attempt("redeemer")).toEqual({ result: { ran: true, value: "sent" }, ran: true });
    // Several redemptions go out one after another
    expect((await attempt("redeemer")).ran).toBe(true);
});

test("a redemption that is not submitted does not block the rebalancer", async () => {
    for (const state of ["pending", "failed", "stuck", "confirmed"] as const) await redemption(state);
    expect((await attempt("rebalancer")).ran).toBe(true);
});

test("shut() closes the gate for 11 minutes for both and then opens it", async () => {
    expect(GATE_SHUT_MS).toBe(11 * MINUTE);
    gate.shut();
    for (const from of ["redeemer", "rebalancer"] as const) {
        expect(await attempt(from)).toEqual({ result: { ran: false, reason: "shut" }, ran: false });
    }
    clock += 11 * MINUTE - 1;
    expect((await attempt("redeemer")).result).toEqual({ ran: false, reason: "shut" });
    clock += 1;
    expect((await attempt("redeemer")).ran).toBe(true);
    expect((await attempt("rebalancer")).ran).toBe(true);
});

test("a second shut() restarts the 11 minutes", async () => {
    gate.shut();
    clock += 6 * MINUTE;
    gate.shut();
    clock += 6 * MINUTE;
    expect((await attempt("redeemer")).result).toEqual({ ran: false, reason: "shut" });
    clock += 5 * MINUTE;
    expect((await attempt("redeemer")).ran).toBe(true);
});

test("a shut() made inside a submission refuses the one queued behind it", async () => {
    const first = gate.run(
        async () => {
            await delay(10);
            gate.shut();
            return "timed out";
        },
        { from: "redeemer" },
    );
    const second = attempt("redeemer");
    expect(await first).toEqual({ ran: true, value: "timed out" });
    expect(await second).toEqual({ result: { ran: false, reason: "shut" }, ran: false });
});

test("a submission queued behind another is checked only once it has the gate", async () => {
    const first = gate.run(
        async () => {
            await delay(20);
            // The batch the first submission sent is on the books by the time the second one looks
            await rebalance("move", { attemptedAt: new Date(clock), relayerTransactionId: "tx-first" });
            return "sent";
        },
        { from: "rebalancer" },
    );
    const second = attempt("redeemer");
    expect(await first).toEqual({ ran: true, value: "sent" });
    expect(await second).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
});

test("a rebalancer submission started while a redemption is mid-call waits for it and then sees it submitted", async () => {
    const first = gate.run(
        async () => {
            await delay(20);
            // The redeemer stores `submitted` only after its call returns
            await redemption("submitted");
            return "redeemed";
        },
        { from: "redeemer" },
    );
    const second = attempt("rebalancer");
    expect(await first).toEqual({ ran: true, value: "redeemed" });
    expect(await second).toEqual({ result: { ran: false, reason: "unconfirmed" }, ran: false });
});

test("a refused run leaves no side effect", async () => {
    const drain = await rebalance("move", { attemptedAt: ago(1), relayerTransactionId: "tx-drain" });
    await redemption("submitted");
    const before = {
        rebalances: await database.collections.poolRebalances.find({}).toArray(),
        redemptions: await database.collections.predictionRedemptions.find({}).toArray(),
    };
    expect((await attempt("redeemer")).ran).toBe(false);
    expect((await attempt("rebalancer")).ran).toBe(false);
    gate.shut();
    expect((await attempt("redeemer")).result).toEqual({ ran: false, reason: "shut" });
    expect(await database.collections.poolRebalances.find({}).toArray()).toEqual(before.rebalances);
    expect(await database.collections.predictionRedemptions.find({}).toArray()).toEqual(before.redemptions);

    // The gate is not left held: it opens as soon as the batch is final and the shutting runs out
    await database.collections.poolRebalances.updateOne(
        { _id: drain._id },
        { $set: { "polygon.relayerFinalAt": ago(0) } },
    );
    clock += GATE_SHUT_MS;
    expect((await attempt("redeemer")).ran).toBe(true);
});
