import { setTimeout as sleep } from "node:timers/promises";
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
    // A day on, by a clock of the test's own: an order's age sets how often it is looked at.
    const { slow, tracker, at } = await steppedTracker();
    try {
        const user = await slow.user();
        const placed = await place(user, slow, "ethereum:ETH", "0.1");
        at(DAY_MS);
        await tracker.tick();
        expect((await placed.state()).state).toBe("expired");
        await expect.poll(() => placed.pushes.at(-1)).toBe("expired");
    } finally {
        await slow.stop();
    }
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

/** A server whose own tracker sleeps, and a tracker of ours that runs on a clock the test sets. */
async function steppedTracker() {
    const slow = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { ORDER_POLL_MS: "600000" },
    });
    const base = Date.now();
    let offset = 0;
    const tracker = new OrderTracker({
        collections: slow.server.services.database.collections,
        providers: [slow.bridge],
        sources: createSourceClients({ ethereum: [inject("ethereumUrl")], bnb: [inject("bnbUrl")] }),
        bus: slow.server.services.bus,
        logger: pino({ level: "silent" }),
        pollMs: 100,
        now: () => base + offset,
    });
    return {
        slow,
        tracker,
        base,
        at: (ms: number) => {
            offset = ms;
        },
    };
}

test("pushes reach the socket in the order the steps happened, however slow a lookup is", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await expect.poll(() => placed.pushes).toEqual(["created"]);
    const order = await placed.state();
    const { accounts, bus } = stack.server.services;
    const find = accounts.findById.bind(accounts);
    let slow = true;
    const lookup = vi.spyOn(accounts, "findById").mockImplementation(async (id) => {
        // Only the first lookup lags.
        if (slow) {
            slow = false;
            await sleep(300);
        }
        return find(id);
    });
    try {
        bus.emit("order:updated", { order: { ...order, state: "in_block" } });
        bus.emit("order:updated", { order: { ...order, state: "bridging" } });
        await expect.poll(() => placed.pushes).toEqual(["created", "in_block", "bridging"]);
    } finally {
        lookup.mockRestore();
    }
});

test("a step the tracker sees is announced after the report that led to it", async () => {
    const user = await stack.user();
    const placed = await place(user, stack, "ethereum:ETH", "0.1");
    await ethereum.fund(user.wallet, "5");
    const hashes = await ethereum.sendTxs(
        user.wallet,
        placed.txs.map((tx) => ({ to: tx.to, data: tx.data, value: BigInt(tx.value) })),
    );
    // The report is written at once, but its answer is slow: the tracker sees it and moves on first.
    const { depositOrders } = db();
    const write = depositOrders.findOneAndUpdate.bind(depositOrders) as (...args: unknown[]) => Promise<unknown>;
    const slowReport = vi.spyOn(depositOrders, "findOneAndUpdate").mockImplementation((async (...args: unknown[]) => {
        const result = await write(...args);
        if ((args[1] as { $set?: { state?: string } }).$set?.state === "sent") await sleep(500);
        return result;
    }) as never);
    try {
        await placed.report(hashes);
    } finally {
        slowReport.mockRestore();
    }
    await expect.poll(() => placed.pushes, { timeout: 5000 }).toEqual(["created", "sent", "in_block"]);
});

test("an older order is asked about less often, and a stale one not at all", async () => {
    const { slow, tracker, base, at } = await steppedTracker();
    try {
        const user = await slow.user();
        const placed = await place(user, slow, "ethereum:ETH", "0.1");
        const calls = () => status.mock.calls.filter(([quote]) => quote.ref === placed.ref).length;
        const status = vi.spyOn(slow.bridge, "status");
        const { depositOrders } = slow.server.services.database.collections;
        // Waiting in a bridge, so nothing expires it.
        await depositOrders.updateOne({ _id: new ObjectId(placed.order.id) }, { $set: { state: "bridging" } });
        const poll = async (ms: number) => {
            at(ms);
            await tracker.tick();
            return calls();
        };

        // The first minute: every pass.
        expect(await poll(0)).toBe(1);
        expect(await poll(1_000)).toBe(2);
        // Up to 10 minutes: every 15 s.
        await depositOrders.updateOne(
            { _id: new ObjectId(placed.order.id) },
            { $set: { createdAt: new Date(base - 120_000) } },
        );
        expect(await poll(1_500)).toBe(2);
        expect(await poll(16_000)).toBe(3);
        expect(await poll(20_000)).toBe(3);
        expect(await poll(31_500)).toBe(4);
        // After that: every minute.
        await depositOrders.updateOne(
            { _id: new ObjectId(placed.order.id) },
            { $set: { createdAt: new Date(base - 700_000) } },
        );
        expect(await poll(40_000)).toBe(4);
        expect(await poll(92_000)).toBe(5);
        expect(await poll(100_000)).toBe(5);

        // A day without a change: left alone, and no longer listed.
        const accountId = placed.accountId;
        expect((await slow.server.services.orders.open(accountId)).map((o) => o._id.toHexString())).toEqual([
            placed.order.id,
        ]);
        await depositOrders.updateOne(
            { _id: new ObjectId(placed.order.id) },
            { $set: { updatedAt: new Date(base - DAY_MS - 1_000) } },
        );
        expect(await poll(200_000)).toBe(5);
        expect(await slow.server.services.orders.open(accountId)).toEqual([]);
    } finally {
        await slow.stop();
    }
});

test("a pass asks about at most eight orders at once", async () => {
    const { slow, tracker } = await steppedTracker();
    try {
        const user = await slow.user();
        const placed = await place(user, slow, "ethereum:ETH", "0.1");
        const { depositOrders } = slow.server.services.database.collections;
        const template = (await placed.state())!;
        await depositOrders.insertMany(
            Array.from({ length: 20 }, (_, i) => ({
                ...template,
                _id: new ObjectId(),
                ref: `load-${i}`,
                state: "bridging" as const,
            })),
        );
        let inFlight = 0;
        let most = 0;
        let asked = 0;
        const status = vi.spyOn(slow.bridge, "status").mockImplementation(async ({ ref }) => {
            if (!ref.startsWith("load-")) return { stage: "waiting" };
            asked++;
            most = Math.max(most, ++inFlight);
            await sleep(25);
            inFlight--;
            return { stage: "waiting" };
        });
        try {
            await tracker.tick();
        } finally {
            status.mockRestore();
        }
        expect(asked).toBe(20);
        expect(most).toBe(8);
    } finally {
        await slow.stop();
    }
});
