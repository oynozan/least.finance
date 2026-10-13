import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino, type Logger } from "pino";
import { createTestClient, getAddress, http, parseUnits, publicActions, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { FORWARD_HOOK_DATA } from "../../src/withdrawals/cctp-burn.ts";
import { Payouts } from "../../src/withdrawals/payouts.ts";
import { solanaBytes32 } from "../../src/withdrawals/solana-recipient.ts";
import { withdrawalView } from "../../src/withdrawals/views.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";
import { installStub } from "../support/stub-token-messenger.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TOKEN_MESSENGER: Address = "0x00000000000000000000000000000000000a11ce";
const USDC_VIEW: Address = "0x00000000000000000000000000000000000b0b01";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const USDC_ACCOUNT = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
const MINUTE = 60_000;

let database: Database;
let ledger: Ledger;
let bus: Bus;
let iris: FakeIris;
let messenger: Awaited<ReturnType<typeof installStub>>;
let usdc: Awaited<ReturnType<typeof installStub>>;
let clock = Date.now();
const quiet = pino({ level: "silent" });
const signer = createKeyring(MNEMONIC).operator();
const chain = createTestClient({
    chain: arcChain([inject("anvilUrl")]),
    mode: "anvil",
    transport: http(inject("anvilUrl")),
    pollingInterval: 50,
}).extend(publicActions);
let seeded = 0;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    bus = new Bus();
    ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger: quiet,
        minDeposit: 0n,
    });
    iris = await startFakeIris();
    await chain.setBalance({ address: signer.address, value: wei("1000") });
    messenger = await installStub(inject("anvilUrl"), TOKEN_MESSENGER);
    usdc = await installStub(inject("anvilUrl"), USDC_VIEW);
});
afterAll(async () => {
    await iris.stop();
    await database.close();
});

const worker = (extra: Partial<ConstructorParameters<typeof Payouts>[0]> = {}) =>
    new Payouts({
        collections: database.collections,
        ledger,
        client: chain,
        signer,
        bus,
        logger: quiet,
        pollMs: 100,
        iris: createIris({ baseUrl: iris.url }),
        tokenMessenger: TOKEN_MESSENGER,
        usdc: USDC_VIEW,
        now: () => clock,
        ...extra,
    });

async function seedAccount(balance = "0") {
    const now = new Date();
    const account = {
        _id: new ObjectId(),
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: 5000 + ++seeded,
        depositAddress: `0x${String(seeded + 9000).padStart(40, "0")}`,
        balance: toDecimal(wei(balance)),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.accounts.insertOne(account);
    return account;
}

type SeedOptions = { setup?: boolean; state?: "sending" | "forwarding"; burnTxHash?: Hex; updatedAt?: Date };

/** A Solana withdrawal whose `usdc` already left the account's balance. */
async function seedSolana(amount: string, options: SeedOptions = {}) {
    const account = await seedAccount();
    const at = options.updatedAt ?? new Date(clock);
    const withdrawal = {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        amount: toDecimal(wei(amount)),
        to: WALLET,
        network: "solana" as const,
        state: options.state ?? ("sending" as const),
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        solana: {
            wallet: WALLET,
            usdcAccount: USDC_ACCOUNT,
            setup: options.setup ?? false,
            fee: toDecimal(parseUnits("0.127", 18)),
            maxFee: toDecimal(parseUnits("0.15", 18)),
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: options.burnTxHash ?? null,
            forwardTxHash: null,
            irisCheckedAt: null,
        },
        createdAt: at,
        updatedAt: at,
    };
    await database.collections.withdrawals.insertOne(withdrawal);
    return { account, withdrawal };
}

async function seedArc(amount: string) {
    const account = await seedAccount();
    const to = privateKeyToAddress(generatePrivateKey());
    const withdrawal = {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        amount: toDecimal(wei(amount)),
        to: to.toLowerCase(),
        state: "sending" as const,
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    await database.collections.withdrawals.insertOne(withdrawal);
    return { withdrawal, to };
}

const stateOf = async (id: ObjectId) => (await database.collections.withdrawals.findOne({ _id: id }))!;
const balanceOf = async (id: ObjectId) =>
    fromDecimal((await database.collections.accounts.findOne({ _id: id }))!.balance);
const refunds = (id: ObjectId) => database.collections.ledger.countDocuments({ refId: id, kind: "withdrawal_refund" });
const messageRequests = () => iris.requests().filter((url) => url.startsWith("/v2/messages/")).length;
const isolated = async () => {
    await database.collections.withdrawals.updateMany(
        { state: { $in: ["sending", "forwarding"] } },
        { $set: { state: "sent" } },
    );
    await messenger.revertCalls(false);
    await usdc.revertCalls(false);
    iris.failWith(null);
};

test("approve then burn go out in nonce order, the stub records the right domain, mintRecipient, maxFee and hook data, with and without setup", async () => {
    await isolated();
    const plain = await seedSolana("9");
    const withSetup = await seedSolana("4", { setup: true });
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });

    await worker().tick();

    const approves = (await usdc.calls()).filter((call) => call.name === "approve");
    const burns = await messenger.calls();
    expect(approves.map((call) => call.name === "approve" && call.amount)).toEqual([9_000_000n, 4_000_000n]);
    expect(approves[0]).toMatchObject({ spender: getAddress(TOKEN_MESSENGER) });
    expect(burns).toHaveLength(2);
    expect(burns[0]).toMatchObject({
        amount: 9_000_000n,
        destinationDomain: 5,
        mintRecipient: solanaBytes32(USDC_ACCOUNT),
        burnToken: getAddress(USDC_VIEW),
        destinationCaller: `0x${"00".repeat(32)}`,
        maxFee: 150_000n,
        minFinalityThreshold: 2000,
        hookData: FORWARD_HOOK_DATA,
    });
    expect(burns[1]).toMatchObject({ amount: 4_000_000n, mintRecipient: solanaBytes32(USDC_ACCOUNT) });
    expect(burns[1]!.name === "depositForBurnWithHook" && burns[1]!.hookData).toHaveLength(2 + 65 * 2);
    expect(burns[1]!.name === "depositForBurnWithHook" && burns[1]!.hookData).toContain(solanaBytes32(WALLET).slice(2));

    const a = await stateOf(plain.withdrawal._id);
    const b = await stateOf(withSetup.withdrawal._id);
    expect([a.solana!.approveNonce, a.solana!.burnNonce, b.solana!.approveNonce, b.solana!.burnNonce]).toEqual([
        nonceBefore,
        nonceBefore + 1,
        nonceBefore + 2,
        nonceBefore + 3,
    ]);
    expect(a.state).toBe("forwarding");
});

test("both raw transactions and hashes are stored before either is broadcast", async () => {
    await isolated();
    const { withdrawal } = await seedSolana("2");
    const seen: object[] = [];
    await worker({
        broadcast: async (rawTx) => {
            const doc = await stateOf(withdrawal._id);
            seen.push({
                approveRawTx: doc.solana!.approveRawTx !== null,
                approveTxHash: doc.solana!.approveTxHash !== null,
                burnRawTx: doc.solana!.burnRawTx !== null,
                burnTxHash: doc.solana!.burnTxHash !== null,
            });
            return chain.sendRawTransaction({ serializedTransaction: rawTx });
        },
    }).tick();

    expect(seen).toHaveLength(2);
    for (const entry of seen) {
        expect(entry).toEqual({ approveRawTx: true, approveTxHash: true, burnRawTx: true, burnTxHash: true });
    }
});

test("the state goes sending to forwarding when the burn is mined, then to sent when Iris returns forwardTxHash, which is stored", async () => {
    await isolated();
    const { withdrawal } = await seedSolana("3");
    const states: string[] = [];
    const listener = ({ withdrawal: moved }: { withdrawal: { _id: ObjectId; state: string } }) => {
        if (moved._id.equals(withdrawal._id)) states.push(moved.state);
    };
    bus.on("withdrawal:updated", listener);
    const payouts = worker();

    await payouts.tick();
    const burning = await stateOf(withdrawal._id);
    expect(burning.state).toBe("forwarding");
    expect(burning.solana!.burnTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.getTransactionReceipt({ hash: burning.solana!.burnTxHash! })).status).toBe("success");

    iris.setPending(burning.solana!.burnTxHash!);
    await payouts.tick();
    expect((await stateOf(withdrawal._id)).state).toBe("forwarding");

    clock += 2_000;
    iris.setForwarded(burning.solana!.burnTxHash!, "5ForwardSig");
    await payouts.tick();
    bus.off("withdrawal:updated", listener);

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("sent");
    expect(done.solana!.forwardTxHash).toBe("5ForwardSig");
    expect(states).toEqual(["forwarding", "sent"]);
    expect(await refunds(withdrawal._id)).toBe(0);
});

test("a refused approve ends failed with exactly one withdrawal_refund", async () => {
    await isolated();
    const { account, withdrawal } = await seedSolana("5");
    const payouts = worker({
        broadcast: async () => {
            throw new Error("insufficient funds for gas * price + value");
        },
    });
    await payouts.tick();
    await payouts.tick();

    expect((await stateOf(withdrawal._id)).state).toBe("failed");
    expect(await balanceOf(account._id)).toBe(wei("5"));
    expect(await refunds(withdrawal._id)).toBe(1);
});

test("a reverted burn ends failed with one refund", async () => {
    await isolated();
    const { account, withdrawal } = await seedSolana("5");
    await messenger.revertCalls(true);
    const payouts = worker();
    await payouts.tick();
    await payouts.tick();
    await messenger.revertCalls(false);

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("failed");
    expect(await balanceOf(account._id)).toBe(wei("5"));
    expect(await refunds(withdrawal._id)).toBe(1);
});

test("a burn mined and then Iris down for a long time never refunds and stays forwarding", async () => {
    await isolated();
    const { account, withdrawal } = await seedSolana("6");
    const payouts = worker();
    await payouts.tick();
    iris.failWith(503);

    for (let hour = 0; hour < 12; hour++) {
        clock += 60 * MINUTE;
        await payouts.tick();
    }

    expect((await stateOf(withdrawal._id)).state).toBe("forwarding");
    expect(await balanceOf(account._id)).toBe(0n);
    expect(await refunds(withdrawal._id)).toBe(0);
    iris.failWith(null);
});

test("Iris answering 429 backs off and leaves the state unchanged", async () => {
    await isolated();
    const { withdrawal } = await seedSolana("2");
    const payouts = worker();
    await payouts.tick();
    const hash = (await stateOf(withdrawal._id)).solana!.burnTxHash!;
    iris.setForwarded(hash, "5Sig");
    iris.failWith(429);
    const before = messageRequests();

    clock += 2_000;
    await payouts.tick();
    expect(messageRequests()).toBe(before + 1);
    clock += 2_000;
    await payouts.tick();
    expect(messageRequests()).toBe(before + 1);
    expect((await stateOf(withdrawal._id)).state).toBe("forwarding");

    iris.failWith(null);
    clock += 10 * MINUTE;
    await payouts.tick();
    expect((await stateOf(withdrawal._id)).state).toBe("sent");
});

test("restart in sending with stored raw transactions re-sends the same bytes and the person is paid once", async () => {
    await isolated();
    const { withdrawal } = await seedSolana("3");
    const approvesBefore = (await usdc.calls()).length;
    const burnsBefore = (await messenger.calls()).length;
    const first = worker({
        broadcast: async (rawTx) => {
            await chain.sendRawTransaction({ serializedTransaction: rawTx });
            throw new Error("fetch failed");
        },
    });
    await first.tick();
    const signed = await stateOf(withdrawal._id);
    expect(signed.state).toBe("sending");
    expect(signed.solana!.burnRawTx).not.toBeNull();

    await worker().tick();

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("forwarding");
    expect(done.solana!.approveRawTx).toBe(signed.solana!.approveRawTx);
    expect(done.solana!.burnRawTx).toBe(signed.solana!.burnRawTx);
    expect((await usdc.calls()).length - approvesBefore).toBe(1);
    expect((await messenger.calls()).length - burnsBefore).toBe(1);
});

test("restart in forwarding resumes polling from the stored burn hash and sends nothing", async () => {
    await isolated();
    const burnTxHash: Hex = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const { withdrawal } = await seedSolana("3", { state: "forwarding", burnTxHash });
    iris.setForwarded(burnTxHash, "5Resumed");
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });

    await worker().tick();

    const done = await stateOf(withdrawal._id);
    expect(done.state).toBe("sent");
    expect(done.solana!.forwardTxHash).toBe("5Resumed");
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore);
});

test("Arc and Solana withdrawals interleaved take distinct nonces", async () => {
    await isolated();
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const arcA = await seedArc("1");
    const sol = await seedSolana("2");
    const arcB = await seedArc("1");

    await worker().tick();

    const a = await stateOf(arcA.withdrawal._id);
    const s = await stateOf(sol.withdrawal._id);
    const b = await stateOf(arcB.withdrawal._id);
    expect([a.state, s.state, b.state]).toEqual(["sent", "forwarding", "sent"]);
    const nonces = [a.nonce, s.solana!.approveNonce, s.solana!.burnNonce, b.nonce];
    expect(new Set(nonces).size).toBe(4);
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 4);
});

test("forwarding for 15 minutes shows the delayed flag and logs 'Solana withdrawal stalled' once an hour", async () => {
    await isolated();
    const burnTxHash: Hex = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const { withdrawal } = await seedSolana("3", { state: "forwarding", burnTxHash, updatedAt: new Date(clock) });
    iris.setPending(burnTxHash);
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const payouts = worker({ logger });

    clock += 14 * MINUTE;
    await payouts.tick();
    expect(error).not.toHaveBeenCalled();
    expect(withdrawalView(await stateOf(withdrawal._id), clock).delayed).toBe(false);

    clock += 2 * MINUTE;
    await payouts.tick();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![1]).toBe("Solana withdrawal stalled");
    expect(withdrawalView(await stateOf(withdrawal._id), clock).delayed).toBe(true);

    clock += 30 * MINUTE;
    await payouts.tick();
    expect(error).toHaveBeenCalledTimes(1);

    clock += 31 * MINUTE;
    await payouts.tick();
    expect(error).toHaveBeenCalledTimes(2);
    expect((await stateOf(withdrawal._id)).state).toBe("forwarding");
});

test("Iris reporting the forward failed logs the full response at error and does not refund", async () => {
    await isolated();
    const burnTxHash: Hex = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const { account, withdrawal } = await seedSolana("3", { state: "forwarding", burnTxHash });
    iris.setForwardFailed(burnTxHash);
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

    await worker({ logger }).tick();

    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).toContain("FAILED");
    expect((await stateOf(withdrawal._id)).state).toBe("forwarding");
    expect(await balanceOf(account._id)).toBe(0n);
    expect(await refunds(withdrawal._id)).toBe(0);
});

test("Iris is asked at most once per tick and at most 5 times per second in total", async () => {
    await isolated();
    for (let i = 0; i < 8; i++) {
        const burnTxHash: Hex = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
        await seedSolana("1", { state: "forwarding", burnTxHash });
        iris.setPending(burnTxHash);
    }
    const payouts = worker();
    const before = messageRequests();
    let last = before;
    for (let tick = 0; tick < 8; tick++) {
        await payouts.tick();
        const now = messageRequests();
        expect(now - last).toBeLessThanOrEqual(1);
        last = now;
    }
    expect(last - before).toBe(5);

    clock += 1_000;
    await payouts.tick();
    expect(messageRequests() - last).toBe(1);
});
