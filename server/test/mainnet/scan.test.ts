import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { Decimal128, MongoClient, ObjectId } from "mongodb";
import { pino } from "pino";
import { formatUnits, getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { ARC_RPC_URLS, createArcClient } from "../../src/chain/arc.ts";
import { findTransfersTo } from "../../src/chain/native-transfers.ts";
import { loadConfig } from "../../src/config.ts";
import type { AccountDoc } from "../../src/db/mongo.ts";
import type { DepositPage, DepositReceipt } from "../../src/protocol.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { startFakePrivy, type FakePrivy } from "../support/fake-privy.ts";

const TX_PLAIN = "0xd346d5673985926cf8fdeeb40763244430943f795e84e048a20ef9797af95deb";
const TX_ERC20 = "0xe733e1a07d27ae01fd8af9afa7b25271de64813712032a9888c2c9ca454c4c9f";
const TO_PLAIN = "0x84ab385972b366abcd7dfb6792f4624d92a224a4";
const TO_ERC20 = "0xfd4960f33670f3477ebe817b184dd59fc4961437";
const BLOCK_PLAIN = 24998035;
const BLOCK_ERC20 = 24997957;
const START_BLOCK = 24997950;
const SCAN_THROUGH = 24998040;

const dbName = `mainnet_${randomUUID().replaceAll("-", "")}`;
let mongo: MongoClient;
let privy: FakePrivy;
let server: RunningServer;
const accounts: Record<"plain" | "erc20", { doc: AccountDoc; userId: string }> = {} as never;

function account(depositAddress: Address, depositIndex: number) {
    const now = new Date();
    const doc: AccountDoc = {
        _id: new ObjectId(),
        wallet: privateKeyToAddress(generatePrivateKey()).toLowerCase(),
        privyUserId: `did:privy:${randomUUID().replaceAll("-", "")}`,
        depositIndex,
        depositAddress,
        balance: Decimal128.fromString("0"),
        version: 0,
        openedAtBlock: 24997000,
        createdAt: now,
        updatedAt: now,
    };
    privy.setUser(doc.privyUserId, [doc.wallet]);
    return { doc, userId: doc.privyUserId };
}

beforeAll(async () => {
    privy = await startFakePrivy();
    accounts.plain = account(TO_PLAIN, 999_999);
    accounts.erc20 = account(TO_ERC20, 999_998);
    mongo = new MongoClient(inject("mongoUri"));
    await mongo.db(dbName).collection<AccountDoc>("accounts").insertMany([accounts.plain.doc, accounts.erc20.doc]);

    const config = loadConfig({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "0",
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
        MONGODB_URI: inject("mongoUri"),
        MONGODB_DB: dbName,
        PRIVY_APP_ID: privy.appId,
        PRIVY_APP_SECRET: privy.appSecret,
        PRIVY_VERIFICATION_KEY: privy.verificationKey,
        PRIVY_API_URL: privy.url,
        DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
        DEPOSIT_MIN_USDC: "0.000001",
        DEPOSIT_START_BLOCK: String(START_BLOCK),
        DEPOSIT_SCAN_RANGE: "100",
        DEPOSIT_POLL_MS: "100",
    });
    server = await startServer(config, pino({ level: config.LOG_LEVEL }));
});

afterAll(async () => {
    await server?.close();
    await mongo?.db(dbName).dropDatabase();
    await mongo?.close();
    await privy?.stop();
});

async function api<T>(who: { doc: AccountDoc; userId: string }, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${server.url}/v1/accounts/${who.doc.wallet}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${await privy.token(who.userId)}`,
            "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
}

test("the scan credits the real transfers to each deposit address, once and exactly", async () => {
    await expect
        .poll(() => server.services.watcher.status().scannedThrough ?? 0, { timeout: 90_000, interval: 200 })
        .toBeGreaterThanOrEqual(SCAN_THROUGH);
    // Nothing further is needed, and the scan would otherwise run on towards the head.
    await server.services.watcher.stop();
    const scannedThrough = server.services.watcher.status().scannedThrough!;

    const deposits = mongo.db(dbName).collection("deposits");
    const chain = await findTransfersTo(
        createArcClient(ARC_RPC_URLS),
        [TO_PLAIN, TO_ERC20],
        START_BLOCK,
        scannedThrough,
    );
    const rows = await deposits.find({}).toArray();
    expect(rows).toHaveLength(chain.length);
    expect(chain.map((t) => t.txHash)).toEqual(expect.arrayContaining([TX_PLAIN, TX_ERC20]));

    const plain = await api<DepositPage>(accounts.plain, "/deposits");
    expect(plain.items).toHaveLength(chain.filter((t) => t.to === TO_PLAIN).length);
    expect(plain.items.find((d) => d.txHash === TX_PLAIN)).toMatchObject({
        amount: "0.0031273",
        logIndex: 0,
        blockNumber: BLOCK_PLAIN,
        from: getAddress("0xf56ed4fb3308d58346a07692320c851936480d33"),
    });

    const erc20 = await api<DepositPage>(accounts.erc20, "/deposits");
    expect(erc20.items.find((d) => d.txHash === TX_ERC20)).toMatchObject({
        amount: "0.001",
        logIndex: 0,
        blockNumber: BLOCK_ERC20,
    });

    // Each balance is exactly the sum of what the chain shows for its address.
    for (const [who, to] of [
        [accounts.plain, TO_PLAIN],
        [accounts.erc20, TO_ERC20],
    ] as const) {
        const expected = chain.filter((t) => t.to === to);
        const view = await api<{ balance: string; version: number }>(who, "");
        const sum = expected.reduce((total, t) => total + t.value, 0n);
        expect(view.balance).toBe(formatUnits(sum, 18));
        expect(view.version).toBe(expected.length);
    }
    expect(plain.items.find((d) => d.txHash === TX_PLAIN)?.blockNumber).toBe(BLOCK_PLAIN);
});

test("reporting a transaction the scan already credited changes nothing", async () => {
    const before = await api<{ balance: string; version: number }>(accounts.plain, "");
    const listed = await api<DepositPage>(accounts.plain, "/deposits");
    const original = listed.items.find((d) => d.txHash === TX_PLAIN)!;

    const first = await api<DepositReceipt>(accounts.plain, "/deposits", { txHash: TX_PLAIN });
    const second = await api<DepositReceipt>(accounts.plain, "/deposits", { txHash: TX_PLAIN });
    for (const receipt of [first, second]) {
        expect(receipt.deposits).toEqual([original]);
        expect(receipt.account.balance).toBe(before.balance);
        expect(receipt.account.version).toBe(before.version);
    }
    expect(await api<{ balance: string; version: number }>(accounts.plain, "")).toMatchObject(before);
    expect((await api<DepositPage>(accounts.plain, "/deposits")).items).toEqual(listed.items);
});

test("reporting a transaction that sent nothing to the account is refused", async () => {
    const response = await fetch(`${server.url}/v1/accounts/${accounts.erc20.doc.wallet}/deposits`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${await privy.token(accounts.erc20.userId)}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ txHash: TX_PLAIN }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ error: { code: "no_deposit" } });
});
