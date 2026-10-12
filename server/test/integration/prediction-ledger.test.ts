import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { connectDatabase, isDuplicateKey, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { isAppError } from "../../src/errors.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);

let database: Database;
let ledger: Ledger;
beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus: new Bus(),
        logger: pino({ level: "silent" }),
        minDeposit: 0n,
    });
});
afterAll(() => database.close());

let nextIndex = 1;
async function seedAccount(usdc: string) {
    const { accounts, ledger: entries } = database.collections;
    const _id = new ObjectId();
    const now = new Date();
    const amount = wei(usdc);
    const index = nextIndex++;
    await accounts.insertOne({
        _id,
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: index,
        depositAddress: `0x${index.toString(16).padStart(40, "0")}`,
        balance: toDecimal(amount),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    });
    await entries.insertOne({
        _id: new ObjectId(),
        accountId: _id,
        kind: "deposit",
        amount: toDecimal(amount),
        balanceAfter: toDecimal(amount),
        refId: new ObjectId(),
        createdAt: now,
    });
    return _id;
}

const debit = (accountId: ObjectId, usdc: string, refId = new ObjectId()) =>
    ledger.runInTransaction((session) => ledger.debitInSession(session, accountId, wei(usdc), "prediction_buy", refId));

async function ledgerState(accountId: ObjectId) {
    const account = await database.collections.accounts.findOne({ _id: accountId });
    const rows = await database.collections.ledger.find({ accountId }).toArray();
    const sum = rows.reduce((total, row) => total + fromDecimal(row.amount), 0n);
    return { balance: fromDecimal(account!.balance), version: account!.version, rows, sum };
}

test("a debit takes the balance down and writes one prediction_buy row", async () => {
    const id = await seedAccount("10");
    const refId = new ObjectId();
    const account = await debit(id, "4", refId);

    expect(fromDecimal(account.balance)).toBe(wei("6"));
    const state = await ledgerState(id);
    expect(state.balance).toBe(wei("6"));
    expect(state.version).toBe(2);
    const buys = state.rows.filter((row) => row.kind === "prediction_buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ refId, accountId: id });
    expect(fromDecimal(buys[0]!.amount)).toBe(-wei("4"));
    expect(fromDecimal(buys[0]!.balanceAfter)).toBe(wei("6"));
    expect(state.sum).toBe(state.balance);
});

test("a debit larger than the balance throws insufficient_funds and changes nothing", async () => {
    const id = await seedAccount("3");
    const error = await debit(id, "3.000000000000000001").catch((e: unknown) => e);

    expect(isAppError(error) && error.code).toBe("insufficient_funds");
    const state = await ledgerState(id);
    expect(state.balance).toBe(wei("3"));
    expect(state.version).toBe(1);
    expect(state.rows).toHaveLength(1);
});

test("two concurrent debits that together exceed the balance: exactly one succeeds", async () => {
    const id = await seedAccount("10");
    const results = await Promise.allSettled([debit(id, "6"), debit(id, "6")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const state = await ledgerState(id);
    expect(state.balance).toBe(wei("4"));
    expect(state.balance).toBeGreaterThanOrEqual(0n);
    expect(state.sum).toBe(state.balance);
});

test("a second credit of the same kind and refId is rejected by ref_unique", async () => {
    const id = await seedAccount("1");
    const refId = new ObjectId();
    const credit = () =>
        ledger.runInTransaction((session) => ledger.creditInSession(session, id, wei("2"), "prediction_refund", refId));

    const first = await credit();
    expect(fromDecimal(first.balance)).toBe(wei("3"));
    const error = await credit().catch((e: unknown) => e);
    expect(isDuplicateKey(error)).toBe(true);
    const state = await ledgerState(id);
    expect(state.balance).toBe(wei("3"));
    expect(state.sum).toBe(state.balance);
});

test("a debit or credit of zero or less throws and writes nothing", async () => {
    const id = await seedAccount("3");
    for (const amount of [0n, -1n]) {
        await expect(
            ledger.runInTransaction((session) =>
                ledger.debitInSession(session, id, amount, "prediction_buy", new ObjectId()),
            ),
        ).rejects.toThrow();
        await expect(
            ledger.runInTransaction((session) =>
                ledger.creditInSession(session, id, amount, "prediction_refund", new ObjectId()),
            ),
        ).rejects.toThrow();
    }
    const state = await ledgerState(id);
    expect(state.balance).toBe(wei("3"));
    expect(state.version).toBe(1);
    expect(state.rows).toHaveLength(1);
});
