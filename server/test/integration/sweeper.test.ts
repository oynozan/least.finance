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

test("two quick deposits to one address sweep without a clash", async () => {
    const user = await openUser();
    const sweeps = recordSweeps();
    const first = await stack.chain.send(user.wallet, user.depositAddress, "10");
    const second = await stack.chain.send(user.wallet, user.depositAddress, "20");
    await Promise.all([
        api(user, "/v1/account/deposits", { txHash: first }),
        api(user, "/v1/account/deposits", { txHash: second }),
    ]);

    await vi.waitFor(() => expect(sweeps.hashes.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const settled = await Promise.allSettled(sweeps.hashes);
    sweeps.restore();
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
            const receipt = await stack.chain.client.getTransactionReceipt({ hash: result.value });
            expect(receipt.status).toBe("success");
        }
    }
    expect(await balanceOf(user.depositAddress)).toBeLessThanOrEqual(DUST);
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
    const treasury = keyring().operator().address;
    await stack.server.services.sweeper.sweepAll();
    expect(await collections().deposits.countDocuments({ to: treasury })).toBe(0);
});
