import { randomUUID } from "node:crypto";
import { io as connectSocket } from "socket.io-client";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { AccountView, Ack, DepositView, WalletSession } from "../../src/protocol.ts";
import { startStack, WEB_ORIGIN, type AppSocket, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

type Failure = { message: string; data?: { code: string; message: string } };

/** Opens a socket with arbitrary handshake settings, resolving with how it ended. */
function attempt(url: string, auth: Record<string, unknown> | undefined, origin?: string) {
    const socket = connectSocket(url, {
        auth,
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        ...(origin ? { extraHeaders: { origin } } : {}),
    });
    return new Promise<{ connected: true } | { connected: false; error: Failure }>((resolve) => {
        socket.once("connect", () => {
            resolve({ connected: true });
            socket.disconnect();
        });
        socket.once("connect_error", (error) => {
            resolve({ connected: false, error: error as unknown as Failure });
            socket.disconnect();
        });
    });
}

async function connect(socket: AppSocket) {
    const result = await socket.timeout(5000).emitWithAck("account:open", {});
    if (!result.ok) throw new Error(`account:open failed: ${result.error.code}`);
    return result.data;
}

function collect(socket: AppSocket) {
    const pushes: Push[] = [];
    socket.on("deposit:credited", (payload) => pushes.push(payload));
    return pushes;
}
type Push = { deposit: DepositView; account: AccountView };

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe("handshake", () => {
    test("a connection without a token is refused as unauthorized", async () => {
        const result = await attempt(stack.url, undefined);
        expect(result).toMatchObject({ connected: false, error: { data: { code: "unauthorized" } } });
    });

    test("a garbage token is refused as unauthorized", async () => {
        const result = await attempt(stack.url, { token: "not-a-jwt" });
        expect(result).toMatchObject({ connected: false, error: { data: { code: "unauthorized" } } });
    });

    test("an expired token is refused as unauthorized", async () => {
        const user = await stack.user();
        const token = await stack.privy.token(user.userId, { expiresInSeconds: -60 });
        const result = await attempt(stack.url, { token });
        expect(result).toMatchObject({ connected: false, error: { data: { code: "unauthorized" } } });
    });

    test("a valid token connects", async () => {
        const user = await stack.user();
        expect(await attempt(stack.url, { token: user.token }, WEB_ORIGIN)).toEqual({ connected: true });
    });
});

describe("origin", () => {
    test("a page on another site is refused", async () => {
        const user = await stack.user();
        const result = await attempt(stack.url, { token: user.token }, "https://evil.example");
        expect(result.connected).toBe(false);
    });

    test("a client sending no origin connects with a valid token", async () => {
        const user = await stack.user();
        expect(await attempt(stack.url, { token: user.token })).toEqual({ connected: true });
    });
});

describe("account:open", () => {
    test("binds the signed-in person's account without a wallet address", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        const result = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
        expect(result).toMatchObject({
            ok: true,
            data: {
                account: { depositAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/), balance: "0", version: 0 },
                deposits: { items: [], next: null },
                rules: { chainId: 5042 },
            },
        });
        if (!result.ok) return;
        expect(result.data.account).not.toHaveProperty("wallet");
        const again = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
        expect(again.ok && again.data.account.depositAddress).toBe(result.data.account.depositAddress);
    });

    test("one account per person, however many wallets they've linked", async () => {
        const w1 = privateKeyToAddress(generatePrivateKey());
        const w2 = privateKeyToAddress(generatePrivateKey());
        const userId = `did:privy:${randomUUID().replaceAll("-", "")}`;
        stack.privy.setUser(userId, [w1, w2]);
        const user: User = { userId, wallet: w1, token: await stack.privy.token(userId) };

        const first = await connect(await stack.socket(user));
        const second = await connect(await stack.socket(user));
        expect(second.account.depositAddress).toBe(first.account.depositAddress);
        const { accounts } = stack.server.services.database.collections;
        expect(await accounts.countDocuments({ privyUserId: userId })).toBe(1);
    });

    test("an event without an acknowledgement doesn't break the server", async () => {
        const socket = await stack.socket(await stack.user());
        const raw = socket as unknown as { emit(event: string, ...args: unknown[]): void };
        raw.emit("account:open", {});
        raw.emit("account:open");
        const session = await connect(socket);
        expect(session.account.balance).toBe("0");
        expect(socket.connected).toBe(true);
    });
});

describe("before account:open", () => {
    test("listing deposits needs an open account", async () => {
        const socket = await stack.socket(await stack.user());
        const result = await socket.timeout(5000).emitWithAck("deposits:list", {});
        expect(result).toMatchObject({
            ok: false,
            error: { code: "wallet_not_connected", message: "Your account isn't open yet. Reload the page to open it." },
        });
    });

    test("submitting a deposit needs an open account", async () => {
        const socket = await stack.socket(await stack.user());
        const result = await socket.timeout(5000).emitWithAck("deposit:submit", { txHash: `0x${"ab".repeat(32)}` });
        expect(result).toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    });
});

describe("deposits", () => {
    test("a submitted deposit is credited, acked, and pushed to every tab but nobody else", async () => {
        const user = await stack.user();
        const other = await stack.user();
        const tab1 = await stack.socket(user);
        const tab2 = await stack.socket(user);
        const bystander = await stack.socket(other);
        const session = await connect(tab1);
        await connect(tab2);
        await connect(bystander);
        const pushes1 = collect(tab1);
        const pushes2 = collect(tab2);
        const pushesOther = collect(bystander);

        const hash = await stack.chain.send(user.wallet, session.account.depositAddress, "12.5");
        const receipt = await tab1.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash });
        expect(receipt).toMatchObject({
            ok: true,
            data: { txHash: hash, account: { balance: "12.5", version: 1 }, deposits: [{ amount: "12.5" }] },
        });
        await waitFor(() => expect(pushes1).toHaveLength(1));
        await waitFor(() => expect(pushes2).toHaveLength(1));
        await settle();
        expect(pushesOther).toHaveLength(0);
        expect(pushes2[0]!.deposit.txHash).toBe(hash);
    });

    test("the push carries the deposit and the account, and versions rise by one per deposit", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        const session = await connect(socket);
        const pushes = collect(socket);

        const first = await stack.chain.send(user.wallet, session.account.depositAddress, "1");
        const second = await stack.chain.send(user.wallet, session.account.depositAddress, "2.25");
        await waitFor(() => expect(pushes).toHaveLength(2), 8000);

        const ordered = [...pushes].sort((a, b) => a.account.version - b.account.version);
        expect(ordered.map((p) => p.account.version)).toEqual([1, 2]);
        expect(ordered.map((p) => p.deposit.txHash)).toEqual([first, second]);
        expect(ordered.map((p) => p.account.balance)).toEqual(["1", "3.25"]);
        expect(ordered[0]!.deposit).toEqual({
            id: expect.stringMatching(/^[0-9a-f]{24}$/),
            txHash: first,
            logIndex: expect.any(Number),
            from: getAddress(user.wallet),
            amount: "1",
            blockNumber: expect.any(Number),
            creditedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        });
        expect(new Date(ordered[0]!.deposit.creditedAt).toISOString()).toBe(ordered[0]!.deposit.creditedAt);
    });

    test("a transfer nobody reported is found by the scan and pushed", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        const session = await connect(socket);
        const pushed = new Promise<{ deposit: { amount: string } }>((resolve) =>
            socket.once("deposit:credited", resolve),
        );
        await stack.chain.send(user.wallet, session.account.depositAddress, "3");
        expect((await pushed).deposit.amount).toBe("3");
    });

    test("the same transaction reported at once from two sockets is credited once", async () => {
        const user = await stack.user();
        const a = await stack.socket(user);
        const b = await stack.socket(user);
        const session = await connect(a);
        await connect(b);

        const hash = await stack.chain.send(user.wallet, session.account.depositAddress, "5");
        const [ra, rb] = await Promise.all([
            a.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash }),
            b.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash }),
        ]);
        expect(ra).toMatchObject({ ok: true, data: { account: { balance: "5" } } });
        expect(rb).toMatchObject({ ok: true, data: { account: { balance: "5" } } });
        await settle(600);

        const { collections } = stack.server.services.database;
        const accountDoc = await collections.accounts.findOne({ privyUserId: user.userId });
        expect(accountDoc).not.toBeNull();
        expect(await collections.ledger.countDocuments({ accountId: accountDoc!._id })).toBe(1);
        expect(await collections.deposits.countDocuments({ accountId: accountDoc!._id })).toBe(1);
        const view = await a.timeout(5000).emitWithAck("account:open", {});
        expect(view).toMatchObject({ ok: true, data: { account: { balance: "5", version: 1 } } });
    });
});

describe("whose account a socket hears about", () => {
    test("a person's deposits aren't pushed to someone else", async () => {
        const a = await stack.user();
        const b = await stack.user();
        const socketA = await stack.socket(a);
        const socketB = await stack.socket(b);
        const sessionA = await connect(socketA);
        await connect(socketB);
        const pushesA = collect(socketA);
        const pushesB = collect(socketB);

        const hash = await stack.chain.send(a.wallet, sessionA.account.depositAddress, "2");
        await waitFor(() => expect(pushesA).toHaveLength(1), 8000);
        await settle(600);
        expect(pushesA[0]!.deposit.txHash).toBe(hash);
        expect(pushesB).toHaveLength(0);
    });

    test("a new connection with another person's token binds that person's account", async () => {
        const a = await stack.user();
        const b = await stack.user();
        const first = await stack.socket(a);
        const sessionA = await connect(first);
        first.disconnect();

        const second = await stack.socket(b);
        const sessionB = await connect(second);
        expect(sessionB.account.depositAddress).not.toBe(sessionA.account.depositAddress);
        const pushes = collect(second);

        await stack.chain.send(a.wallet, sessionA.account.depositAddress, "1");
        await settle(1000);
        expect(pushes).toHaveLength(0);
    });
});

describe("limits", () => {
    test("events past 40 in ten seconds are answered rate_limited", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        await connect(socket);

        const results = await Promise.all(
            Array.from({ length: 50 }, () => socket.timeout(10_000).emitWithAck("deposits:list", {})),
        );
        const limited = results.filter((r) => !r.ok && r.error.code === "rate_limited");
        expect(limited.length).toBeGreaterThanOrEqual(9);
        expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(40);
    });
});

describe("Solana sockets", () => {
    let open: Stack;
    beforeAll(async () => {
        open = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { SOLANA_DEPOSITS: "on" },
        });
    });
    afterAll(() => open?.stop());

    test("solana:blockhash answers the fake RPC's blockhash and is limited to 30 per minute", async () => {
        open.solanaRpc.setBlockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", 321);
        const user = await open.user();
        const socket = await open.socket(user);
        await connect(socket);
        const acks: Ack<{ blockhash: string; lastValidBlockHeight: number }>[] = [];
        for (let i = 0; i < 31; i++) acks.push(await socket.timeout(5000).emitWithAck("solana:blockhash", {}));
        expect(acks[0]).toEqual({
            ok: true,
            data: { blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", lastValidBlockHeight: 321 },
        });
        expect(acks.slice(0, 30).every((ack) => ack.ok)).toBe(true);
        expect(acks[30]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    });

    test("solana:blockhash is unavailable while SOLANA_DEPOSITS is off", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        await connect(socket);
        expect(await socket.timeout(5000).emitWithAck("solana:blockhash", {})).toEqual({
            ok: false,
            error: { code: "unavailable", message: "Solana isn't open yet." },
        });
    });

    test("deposit:order for a Solana coin returns a kind: solana tx", async () => {
        const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
        const user = await open.user();
        open.privy.setUser(user.userId, [user.wallet, { address: wallet, chain: "solana" }]);
        const socket = await open.socket(user);
        await connect(socket);
        const result = await socket
            .timeout(5000)
            .emitWithAck("deposit:order", { coin: "solana:USDC", amount: "10", wallet });
        if (!result.ok) throw new Error(result.error.code);
        expect(result.data.txs).toHaveLength(1);
        expect(result.data.txs[0]).toMatchObject({ kind: "solana", lookupTables: [] });
    });
});

describe("session expiry", () => {
    test("a token that runs out gets session:expired and a disconnect", async () => {
        const user = await stack.user();
        const token = await stack.privy.token(user.userId, { expiresInSeconds: 2 });
        const socket = await stack.socket({ ...user, token });
        const expired = new Promise<void>((resolve) => socket.once("session:expired", resolve));
        const reason = new Promise<string>((resolve) => socket.once("disconnect", resolve));
        await expired;
        expect(await reason).toBe("io server disconnect");
        expect(socket.connected).toBe(false);
    }, 15_000);
});

describe("handshake rate limit", () => {
    test("connections past the per-minute limit from one address are turned away", async () => {
        const own = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { SOCKET_HANDSHAKES_PER_MINUTE: "30" },
        });
        try {
            const user = await own.user();
            const results = [];
            for (let i = 0; i < 31; i++) results.push(await attempt(own.url, { token: user.token }));
            expect(results.slice(0, 30).every((r) => r.connected)).toBe(true);
            expect(results[30]).toMatchObject({ connected: false, error: { data: { code: "rate_limited" } } });
        } finally {
            await own.stop();
        }
    }, 30_000);
});

function waitFor(fn: () => void, timeout = 5000) {
    return vi.waitFor(fn, { timeout, interval: 50 });
}
