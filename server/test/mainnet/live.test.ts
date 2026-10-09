import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { pino } from "pino";
import { io as connectSocket } from "socket.io-client";
import { createPublicClient, createWalletClient, formatUnits, http, parseGwei, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { arcChain } from "../../src/chain/arc.ts";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { loadConfig } from "../../src/config.ts";
import type { AppSocket } from "../support/stack.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { startFakePrivy, type FakePrivy } from "../support/fake-privy.ts";

// Spends real USDC on Arc mainnet, so it only runs when a funded key is given.
const LIVE_KEY = process.env.ARC_LIVE_PRIVATE_KEY as Hex | undefined;
const AMOUNT = process.env.ARC_LIVE_AMOUNT ?? "0.02";
const GAS_LIMIT = 21_000n;
// Arc drops transactions whose max fee is under 20 gwei.
const MAX_FEE = parseGwei("40");
const PRIORITY_FEE = parseGwei("1");

let privy: FakePrivy;
let server: RunningServer;
let dbName: string;
let socket: AppSocket | undefined;

beforeAll(async () => {
    if (!LIVE_KEY) return;
    privy = await startFakePrivy();
    dbName = `mainnet_live_${randomUUID().replaceAll("-", "")}`;
    const config = loadConfig({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "0",
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
        CORS_ORIGINS: "http://localhost:3000",
        MONGODB_URI: inject("mongoUri"),
        MONGODB_DB: dbName,
        PRIVY_APP_ID: privy.appId,
        PRIVY_APP_SECRET: privy.appSecret,
        PRIVY_VERIFICATION_KEY: privy.verificationKey,
        PRIVY_API_URL: privy.url,
        DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
        DEPOSIT_POLL_MS: "500",
    });
    server = await startServer(config, pino({ level: config.LOG_LEVEL }));
});

afterAll(async () => {
    socket?.disconnect();
    await server?.services.database.db.dropDatabase().catch(() => undefined);
    await server?.close();
    await privy?.stop();
});

test.skipIf(!LIVE_KEY)(
    "a real deposit on arc mainnet is credited, and the derived key can sweep it back",
    async () => {
        const owner = privateKeyToAccount(LIVE_KEY!);
        const userId = `did:privy:${randomUUID().replaceAll("-", "")}`;
        privy.setUser(userId, [owner.address]);

        socket = connectSocket(server.url, {
            auth: { token: await privy.token(userId) },
            transports: ["websocket"],
            extraHeaders: { origin: "http://localhost:3000" },
            reconnection: false,
            forceNew: true,
        });
        await new Promise<void>((resolve, reject) => {
            socket!.once("connect", () => resolve());
            socket!.once("connect_error", reject);
        });
        const session = await socket.timeout(10_000).emitWithAck("wallet:connect", { address: owner.address });
        if (!session.ok) throw new Error(session.error.message);
        const depositAddress = session.data.account.depositAddress;
        expect(session.data.account.balance).toBe("0");

        const chain = arcChain(server.services.config.ARC_RPC_URLS);
        const rpcUrl = chain.rpcUrls.default.http[0];
        const rpc = createPublicClient({ chain, transport: http(rpcUrl) });
        const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });

        const pushed = new Promise<{ deposit: { amount: string; txHash: string }; account: { balance: string } }>(
            (resolve) => socket!.once("deposit:credited", resolve),
        );
        const depositHash = await wallet.sendTransaction({
            to: depositAddress,
            value: parseUnits(AMOUNT, 18),
            maxFeePerGas: MAX_FEE,
            maxPriorityFeePerGas: PRIORITY_FEE,
            gas: GAS_LIMIT,
        });
        console.log(`live deposit tx: ${depositHash}`);

        const ack = await socket.timeout(60_000).emitWithAck("deposit:submit", { txHash: depositHash });
        if (!ack.ok) throw new Error(ack.error.message);
        expect(ack.data.deposits).toHaveLength(1);
        expect(ack.data.deposits[0]).toMatchObject({ txHash: depositHash, amount: AMOUNT });
        expect(ack.data.account.balance).toBe(AMOUNT);
        expect(await pushed).toMatchObject({
            deposit: { amount: AMOUNT, txHash: depositHash },
            account: { balance: AMOUNT },
        });

        // The server's derived key must control the deposit address: send the funds back, minus gas.
        const { config } = server.services;
        const index = (await server.services.accounts.find(owner.address.toLowerCase()))!.depositIndex;
        const signer = createKeyring(config.DEPOSIT_MNEMONIC).signerAt(index);
        expect(signer.address.toLowerCase()).toBe(depositAddress.toLowerCase());

        const sweeper = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
        const balance = await rpc.getBalance({ address: depositAddress });
        expect(formatUnits(balance, 18)).toBe(AMOUNT);

        const sweepHash = await sweeper.sendTransaction({
            to: owner.address,
            value: balance - GAS_LIMIT * MAX_FEE,
            maxFeePerGas: MAX_FEE,
            maxPriorityFeePerGas: PRIORITY_FEE,
            gas: GAS_LIMIT,
        });
        console.log(`live sweep tx: ${sweepHash}`);
        const receipt = await rpc.waitForTransactionReceipt({ hash: sweepHash, timeout: 60_000 });
        expect(receipt.status).toBe("success");
    },
    180_000,
);
