import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { randomUUID } from "node:crypto";
import { parseUnits } from "viem";
import { toDecimal } from "../../src/db/money.ts";
import type { Ack, WalletSession, WithdrawLimits, WithdrawalPlaced, WithdrawalView } from "../../src/protocol.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

async function bind(user: User) {
    const socket = await stack.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    return { socket, session: opened.data };
}

/** Gives the user's account a balance straight in the database. */
async function credit(user: User, usdc: string) {
    const { accounts } = stack.server.services.database.collections;
    await accounts.updateOne({ privyUserId: user.userId }, { $set: { balance: toDecimal(parseUnits(usdc, 18)) } });
}

const withdraw = (socket: AppSocket, to: string, amount: string, requestId: string = randomUUID()) =>
    socket.timeout(5000).emitWithAck("withdraw:create", { requestId, amount, to }) as Promise<Ack<WithdrawalPlaced>>;

const nextUpdate = (socket: AppSocket, state: string) =>
    new Promise<WithdrawalView>((resolve) => {
        const listen = ({ withdrawal }: { withdrawal: WithdrawalView }) => {
            if (withdrawal.state !== state) return;
            socket.off("withdrawal:update", listen);
            resolve(withdrawal);
        };
        socket.on("withdrawal:update", listen);
    });

test("withdrawing over the socket pays a linked wallet and pushes sending then sent", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const { socket } = await bind(user);
    await credit(user, "10");
    const seen: string[] = [];
    const balances: string[] = [];
    socket.on("withdrawal:update", ({ withdrawal, account }) => {
        seen.push(withdrawal.state);
        balances.push(account.balance);
    });
    const sent = nextUpdate(socket, "sent");

    const before = await stack.chain.client.getBalance({ address: user.wallet });
    const result = await withdraw(socket, user.wallet.toLowerCase(), "4.5");
    if (!result.ok) throw new Error(result.error.code);
    expect(result.data).toMatchObject({ amount: "4.5", to: user.wallet.toLowerCase(), state: "sending" });
    expect(result.data.account.balance).toBe("5.5");

    const done = await sent;
    expect(done.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(seen).toEqual(["sending", "sent"]);
    expect(balances).toEqual(["5.5", "5.5"]);
    const after = await stack.chain.client.getBalance({ address: user.wallet });
    expect(after - before).toBe(4_500_000_000_000_000_000n);
});

test("an unlinked wallet is forbidden; a Solana address is a bad request with no Privy lookup", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const { socket } = await bind(user);
    await credit(user, "10");

    const stranger = await withdraw(socket, "0x1234567890123456789012345678901234567890", "1");
    expect(stranger).toMatchObject({ ok: false, error: { code: "forbidden" } });

    const lookups = stack.privy.userLookups;
    const solana = await withdraw(socket, SOLANA, "1");
    expect(solana).toEqual({
        ok: false,
        error: {
            code: "bad_request",
            message: "USDC on Arc can't go to a Solana wallet. Link an EVM wallet to withdraw.",
        },
    });
    expect(stack.privy.userLookups).toBe(lookups);
});

test("the session hands back recent withdrawals, newest first", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const first = await bind(user);
    await credit(user, "10");
    const a = await withdraw(first.socket, user.wallet, "1");
    const b = await withdraw(first.socket, user.wallet, "2");
    if (!a.ok || !b.ok) throw new Error("withdraw failed");

    const again = await bind(user);
    expect(again.session.withdrawals.map((w) => w.id)).toEqual([b.data.id, a.data.id]);
    expect(again.session.withdrawals[0]!.amount).toBe("2");
});

test("limits come back as UsdcAmount strings", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const { socket } = await bind(user);
    await credit(user, "7.25");
    const limits = (await socket.timeout(5000).emitWithAck("withdraw:limits", {})) as Ack<WithdrawLimits>;
    expect(limits).toEqual({ ok: true, data: { max: "7.25", min: "0.01" } });
});

test("another person's socket gets no withdrawal push", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const other = await stack.user();
    const owner = await bind(user);
    const second = await bind(user);
    const stranger = await bind(other);
    await credit(user, "10");
    const got: string[] = [];
    stranger.socket.on("withdrawal:update", ({ withdrawal }) => got.push(withdrawal.id));
    const pushed = nextUpdate(second.socket, "sent");

    const result = await withdraw(owner.socket, user.wallet, "1");
    if (!result.ok) throw new Error(result.error.code);
    expect((await pushed).id).toBe(result.data.id);
    expect(got).toEqual([]);
});

test("withdraw:limits allows 30 reads a minute per person, then rate-limits", async () => {
    await stack.fundTreasury("100");
    const user = await stack.user();
    const { socket } = await bind(user);
    await credit(user, "1");
    const read = () => socket.timeout(5000).emitWithAck("withdraw:limits", {}) as Promise<Ack<WithdrawLimits>>;

    for (let i = 0; i < 30; i++) expect((await read()).ok).toBe(true);
    expect(await read()).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    // Another person is not held up by it.
    const other = await bind(await stack.user());
    expect(((await other.socket.timeout(5000).emitWithAck("withdraw:limits", {})) as Ack<WithdrawLimits>).ok).toBe(
        true,
    );
});
