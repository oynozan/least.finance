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
let seeded = 0;
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

async function seedAccount(usdc: string) {
    const _id = new ObjectId();
    const now = new Date();
    await database.collections.accounts.insertOne({
        _id,
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: ++seeded,
        depositAddress: `0x${String(seeded).padStart(40, "0")}`,
        balance: toDecimal(wei(usdc)),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    });
    return _id;
}

const balanceOf = async (id: ObjectId) =>
    fromDecimal((await database.collections.accounts.findOne({ _id: id }))!.balance);

test("a withdrawal debit and its refund each happen once", async () => {
    const id = await seedAccount("10");
    const ref = new ObjectId();

    await ledger.runInTransaction((s) => ledger.debitInSession(s, id, 5n * 10n ** 18n, "withdrawal", ref));
    expect(await balanceOf(id)).toBe(5n * 10n ** 18n);

    await ledger.runInTransaction((s) => ledger.creditInSession(s, id, 5n * 10n ** 18n, "withdrawal_refund", ref));
    expect(await balanceOf(id)).toBe(10n * 10n ** 18n);

    const again = ledger.runInTransaction((s) =>
        ledger.creditInSession(s, id, 5n * 10n ** 18n, "withdrawal_refund", ref),
    );
    await expect(again).rejects.toSatisfy(isDuplicateKey);
    expect(await balanceOf(id)).toBe(10n * 10n ** 18n);

    const rows = await database.collections.ledger.find({ accountId: id }).toArray();
    expect(rows.map((row) => row.kind).sort()).toEqual(["withdrawal", "withdrawal_refund"]);
});

test("a withdrawal above the balance is refused", async () => {
    const id = await seedAccount("1");
    const attempt = ledger.runInTransaction((s) =>
        ledger.debitInSession(s, id, 2n * 10n ** 18n, "withdrawal", new ObjectId()),
    );
    await expect(attempt).rejects.toSatisfy((error) => isAppError(error) && error.code === "insufficient_funds");
    expect(await balanceOf(id)).toBe(10n ** 18n);
});

test("the withdrawals collection is indexed for lookups, repeats and the payout worker", async () => {
    const indexes = await database.collections.withdrawals.indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));
    expect(byName.request_unique).toMatchObject({ key: { accountId: 1, requestId: 1 }, unique: true });
    expect(byName.account_withdrawals?.key).toEqual({ accountId: 1, _id: -1 });
    expect(byName.state_created?.key).toEqual({ state: 1, createdAt: 1 });
});
