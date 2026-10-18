import { randomBytes, randomUUID } from "node:crypto";
import { base58 } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { createTestClient, http, parseUnits, publicActions, type Address } from "viem";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import { createSolanaRpc, type SolanaRpc } from "../../src/crosschain/solana.ts";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { usdcAccountOf } from "../../src/withdrawals/solana-recipient.ts";
import { Withdrawals, TREASURY_GAS_RESERVE } from "../../src/withdrawals/withdrawals.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";
import { startFakeSolanaRpc, type FakeSolanaRpc } from "../support/fake-solana-rpc.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let database: Database;
let withdrawals: Withdrawals;
let iris: FakeIris;
let rpc: FakeSolanaRpc;
let treasury: Address;
let bus: Bus;
/** Reads through the fake RPC, except for the wallets a test has made vanish. */
const gone = new Set<string>();
const switches = { SOLANA_DEPOSITS: "on" as "on" | "off", SOLANA_WITHDRAWALS: "on" as "on" | "off" };
const chain = createTestClient({
    chain: arcChain([inject("anvilUrl")]),
    mode: "anvil",
    transport: http(inject("anvilUrl")),
}).extend(publicActions);
let seeded = 0;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    iris = await startFakeIris();
    rpc = await startFakeSolanaRpc();
    bus = new Bus();
    const logger = pino({ level: "silent" });
    const ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger,
        minDeposit: 0n,
    });
    const signer = createKeyring(generateMnemonic(wordlist)).operator();
    treasury = signer.address;
    const real = createSolanaRpc([rpc.url]);
    const reading: SolanaRpc = {
        ...real,
        getAccountInfo: (address) => (gone.has(address) ? Promise.resolve(null) : real.getAccountInfo(address)),
    };
    withdrawals = new Withdrawals({
        collections: database.collections,
        ledger,
        client: chain,
        treasury,
        bus,
        logger,
        minWithdraw: wei("0.01"),
        solana: {
            rpc: reading,
            iris: createIris({ baseUrl: iris.url }),
            switches,
            min: wei("1"),
            tolerance: wei("0.05"),
        },
    });
});
afterAll(async () => {
    await database.close();
    await iris.stop();
    await rpc.stop();
});

async function fundTreasury(usdc: string) {
    await database.collections.withdrawals.deleteMany({});
    await chain.setBalance({ address: treasury, value: wei(usdc) + TREASURY_GAS_RESERVE });
}

async function seedAccount(usdc: string) {
    const now = new Date();
    const account = {
        _id: new ObjectId(),
        privyUserId: `did:privy:${randomUUID()}`,
        depositIndex: 5000 + ++seeded,
        depositAddress: `0x${String(5000 + seeded).padStart(40, "0")}`,
        balance: toDecimal(wei(usdc)),
        version: 1,
        openedAtBlock: 0,
        createdAt: now,
        updatedAt: now,
    };
    await database.collections.accounts.insertOne(account);
    return account;
}

const newWallet = () => base58.encode(randomBytes(32));
const balanceOf = async (id: ObjectId) =>
    fromDecimal((await database.collections.accounts.findOne({ _id: id }))!.balance);
const request = (to: string, amount: string, extra: { reviewedFee?: string } = {}) => ({
    requestId: randomUUID(),
    amount,
    to,
    network: "solana" as const,
    ...extra,
});
const failure = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }),
    );
const ledgerCount = (id: ObjectId) => database.collections.ledger.countDocuments({ accountId: id, kind: "withdrawal" });

test("create debits once and inserts a sending Solana withdrawal with fee, maxFee and setup", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const wallet = newWallet();
    iris.setFees({ med: 127_000, high: 150_000 }, { med: 286_000, high: 320_000 });

    const withdrawal = await withdrawals.create(account, request(wallet, "10"));

    expect(withdrawal).toMatchObject({ network: "solana", state: "sending", to: wallet, nonce: null, rawTx: null });
    expect(fromDecimal(withdrawal.amount)).toBe(wei("10"));
    expect(withdrawal.solana).toMatchObject({
        wallet,
        usdcAccount: await usdcAccountOf(wallet),
        setup: true,
        burnTxHash: null,
        forwardTxHash: null,
    });
    expect(fromDecimal(withdrawal.solana!.fee)).toBe(wei("0.286"));
    expect(fromDecimal(withdrawal.solana!.maxFee)).toBe(wei("0.32"));
    expect(await balanceOf(account._id)).toBe(wei("90"));
    expect(await ledgerCount(account._id)).toBe(1);
});

test("the same requestId twice makes one withdrawal", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const input = request(newWallet(), "10");

    const [first, second] = await Promise.all([withdrawals.create(account, input), withdrawals.create(account, input)]);

    expect(second._id).toEqual(first._id);
    expect(await balanceOf(account._id)).toBe(wei("90"));
    expect(await ledgerCount(account._id)).toBe(1);
});

test("a program-owned wallet is refused and nothing is debited", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const wallet = newWallet();
    rpc.setAccount(wallet, { owner: TOKEN, lamports: 1n });

    expect(await failure(withdrawals.create(account, request(wallet, "10")))).toEqual({
        code: "bad_request",
        message: "That address can't receive USDC.",
    });
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await ledgerCount(account._id)).toBe(0);
});

test("under 1 USDC is refused with 'The smallest withdrawal to Solana is $1.'", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    expect(await failure(withdrawals.create(account, request(newWallet(), "0.99")))).toEqual({
        code: "bad_request",
        message: "The smallest withdrawal to Solana is $1.00.",
    });
    expect(await balanceOf(account._id)).toBe(wei("100"));
});

test("an amount where amount minus maxFee is zero or less is refused", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    iris.setFees({ med: 1_000_000, high: 1_200_000 }, { med: 1_000_000, high: 1_200_000 });
    for (const amount of ["1", "1.2"]) {
        expect(await failure(withdrawals.create(account, request(newWallet(), amount)))).toMatchObject({
            code: "bad_request",
        });
    }
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await ledgerCount(account._id)).toBe(0);
    iris.setFees({ med: 127_000, high: 150_000 }, { med: 286_000, high: 320_000 });
});

test("a fee above reviewedFee plus 0.05 gives quote_changed with the new fee and nothing debited", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    const wallet = newWallet();
    iris.setFees({ med: 250_000, high: 300_000 }, { med: 400_000, high: 450_000 });

    const error = await failure(withdrawals.create(account, request(wallet, "10", { reviewedFee: "0.2" })));

    expect(error).toMatchObject({ code: "quote_changed" });
    expect(error!.message).toContain("0.4");
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await ledgerCount(account._id)).toBe(0);
    iris.setFees({ med: 127_000, high: 150_000 }, { med: 286_000, high: 320_000 });
});

test("a fee within the tolerance proceeds", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    iris.setFees({ med: 127_000, high: 150_000 }, { med: 250_000, high: 300_000 });

    const withdrawal = await withdrawals.create(account, request(newWallet(), "10", { reviewedFee: "0.2" }));

    expect(withdrawal.state).toBe("sending");
    expect(fromDecimal(withdrawal.solana!.fee)).toBe(wei("0.25"));
    iris.setFees({ med: 127_000, high: 150_000 }, { med: 286_000, high: 320_000 });
});

test("an Iris fee failure is 'Couldn't price this right now. Nothing was taken.'", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    iris.failWith(503);
    try {
        expect(await failure(withdrawals.create(account, request(newWallet(), "10")))).toEqual({
            code: "unavailable",
            message: "Couldn't price this right now. Nothing was taken.",
        });
    } finally {
        iris.failWith(null);
    }
    expect(await balanceOf(account._id)).toBe(wei("100"));
});

test("the treasury short is insufficient_funds", async () => {
    const account = await seedAccount("100");
    await fundTreasury("5");
    expect(await failure(withdrawals.create(account, request(newWallet(), "10")))).toMatchObject({
        code: "insufficient_funds",
    });
    expect(await balanceOf(account._id)).toBe(wei("100"));
    expect(await ledgerCount(account._id)).toBe(0);
});

test("an account missing at the quote and present at create takes the cheaper path; present then gone turns setup on", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");

    const first = newWallet();
    const quoted = await withdrawals.quoteSolana(account, { amount: "10", to: first });
    expect(quoted).toEqual({ fee: wei("0.286"), receive: wei("9.714"), setup: true, setupFee: wei("0.159") });
    rpc.setAccount(await usdcAccountOf(first), { owner: TOKEN, lamports: 2_039_280n });
    const cheaper = await withdrawals.create(account, request(first, "10", { reviewedFee: "0.286" }));
    expect(cheaper.solana).toMatchObject({ setup: false });
    expect(fromDecimal(cheaper.solana!.fee)).toBe(wei("0.127"));

    const second = newWallet();
    const usdc = await usdcAccountOf(second);
    rpc.setAccount(usdc, { owner: TOKEN, lamports: 2_039_280n });
    expect((await withdrawals.quoteSolana(account, { amount: "10", to: second })).setup).toBe(false);
    gone.add(usdc);
    const dearer = await withdrawals.create(account, request(second, "10"));
    expect(dearer.solana).toMatchObject({ setup: true });
    expect(fromDecimal(dearer.solana!.fee)).toBe(wei("0.286"));
    gone.delete(usdc);
});

test("switch off is 'Solana withdrawals aren't open yet.'", async () => {
    const account = await seedAccount("100");
    await fundTreasury("500");
    switches.SOLANA_WITHDRAWALS = "off";
    try {
        expect(await failure(withdrawals.create(account, request(newWallet(), "10")))).toEqual({
            code: "unavailable",
            message: "Solana withdrawals aren't open yet.",
        });
        expect(await failure(withdrawals.quoteSolana(account, { amount: "10", to: newWallet() }))).toMatchObject({
            code: "unavailable",
        });
    } finally {
        switches.SOLANA_WITHDRAWALS = "on";
    }
    expect(await balanceOf(account._id)).toBe(wei("100"));
});
