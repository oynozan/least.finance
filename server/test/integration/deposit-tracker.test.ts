import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { OrderTracker } from "../../src/crosschain/tracker.ts";
import { formatUsdc, fromDecimal } from "../../src/db/money.ts";
import type { Ack, DepositOrderView, OrderState, SourceTxView, WalletSession } from "../../src/protocol.ts";
import { FAKE_BRIDGE_ADDRESS } from "../support/fake-bridge.ts";
import { sourceChain } from "../support/source-chains.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

const ethereum = sourceChain(inject("ethereumUrl"), 1);
const bnb = sourceChain(inject("bnbUrl"), 56);
const HASH = `0x${"ab".repeat(32)}` as const;
const DAY_MS = 86_400_000;

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { ORDER_POLL_MS: "100" },
    });
});
afterAll(() => stack?.stop());

const db = () => stack.server.services.database.collections;

/** Opens an order for `user` on a socket that records every progress push. */
async function place(user: User, current: Stack, coin: string, amount: string) {
    const socket = await current.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const pushes: OrderState[] = [];
    socket.on("deposit:progress", ({ order }) => pushes.push(order.state));
    const created = (await socket
        .timeout(5000)
        .emitWithAck("deposit:order", { coin, amount, wallet: user.wallet })) as Ack<{
        order: DepositOrderView;
        txs: SourceTxView[];
    }>;
    if (!created.ok) throw new Error(created.error.code);
    const { order, txs } = created.data;
    const report = (hashes: string[]) =>
        socket.timeout(5000).emitWithAck("deposit:source", { orderId: order.id, txHashes: hashes });
    const state = async () =>
        (await current.server.services.database.collections.depositOrders.findOne({ _id: new ObjectId(order.id) }))!;
    const ref = (await state()).ref;
    return { order, txs, pushes, report, state, ref, accountId: (await state()).accountId };
}

/** Sends the order's transactions from the user's wallet on Ethereum and reports them. */
async function sendAndReport(user: User, placed: Awaited<ReturnType<typeof place>>) {
    await ethereum.fund(user.wallet, "5");
    const hashes = await ethereum.sendTxs(
        user.wallet,
        placed.txs.map((tx) => ({ to: tx.to, data: tx.data, value: BigInt(tx.value) })),
    );
    await placed.report(hashes);
    return hashes;
}

const balanceOf = async (accountId: ObjectId) =>
    formatUsdc(fromDecimal((await db().accounts.findOne({ _id: accountId }))!.balance));
const inState = (placed: Awaited<ReturnType<typeof place>>, state: OrderState) => async () =>
    (await placed.state()).state === state;

test("a bridged deposit goes through every step and is credited once", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await sendAndReport(user, placed);
    await expect.poll(inState(placed, "in_block")).toBe(true);

    await stack.bridge.advance(placed.ref, "pending");
    await expect.poll(inState(placed, "bridging")).toBe(true);
    await stack.bridge.advance(placed.ref, "filled");
    await expect.poll(inState(placed, "delivered")).toBe(true);

    const order = await placed.state();
    const deposit = await db().deposits.findOne({ accountId: placed.accountId });
    expect(order.depositId).toEqual(deposit!._id);
    expect(deposit!.origin).toMatchObject({ coin: "ethereum:ETH", amount: "0.1" });
    expect(deposit!.origin!.orderId).toEqual(order._id);
    await expect.poll(() => placed.pushes.includes("delivered")).toBe(true);
    expect(placed.pushes.filter((state, i) => state !== placed.pushes[i - 1])).toEqual([
        "created",
        "sent",
        "in_block",
        "bridging",
        "delivered",
    ]);
    expect(await balanceOf(placed.accountId)).toBe("300");
    expect(await db().ledger.countDocuments({ accountId: placed.accountId })).toBe(1);
    expect(await db().deposits.countDocuments({ accountId: placed.accountId })).toBe(1);
});

test("a fill credited before the provider says filled is linked once", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await sendAndReport(user, placed);
    await stack.bridge.advance(placed.ref, "pending");
    await expect.poll(inState(placed, "bridging")).toBe(true);

    // The provider's answer waits until the watcher has credited the fill.
    const original = stack.bridge.status.bind(stack.bridge);
    const status = vi.spyOn(stack.bridge, "status").mockImplementation(async (quote, hash, coin) => {
        if (quote.ref === placed.ref) {
            await vi.waitFor(async () =>
                expect(await db().deposits.countDocuments({ accountId: placed.accountId })).toBe(1),
            );
        }
        return original(quote, hash, coin);
    });
    try {
        await stack.bridge.advance(placed.ref, "filled");
        await expect.poll(inState(placed, "delivered")).toBe(true);
    } finally {
        status.mockRestore();
    }
    const deposits = await db().deposits.find({ accountId: placed.accountId }).toArray();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.origin!.orderId).toEqual((await placed.state())._id);
    expect(await balanceOf(placed.accountId)).toBe("300");
    expect(await db().ledger.countDocuments({ accountId: placed.accountId })).toBe(1);
});

test("a refund ends refunded, and nothing is credited", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await sendAndReport(user, placed);
    await expect.poll(inState(placed, "in_block")).toBe(true);
    await stack.bridge.advance(placed.ref, "refunded");
    await expect.poll(inState(placed, "refunded")).toBe(true);
    await expect.poll(() => placed.pushes.at(-1)).toBe("refunded");
    expect(await balanceOf(placed.accountId)).toBe("0");
    expect(await db().deposits.countDocuments({ accountId: placed.accountId })).toBe(0);
});

test("a reverted source transaction fails the order", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "bnb:BNB", "1");
    await bnb.fund(user.wallet, "5");
    // 0xfe is the invalid opcode: any call to the bridge address reverts.
    await bnb.client.setCode({ address: FAKE_BRIDGE_ADDRESS, bytecode: "0xfe" });
    try {
        const hashes = await bnb.sendTxs(
            user.wallet,
            placed.txs.map((tx) => ({ to: tx.to, data: tx.data, value: BigInt(tx.value) })),
        );
        await placed.report(hashes);
        await expect.poll(inState(placed, "failed")).toBe(true);
    } finally {
        await bnb.client.setCode({ address: FAKE_BRIDGE_ADDRESS, bytecode: "0x" });
    }
    expect(await balanceOf(placed.accountId)).toBe("0");
});

test("an order nobody reported still completes when the provider knows it", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await stack.bridge.advance(placed.ref, "filled");
    await expect.poll(inState(placed, "delivered")).toBe(true);
    expect(placed.pushes.filter((state, i) => state !== placed.pushes[i - 1])).toContain("bridging");
    expect(await balanceOf(placed.accountId)).toBe("300");
    expect(await db().ledger.countDocuments({ accountId: placed.accountId })).toBe(1);
});

test("an unreported order expires", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await db().depositOrders.updateOne(
        { _id: new ObjectId(placed.order.id) },
        { $set: { createdAt: new Date(Date.now() - DAY_MS) } },
    );
    await expect.poll(inState(placed, "expired")).toBe(true);
    await expect.poll(() => placed.pushes.at(-1)).toBe("expired");
});

test("a source transaction that never lands fails the order", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await placed.report([HASH]);
    await expect.poll(async () => (await placed.state()).state).toBe("sent");
    await db().depositOrders.updateOne(
        { _id: new ObjectId(placed.order.id) },
        { $set: { updatedAt: new Date(Date.now() - DAY_MS) } },
    );
    await expect.poll(inState(placed, "failed")).toBe(true);
});

test("a failing status call leaves the order as it was", async () => {
    // A server whose own tracker sleeps, so the test steps passes by hand.
    const slow = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { ORDER_POLL_MS: "600000" },
    });
    try {
        const tracker = new OrderTracker({
            collections: slow.server.services.database.collections,
            providers: [slow.bridge],
            sources: createSourceClients({ ethereum: [inject("ethereumUrl")], bnb: [inject("bnbUrl")] }),
            bus: slow.server.services.bus,
            logger: pino({ level: "silent" }),
            pollMs: 100,
        });
        const user = await slow.user();
        const placed = await place(user, slow, "ethereum:ETH", "0.1");
        const read = async () =>
            slow.server.services.database.collections.depositOrders.findOne({ _id: new ObjectId(placed.order.id) });
        await slow.bridge.advance(placed.ref, "pending");
        slow.bridge.failNextStatus(placed.ref);
        const before = await read();

        await tracker.tick();
        expect(await read()).toEqual(before);
        expect(placed.pushes).toEqual(["created"]);

        await tracker.tick();
        expect((await read())!.state).toBe("bridging");
        await expect.poll(() => placed.pushes).toEqual(["created", "bridging"]);
    } finally {
        await slow.stop();
    }
});
