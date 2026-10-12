import { ObjectId } from "mongodb";
import { getAddress } from "viem";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import type { Ack, DepositOrderView, SourceTxView, WalletSession } from "../../src/protocol.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";
import { FAKE_BRIDGE_ADDRESS } from "../support/fake-bridge.ts";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const HASH = `0x${"ab".repeat(32)}` as const;

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

const ask = (socket: AppSocket, coin: string, amount: string, wallet: string) =>
    socket.timeout(5000).emitWithAck("deposit:order", { coin, amount, wallet }) as Promise<
        Ack<{ order: DepositOrderView; txs: SourceTxView[] }>
    >;

test("a preview quotes without creating an order", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const quote = await socket.timeout(5000).emitWithAck("deposit:quote", {
        coin: "ethereum:ETH",
        amount: "0.1",
        wallet: user.wallet,
    });
    expect(quote).toEqual({
        ok: true,
        data: { coin: "ethereum:ETH", amount: "0.1", usdcOut: "300", etaSeconds: 2, provider: "fake" },
    });
    const again = await bind(user);
    expect(again.session.orders).toEqual([]);
});

test("an order pays the account's Arc address and refunds the sending wallet", async () => {
    const user = await stack.user();
    const { socket, session } = await bind(user);
    const result = await ask(socket, "ethereum:USDC", "25.5", user.wallet.toLowerCase());
    if (!result.ok) throw new Error(result.error.code);
    const { order, txs } = result.data;

    expect(order).toMatchObject({
        coin: "ethereum:USDC",
        amount: "25.5",
        wallet: getAddress(user.wallet),
        usdcOut: "25.5",
        state: "created",
        sourceTxHashes: [],
        depositId: null,
    });
    expect(txs).toHaveLength(2);
    expect(txs.map((tx) => tx.chainId)).toEqual([1, 1]);
    expect(txs[1]).toMatchObject({ to: getAddress(FAKE_BRIDGE_ADDRESS), value: "0x0" });

    const mine = await stack.server.services.database.collections.depositOrders.findOne({
        _id: new ObjectId(order.id),
    });
    expect(mine).toMatchObject({
        recipient: session.account.depositAddress.toLowerCase(),
        refundTo: getAddress(user.wallet).toLowerCase(),
        provider: "fake",
    });
});

test("a native coin order carries its value", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const result = await ask(socket, "ethereum:ETH", "0.5", user.wallet);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.data.txs).toHaveLength(1);
    expect(BigInt(result.data.txs[0]!.value)).toBe(500_000_000_000_000_000n);
});

test("a wallet that isn't linked is refused", async () => {
    const user = await stack.user();
    const other = await stack.user();
    const { socket } = await bind(user);
    const result = await ask(socket, "ethereum:ETH", "0.1", other.wallet);
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const quote = await socket
        .timeout(5000)
        .emitWithAck("deposit:quote", { coin: "ethereum:ETH", amount: "0.1", wallet: other.wallet });
    expect(quote).toMatchObject({ ok: false, error: { code: "forbidden" } });
});

test("a Solana wallet is refused for now", async () => {
    const user = await stack.user();
    stack.privy.setUser(user.userId, [user.wallet, { address: SOLANA, chain: "solana" }]);
    const { socket } = await bind(user);
    // Binding reads balances in the background, which looks the user up too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lookups = stack.privy.userLookups;
    const result = await ask(socket, "solana:SOL", "1", SOLANA);
    expect(result).toEqual({
        ok: false,
        error: { code: "bad_request", message: "Deposits from Solana aren't open yet." },
    });
    expect(stack.privy.userLookups).toBe(lookups);
});

test("reporting the source sends the order once", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const created = await ask(socket, "ethereum:ETH", "0.1", user.wallet);
    if (!created.ok) throw new Error(created.error.code);
    const progress: DepositOrderView[] = [];
    socket.on("deposit:progress", ({ order }) => progress.push(order));

    const first = await socket.timeout(5000).emitWithAck("deposit:source", {
        orderId: created.data.order.id,
        txHashes: [HASH.toUpperCase().replace("0X", "0x")],
    });
    expect(first).toMatchObject({ ok: true, data: { state: "sent", sourceTxHashes: [HASH] } });
    const second = await socket
        .timeout(5000)
        .emitWithAck("deposit:source", { orderId: created.data.order.id, txHashes: [`0x${"cd".repeat(32)}`] });
    expect(second).toMatchObject({ ok: true, data: { state: "sent", sourceTxHashes: [HASH] } });

    await expect.poll(() => progress.filter((order) => order.state === "sent").length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = progress.filter((order) => order.state === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: created.data.order.id, state: "sent" });
});

test("another account's order is not found", async () => {
    const owner = await stack.user();
    const other = await stack.user();
    const { socket } = await bind(owner);
    const created = await ask(socket, "ethereum:ETH", "0.1", owner.wallet);
    if (!created.ok) throw new Error(created.error.code);
    const { socket: intruder } = await bind(other);
    const result = await intruder
        .timeout(5000)
        .emitWithAck("deposit:source", { orderId: created.data.order.id, txHashes: [HASH] });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("an amount with more decimals than the coin is refused", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const result = await ask(socket, "ethereum:USDC", "1.0000001", user.wallet);
    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
});

test("USDC on Arc isn't bridged", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const result = await ask(socket, "arc:USDC", "1", user.wallet);
    expect(result).toEqual({
        ok: false,
        error: { code: "bad_request", message: "USDC on Arc goes straight to your deposit address." },
    });
});

test("the session hands back open orders", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const first = await ask(socket, "ethereum:ETH", "0.1", user.wallet);
    const second = await ask(socket, "bnb:BNB", "1", user.wallet);
    if (!first.ok || !second.ok) throw new Error("order failed");
    const { session } = await bind(user);
    expect(session.orders.map((order) => order.id)).toEqual([second.data.order.id, first.data.order.id]);
});

test("orders are rate limited per person", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const acks: Ack<unknown>[] = [];
    for (let i = 0; i < 12; i++) acks.push(await ask(socket, "ethereum:USDC", "1", user.wallet));
    expect(acks.filter((a) => a.ok)).toHaveLength(10);
    const refused = acks.filter((a) => !a.ok);
    expect(refused).toHaveLength(2);
    expect(refused.every((a) => !a.ok && a.error.code === "rate_limited")).toBe(true);
});
