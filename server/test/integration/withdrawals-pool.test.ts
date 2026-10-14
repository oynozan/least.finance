import { randomUUID } from "node:crypto";
import { Decimal128, ObjectId } from "mongodb";
import { pino } from "pino";
import { createTestClient, http, parseUnits, publicActions, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { arcChain } from "../../src/chain/arc.ts";
import {
    connectDatabase,
    type Database,
    type PoolDirection,
    type PoolRebalanceDoc,
    type PoolRebalanceState,
} from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { Withdrawals, TREASURY_GAS_RESERVE } from "../../src/withdrawals/withdrawals.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const e6 = (usdc: string) => parseUnits(usdc, 6);
const TO = "0x1234567890123456789012345678901234567890" as Address;

let database: Database;
let withdrawals: Withdrawals;
let treasury: Address;
const chain = createTestClient({
    chain: arcChain([inject("anvilUrl")]),
    mode: "anvil",
    transport: http(inject("anvilUrl")),
}).extend(publicActions);
let seeded = 0;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const bus = new Bus();
    const logger = pino({ level: "silent" });
    const ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger,
        minDeposit: 0n,
    });
    treasury = privateKeyToAddress(generatePrivateKey());
    withdrawals = new Withdrawals({
        collections: database.collections,
        ledger,
        client: chain,
        treasury,
        bus,
        logger,
        minWithdraw: wei("0.01"),
    });
});
afterAll(() => database.close());

/** The treasury holds `usdc` beyond the gas reserve, and nothing else is owed. */
async function fundTreasury(usdc: string) {
    await database.collections.withdrawals.deleteMany({});
    await database.collections.poolRebalances.deleteMany({});
    await chain.setBalance({ address: treasury, value: wei(usdc) + TREASURY_GAS_RESERVE });
}

async function seedAccount(usdc: string) {
    const now = new Date();
    const account = {
        _id: new ObjectId(),
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: ++seeded,
        depositAddress: `0x${String(seeded).padStart(40, "0")}`,
        balance: toDecimal(wei(usdc)),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.accounts.insertOne(account);
    return account;
}

async function seedPool(direction: PoolDirection, state: PoolRebalanceState, usdc: string) {
    const now = new Date();
    const doc: PoolRebalanceDoc = {
        _id: new ObjectId(),
        kind: "move",
        direction,
        source: "operator",
        reason: "operator",
        amountE6: toDecimal(e6(usdc)),
        maxFeeE6: Decimal128.fromString("0"),
        reservedE6: Decimal128.fromString("0"),
        ...(state === "done" || state === "failed" ? {} : { active: true as const }),
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
    await database.collections.poolRebalances.insertOne(doc);
    return doc;
}

const request = (amount: string) => ({ requestId: randomUUID(), amount, to: TO });
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: { code?: string }) => error.code,
    );
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("treasuryFree subtracts an arc_to_polygon row in sending and not one in forwarding", async () => {
    await fundTreasury("100");
    expect(await withdrawals.treasuryFree()).toBe(wei("100"));

    const sending = await seedPool("arc_to_polygon", "sending", "30");
    expect(await withdrawals.treasuryFree()).toBe(wei("70"));

    await database.collections.poolRebalances.updateOne(
        { _id: sending._id },
        { $set: { state: "forwarding" }, $unset: { active: "" } },
    );
    expect(await withdrawals.treasuryFree()).toBe(wei("100"));
});

test("treasuryFree subtracts a top-up together with the withdrawals in sending", async () => {
    await fundTreasury("100");
    const account = await seedAccount("100");
    await withdrawals.create(account, request("20"));
    await seedPool("arc_to_polygon", "sending", "30");

    expect(await withdrawals.treasuryFree()).toBe(wei("50"));
    expect((await withdrawals.limits(account)).max).toBe(wei("50"));
});

test("a polygon_to_arc row never subtracts", async () => {
    await fundTreasury("100");
    for (const state of ["queued", "sending", "submitting", "forwarding"] as const) {
        await database.collections.poolRebalances.deleteMany({});
        await seedPool("polygon_to_arc", state, "40");
        expect(await withdrawals.treasuryFree()).toBe(wei("100"));
    }
});

test("withTreasuryLock runs after an earlier create and before a later one", async () => {
    await fundTreasury("100");
    const account = await seedAccount("100");
    const rows = () => database.collections.withdrawals.countDocuments({});

    const first = withdrawals.create(account, request("10"));
    const seen: number[] = [];
    const held = withdrawals.withTreasuryLock(async () => {
        seen.push(await rows());
        await sleep(40);
        seen.push(await rows());
        return "held";
    });
    const last = withdrawals.create(account, request("10"));

    expect(await held).toBe("held");
    await Promise.all([first, last]);
    expect(seen).toEqual([1, 1]);
    expect(await rows()).toBe(2);
});

test("a throwing lock holder does not stop later creates", async () => {
    await fundTreasury("100");
    const account = await seedAccount("100");

    await expect(
        withdrawals.withTreasuryLock(async () => {
            throw new Error("boom");
        }),
    ).rejects.toThrow("boom");

    const made = await withdrawals.create(account, request("10"));
    expect(made.state).toBe("sending");
});

test("a withdrawal created while a top-up start holds the lock sees a treasuryFree that already subtracts the top-up, and is refused when it no longer fits", async () => {
    await fundTreasury("100");
    const account = await seedAccount("100");
    const queued = await seedPool("arc_to_polygon", "queued", "80");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let freeInside = 0n;
    const start = withdrawals.withTreasuryLock(async () => {
        freeInside = await withdrawals.treasuryFree();
        await database.collections.poolRebalances.updateOne({ _id: queued._id }, { $set: { state: "sending" } });
        entered();
        await gate;
    });
    await inside;

    const tooBig = withdrawals.create(account, request("50"));
    const fits = withdrawals.create(account, request("15"));
    await sleep(30);
    expect(await database.collections.withdrawals.countDocuments({})).toBe(0);

    release();
    await start;

    expect(freeInside).toBe(wei("100"));
    expect(await code(tooBig)).toBe("insufficient_funds");
    expect((await fits).state).toBe("sending");
    expect(fromDecimal((await database.collections.accounts.findOne({ _id: account._id }))!.balance)).toBe(wei("85"));
    expect(await withdrawals.treasuryFree()).toBe(wei("5"));
});
