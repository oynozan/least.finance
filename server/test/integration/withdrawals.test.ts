import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { createTestClient, http, parseUnits, publicActions, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { arcChain } from "../../src/chain/arc.ts";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { Withdrawals, TREASURY_GAS_RESERVE } from "../../src/withdrawals/withdrawals.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const TO = "0x1234567890123456789012345678901234567890" as Address;

let database: Database;
let withdrawals: Withdrawals;
let treasury: Address;
let bus: Bus;
const chain = createTestClient({
    chain: arcChain([inject("anvilUrl")]),
    mode: "anvil",
    transport: http(inject("anvilUrl")),
}).extend(publicActions);
let seeded = 0;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    bus = new Bus();
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

const balanceOf = async (id: ObjectId) =>
    fromDecimal((await database.collections.accounts.findOne({ _id: id }))!.balance);
const request = (amount: string) => ({ requestId: randomUUID(), amount, to: TO });
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: { code?: string }) => error.code,
    );

test("limits are the smaller of the balance and what the treasury can pay", async () => {
    const account = await seedAccount("100");
    await fundTreasury("30");
    expect(await withdrawals.limits(account)).toEqual({ max: wei("30"), min: wei("0.01") });
    await fundTreasury("500");
    expect((await withdrawals.limits(account)).max).toBe(wei("100"));
});

test("a withdrawal debits once and starts sending", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const events: unknown[] = [];
    bus.once("withdrawal:updated", (event) => events.push(event));

    const withdrawal = await withdrawals.create(account, request("25"));

    expect(withdrawal.state).toBe("sending");
    expect(withdrawal.to).toBe(TO);
    expect(fromDecimal(withdrawal.amount)).toBe(wei("25"));
    expect(await balanceOf(account._id)).toBe(wei("75"));
    const entries = await database.collections.ledger.find({ accountId: account._id, kind: "withdrawal" }).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.refId).toEqual(withdrawal._id);
    expect(events).toHaveLength(1);
    expect(await withdrawals.recent(account._id)).toHaveLength(1);
});

test("the same requestId twice makes one withdrawal", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const input = request("25");

    const [first, second] = await Promise.all([withdrawals.create(account, input), withdrawals.create(account, input)]);

    expect(second._id).toEqual(first._id);
    expect(await balanceOf(account._id)).toBe(wei("75"));
    const entries = await database.collections.ledger.countDocuments({ accountId: account._id, kind: "withdrawal" });
    expect(entries).toBe(1);
});

test("two withdrawals that together exceed the balance: one goes through", async () => {
    const account = await seedAccount("40");
    await fundTreasury("500");

    const results = await Promise.allSettled([
        withdrawals.create(account, request("30")),
        withdrawals.create(account, request("30")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason.code).toBe("insufficient_funds");
    expect(await balanceOf(account._id)).toBe(wei("10"));
});

test("a treasury that can't cover it refuses before debiting", async () => {
    const account = await seedAccount("100");
    await fundTreasury("20");

    const error = await withdrawals.create(account, request("50")).catch((caught: Error) => caught);

    expect(error).toMatchObject({
        code: "insufficient_funds",
        message: "Withdrawals can pay at most $20.00 right now. Nothing was taken.",
    });
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await database.collections.withdrawals.countDocuments({ accountId: account._id })).toBe(0);
});

test("two withdrawals at once can't overdraw the treasury", async () => {
    const [one, two] = [await seedAccount("100"), await seedAccount("100")];
    await fundTreasury("50");

    const results = await Promise.all([
        code(withdrawals.create(one, request("30"))),
        code(withdrawals.create(two, request("30"))),
    ]);

    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.filter((result) => result === "insufficient_funds")).toHaveLength(1);
    expect((await balanceOf(one._id)) + (await balanceOf(two._id))).toBe(wei("170"));
});

test("under the minimum, or more than 6 decimals, is a bad request", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");

    expect(await code(withdrawals.create(account, request("0.001")))).toBe("bad_request");
    expect(await code(withdrawals.create(account, request("1.1234567")))).toBe("bad_request");
    expect(await balanceOf(account._id)).toBe(wei("100"));
});

test("an amount of zero is a bad request, even where the minimum is zero", async () => {
    const logger = pino({ level: "silent" });
    const ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger,
        minDeposit: 0n,
    });
    const lax = new Withdrawals({
        collections: database.collections,
        ledger,
        client: chain,
        treasury,
        bus,
        logger,
        minWithdraw: 0n,
    });
    const account = await seedAccount("100");
    await fundTreasury("500");

    expect(await code(lax.create(account, request("0")))).toBe("bad_request");
    expect(await code(lax.create(account, request("0.000000")))).toBe("bad_request");
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await database.collections.withdrawals.countDocuments({ accountId: account._id })).toBe(0);
});
