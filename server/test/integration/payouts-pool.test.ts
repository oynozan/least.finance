import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ObjectId } from "mongodb";
import { pino, type Logger } from "pino";
import { createTestClient, getAddress, http, keccak256, parseGwei, parseUnits, publicActions, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import {
    connectDatabase,
    type Database,
    type PoolDirection,
    type PoolRebalanceDoc,
    type PoolRebalanceState,
} from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { FORWARD_HOOK_DATA } from "../../src/withdrawals/cctp-burn.ts";
import { Payouts } from "../../src/withdrawals/payouts.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";
import { installStub } from "../support/stub-token-messenger.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const e6 = (usdc: string) => parseUnits(usdc, 6);
const randomAddress = () => privateKeyToAddress(generatePrivateKey());
const TOKEN_MESSENGER = randomAddress();
const USDC_VIEW = randomAddress();
const POOL_WALLET = randomAddress();
const WALLET_BYTES32 = `0x${"00".repeat(12)}${POOL_WALLET.slice(2).toLowerCase()}`;
const MAX_FEE = 213_201n;
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const USDC_ACCOUNT = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";

let database: Database;
let ledger: Ledger;
let bus: Bus;
let iris: FakeIris;
let messenger: Awaited<ReturnType<typeof installStub>>;
let usdc: Awaited<ReturnType<typeof installStub>>;
let signing: ReturnType<typeof vi.spyOn>;
const clock = Date.now();
const quiet = pino({ level: "silent" });
const signer = createKeyring(generateMnemonic(wordlist)).operator();
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
    signing = vi.spyOn(signer, "signTransaction");
});
afterAll(async () => {
    signing.mockRestore();
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

type SeedOptions = {
    state?: PoolRebalanceState;
    direction?: PoolDirection | null;
    updatedAt?: Date;
    burnTxHash?: Hex;
    mintRecipient?: string | null;
};

/** A top-up row of `amount` USDC that has been queued and started, so it waits in `sending` with nothing signed. */
async function seedRebalance(amount: string, options: SeedOptions = {}) {
    const at = options.updatedAt ?? new Date(clock - 3_600_000);
    const state = options.state ?? "sending";
    const doc: PoolRebalanceDoc = {
        _id: new ObjectId(),
        kind: "move",
        direction: options.direction === undefined ? "arc_to_polygon" : options.direction,
        source: "operator",
        reason: "operator",
        amountE6: toDecimal(e6(amount)),
        maxFeeE6: toDecimal(MAX_FEE),
        reservedE6: toDecimal(0n),
        active: true,
        state,
        attempts: 0,
        nextAt: null,
        lastError: null,
        mintRecipient: options.mintRecipient === undefined ? POOL_WALLET : options.mintRecipient,
        createdAt: at,
        updatedAt: at,
        doneAt: null,
        resolvedAt: null,
        arc: {
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: options.burnTxHash ?? null,
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

async function seedAccount() {
    const now = new Date();
    const account = {
        _id: new ObjectId(),
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: 6000 + ++seeded,
        depositAddress: `0x${String(seeded + 9000).padStart(40, "0")}`,
        balance: toDecimal(0n),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.accounts.insertOne(account);
    return account;
}

async function seedArc(amount: string) {
    const account = await seedAccount();
    const withdrawal = {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        amount: toDecimal(wei(amount)),
        to: randomAddress().toLowerCase(),
        state: "sending" as const,
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    await database.collections.withdrawals.insertOne(withdrawal);
    return withdrawal;
}

async function seedSolana(amount: string) {
    const account = await seedAccount();
    const withdrawal = {
        _id: new ObjectId(),
        accountId: account._id,
        requestId: randomUUID(),
        amount: toDecimal(wei(amount)),
        to: WALLET,
        network: "solana" as const,
        state: "sending" as const,
        nonce: null,
        rawTx: null,
        txHash: null,
        failure: null,
        solana: {
            wallet: WALLET,
            usdcAccount: USDC_ACCOUNT,
            setup: false,
            fee: toDecimal(parseUnits("0.127", 18)),
            maxFee: toDecimal(parseUnits("0.15", 18)),
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: null,
            forwardTxHash: null,
            irisCheckedAt: null,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    await database.collections.withdrawals.insertOne(withdrawal);
    return withdrawal;
}

const rowOf = async (id: ObjectId) => (await database.collections.poolRebalances.findOne({ _id: id }))!;
const withdrawalOf = async (id: ObjectId) => (await database.collections.withdrawals.findOne({ _id: id }))!;
const ledgerCount = () => database.collections.ledger.countDocuments({});
const refunds = () => database.collections.ledger.countDocuments({ kind: "withdrawal_refund" });
const approves = async () => (await usdc.calls()).filter((call) => call.name === "approve");
const messageRequests = () => iris.requests().filter((url) => url.startsWith("/v2/messages/")).length;
const quietLogger = () => {
    const logs = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    return { logs, logger: logs as unknown as Logger };
};
const isolated = async () => {
    await database.collections.poolRebalances.updateMany(
        { active: true },
        { $set: { state: "done" }, $unset: { active: "" } },
    );
    await database.collections.withdrawals.updateMany(
        { state: { $in: ["sending", "forwarding"] } },
        { $set: { state: "sent" } },
    );
    await messenger.revertCalls(false);
    await usdc.revertCalls(false);
    signing.mockClear();
};
const unreachable = async () => {
    throw new Error("fetch failed");
};
/** A client whose transactions are never confirmed, so a receipt wait ends unconfirmed. */
const receiptsNeverArrive = () =>
    new Proxy(chain, {
        get: (target, property, receiver) =>
            property === "waitForTransactionReceipt"
                ? () => Promise.reject(new Error("timed out waiting for the receipt"))
                : Reflect.get(target, property, receiver),
    });
const gasSpent = async (hashes: (string | null)[]) => {
    let total = 0n;
    for (const hash of hashes) {
        const receipt = await chain.getTransactionReceipt({ hash: hash as Hex });
        total += receipt.gasUsed * receipt.effectiveGasPrice;
    }
    return total;
};

test("approve then burn go out in nonce order and the stub records domain 7, the pool wallet as mintRecipient, zero destinationCaller, the stored maxFee, finality 2000 and FORWARD_HOOK_DATA", async () => {
    await isolated();
    const row = await seedRebalance("9");
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const approvesBefore = (await approves()).length;
    const burnsBefore = (await messenger.calls()).length;

    await worker().tick();

    const sentApproves = (await approves()).slice(approvesBefore);
    const burns = (await messenger.calls()).slice(burnsBefore);
    expect(sentApproves).toEqual([{ name: "approve", spender: getAddress(TOKEN_MESSENGER), amount: 9_000_000n }]);
    expect(burns).toHaveLength(1);
    expect(burns[0]).toEqual({
        name: "depositForBurnWithHook",
        amount: 9_000_000n,
        destinationDomain: 7,
        mintRecipient: WALLET_BYTES32,
        burnToken: getAddress(USDC_VIEW),
        destinationCaller: `0x${"00".repeat(32)}`,
        maxFee: MAX_FEE,
        minFinalityThreshold: 2000,
        hookData: FORWARD_HOOK_DATA,
    });

    const done = await rowOf(row._id);
    expect([done.arc.approveNonce, done.arc.burnNonce]).toEqual([nonceBefore, nonceBefore + 1]);
    const approveTx = await chain.getTransaction({ hash: done.arc.approveTxHash as Hex });
    const burnTx = await chain.getTransaction({ hash: done.arc.burnTxHash as Hex });
    expect([approveTx.nonce, burnTx.nonce]).toEqual([nonceBefore, nonceBefore + 1]);
    expect([approveTx.to, burnTx.to]).toEqual([USDC_VIEW.toLowerCase(), TOKEN_MESSENGER.toLowerCase()]);
    expect(done.state).toBe("forwarding");
    expect(done.active).toBe(true);
});

test("both raw transactions and hashes are stored before either is broadcast", async () => {
    await isolated();
    const row = await seedRebalance("2");
    const seen: object[] = [];

    await worker({
        broadcast: async (rawTx) => {
            const doc = await rowOf(row._id);
            seen.push({
                approveRawTx: doc.arc.approveRawTx !== null,
                approveTxHash: doc.arc.approveTxHash !== null,
                burnRawTx: doc.arc.burnRawTx !== null,
                burnTxHash: doc.arc.burnTxHash !== null,
            });
            return chain.sendRawTransaction({ serializedTransaction: rawTx });
        },
    }).tick();

    expect(seen).toHaveLength(2);
    for (const entry of seen) {
        expect(entry).toEqual({ approveRawTx: true, approveTxHash: true, burnRawTx: true, burnTxHash: true });
    }
    const done = await rowOf(row._id);
    expect(done.arc.approveTxHash).toBe(keccak256(done.arc.approveRawTx as Hex));
    expect(done.arc.burnTxHash).toBe(keccak256(done.arc.burnRawTx as Hex));
});

test("the burn mined moves sending to forwarding and emits pool-rebalance:updated once", async () => {
    await isolated();
    const row = await seedRebalance("3");
    const events: { _id: ObjectId; state: string }[] = [];
    const listener = ({ rebalance }: { rebalance: PoolRebalanceDoc }) => events.push(rebalance);
    bus.on("pool-rebalance:updated", listener);
    const withdrawalEvents = vi.fn();
    bus.on("withdrawal:updated", withdrawalEvents);
    const payouts = worker();

    await payouts.tick();
    await payouts.tick();
    bus.off("pool-rebalance:updated", listener);
    bus.off("withdrawal:updated", withdrawalEvents);

    expect(events).toHaveLength(1);
    expect(events[0]!._id.equals(row._id)).toBe(true);
    expect(events[0]!.state).toBe("forwarding");
    expect(withdrawalEvents).not.toHaveBeenCalled();
    const done = await rowOf(row._id);
    expect(done.state).toBe("forwarding");
    expect(done.arc.burnTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.getTransactionReceipt({ hash: done.arc.burnTxHash as Hex })).status).toBe("success");
});

test("a refused approve ends failed with no ledger row and the treasury unchanged except gas", async () => {
    await isolated();
    const row = await seedRebalance("5");
    const ledgerBefore = await ledgerCount();
    const balanceBefore = await chain.getBalance({ address: signer.address });
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const events: string[] = [];
    const listener = ({ rebalance }: { rebalance: PoolRebalanceDoc }) => events.push(rebalance.state);
    bus.on("pool-rebalance:updated", listener);
    const payouts = worker({
        broadcast: async () => {
            throw new Error("insufficient funds for gas * price + value");
        },
    });

    await payouts.tick();
    await payouts.tick();
    bus.off("pool-rebalance:updated", listener);

    const failed = await rowOf(row._id);
    expect(failed.state).toBe("failed");
    expect(failed.active).toBeUndefined();
    expect(failed.lastError).toBe("Rejected by the network");
    expect(failed.doneAt).toEqual(new Date(clock));
    expect(failed.updatedAt).toEqual(new Date(clock));
    expect(events).toEqual(["failed"]);
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(await refunds()).toBe(0);
    expect(await chain.getBalance({ address: signer.address })).toBe(balanceBefore);
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore);
});

test("a reverted burn ends failed the same way", async () => {
    await isolated();
    const row = await seedRebalance("5");
    const ledgerBefore = await ledgerCount();
    const balanceBefore = await chain.getBalance({ address: signer.address });
    const approvesBefore = (await approves()).length;
    await messenger.revertCalls(true);
    const payouts = worker();

    await payouts.tick();
    await payouts.tick();
    await messenger.revertCalls(false);

    const failed = await rowOf(row._id);
    expect(failed.state).toBe("failed");
    expect(failed.active).toBeUndefined();
    expect(failed.lastError).toBe("Burn reverted on the network");
    expect(failed.doneAt).toEqual(new Date(clock));
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(await refunds()).toBe(0);
    expect((await approves()).length - approvesBefore).toBe(1);
    const gas = await gasSpent([failed.arc.approveTxHash, failed.arc.burnTxHash]);
    expect(gas).toBeGreaterThan(0n);
    expect(balanceBefore - (await chain.getBalance({ address: signer.address }))).toBe(gas);
});

test("a reverted approve ends failed without a burn", async () => {
    await isolated();
    const row = await seedRebalance("5");
    const burnsBefore = (await messenger.calls()).length;
    await usdc.revertCalls(true);

    await worker().tick();
    await usdc.revertCalls(false);

    const failed = await rowOf(row._id);
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toBe("Approval reverted on the network");
    expect((await messenger.calls()).length).toBe(burnsBefore);
});

test("a reverted burn leaves the allowance and logs info, and sets nothing back to zero", async () => {
    await isolated();
    const row = await seedRebalance("6");
    const approvesBefore = (await approves()).length;
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    await messenger.revertCalls(true);
    const { logs, logger } = quietLogger();
    const payouts = worker({ logger });

    await payouts.tick();
    await payouts.tick();
    await payouts.tick();
    await messenger.revertCalls(false);

    expect((await rowOf(row._id)).state).toBe("failed");
    expect((await approves()).slice(approvesBefore)).toEqual([
        { name: "approve", spender: getAddress(TOKEN_MESSENGER), amount: 6_000_000n },
    ]);
    // Exactly the approve and the reverted burn were sent: no reset of the allowance followed.
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 2);
    const infos = logs.info.mock.calls.filter(([, message]) => /allowance/i.test(String(message)));
    expect(infos).toHaveLength(1);
    expect(infos[0]![0]).toMatchObject({ rebalanceId: row._id.toHexString(), amountE6: "6000000" });
});

test("restart in sending re-sends the same bytes and the burn is recorded once", async () => {
    await isolated();
    const row = await seedRebalance("3");
    const approvesBefore = (await approves()).length;
    const burnsBefore = (await messenger.calls()).length;
    const first = worker({
        broadcast: async (rawTx) => {
            await chain.sendRawTransaction({ serializedTransaction: rawTx });
            throw new Error("fetch failed");
        },
    });
    await first.tick();
    const signed = await rowOf(row._id);
    expect(signed.state).toBe("sending");
    expect(signed.arc.burnRawTx).not.toBeNull();

    await worker().tick();

    const done = await rowOf(row._id);
    expect(done.state).toBe("forwarding");
    expect(done.arc.approveRawTx).toBe(signed.arc.approveRawTx);
    expect(done.arc.burnRawTx).toBe(signed.arc.burnRawTx);
    expect((await approves()).length - approvesBefore).toBe(1);
    expect((await messenger.calls()).length - burnsBefore).toBe(1);
    expect(signing).toHaveBeenCalledTimes(2);
});

test("an Arc withdrawal, a Solana withdrawal and a rebalance interleaved take distinct nonces", async () => {
    await isolated();
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const arcA = await seedArc("1");
    const solana = await seedSolana("2");
    const row = await seedRebalance("4");
    const arcB = await seedArc("1");

    await worker().tick();

    const a = await withdrawalOf(arcA._id);
    const s = await withdrawalOf(solana._id);
    const b = await withdrawalOf(arcB._id);
    const r = await rowOf(row._id);
    expect([a.state, s.state, b.state, r.state]).toEqual(["sent", "forwarding", "sent", "forwarding"]);
    const nonces = [a.nonce, s.solana!.approveNonce, s.solana!.burnNonce, b.nonce, r.arc.approveNonce, r.arc.burnNonce];
    expect(new Set(nonces).size).toBe(6);
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 6);
});

test("a new withdrawal is not signed while a rebalance's stored transactions are unconfirmed, and takes the nonce above its burn once they are sent", async () => {
    await isolated();
    const row = await seedRebalance("4");
    await worker({ broadcast: unreachable }).tick();
    const stored = await rowOf(row._id);
    expect(stored.arc.burnNonce).not.toBeNull();
    const withdrawal = await seedArc("1");
    signing.mockClear();

    await worker({ client: receiptsNeverArrive(), broadcast: async (rawTx) => keccak256(rawTx) }).tick();

    const held = await withdrawalOf(withdrawal._id);
    expect([held.state, held.nonce, held.rawTx]).toEqual(["sending", null, null]);
    expect(signing).not.toHaveBeenCalled();
    const unsent = await rowOf(row._id);
    expect(unsent.state).toBe("sending");
    expect(unsent.arc).toEqual(stored.arc);

    const order: Hex[] = [];
    await worker({
        broadcast: async (rawTx) => {
            order.push(keccak256(rawTx));
            return chain.sendRawTransaction({ serializedTransaction: rawTx });
        },
    }).tick();

    const paid = await withdrawalOf(withdrawal._id);
    expect(paid.state).toBe("sent");
    expect(paid.nonce).toBe(stored.arc.burnNonce! + 1);
    expect(order).toEqual([stored.arc.approveTxHash, stored.arc.burnTxHash, paid.txHash]);
    expect((await rowOf(row._id)).state).toBe("forwarding");
});

test.each(["Arc", "Solana"] as const)(
    "a withdrawal to %s queued while the node is unreachable is not signed above a stored rebalance, and is once it is sent",
    async (network) => {
        await isolated();
        const row = await seedRebalance("4");
        await worker({ broadcast: unreachable }).tick();
        const stored = await rowOf(row._id);
        const withdrawal = await (network === "Arc" ? seedArc("1") : seedSolana("1"));
        signing.mockClear();

        await worker({ broadcast: unreachable }).tick();

        const held = await withdrawalOf(withdrawal._id);
        expect([held.state, held.nonce, held.rawTx, held.solana?.approveRawTx ?? null]).toEqual([
            "sending",
            null,
            null,
            null,
        ]);
        expect(signing).not.toHaveBeenCalled();
        expect((await rowOf(row._id)).arc).toEqual(stored.arc);

        await worker().tick();

        const paid = await withdrawalOf(withdrawal._id);
        expect(paid.state).toBe(network === "Arc" ? "sent" : "forwarding");
        expect(paid.nonce ?? paid.solana?.approveNonce).toBe(stored.arc.burnNonce! + 1);
        expect((await rowOf(row._id)).state).toBe("forwarding");
    },
);

test("a burn refused at broadcast after a withdrawal was queued ends failed and the withdrawal takes the nonce the burn never used", async () => {
    await isolated();
    const row = await seedRebalance("4");
    await worker({ broadcast: unreachable }).tick();
    const stored = await rowOf(row._id);
    const withdrawal = await seedArc("1");
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });

    await worker({
        broadcast: async (rawTx) => {
            if (keccak256(rawTx) === stored.arc.burnTxHash) {
                throw new Error("insufficient funds for gas * price + value");
            }
            return chain.sendRawTransaction({ serializedTransaction: rawTx });
        },
    }).tick();

    expect((await rowOf(row._id)).state).toBe("failed");
    const paid = await withdrawalOf(withdrawal._id);
    expect(paid.state).toBe("sent");
    expect(paid.nonce).toBe(stored.arc.burnNonce);
    expect(await chain.getTransactionCount({ address: signer.address, blockTag: "pending" })).toBe(nonceBefore + 2);
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 2);
});

test("a withdrawal that already carries its bytes is sent ahead of a stored rebalance, and a new one after it", async () => {
    await isolated();
    const first = await seedArc("1");
    await worker({ broadcast: unreachable }).tick();
    const row = await seedRebalance("4");
    await worker({ client: receiptsNeverArrive(), broadcast: async (rawTx) => keccak256(rawTx) }).tick();
    const second = await seedArc("1");
    const signed = await withdrawalOf(first._id);
    const stored = await rowOf(row._id);
    expect(stored.arc.approveNonce).toBe(signed.nonce! + 1);
    const order: Hex[] = [];

    await worker({
        broadcast: async (rawTx) => {
            order.push(keccak256(rawTx));
            return chain.sendRawTransaction({ serializedTransaction: rawTx });
        },
    }).tick();

    const last = await withdrawalOf(second._id);
    expect(last.state).toBe("sent");
    expect(last.nonce).toBe(stored.arc.burnNonce! + 1);
    expect(order).toEqual([signed.txHash, stored.arc.approveTxHash, stored.arc.burnTxHash, last.txHash]);
    expect((await withdrawalOf(first._id)).state).toBe("sent");
    expect((await rowOf(row._id)).state).toBe("forwarding");
});

test("a burn mined and nothing else ever re-burns", async () => {
    await isolated();
    const row = await seedRebalance("2");
    const approvesBefore = (await approves()).length;
    const burnsBefore = (await messenger.calls()).length;
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const payouts = worker();

    for (let pass = 0; pass < 5; pass++) await payouts.tick();

    expect((await rowOf(row._id)).state).toBe("forwarding");
    expect((await messenger.calls()).length - burnsBefore).toBe(1);
    expect((await approves()).length - approvesBefore).toBe(1);
    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore + 2);
    expect(signing).toHaveBeenCalledTimes(2);
});

test("an unreachable node leaves the row sending and the next pass re-sends the same bytes", async () => {
    await isolated();
    const row = await seedRebalance("3");
    const burnsBefore = (await messenger.calls()).length;
    const { logs, logger } = quietLogger();

    await worker({ logger, broadcast: unreachable }).tick();

    const stored = await rowOf(row._id);
    expect(stored.state).toBe("sending");
    expect(stored.active).toBe(true);
    expect(stored.lastError).toBeNull();
    expect(stored.arc.approveRawTx).not.toBeNull();
    expect(logs.warn).toHaveBeenCalled();
    expect(signing).toHaveBeenCalledTimes(2);

    await worker().tick();

    const done = await rowOf(row._id);
    expect(done.state).toBe("forwarding");
    expect(done.arc.approveRawTx).toBe(stored.arc.approveRawTx);
    expect(done.arc.burnRawTx).toBe(stored.arc.burnRawTx);
    expect(done.arc.approveNonce).toBe(stored.arc.approveNonce);
    expect(signing).toHaveBeenCalledTimes(2);
    expect((await messenger.calls()).length - burnsBefore).toBe(1);
});

test("storing the signed bytes leaves updatedAt alone, and the burn mined sets it", async () => {
    await isolated();
    const row = await seedRebalance("2");

    await worker({ broadcast: unreachable }).tick();

    const stored = await rowOf(row._id);
    expect(stored.arc.approveRawTx).not.toBeNull();
    expect(stored.updatedAt).toEqual(row.updatedAt);

    await worker().tick();

    const done = await rowOf(row._id);
    expect(done.state).toBe("forwarding");
    expect(done.updatedAt).toEqual(new Date(clock));
    expect(done.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
});

test("a stored approve whose nonce another transaction took is cleared without touching updatedAt, and signed again", async () => {
    await isolated();
    const row = await seedRebalance("2");
    await worker({ broadcast: unreachable }).tick();
    const stored = await rowOf(row._id);
    const taken = await signer.signTransaction({
        type: "eip1559",
        chainId: chain.chain.id,
        nonce: stored.arc.approveNonce!,
        to: randomAddress(),
        value: 1n,
        gas: 21_000n,
        maxFeePerGas: parseGwei("500"),
        maxPriorityFeePerGas: parseGwei("1"),
    });
    await chain.waitForTransactionReceipt({
        hash: await chain.sendRawTransaction({ serializedTransaction: taken }),
    });
    const approvesBefore = (await approves()).length;
    const payouts = worker();

    await payouts.tick();

    const cleared = await rowOf(row._id);
    expect(cleared.state).toBe("sending");
    expect(cleared.arc).toEqual({
        approveNonce: null,
        approveRawTx: null,
        approveTxHash: null,
        burnNonce: null,
        burnRawTx: null,
        burnTxHash: null,
    });
    expect(cleared.updatedAt).toEqual(row.updatedAt);
    expect((await approves()).length).toBe(approvesBefore);

    await payouts.tick();

    const done = await rowOf(row._id);
    expect(done.state).toBe("forwarding");
    expect(done.arc.approveNonce).toBe(stored.arc.approveNonce! + 1);
    expect((await approves()).length - approvesBefore).toBe(1);
});

test("only an arc_to_polygon row in sending is signed, and a forwarding row is never asked of Iris", async () => {
    await isolated();
    const queued = await seedRebalance("2", { state: "queued" });
    await database.collections.poolRebalances.updateOne({ _id: queued._id }, { $unset: { active: "" } });
    const drain = await seedRebalance("2", { direction: "polygon_to_arc", state: "submitting", mintRecipient: null });
    await database.collections.poolRebalances.updateOne({ _id: drain._id }, { $unset: { active: "" } });
    const burnTxHash: Hex = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const forwarding = await seedRebalance("2", { state: "forwarding", burnTxHash });
    iris.setPending(burnTxHash);
    const nonceBefore = await chain.getTransactionCount({ address: signer.address });
    const requestsBefore = messageRequests();

    await worker().tick();

    expect(await chain.getTransactionCount({ address: signer.address })).toBe(nonceBefore);
    expect(signing).not.toHaveBeenCalled();
    expect(messageRequests()).toBe(requestsBefore);
    expect((await rowOf(queued._id)).state).toBe("queued");
    expect((await rowOf(drain._id)).state).toBe("submitting");
    expect((await rowOf(forwarding._id)).state).toBe("forwarding");
});

test("a row with no mint recipient ends failed before anything is signed", async () => {
    await isolated();
    const row = await seedRebalance("2", { mintRecipient: null });

    await worker().tick();

    const failed = await rowOf(row._id);
    expect(failed.state).toBe("failed");
    expect(failed.active).toBeUndefined();
    expect(failed.lastError).toBe("No mint recipient");
    expect(failed.arc.approveRawTx).toBeNull();
    expect(signing).not.toHaveBeenCalled();
});

test("Payouts wakes on a sending rebalance and not on any other state", async () => {
    await isolated();
    const payouts = worker({ pollMs: 600_000 });
    payouts.start();
    await payouts.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await seedRebalance("2");

    bus.emit("pool-rebalance:updated", { rebalance: { ...row, state: "forwarding" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await rowOf(row._id)).arc.approveRawTx).toBeNull();

    bus.emit("pool-rebalance:updated", { rebalance: row });
    await expect.poll(async () => (await rowOf(row._id)).state).toBe("forwarding");
    await payouts.stop();
    expect(bus.listenerCount("pool-rebalance:updated")).toBe(0);
});
