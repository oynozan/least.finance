import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { parseUnits, type Address, type Hex } from "viem";
import { fromDecimal } from "../../src/db/money.ts";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const collections = () => stack.server.services.database.collections;
const wei = (usdc: string) => parseUnits(usdc, 18);
const keyring = () => createKeyring(stack.server.services.config.DEPOSIT_MNEMONIC);
/** What a sweep may leave behind: 10 sends' worth of gas at the highest fee used. */
const DUST = 10n * 21_000n * 100_000_000_000n;

async function api(user: User, path: string, body?: unknown) {
    const response = await fetch(`${stack.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
}

async function openUser() {
    const user = await stack.user({ usdc: "1000" });
    const { body } = await api(user, "/v1/account", {});
    return { ...user, depositAddress: body.account.depositAddress as Address };
}

const balanceOf = (address: Address) => stack.chain.client.getBalance({ address });

/** Records the hash of every sweep the server runs on its own. */
function recordSweeps() {
    const sweeper = stack.server.services.sweeper;
    const original = sweeper.sweep.bind(sweeper);
    const hashes: Promise<Hex | null>[] = [];
    const spy = vi.spyOn(sweeper, "sweep").mockImplementation((index) => {
        const result = original(index);
        hashes.push(result);
        return result;
    });
    return { hashes, restore: () => spy.mockRestore() };
}

test("a credited deposit is swept into the treasury", async () => {
    const user = await openUser();
    const treasury = keyring().operator().address;
    const before = await balanceOf(treasury);
    const sweeps = recordSweeps();
    const txHash = await stack.chain.send(user.wallet, user.depositAddress, "50");
    const { body } = await api(user, "/v1/account/deposits", { txHash });
    expect(body.account.balance).toBe("50");

    await vi.waitFor(() => expect(sweeps.hashes.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect((await Promise.all(sweeps.hashes)).some((hash) => hash !== null)).toBe(true);
    sweeps.restore();
    expect(await balanceOf(user.depositAddress)).toBeLessThanOrEqual(DUST);
    const gained = (await balanceOf(treasury)) - before;
    expect(gained).toBeGreaterThan(wei("49.99"));
    expect(gained).toBeLessThanOrEqual(wei("50"));
    const account = await collections().accounts.findOne({ privyUserId: user.userId });
    expect(account && fromDecimal(account.balance)).toBe(wei("50"));
});

test("two sweeps of one address at once sweep without a clash", async () => {
    const user = await openUser();
    const account = await collections().accounts.findOne({ privyUserId: user.userId });
    const index = account!.depositIndex;
    const treasury = keyring().operator().address;
    const before = await balanceOf(treasury);
    await stack.chain.client.setBalance({ address: user.depositAddress, value: wei("30") });

    // Neither is awaited before the other starts, so without a queue both read the full balance.
    const first = stack.server.services.sweeper.sweep(index);
    const second = stack.server.services.sweeper.sweep(index);
    const settled = await Promise.allSettled([first, second]);

    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const hashes = settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
    // The first moves the balance; the second finds dust.
    expect(hashes[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashes[1]).toBeNull();
    const receipt = await stack.chain.client.getTransactionReceipt({ hash: hashes[0]! });
    expect(receipt.status).toBe("success");
    expect(await balanceOf(user.depositAddress)).toBeLessThanOrEqual(DUST);
    const gained = (await balanceOf(treasury)) - before;
    expect(gained).toBeGreaterThan(wei("29.99"));
    expect(gained).toBeLessThanOrEqual(wei("30"));
});

test("the catch-up pass sweeps an address the bus never mentioned, and leaves dust alone", async () => {
    while (((await collections().counters.findOne({ _id: "depositIndex" }))?.seq ?? 0) < 4) await openUser();
    const { addressAt } = keyring();
    await stack.chain.client.setBalance({ address: addressAt(3), value: wei("7") });
    await stack.chain.client.setBalance({ address: addressAt(4), value: 1n });

    await stack.server.services.sweeper.sweepAll();

    expect(await balanceOf(addressAt(3))).toBeLessThanOrEqual(DUST);
    expect(await balanceOf(addressAt(4))).toBe(1n);
});

test("a sweep credits nobody", async () => {
    const user = await openUser();
    const account = await collections().accounts.findOne({ privyUserId: user.userId });
    await stack.chain.client.setBalance({ address: user.depositAddress, value: wei("12") });
    const balances = async () =>
        (await collections().accounts.find().toArray()).map((doc) => [doc._id.toHexString(), doc.balance]);
    const depositsBefore = await collections().deposits.countDocuments();
    const balancesBefore = await balances();

    const hash = await stack.server.services.sweeper.sweep(account!.depositIndex);
    expect(hash).not.toBeNull();
    // Let the deposit scan see the sweep's block before looking.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(await collections().deposits.countDocuments()).toBe(depositsBefore);
    expect(await collections().deposits.countDocuments({ txHash: hash! })).toBe(0);
    expect(await balances()).toEqual(balancesBefore);
});
