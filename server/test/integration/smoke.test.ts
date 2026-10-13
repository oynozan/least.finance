import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

test("a reported deposit is credited and pushed", async () => {
    const user = await stack.user();
    const socket = await stack.socket(user);
    const session = await socket.timeout(5000).emitWithAck("account:open", {});
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const pushed = new Promise((resolve) => socket.once("deposit:credited", resolve));
    const hash = await stack.chain.send(user.wallet, session.data.account.depositAddress, "12.5");
    const receipt = await socket.timeout(10000).emitWithAck("deposit:submit", { txHash: hash });
    expect(receipt).toMatchObject({ ok: true, data: { account: { balance: "12.5" } } });
    expect(await pushed).toMatchObject({ deposit: { amount: "12.5", txHash: hash } });
});

test("the session carries solana: { deposits: false, withdrawals: false } by default", async () => {
    const socket = await stack.socket(await stack.user());
    const session = await socket.timeout(5000).emitWithAck("account:open", {});
    expect(session).toMatchObject({ ok: true, data: { solana: { deposits: false, withdrawals: false } } });
});
