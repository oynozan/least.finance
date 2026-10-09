import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { pino } from "pino";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import { loadConfig } from "../../src/config.ts";
import type { AccountView, DepositView } from "../../src/protocol.ts";
import { startServer } from "../../src/server.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";

// Regressions for what the review of the deposit server found.

/** Nothing listens here, so every request to it fails at once. */
const DEAD_RPC = "http://127.0.0.1:9";

const stacks: Stack[] = [];
async function stack(env: Record<string, string> = {}) {
    const started = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), env });
    stacks.push(started);
    return started;
}
afterAll(() => Promise.all(stacks.map((s) => s.stop())));

async function connect(socket: AppSocket, address: string) {
    const result = await socket.timeout(5000).emitWithAck("wallet:connect", { address });
    if (!result.ok) throw new Error(`wallet:connect failed: ${result.error.code}`);
    return result.data;
}

async function post(s: Stack, user: User, path: string, body: unknown) {
    const response = await fetch(`${s.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
}

const randomHash = () => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;

describe("the chain scan", () => {
    let s: Stack;
    beforeAll(async () => {
        s = await stack();
    });

    test("credits deposits from the next RPC while the first is down", async () => {
        // The stack's own server scans through the emulator; this one puts a dead RPC first.
        const config = { ...s.server.services.config, PORT: 0, ARC_RPC_URLS: [DEAD_RPC, s.emulator.url] };
        const second = await startServer(config, pino({ level: "silent" }));
        try {
            const user = await s.user();
            const socket = await s.socket(user);
            const { account } = await connect(socket, user.wallet);
            const hash = await s.chain.send(user.wallet, account.depositAddress, "3");
            const { blockNumber } = await s.chain.client.getTransactionReceipt({ hash });
            await vi.waitFor(
                () => {
                    const scan = second.services.watcher.status();
                    expect(scan.lastError).toBeNull();
                    expect(scan.scannedThrough).toBeGreaterThanOrEqual(Number(blockNumber));
                },
                { timeout: 10_000, interval: 100 },
            );
            expect((await second.services.accounts.find(user.wallet))?.version).toBe(1);
        } finally {
            await second.close();
        }
    }, 30_000);

    test("stays the configured number of blocks behind the head", async () => {
        // Other test files mine on the same chain meanwhile, so the lag is wide enough that they can't close it.
        const lagging = await stack({ DEPOSIT_SCAN_LAG_BLOCKS: "50" });
        const user = await lagging.user();
        const socket = await lagging.socket(user);
        const { account } = await connect(socket, user.wallet);
        const credited = new Promise<{ deposit: DepositView }>((resolve) => socket.once("deposit:credited", resolve));

        await lagging.chain.send(user.wallet, account.depositAddress, "4");
        await new Promise((resolve) => setTimeout(resolve, 800));
        const before = await lagging.server.services.accounts.find(user.wallet);
        expect(before?.version, "not credited while the block is within the lag").toBe(0);

        await lagging.chain.client.mine({ blocks: 50 });
        expect((await credited).deposit.amount).toBe("4");
    }, 30_000);
});

describe("reported deposits", () => {
    test("an account checks at most three transactions at once", async () => {
        const s = await stack({ DEPOSIT_RECEIPT_TIMEOUT_MS: "2000" });
        const user = await s.user();
        await post(s, user, "/v1/wallets/connect", { address: user.wallet });
        const path = `/v1/accounts/${user.wallet}/deposits`;

        const reports = await Promise.all(
            Array.from({ length: 4 }, () => post(s, user, path, { txHash: randomHash() })),
        );
        const codes = reports.map((r) => r.body.error?.code).sort();
        expect(codes).toEqual(["rate_limited", "tx_not_found", "tx_not_found", "tx_not_found"]);
        expect(reports.find((r) => r.body.error?.code === "rate_limited")?.status).toBe(429);

        // Once those finish, the account can report again.
        const again = await post(s, user, path, { txHash: randomHash() });
        expect(again.body.error.code).toBe("tx_not_found");
    }, 30_000);
});

describe("access tokens", () => {
    test("are checked against Privy's key set when no verification key is set", async () => {
        const s = await stack({ PRIVY_VERIFICATION_KEY: "" });
        const user = await s.user();
        const { status, body } = await post(s, user, "/v1/wallets/connect", { address: user.wallet });
        expect(status).toBe(200);
        expect(body.account.balance).toBe("0");

        const forged = await s.privy.token(user.userId, { appId: "someone-else" });
        const refused = await post(s, { ...user, token: forged }, "/v1/wallets/connect", { address: user.wallet });
        expect(refused.status).toBe(401);
    });

    test("an unreachable key set is unavailable, not a sign-out", async () => {
        const s = await stack({ PRIVY_VERIFICATION_KEY: "" });
        const config = { ...s.server.services.config, PORT: 0, PRIVY_API_URL: DEAD_RPC };
        const cut = await startServer(config, pino({ level: "silent" }));
        try {
            const user = await s.user();
            const response = await fetch(`${cut.url}/v1/wallets/connect`, {
                method: "POST",
                headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
                body: JSON.stringify({ address: user.wallet }),
            });
            expect(response.status).toBe(503);
            expect(((await response.json()) as any).error.code).toBe("unavailable");
        } finally {
            await cut.close();
        }
    });

    test("a verification key that isn't one stops the server from starting", async () => {
        const s = await stack();
        const config = loadConfig({
            MONGODB_URI: inject("mongoUri"),
            MONGODB_DB: `test_${randomUUID().replaceAll("-", "")}`,
            PORT: "0",
            HOST: "127.0.0.1",
            LOG_LEVEL: "silent",
            PRIVY_APP_ID: s.privy.appId,
            PRIVY_APP_SECRET: s.privy.appSecret,
            PRIVY_VERIFICATION_KEY: "-----BEGIN PUBLIC KEY-----\\nnot a key\\n-----END PUBLIC KEY-----",
            ARC_RPC_URLS: s.emulator.url,
            DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
        });
        await expect(startServer(config, pino({ level: "silent" }))).rejects.toThrow(/PRIVY_VERIFICATION_KEY/);
    });
});

describe("a wallet that moves to another Privy user", () => {
    test("is no longer the old user's: no pushes, no requests", async () => {
        const s = await stack();
        const alice = await s.user();
        const aliceSocket = await s.socket(alice);
        const { account } = await connect(aliceSocket, alice.wallet);

        // The wallet is unlinked from Alice and linked to Bob, who connects it.
        const bobId = `did:privy:${randomUUID().replaceAll("-", "")}`;
        s.privy.setUser(alice.userId, [privateKeyToAddress(generatePrivateKey())]);
        s.privy.setUser(bobId, [alice.wallet]);
        const bob: User = { userId: bobId, wallet: alice.wallet as Address, token: await s.privy.token(bobId) };
        const bobSocket = await s.socket(bob);
        await connect(bobSocket, bob.wallet);

        const alicePushes: unknown[] = [];
        aliceSocket.on("deposit:credited", (payload) => alicePushes.push(payload));
        const bobPush = new Promise<{ deposit: DepositView; account: AccountView }>((resolve) =>
            bobSocket.once("deposit:credited", resolve),
        );
        await s.chain.send(alice.wallet, account.depositAddress, "6");
        expect((await bobPush).account.balance).toBe("6");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(alicePushes).toHaveLength(0);

        const list = await aliceSocket.timeout(5000).emitWithAck("deposits:list", {});
        expect(list).toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    }, 30_000);
});

describe("when Privy can't answer", () => {
    async function connectOver(s: Stack, user: User) {
        return post(s, user, "/v1/wallets/connect", { address: user.wallet });
    }

    test("with a wrong app secret, wallets connected before carry on and new ones wait", async () => {
        const s = await stack({ PRIVY_APP_SECRET: "not-the-secret" });
        await vi.waitFor(() => expect(s.server.services.identity.apiState()).toBe("rejected"));

        // Opened earlier, when Privy still vouched for the wallet.
        const returning = await s.user();
        await s.server.services.accounts.open(returning.wallet, returning.userId);
        const back = await connectOver(s, returning);
        expect(back.status).toBe(200);
        expect(back.body.account.wallet.toLowerCase()).toBe(returning.wallet.toLowerCase());

        const newcomer = await s.user();
        const refused = await connectOver(s, newcomer);
        expect(refused.status).toBe(503);
        expect(refused.body.error.code).toBe("unavailable");

        const ready = await fetch(`${s.url}/ready`).then((r) => r.json() as Promise<any>);
        expect(ready.privy).toBe("rejected");
    });

    test("while Privy is down, a returning wallet's socket still connects and deposits", async () => {
        const s = await stack();
        const user = await s.user();
        await s.server.services.accounts.open(user.wallet, user.userId);
        s.privy.failLookups(100, 503);
        try {
            const socket = await s.socket(user);
            const { account } = await connect(socket, user.wallet);
            const hash = await s.chain.send(user.wallet, account.depositAddress, "2");
            const receipt = await socket.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash });
            expect(receipt).toMatchObject({ ok: true, data: { account: { balance: "2" } } });
        } finally {
            s.privy.failLookups(0, 503);
        }
    }, 30_000);

    test("someone else's wallet isn't let through on another user's earlier verification", async () => {
        const s = await stack();
        const owner = await s.user();
        await s.server.services.accounts.open(owner.wallet, owner.userId);
        const intruder = await s.user();
        s.privy.failLookups(100, 503);
        try {
            const result = await post(s, intruder, "/v1/wallets/connect", { address: owner.wallet });
            expect(result.status).toBe(503);
        } finally {
            s.privy.failLookups(0, 503);
        }
    });

    test("ready reports Privy's state and stays ready", async () => {
        const s = await stack();
        await vi.waitFor(() => expect(s.server.services.identity.apiState()).toBe("ok"));
        await vi.waitFor(async () => {
            const response = await fetch(`${s.url}/ready`);
            expect(response.status).toBe(200);
            expect(((await response.json()) as any).privy).toBe("ok");
        });
    });
});
