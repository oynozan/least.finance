import { pino } from "pino";
import { afterEach, beforeAll, afterAll, expect, inject, test, vi } from "vitest";
import { parseUnits, type Address, type Hash } from "viem";
import { fromDecimal } from "../../src/db/money.ts";
import { fakeStatsReaders } from "../support/stats-readers.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
/** Servers a test started itself; closed after it. */
const extra: RunningServer[] = [];

beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(async () => {
    for (const server of extra.splice(0)) await server.close().catch(() => undefined);
    await stack?.stop();
});

const wei = (usdc: string) => parseUnits(usdc, 18);
const silent = pino({ level: "silent" });

/** The server the stack currently runs, which a restart replaces. */
let current: RunningServer | undefined;
const live = () => current ?? stack.server;
const collections = () => live().services.database.collections;

async function send(from: Address, to: Address, usdc: string): Promise<Hash> {
    const { client } = stack.chain;
    const hash = await client.sendTransaction({ account: from, to, value: wei(usdc), chain: client.chain });
    await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    return hash;
}

async function openUser(server: RunningServer = live()) {
    const user: User = await stack.user();
    const response = await fetch(`${server.url}/v1/account`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { account: { depositAddress: Address } };
    const account = await server.services.database.collections.accounts.findOne({ privyUserId: user.userId });
    if (!account) throw new Error("account missing");
    return { ...user, depositAddress: body.account.depositAddress, accountId: account._id };
}
type Opened = Awaited<ReturnType<typeof openUser>>;

const depositsOf = (user: Opened) =>
    collections().deposits.find({ accountId: user.accountId }).sort({ _id: 1 }).toArray();
const balanceOf = async (user: Opened) => {
    const account = await collections().accounts.findOne({ _id: user.accountId });
    if (!account) throw new Error("account missing");
    return fromDecimal(account.balance);
};
const waitForBalance = (user: Opened, usdc: string) =>
    expect.poll(() => balanceOf(user), { timeout: 15_000, interval: 50 }).toBe(wei(usdc));

async function scanned(server: RunningServer = live()) {
    const head = Number(await stack.chain.client.getBlockNumber());
    await vi.waitFor(() => expect(server.services.watcher.status().scannedThrough).toBeGreaterThanOrEqual(head), {
        timeout: 10_000,
        interval: 50,
    });
}

/** Replaces the stack's server with a fresh one on the same database, as a restart would. */
async function restart(whileDown: () => Promise<void> = async () => undefined) {
    const config = live().services.config;
    await live().close();
    await whileDown();
    const server = await startServer(config, silent, { statsReaders: fakeStatsReaders() });
    extra.push(server);
    current = server;
    return server;
}

afterEach(async () => {
    const { accounts, deposits, ledger } = collections();
    for (const account of await accounts.find().toArray()) {
        const entries = await ledger.find({ accountId: account._id }).toArray();
        const total = entries.reduce((sum, entry) => sum + fromDecimal(entry.amount), 0n);
        expect(total, `ledger sum of ${account.privyUserId}`).toBe(fromDecimal(account.balance));
        expect(await deposits.countDocuments({ accountId: account._id })).toBe(entries.length);
    }
});

test("every deposit is credited when the chain caps the results of a log query", async () => {
    // A throwaway stack: its emulator refuses queries that would return more than two logs.
    const capped = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        emulator: { maxResults: 2 },
    });
    try {
        const user = await capped.user();
        const opened = await fetch(`${capped.url}/v1/account`, {
            method: "POST",
            headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
            body: JSON.stringify({}),
        }).then((r) => r.json() as Promise<{ account: { depositAddress: Address } }>);
        const address = opened.account.depositAddress;

        // Down while the deposits land, so the first pass back reads them in one range.
        const config = capped.server.services.config;
        await capped.server.close();
        const { client } = capped.chain;
        for (let i = 1; i <= 6; i++) {
            const hash = await client.sendTransaction({
                account: user.wallet,
                to: address,
                value: wei("1"),
                chain: client.chain,
            });
            await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
        }
        const before = capped.emulator.logQueries;
        const server = await startServer(config, silent, { statsReaders: fakeStatsReaders() });
        extra.push(server);
        try {
            const db = server.services.database.collections;
            await expect.poll(() => db.deposits.countDocuments(), { timeout: 15_000, interval: 50 }).toBe(6);
            const account = await db.accounts.findOne({ privyUserId: user.userId });
            expect(fromDecimal(account!.balance)).toBe(wei("6"));
            expect(account!.version).toBe(6);
            expect(capped.emulator.logQueries - before).toBeGreaterThan(1);
            expect(await db.ledger.countDocuments()).toBe(6);
            await server.services.database.db.dropDatabase();
        } finally {
            await server.close();
        }
    } finally {
        await capped.stop();
    }
});

test("a range the chain refuses as too wide is split until it passes", async () => {
    const capped = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        emulator: { maxRange: 2 },
    });
    try {
        const user = await capped.user();
        const opened = await fetch(`${capped.url}/v1/account`, {
            method: "POST",
            headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
            body: JSON.stringify({}),
        }).then((r) => r.json() as Promise<{ account: { depositAddress: Address } }>);
        const config = capped.server.services.config;
        await capped.server.close();
        const { client } = capped.chain;
        for (let i = 0; i < 5; i++) {
            const hash = await client.sendTransaction({
                account: user.wallet,
                to: opened.account.depositAddress,
                value: wei("0.5"),
                chain: client.chain,
            });
            await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
        }
        const server = await startServer(config, silent, { statsReaders: fakeStatsReaders() });
        extra.push(server);
        try {
            const db = server.services.database.collections;
            await expect.poll(() => db.deposits.countDocuments(), { timeout: 15_000, interval: 50 }).toBe(5);
            await server.services.database.db.dropDatabase();
        } finally {
            await server.close();
        }
    } finally {
        await capped.stop();
    }
});

test("a deposit sent during an RPC outage is credited once the RPC recovers", async () => {
    const user = await openUser();
    await scanned();
    stack.emulator.failNext(8);
    await send(user.wallet, user.depositAddress, "2");

    await expect
        .poll(() => live().services.watcher.status().lastError, { timeout: 5_000, interval: 20 })
        .not.toBeNull();
    await waitForBalance(user, "2");
    expect(await depositsOf(user)).toHaveLength(1);
    await expect.poll(() => live().services.watcher.status().lastError, { timeout: 5_000 }).toBeNull();
});

test("a deposit sent while the server was down is credited after it restarts, and nothing is credited twice", async () => {
    const user = await openUser();
    await send(user.wallet, user.depositAddress, "1");
    await waitForBalance(user, "1");
    await scanned();
    const cursorId = "deposits:5042";
    const before = await collections().cursors.findOne({ _id: cursorId });
    expect(before).not.toBeNull();

    let during = "";
    await restart(async () => {
        during = await send(user.wallet, user.depositAddress, "2");
    });
    await waitForBalance(user, "3");
    await scanned();

    const deposits = await depositsOf(user);
    expect(deposits).toHaveLength(2);
    expect(deposits[1]).toMatchObject({ txHash: during, source: "scan" });
    expect((await collections().cursors.findOne({ _id: cursorId }))!.block).toBeGreaterThan(before!.block);
    const account = await collections().accounts.findOne({ _id: user.accountId });
    expect(account!.version).toBe(2);
});

test("two servers scanning one database credit every deposit exactly once", async () => {
    const a = live();
    const b = await startServer({ ...a.services.config, PORT: 0 }, silent, { statsReaders: fakeStatsReaders() });
    extra.push(b);
    const credited = { a: 0, b: 0 };
    a.services.bus.on("deposit:credited", () => credited.a++);
    b.services.bus.on("deposit:credited", () => credited.b++);

    const user = await openUser(a);
    const amounts = ["1", "2", "3", "0.5", "0.25", "4"];
    for (const amount of amounts) await send(user.wallet, user.depositAddress, amount);
    await waitForBalance(user, "10.75");
    await scanned(a);
    await scanned(b);

    expect(await depositsOf(user)).toHaveLength(amounts.length);
    expect(await collections().ledger.countDocuments({ accountId: user.accountId })).toBe(amounts.length);
    expect(credited.a + credited.b).toBe(amounts.length);
    expect((await collections().accounts.findOne({ _id: user.accountId }))!.version).toBe(amounts.length);
});

test("a server learns an account opened by another through the registry refresh", async () => {
    const a = live();
    const b = await startServer({ ...a.services.config, PORT: 0 }, silent, { statsReaders: fakeStatsReaders() });
    extra.push(b);
    // Only B scans, so a credit proves B found the account on its own.
    await a.services.watcher.stop();
    await scanned(b);

    const user = await openUser(a);
    await send(user.wallet, user.depositAddress, "3");
    await waitForBalance(user, "3");
    expect((await depositsOf(user))[0]).toMatchObject({ source: "scan" });
    a.services.watcher.start();
});
