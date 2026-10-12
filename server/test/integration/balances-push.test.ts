import { getAddress } from "viem";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { SOLANA_COINS } from "../../src/crosschain/catalog.ts";
import type { BalancesView } from "../../src/protocol.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOLANA_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_MINT = SOLANA_COINS.find((coin) => coin.mint)!.mint!;

let clock = 1_000_000;
let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), now: () => clock });
});
afterAll(() => stack?.stop());

/** A signed-in user with one EVM and one Solana wallet. */
async function person(solana = SOLANA) {
    const user = await stack.user();
    stack.privy.setUser(user.userId, [user.wallet, { address: solana, chain: "solana" }]);
    return user;
}

/** Collects every `balances` push of a socket. */
function listen(socket: AppSocket) {
    const pushes: BalancesView[] = [];
    socket.on("balances", (view) => pushes.push(view));
    return pushes;
}

async function bind(user: User) {
    const socket = await stack.socket(user);
    const pushes = listen(socket);
    const opened = await socket.timeout(5000).emitWithAck("account:open", {});
    expect(opened.ok).toBe(true);
    await expect.poll(() => pushes.length).toBe(1);
    return { socket, pushes };
}

const click = async (socket: AppSocket) => {
    const result = await socket.timeout(5000).emitWithAck("balances:refresh", {});
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
};

const solanaRows = (view: BalancesView, wallet = SOLANA) => view.rows.filter((row) => row.wallet === wallet);

test("binding pushes every coin in every linked wallet", async () => {
    stack.solanaRpc.setBalance(SOLANA, 2_000_000_000n);
    stack.solanaRpc.setTokenBalance(SOLANA, USDC_MINT, 12_500_000n);
    const user = await person();
    const { pushes } = await bind(user);

    const rows = pushes[0]!.rows;
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.wallet === getAddress(user.wallet))).toHaveLength(7);
    expect(solanaRows(pushes[0]!).map((row) => [row.symbol, row.amount, row.usd])).toEqual([
        ["SOL", "2", 300],
        ["USDC", "12.5", 12.5],
    ]);
    expect(rows.every((row) => row.amount !== null)).toBe(true);
});

test("a click inside 30 s reads nothing, and after 30 s reads again", async () => {
    const { socket, pushes } = await bind(await person());

    clock += 10_000;
    expect(await click(socket)).toEqual({ read: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pushes).toHaveLength(1);

    clock += 20_000;
    expect(await click(socket)).toEqual({ read: true });
    await expect.poll(() => pushes.length).toBe(2);
});

test("a newly linked wallet is read at once, inside the 30 s", async () => {
    const user = await person();
    const { socket, pushes } = await bind(user);
    expect(pushes[0]!.rows).toHaveLength(9);

    stack.solanaRpc.setBalance(SOLANA_B, 1_000_000_000n);
    stack.privy.setUser(user.userId, [
        user.wallet,
        { address: SOLANA, chain: "solana" },
        { address: SOLANA_B, chain: "solana" },
    ]);
    clock += 6_000;

    expect(await click(socket)).toEqual({ read: true });
    await expect.poll(() => pushes.length).toBe(2);
    expect(pushes[1]!.rows).toHaveLength(11);
    expect(solanaRows(pushes[1]!, SOLANA_B)[0]!.amount).toBe("1");
    // The 30 s window didn't restart.
    expect(pushes[1]!.readAt).toBe(pushes[0]!.readAt);

    clock += 5_000;
    expect(await click(socket)).toEqual({ read: false });
    clock += 20_000;
    expect(await click(socket)).toEqual({ read: true });
});

test("a network that fails keeps its last values", async () => {
    const wallet = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    stack.solanaRpc.setBalance(wallet, 3_000_000_000n);
    const { socket, pushes } = await bind(await person(wallet));
    expect(solanaRows(pushes[0]!, wallet)[0]!.amount).toBe("3");

    clock += 31_000;
    stack.solanaRpc.failNext(100, 429);
    expect(await click(socket)).toEqual({ read: true });
    await expect.poll(() => pushes.length).toBe(2);
    stack.solanaRpc.failNext(0);

    expect(solanaRows(pushes[1]!, wallet).map((row) => row.amount)).toEqual(["3", "0"]);
    expect(pushes[1]!.rows.filter((row) => row.chain !== "solana").every((row) => row.amount !== null)).toBe(true);
});

test("every socket of the account gets the push; another person's doesn't", async () => {
    const user = await person();
    const first = await bind(user);
    const second = await bind(user);
    const other = await bind(await person());
    const before = [first.pushes.length, second.pushes.length, other.pushes.length];

    clock += 31_000;
    await click(first.socket);

    await expect.poll(() => first.pushes.length).toBe(before[0]! + 1);
    await expect.poll(() => second.pushes.length).toBeGreaterThan(before[1]!);
    expect(other.pushes).toHaveLength(before[2]!);
});

test("a burst of clicks reads once", async () => {
    const { socket, pushes } = await bind(await person());
    const reads = stack.solanaRpc.requests();

    clock += 31_000;
    await Promise.all(Array.from({ length: 5 }, () => click(socket)));
    await expect.poll(() => pushes.length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(pushes).toHaveLength(2);
    // One wallet read: SOL and USDC.
    expect(stack.solanaRpc.requests() - reads).toBe(2);
});

test("a wallet unlinked from the person drops out on the next click read", async () => {
    const user = await person();
    const { socket, pushes } = await bind(user);
    expect(pushes[0]!.rows).toHaveLength(9);

    stack.privy.setUser(user.userId, [user.wallet]);
    clock += 31_000;
    await click(socket);
    await expect.poll(() => pushes.length).toBe(2);

    expect(pushes[1]!.rows).toHaveLength(7);
    expect(solanaRows(pushes[1]!)).toEqual([]);
});

test("two binds inside 30 s read once, and both sockets end up holding the view", async () => {
    const user = await person();
    const first = await bind(user);
    const reads = stack.solanaRpc.requests();

    clock += 5_000;
    const second = await bind(user);

    expect(second.pushes[0]!.readAt).toBe(first.pushes[0]!.readAt);
    expect(second.pushes[0]!.rows).toHaveLength(9);
    expect(stack.solanaRpc.requests()).toBe(reads);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(first.pushes).toHaveLength(1);
});

test("a bind that joins a click run that reads nothing still gets a push", async () => {
    const user = await person();
    const first = await bind(user);

    clock += 6_000;
    const socket = await stack.socket(user);
    const pushes = listen(socket);
    const clicking = click(first.socket);
    const opened = await socket.timeout(5000).emitWithAck("account:open", {});
    expect(opened.ok).toBe(true);
    await clicking;

    await expect.poll(() => pushes.length).toBe(1);
    expect(pushes[0]!.rows).toHaveLength(9);
});

test("a due click while Privy fails still reads the last-known wallets", async () => {
    const { socket, pushes } = await bind(await person());

    clock += 31_000;
    stack.privy.failLookups(100, 500);
    try {
        expect(await click(socket)).toEqual({ read: true });
    } finally {
        stack.privy.failLookups(0, 500);
    }
    await expect.poll(() => pushes.length).toBe(2);
    expect(pushes[1]!.rows).toHaveLength(9);
});

test("with Privy failing, repeated clicks inside 5 s make one Privy call", async () => {
    const { socket } = await bind(await person());

    clock += 6_000;
    const before = stack.privy.userLookups;
    stack.privy.failLookups(100, 500);
    try {
        await click(socket);
        const afterFirst = stack.privy.userLookups;
        expect(afterFirst).toBeGreaterThan(before);
        for (let i = 0; i < 4; i++) await click(socket);
        expect(stack.privy.userLookups).toBe(afterFirst);
    } finally {
        stack.privy.failLookups(0, 500);
    }
});
