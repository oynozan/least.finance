import { afterAll, afterEach, beforeAll, expect, inject, test, vi } from "vitest";
import { formatUnits, pad, parseUnits, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { fromDecimal } from "../../src/db/money.ts";
import type { DepositReceipt } from "../../src/protocol.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const collections = () => stack.server.services.database.collections;
const wei = (usdc: string) => parseUnits(usdc, 18);

async function api(user: User, path: string, body?: unknown) {
    const response = await fetch(`${stack.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
}

/** A fresh user whose account is already open. */
async function openUser() {
    const user = await stack.user();
    const { status, body } = await api(user, "/v1/account", {});
    expect(status).toBe(200);
    const depositAddress = body.account.depositAddress as Address;
    const account = await collections().accounts.findOne({ privyUserId: user.userId });
    if (!account) throw new Error("account missing");
    return { ...user, depositAddress, accountId: account._id };
}
type Opened = Awaited<ReturnType<typeof openUser>>;

const report = (user: Opened, txHash: Hash) => api(user, "/v1/account/deposits", { txHash });

const depositsOf = (user: Opened) =>
    collections().deposits.find({ accountId: user.accountId }).sort({ _id: 1 }).toArray();
const ledgerOf = (user: Opened) => collections().ledger.find({ accountId: user.accountId }).sort({ _id: 1 }).toArray();
const accountOf = async (user: Opened) => {
    const account = await collections().accounts.findOne({ _id: user.accountId });
    if (!account) throw new Error("account missing");
    return { ...account, wei: fromDecimal(account.balance) };
};

/** Waits for the scan to have read every block mined so far. */
async function scanned() {
    const head = Number(await stack.chain.client.getBlockNumber());
    await vi.waitFor(() => expect(stack.server.services.watcher.status().scannedThrough).toBeGreaterThanOrEqual(head), {
        timeout: 10_000,
        interval: 50,
    });
}

async function waitForBalance(user: Opened, usdc: string) {
    await expect.poll(async () => (await accountOf(user)).wei, { timeout: 10_000, interval: 50 }).toBe(wei(usdc));
}

/** stack.chain.send, but polling for the receipt faster than viem's four seconds. */
async function send(from: Address, to: Address, usdc: string): Promise<Hash> {
    const { client } = stack.chain;
    const hash = await client.sendTransaction({ account: from, to, value: wei(usdc), chain: client.chain });
    await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    return hash;
}

/** A funded address that isn't anyone's wallet. */
async function stranger() {
    const address = privateKeyToAddress(generatePrivateKey());
    await stack.chain.fund(address, "100");
    return address;
}

/**
 * Hand-assembled contract. Its runtime code makes `calls` CALLs to the address in
 * calldata word 0, each forwarding callvalue/`divisor`, then either stops or reverts.
 */
async function deployForwarder(
    from: Address,
    { calls, divisor, revert }: { calls: number; divisor: number; revert: boolean },
) {
    const call = [
        "60 00", // PUSH1 0    retSize
        "60 00", // PUSH1 0    retOffset
        "60 00", // PUSH1 0    argsSize
        "60 00", // PUSH1 0    argsOffset
        `60 ${divisor.toString(16).padStart(2, "0")}`, // PUSH1 divisor
        "34", // CALLVALUE
        "04", // DIV        callvalue / divisor, the value to forward
        "60 00", // PUSH1 0
        "35", // CALLDATALOAD the target address
        "5a", // GAS
        "f1", // CALL
        "50", // POP        the success flag
    ].join(" ");
    const ending = revert
        ? ["60 00", "60 00", "fd"].join(" ") // PUSH1 0, PUSH1 0, REVERT
        : "00"; // STOP
    const runtime = `0x${Array.from({ length: calls }, () => call)
        .concat(ending)
        .join(" ")
        .replaceAll(" ", "")}` as Hex;
    const size = (runtime.length - 2) / 2;
    const init = [
        `60 ${size.toString(16).padStart(2, "0")}`, // PUSH1 size
        "60 0c", // PUSH1 12     where the runtime starts in this code
        "60 00", // PUSH1 0      destination in memory
        "39", // CODECOPY
        `60 ${size.toString(16).padStart(2, "0")}`, // PUSH1 size
        "60 00", // PUSH1 0
        "f3", // RETURN the runtime
    ]
        .join(" ")
        .replaceAll(" ", "");
    const { client } = stack.chain;
    const hash = await client.sendTransaction({
        account: from,
        data: `0x${init}${runtime.slice(2)}`,
        gas: 500_000n,
        chain: client.chain,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    if (!receipt.contractAddress) throw new Error("deploy failed");
    return receipt.contractAddress;
}

async function sendThrough(from: Address, contract: Address, target: Address, usdc: string): Promise<Hash> {
    const { client } = stack.chain;
    const hash = await client.sendTransaction({
        account: from,
        to: contract,
        value: wei(usdc),
        data: pad(target),
        gas: 500_000n,
        chain: client.chain,
    });
    await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    return hash;
}

/** What must hold for every account whatever happened to it. */
async function expectConsistent() {
    const { accounts, deposits, ledger } = collections();
    for (const account of await accounts.find().toArray()) {
        const entries = await ledger.find({ accountId: account._id }).sort({ _id: 1 }).toArray();
        const docs = await deposits.find({ accountId: account._id }).toArray();
        const total = entries.reduce((sum, entry) => sum + fromDecimal(entry.amount), 0n);
        expect(total, `ledger sum of ${account.privyUserId}`).toBe(fromDecimal(account.balance));
        expect(docs.length, `deposit count of ${account.privyUserId}`).toBe(entries.length);
        expect(account.version, `version of ${account.privyUserId}`).toBe(entries.length);
        expect(new Set(entries.map((entry) => entry.refId.toHexString()))).toEqual(
            new Set(docs.map((deposit) => deposit._id.toHexString())),
        );
    }
}
afterEach(expectConsistent);

test("a deposit that was never reported is credited by the scan", async () => {
    const user = await openUser();
    const hash = await send(user.wallet, user.depositAddress, "5");
    await waitForBalance(user, "5");

    const [deposit] = await depositsOf(user);
    expect(deposit).toMatchObject({
        txHash: hash,
        source: "scan",
        chainId: 5042,
        from: user.wallet.toLowerCase(),
        to: user.depositAddress.toLowerCase(),
    });
    expect(fromDecimal(deposit!.amount)).toBe(wei("5"));
    expect((await accountOf(user)).version).toBe(1);
});

test("a deposit reported and then scanned is credited once", async () => {
    const user = await openUser();
    const hash = await send(user.wallet, user.depositAddress, "3");
    const { status, body } = await report(user, hash);
    expect(status).toBe(200);
    expect(body.account).toMatchObject({ balance: "3", version: 1 });
    await scanned();

    const deposits = await depositsOf(user);
    expect(deposits).toHaveLength(1);
    expect(await ledgerOf(user)).toHaveLength(1);
    expect(await accountOf(user)).toMatchObject({ wei: wei("3"), version: 1 });
});

test("a deposit scanned and then reported is credited once", async () => {
    const user = await openUser();
    const hash = await send(user.wallet, user.depositAddress, "4");
    await waitForBalance(user, "4");

    const { status, body } = await report(user, hash);
    expect(status).toBe(200);
    expect(body.deposits).toHaveLength(1);
    expect(body.account).toMatchObject({ balance: "4", version: 1 });

    const deposits = await depositsOf(user);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.source).toBe("scan");
    expect(await ledgerOf(user)).toHaveLength(1);
});

test("ten concurrent reports of one transaction credit it once", async () => {
    const user = await openUser();
    const socket = await stack.socket(user);
    await socket.timeout(5000).emitWithAck("account:open", {});
    const hash = await send(user.wallet, user.depositAddress, "2.5");

    const results = await Promise.all([
        ...Array.from({ length: 5 }, () => report(user, hash)),
        ...Array.from({ length: 5 }, () => socket.timeout(10_000).emitWithAck("deposit:submit", { txHash: hash })),
    ]);
    for (const result of results) {
        const ok = "status" in result ? result.status === 200 : result.ok;
        expect(ok, JSON.stringify(result)).toBe(true);
    }
    await scanned();

    expect(await depositsOf(user)).toHaveLength(1);
    expect(await ledgerOf(user)).toHaveLength(1);
    expect(await accountOf(user)).toMatchObject({ wei: wei("2.5"), version: 1 });
});

test("a deposit from an address that is not the user's wallet is credited to the account owning the address", async () => {
    const user = await openUser();
    const other = await openUser();
    const sender = await stranger();
    const hash = await send(sender, user.depositAddress, "7");

    const { status, body } = await report(user, hash);
    expect(status).toBe(200);
    expect(body.deposits[0].from.toLowerCase()).toBe(sender.toLowerCase());
    const [deposit] = await depositsOf(user);
    expect(deposit).toMatchObject({ from: sender.toLowerCase(), txHash: hash });
    expect(await accountOf(user)).toMatchObject({ wei: wei("7") });
    expect(await accountOf(other)).toMatchObject({ wei: 0n, version: 0 });

    // Someone else cannot claim it for their own account.
    const claim = await report(other, hash);
    expect(claim.status).toBe(422);
    expect(claim.body.error.code).toBe("no_deposit");
});

test("a sender that is not the wallet is credited by the scan alone", async () => {
    const user = await openUser();
    const sender = await stranger();
    await send(sender, user.depositAddress, "1.5");
    await waitForBalance(user, "1.5");
    expect((await depositsOf(user))[0]).toMatchObject({ from: sender.toLowerCase(), source: "scan" });
});

test("eighteen decimals of precision survive crediting", async () => {
    const user = await openUser();
    const hash = await send(user.wallet, user.depositAddress, "1.000000000000000001");
    const { body } = await report(user, hash);
    expect(body.account.balance).toBe("1.000000000000000001");
    expect(body.deposits[0].amount).toBe("1.000000000000000001");
    expect((await accountOf(user)).wei).toBe(1_000_000_000_000_000_001n);
});

test("several deposits sum exactly and the ledger keeps a running balance", async () => {
    const user = await openUser();
    const amounts = ["0.1", "0.2", "0.010000000000000001", "123.456789012345678901", "0.3"];
    for (const amount of amounts) {
        const hash = await send(user.wallet, user.depositAddress, amount);
        expect((await report(user, hash)).status).toBe(200);
    }
    const total = amounts.reduce((sum, amount) => sum + wei(amount), 0n);
    const account = await accountOf(user);
    expect(account.wei).toBe(total);
    expect(account.version).toBe(amounts.length);
    expect(formatUnits(account.wei, 18)).toBe("124.066789012345678902");

    let running = 0n;
    const ledger = await ledgerOf(user);
    expect(ledger).toHaveLength(amounts.length);
    for (const [i, entry] of ledger.entries()) {
        running += wei(amounts[i]!);
        expect(fromDecimal(entry.amount)).toBe(wei(amounts[i]!));
        expect(fromDecimal(entry.balanceAfter)).toBe(running);
    }
});

test("a transfer under the minimum is not credited by report or scan, and exactly the minimum is", async () => {
    const user = await openUser();
    const socket = await stack.socket(user);
    await socket.timeout(5000).emitWithAck("account:open", {});

    const small = await send(user.wallet, user.depositAddress, "0.009");
    const viaHttp = await report(user, small);
    expect(viaHttp.status).toBe(422);
    expect(viaHttp.body.error.code).toBe("below_minimum");
    const viaSocket = await socket.timeout(5000).emitWithAck("deposit:submit", { txHash: small });
    expect(viaSocket).toMatchObject({ ok: false, error: { code: "below_minimum" } });

    // Unreported small transfer, then a few scan passes.
    await send(user.wallet, user.depositAddress, "0.00999999");
    await scanned();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await scanned();
    expect(await depositsOf(user)).toHaveLength(0);
    expect(await accountOf(user)).toMatchObject({ wei: 0n, version: 0 });

    await send(user.wallet, user.depositAddress, "0.01");
    await waitForBalance(user, "0.01");
    expect(await depositsOf(user)).toHaveLength(1);
});

test("a reverted transaction that forwarded value is rejected and never credited", async () => {
    const user = await openUser();
    const contract = await deployForwarder(user.wallet, { calls: 1, divisor: 1, revert: true });
    const hash = await sendThrough(user.wallet, contract, user.depositAddress, "2");
    const receipt = await stack.chain.client.getTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");

    const { status, body } = await report(user, hash);
    expect(status).toBe(422);
    expect(body.error.code).toBe("tx_reverted");
    await scanned();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await scanned();
    expect(await depositsOf(user)).toHaveLength(0);
    expect(await accountOf(user)).toMatchObject({ wei: 0n, version: 0 });
});

test("a contract that forwards value to the deposit address in two calls is credited twice", async () => {
    const user = await openUser();
    const contract = await deployForwarder(user.wallet, { calls: 2, divisor: 2, revert: false });
    const hash = await sendThrough(user.wallet, contract, user.depositAddress, "3");

    const { status, body } = await report(user, hash);
    expect(status).toBe(200);
    const receipt = body as DepositReceipt;
    expect(receipt.deposits).toHaveLength(2);
    expect(new Set(receipt.deposits.map((d) => d.logIndex)).size).toBe(2);
    expect(receipt.deposits.map((d) => d.amount)).toEqual(["1.5", "1.5"]);
    expect(receipt.account).toMatchObject({ balance: "3", version: 2 });
    await scanned();

    const deposits = await depositsOf(user);
    expect(deposits).toHaveLength(2);
    expect(await ledgerOf(user)).toHaveLength(2);
    expect((await accountOf(user)).wei).toBe(wei("3"));
});

test("the scan credits both forwards of a multi-hop transaction that was never reported", async () => {
    const user = await openUser();
    const contract = await deployForwarder(user.wallet, { calls: 2, divisor: 2, revert: false });
    const hash = await sendThrough(user.wallet, contract, user.depositAddress, "5");
    await waitForBalance(user, "5");
    await scanned();

    const deposits = await depositsOf(user);
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.txHash === hash && d.source === "scan")).toBe(true);
    // The late report agrees with the scan and adds nothing.
    const { body } = await report(user, hash);
    expect(body.deposits).toHaveLength(2);
    expect(await depositsOf(user)).toHaveLength(2);
});

test("value forwarded through a contract is credited although the transaction was sent to the contract", async () => {
    const user = await openUser();
    const contract = await deployForwarder(user.wallet, { calls: 1, divisor: 1, revert: false });
    const hash = await sendThrough(user.wallet, contract, user.depositAddress, "6");
    const tx = await stack.chain.client.getTransaction({ hash });
    expect(tx.to?.toLowerCase()).toBe(contract.toLowerCase());

    const { status, body } = await report(user, hash);
    expect(status).toBe(200);
    expect(body.account.balance).toBe("6");
    const [deposit] = await depositsOf(user);
    // The value reached the account from the contract, not from the wallet.
    expect(deposit!.from).toBe(contract.toLowerCase());
    await scanned();
    expect(await depositsOf(user)).toHaveLength(1);
});

test("a transaction that sent nothing to the account is rejected", async () => {
    const user = await openUser();
    const sender = await stranger();
    const hash = await send(sender, sender, "1");
    const { status, body } = await report(user, hash);
    expect(status).toBe(422);
    expect(body.error.code).toBe("no_deposit");
});
