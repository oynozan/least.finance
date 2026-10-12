import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { Ack, PositionsView, PredictionOrderView, PredictionUpdate, WalletSession } from "../../src/protocol.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";

const TRADING_ENV = {
    PREDICTIONS_TRADING: "on",
    POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_BUILDER_API_KEY: "key",
    POLYMARKET_BUILDER_API_SECRET: "secret",
    POLYMARKET_BUILDER_API_PASSPHRASE: "passphrase",
};

let stack: Stack;
let off: Stack;
beforeAll(async () => {
    const base = { mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") };
    stack = await startStack({ ...base, env: TRADING_ENV });
    off = await startStack(base);
});
afterAll(async () => {
    await stack?.stop();
    await off?.stop();
});

const wei = (usdc: string) => parseUnits(usdc, 18);

async function outcome(s: Stack) {
    const eventId = s.polymarket.fixtures.samples.yesNo;
    const response = await fetch(`${s.url}/markets/${eventId}`);
    const event = (await response.json()) as { outcomes: { tokenId: string }[] };
    return { eventId, tokenId: event.outcomes[0]!.tokenId };
}

/** A signed-in user with an open account holding `usdc`. */
async function person(s: Stack, usdc = "100") {
    const user: User = await s.user();
    const socket = await s.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const { accounts, ledger } = s.server.services.database.collections;
    const account = (await accounts.findOne({ privyUserId: user.userId }))!;
    const updated = await accounts.findOneAndUpdate(
        { _id: account._id },
        { $inc: { balance: toDecimal(wei(usdc)), version: 1 } },
        { returnDocument: "after" },
    );
    await ledger.insertOne({
        _id: new ObjectId(),
        accountId: account._id,
        kind: "deposit",
        amount: toDecimal(wei(usdc)),
        balanceAfter: updated!.balance,
        refId: new ObjectId(),
        createdAt: new Date(),
    });
    const updates: PredictionUpdate[] = [];
    socket.on("prediction:update", (update) => updates.push(update));
    return { user, socket, updates, accountId: account._id };
}

const order = async (socket: AppSocket, s: Stack, amountUSD = "10", extra: Record<string, unknown> = {}) => {
    const { eventId, tokenId } = await outcome(s);
    const quote = await s.server.services.markets.outcome(eventId, tokenId);
    return socket.timeout(5000).emitWithAck("prediction:order", {
        requestId: randomUUID(),
        eventId,
        tokenId,
        amountUSD,
        quotedPrice: quote!.outcome.buyPrice,
        ...extra,
    }) as Promise<Ack<PredictionOrderView>>;
};

describe("prediction events", () => {
    test("prediction:order acks placing and pushes a filled update with the lower balance", async () => {
        const { socket, updates } = await person(stack);
        const acked = await order(socket, stack, "10");
        expect(acked).toMatchObject({ ok: true, data: { state: "placing", amountUSD: "10" } });
        await expect.poll(() => updates.length).toBe(1);
        const update = updates[0]!;
        expect(update.order.state).toBe("filled");
        expect(update.requestId).toBe((acked as { data: PredictionOrderView }).data.requestId);
        expect(update.position).toMatchObject({ state: "open" });
        expect(update.account.balance).toBe("90");
    });

    test("a rejected order pushes failed with price_moved and the balance comes back", async () => {
        const { socket, updates, accountId } = await person(stack);
        const { tokenId } = await outcome(stack);
        stack.trader.onNext(tokenId, "reject:price_moved");
        const acked = await order(socket, stack, "10");
        expect(acked.ok).toBe(true);
        await expect.poll(() => updates.length).toBe(1);
        expect(updates[0]!.order).toMatchObject({ state: "failed", reason: "price_moved" });
        expect(updates[0]!.position).toBeNull();
        const account = await stack.server.services.accounts.findById(accountId);
        expect(fromDecimal(account!.balance)).toBe(wei("100"));
    });

    test("prediction:order is refused with trading_off when trading is off", async () => {
        const { socket } = await person(off);
        const refused = await order(socket, off, "10");
        expect(refused).toMatchObject({ ok: false, error: { code: "trading_off" } });
    });

    test("bad payloads answer bad_request naming the field", async () => {
        const { socket } = await person(stack);
        const good = { requestId: randomUUID(), eventId: "123", tokenId: "456", amountUSD: "10", quotedPrice: 0.5 };
        for (const [field, value] of [
            ["requestId", "nope"],
            ["eventId", "evt-1"],
            ["tokenId", "x1"],
            ["amountUSD", "1.234"],
            ["amountUSD", "0"],
            ["quotedPrice", 1],
            ["quotedPrice", 0],
        ] as const) {
            const result = await socket.timeout(5000).emitWithAck("prediction:order", { ...good, [field]: value });
            expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
            if (!result.ok) expect(result.error.message).toContain(field);
        }
        const quote = await socket
            .timeout(5000)
            .emitWithAck("prediction:quote", { eventId: "x", tokenId: "1", amountUSD: "5" });
        expect(quote).toMatchObject({ ok: false, error: { code: "bad_request" } });
    });

    test("prediction:quote answers a quote", async () => {
        const { socket } = await person(stack);
        const { eventId, tokenId } = await outcome(stack);
        const quote = await socket.timeout(5000).emitWithAck("prediction:quote", { eventId, tokenId, amountUSD: "10" });
        expect(quote).toMatchObject({ ok: true, data: { eventId, tokenId, side: "buy", amountUSD: "10" } });
    });

    test("the 11th order in a minute is rate_limited", async () => {
        const { socket } = await person(stack, "100");
        const results: Ack<PredictionOrderView>[] = [];
        for (let i = 0; i < 11; i++) results.push(await order(socket, stack, "1"));
        expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
        expect(results[10]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    });

    test("account:open pushes positions with an in-flight order", async () => {
        const { user, socket } = await person(stack);
        const { tokenId } = await outcome(stack);
        stack.trader.onNext(tokenId, "hold");
        const acked = await order(socket, stack, "10");
        expect(acked.ok).toBe(true);
        await expect.poll(() => stack.trader.posts.length).toBeGreaterThan(0);

        const second = await stack.socket(user);
        const pushed: PositionsView[] = [];
        second.on("positions", (view) => pushed.push(view));
        const opened = await second.timeout(5000).emitWithAck("account:open", {});
        expect(opened.ok).toBe(true);
        await expect.poll(() => pushed.length).toBe(1);
        expect(pushed[0]!.orders).toHaveLength(1);
        expect(pushed[0]!.orders[0]).toMatchObject({ state: "posted", amountUSD: "10" });
        stack.trader.release(tokenId, "fill");
    });

    test("pushes for one account arrive in bus order", async () => {
        const { socket, updates } = await person(stack);
        const { tokenId } = await outcome(stack);
        stack.trader.onNext(tokenId, "hold");
        const first = await order(socket, stack, "5");
        await expect.poll(() => stack.trader.posts.length).toBeGreaterThan(0);
        const second = await order(socket, stack, "5");
        await expect.poll(() => updates.length).toBe(1);
        stack.trader.release(tokenId, "fill");
        await expect.poll(() => updates.length).toBe(2);
        const ids = [first, second].map((r) => (r as { data: PredictionOrderView }).data.requestId);
        expect(updates.map((u) => u.requestId)).toEqual([ids[1], ids[0]]);
    });

    test("GET /markets/trending carries maxOrderUSD when trading is on", async () => {
        const on = (await (await fetch(`${stack.url}/markets/trending`)).json()) as { maxOrderUSD: number | null };
        expect(on.maxOrderUSD).toEqual(expect.any(Number));
        const none = (await (await fetch(`${off.url}/markets/trending`)).json()) as { maxOrderUSD: number | null };
        expect(none.maxOrderUSD).toBeNull();
    });
});
