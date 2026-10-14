import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { createTestClient, http, parseUnits, publicActions, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { Payouts } from "../../src/withdrawals/payouts.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const MNEMONIC = "test test test test test test test test test test test junk";

let database: Database;
let ledger: Ledger;
let bus: Bus;
const logger = pino({ level: "silent" });
const signer = createKeyring(MNEMONIC).operator();
const chain = createTestClient({
    chain: arcChain([inject("anvilUrl")]),
    mode: "anvil",
    transport: http(inject("anvilUrl")),
}).extend(publicActions);
let seeded = 0;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    bus = new Bus();
    ledger = new Ledger({ client: database.client, collections: database.collections, bus, logger, minDeposit: 0n });
    await chain.setBalance({ address: signer.address, value: wei("1000") });
});
afterAll(() => database.close());

const worker = (extra: Partial<ConstructorParameters<typeof Payouts>[0]> = {}) =>
    new Payouts({
        collections: database.collections,
        ledger,
        client: chain,
        signer,
        bus,
        logger,
        pollMs: 100,
        ...extra,
    });

/** An account whose `usdc` already left its balance for a sending withdrawal to a fresh recipient. */
async function seedWithdrawal(usdc: string, balance = "0") {
    const now = new Date();
    const account = {
        _id: new ObjectId(),
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: 1000 + ++seeded,
        depositAddress: `0x${String(seeded).padStart(40, "0")}`,
        balance: toDecimal(wei(balance)),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.accounts.insertOne(account);
    const to = privateKeyToAddress(generatePrivateKey());
    const withdrawal = {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        amount: toDecimal(wei(usdc)),
        to: to.toLowerCase(),
        state: "sending" as const,
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.withdrawals.insertOne(withdrawal);
    return { account, withdrawal, to: to as Address };
}

const stateOf = async (id: ObjectId) => (await database.collections.withdrawals.findOne({ _id: id }))!;
const balanceOf = async (id: ObjectId) =>
    fromDecimal((await database.collections.accounts.findOne({ _id: id }))!.balance);
const refunds = (id: ObjectId) => database.collections.ledger.countDocuments({ refId: id, kind: "withdrawal_refund" });

test("a withdrawal is paid to the wallet and ends sent", async () => {
    const { withdrawal, to } = await seedWithdrawal("5");
    const before = await chain.getBalance({ address: signer.address });

    await worker().tick();

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("sent");
    expect(done.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await chain.getBalance({ address: to })).toBe(wei("5"));
    const fell = before - (await chain.getBalance({ address: signer.address }));
    expect(fell).toBeGreaterThan(wei("5"));
    expect(fell).toBeLessThan(wei("5.01"));
});

test("a refused broadcast fails the withdrawal and refunds once", async () => {
    const { account, withdrawal } = await seedWithdrawal("5");
    const payouts = worker({
        broadcast: async () => {
            throw new Error("insufficient funds for gas * price + value");
        },
    });

    await payouts.tick();
    await payouts.tick();

    expect((await stateOf(withdrawal._id)).state).toBe("failed");
    expect((await stateOf(withdrawal._id)).failure).toBeTruthy();
    expect(await balanceOf(account._id)).toBe(wei("5"));
    expect(await refunds(withdrawal._id)).toBe(1);
});

test("a reverted payout is refunded", async () => {
    const { account, withdrawal, to } = await seedWithdrawal("5");
    await chain.setCode({ address: to, bytecode: "0xfe" as Hex });
    const payouts = worker();

    await payouts.tick();
    await payouts.tick();

    expect((await stateOf(withdrawal._id)).state).toBe("failed");
    expect(await balanceOf(account._id)).toBe(wei("5"));
    expect(await refunds(withdrawal._id)).toBe(1);
});

test("a restart after signing re-sends the same transaction and pays once", async () => {
    const { withdrawal, to } = await seedWithdrawal("3");
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    // The broadcast reaches the node, and the worker is stopped before it looks for the receipt.
    const first: Payouts = worker({
        broadcast: async (rawTx) => {
            const hash = await chain.sendRawTransaction({ serializedTransaction: rawTx });
            void first.stop();
            return hash;
        },
    });
    first.start();
    await expect.poll(async () => chain.getBalance({ address: to })).toBe(wei("3"));
    await first.stop();
    const signed = await stateOf(withdrawal._id);
    expect(signed.state).toBe("sending");
    expect(signed.rawTx).not.toBeNull();
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 1);

    const second = worker();
    second.start();
    await expect.poll(async () => (await stateOf(withdrawal._id)).state).toBe("sent");
    await second.stop();

    const done = await stateOf(withdrawal._id);
    expect(done.txHash).toBe(signed.txHash);
    expect(done.rawTx).toBe(signed.rawTx);
    expect(done.nonce).toBe(signed.nonce);
    expect(await chain.getBalance({ address: to })).toBe(wei("3"));
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 1);
    const receipt = await chain.getTransactionReceipt({ hash: signed.txHash! });
    expect(receipt.status).toBe("success");
    expect(receipt.transactionHash).toBe(signed.txHash);
});

test("pushes arrive as sending, then sent", async () => {
    const { withdrawal } = await seedWithdrawal("1");
    const states: string[] = [];
    const listener = ({ withdrawal: moved }: { withdrawal: { _id: ObjectId; state: string } }) => {
        if (moved._id.equals(withdrawal._id)) states.push(moved.state);
    };
    bus.on("withdrawal:updated", listener);
    bus.emit("withdrawal:updated", { withdrawal: await stateOf(withdrawal._id), account: null });
    const payouts = worker();
    payouts.start();
    await expect.poll(() => states).toEqual(["sending", "sent"]);
    await payouts.stop();
    bus.off("withdrawal:updated", listener);
});

test("an unreachable broadcast stops the pass, so a later withdrawal never reuses its nonce", async () => {
    const a = await seedWithdrawal("2");
    const b = await seedWithdrawal("2");
    const down = worker({
        broadcast: async () => {
            throw new Error("fetch failed");
        },
    });

    await down.tick();

    expect((await stateOf(a.withdrawal._id)).rawTx).not.toBeNull();
    expect((await stateOf(b.withdrawal._id)).rawTx).toBeNull();

    await worker().tick();

    expect((await stateOf(a.withdrawal._id)).state).toBe("sent");
    expect((await stateOf(b.withdrawal._id)).state).toBe("sent");
    expect(await chain.getBalance({ address: a.to })).toBe(wei("2"));
    expect(await chain.getBalance({ address: b.to })).toBe(wei("2"));
});

test("an opaque broadcast error with the transaction unseen stops the pass, so a later withdrawal signs nothing", async () => {
    const a = await seedWithdrawal("2");
    const b = await seedWithdrawal("2");
    const payouts = worker({
        broadcast: async () => {
            throw new Error("txpool is full");
        },
    });

    await payouts.tick();

    expect((await stateOf(a.withdrawal._id)).rawTx).not.toBeNull();
    expect(await stateOf(b.withdrawal._id)).toMatchObject({ rawTx: null, nonce: null });
    await database.collections.withdrawals.deleteMany({ _id: { $in: [a.withdrawal._id, b.withdrawal._id] } });
});

test("a signed transaction whose nonce another transaction took is signed again, not awaited forever", async () => {
    const { withdrawal, to } = await seedWithdrawal("2");
    const first = worker({ broadcast: async () => "0x" as Hex });
    first.start();
    await expect.poll(async () => (await stateOf(withdrawal._id)).rawTx).not.toBeNull();
    await first.stop();
    const stale = await stateOf(withdrawal._id);
    expect(stale.rawTx).not.toBeNull();
    const other = privateKeyToAddress(generatePrivateKey());
    const hash = await chain.sendRawTransaction({
        serializedTransaction: await signer.signTransaction({
            type: "eip1559",
            chainId: chain.chain!.id,
            nonce: stale.nonce!,
            to: other,
            value: wei("1"),
            gas: 21_000n,
            maxFeePerGas: parseUnits("1000", 9),
            maxPriorityFeePerGas: parseUnits("1", 9),
        }),
    });
    await chain.waitForTransactionReceipt({ hash });

    const payouts = worker();
    await payouts.tick();
    expect((await stateOf(withdrawal._id)).rawTx).toBeNull();
    await payouts.tick();

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("sent");
    expect(done.nonce).not.toBe(stale.nonce);
    expect(await chain.getBalance({ address: to })).toBe(wei("2"));
});

test("an opaque broadcast error after the node took the transaction pays once and refunds nothing", async () => {
    const { account, withdrawal, to } = await seedWithdrawal("2");
    const payouts = worker({
        broadcast: async (rawTx) => {
            await chain.sendRawTransaction({ serializedTransaction: rawTx });
            throw new Error("internal error");
        },
    });

    await payouts.tick();

    expect((await stateOf(withdrawal._id)).state).toBe("sent");
    expect(await chain.getBalance({ address: to })).toBe(wei("2"));
    expect(await balanceOf(account._id)).toBe(0n);
    expect(await refunds(withdrawal._id)).toBe(0);
});

test("an opaque broadcast error with the transaction unseen is given several passes, then refunded once", async () => {
    const { account, withdrawal, to } = await seedWithdrawal("2");
    const payouts = worker({
        broadcast: async () => {
            throw new Error("txpool is full");
        },
    });

    for (let pass = 0; pass < 4; pass++) await payouts.tick();
    expect((await stateOf(withdrawal._id)).state).toBe("sending");
    expect(await balanceOf(account._id)).toBe(0n);

    await payouts.tick();
    await payouts.tick();

    expect((await stateOf(withdrawal._id)).state).toBe("failed");
    expect(await balanceOf(account._id)).toBe(wei("2"));
    expect(await refunds(withdrawal._id)).toBe(1);
    expect(await chain.getBalance({ address: to })).toBe(0n);
});
