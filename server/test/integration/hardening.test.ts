import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

const JSON_HEADERS = { "content-type": "application/json" };

/** Nothing listens here, so every request to it fails at once. */
const DEAD_RPC = "http://127.0.0.1:9";

const stacks: Stack[] = [];
async function stack(env: Record<string, string> = {}) {
    const started = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), env });
    stacks.push(started);
    return started;
}
afterAll(() => Promise.all(stacks.map((s) => s.stop())));

async function connect(socket: AppSocket) {
    const result = await socket.timeout(5000).emitWithAck("account:open", {});
    if (!result.ok) throw new Error(`account:open failed: ${result.error.code}`);
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
            const { account } = await connect(socket);
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
            expect((await second.services.accounts.find(user.userId))?.version).toBe(1);
        } finally {
            await second.close();
        }
    }, 30_000);

    test("stays the configured number of blocks behind the head", async () => {
        // Other test files mine on the same chain meanwhile, so the lag is wide enough that they can't close it.
        const lagging = await stack({ DEPOSIT_SCAN_LAG_BLOCKS: "50" });
        const user = await lagging.user();
        const socket = await lagging.socket(user);
        const { account } = await connect(socket);
        const credited = new Promise<{ deposit: DepositView }>((resolve) => socket.once("deposit:credited", resolve));

        await lagging.chain.send(user.wallet, account.depositAddress, "4");
        await new Promise((resolve) => setTimeout(resolve, 800));
        const before = await lagging.server.services.accounts.find(user.userId);
        expect(before?.version, "not credited while the block is within the lag").toBe(0);

        await lagging.chain.client.mine({ blocks: 50 });
        expect((await credited).deposit.amount).toBe("4");
    }, 30_000);

    test("ready never shows the RPC's address or key when a scan fails", async () => {
        // A keyed endpoint in front of the emulator that can be made to fail on demand
        let down = false;
        const keyed = createServer(async (req, res) => {
            if (down) return res.writeHead(503).end();
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const answer = await fetch(s.emulator.url, {
                method: "POST",
                body: Buffer.concat(chunks),
                headers: JSON_HEADERS,
            });
            res.writeHead(200, JSON_HEADERS).end(await answer.text());
        });
        await new Promise<void>((resolve) => keyed.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(keyed.address() as AddressInfo).port}/v2/SECRETKEY123?dkey=QUERYSECRET`;
        const config = { ...s.server.services.config, PORT: 0, ARC_RPC_URLS: [url] };
        const scanning = await startServer(config, pino({ level: "silent" }));
        try {
            await vi.waitFor(() => expect(scanning.services.watcher.status().lastSuccessAt).not.toBeNull());
            down = true;
            await vi.waitFor(() => expect(scanning.services.watcher.status().lastError).not.toBeNull(), {
                timeout: 15_000,
                interval: 50,
            });
            const response = await fetch(`${scanning.url}/ready`);
            const text = await response.text();
            expect(text).not.toMatch(/SECRETKEY123|QUERYSECRET|127\.0\.0\.1/);
            expect(JSON.parse(text).depositScan.lastError).toEqual(expect.any(String));
        } finally {
            await scanning.close();
            keyed.closeAllConnections();
            keyed.close();
        }
    }, 30_000);
});

describe("reported deposits", () => {
    test("an account checks at most three transactions at once", async () => {
        const s = await stack({ DEPOSIT_RECEIPT_TIMEOUT_MS: "2000" });
        const user = await s.user();
        await post(s, user, "/v1/account", {});
        const path = "/v1/account/deposits";

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
        const { status, body } = await post(s, user, "/v1/account", {});
        expect(status).toBe(200);
        expect(body.account.balance).toBe("0");

        const forged = await s.privy.token(user.userId, { appId: "someone-else" });
        const refused = await post(s, { ...user, token: forged }, "/v1/account", {});
        expect(refused.status).toBe(401);
    });

    test("an unreachable key set is unavailable, not a sign-out", async () => {
        const s = await stack({ PRIVY_VERIFICATION_KEY: "" });
        const config = { ...s.server.services.config, PORT: 0, PRIVY_API_URL: DEAD_RPC };
        const cut = await startServer(config, pino({ level: "silent" }));
        try {
            const user = await s.user();
            const response = await fetch(`${cut.url}/v1/account`, {
                method: "POST",
                headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
                body: JSON.stringify({}),
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
    test("an account stays with its person when a wallet is relinked to someone else", async () => {
        const s = await stack();
        const alice = await s.user();
        const aliceSocket = await s.socket(alice);
        const { account } = await connect(aliceSocket);
        const hash = await s.chain.send(alice.wallet, account.depositAddress, "6");
        await aliceSocket.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash });

        // The wallet is unlinked from Alice and linked to Bob, who opens his account.
        const bobId = `did:privy:${randomUUID().replaceAll("-", "")}`;
        s.privy.setUser(alice.userId, [privateKeyToAddress(generatePrivateKey())]);
        s.privy.setUser(bobId, [alice.wallet]);
        const bob: User = { userId: bobId, wallet: alice.wallet as Address, token: await s.privy.token(bobId) };
        const bobSocket = await s.socket(bob);
        const bobSession = await connect(bobSocket);

        expect(bobSession.account.depositAddress).not.toBe(account.depositAddress);
        expect(bobSession.account.balance).toBe("0");
        const mine = await aliceSocket.timeout(5000).emitWithAck("account:open", {});
        expect(mine).toMatchObject({
            ok: true,
            data: { account: { depositAddress: account.depositAddress, balance: "6" } },
        });
    }, 30_000);
});

describe("when Privy can't answer", () => {
    test("binding needs no answer from Privy's API", async () => {
        const s = await stack();
        const user = await s.user();
        s.privy.failLookups(10, 500);
        try {
            const socket = await s.socket(user);
            const { account } = await connect(socket);
            const hash = await s.chain.send(user.wallet, account.depositAddress, "2");
            const receipt = await socket.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash });
            expect(receipt).toMatchObject({ ok: true, data: { account: { balance: "2" } } });
        } finally {
            s.privy.failLookups(0, 500);
        }
    }, 30_000);

    test("binding needs no answer from Privy's API when it rejects the server's credentials", async () => {
        const s = await stack({ PRIVY_APP_SECRET: "not-the-secret" });
        await vi.waitFor(() => expect(s.server.services.identity.apiState()).toBe("rejected"));

        const opened = await post(s, await s.user(), "/v1/account", {});
        expect(opened.status).toBe(200);

        const ready = await fetch(`${s.url}/ready`).then((r) => r.json() as Promise<any>);
        expect(ready.privy).toBe("rejected");
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
