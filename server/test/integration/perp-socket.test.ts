import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { toDecimal } from "../../src/db/money.ts";
import type {
    Ack,
    PerpOrderRequest,
    PerpOrderView,
    PerpQuoteView,
    PerpUpdate,
    PerpsView,
    WalletSession,
} from "../../src/protocol.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { PERPS_TRADING: "on" },
    });
    const master = createKeyring(stack.server.services.config.DEPOSIT_MNEMONIC).perpAddressAt(0);
    stack.hyperliquid.fund(master, parseUnits("5000", 6));
    await stack.server.services.perps.refreshFloat();
});
afterAll(() => stack?.stop());

const wei = (usdc: string) => parseUnits(usdc, 18);

async function person(usdc = "1000", user?: User) {
    const who = user ?? (await stack.user());
    const socket = await stack.socket(who);
    const updates: PerpUpdate[] = [];
    const lists: PerpsView[] = [];
    socket.on("perp:update", (update) => updates.push(update));
    socket.on("perps", (view) => lists.push(view));
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const { accounts, ledger } = stack.server.services.database.collections;
    const account = (await accounts.findOne({ privyUserId: who.userId }))!;
    if (!user) {
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
    }
    return { user: who, socket, updates, lists };
}

const payload = (extra: Partial<PerpOrderRequest> = {}): PerpOrderRequest => ({
    requestId: randomUUID(),
    asset: "BTC",
    side: "long",
    leverage: 5,
    collateralUSD: "100",
    ...extra,
});

describe("perp events", () => {
    test("perp:quote returns the quote rows", async () => {
        const { socket } = await person();
        const quote = (await socket.timeout(5000).emitWithAck("perp:quote", {
            asset: "BTC",
            side: "long",
            leverage: 5,
            collateralUSD: "100",
        })) as Ack<PerpQuoteView>;

        expect(quote).toMatchObject({
            ok: true,
            data: { sizeCoin: "0.00748", ourFeeUSD: "1", fundingPerHour: "0.0000125" },
        });
        if (!quote.ok) return;
        expect(Number(quote.data.entryPx)).toBeGreaterThan(65000);
        expect(Number(quote.data.liquidationPx)).toBeLessThan(Number(quote.data.entryPx));
        expect(Number(quote.data.takerFeeUSD)).toBeGreaterThan(0);
        expect(Number(quote.data.marginUSD)).toBeGreaterThan(98);
    });

    test("perp:order acks the order and pushes perp:update on fill", async () => {
        const { socket, updates } = await person();
        const acked = (await socket.timeout(5000).emitWithAck("perp:order", payload())) as Ack<{
            order: PerpOrderView;
            account: { balance: string };
        }>;

        expect(acked).toMatchObject({
            ok: true,
            data: { order: { state: "placing", kind: "open" }, account: { balance: "900" } },
        });
        await expect.poll(() => updates.find((u) => u.order.state === "filled")).toBeTruthy();
        const filled = updates.find((u) => u.order.state === "filled")!;
        expect(filled.position).toMatchObject({ asset: "BTC", side: "long", leverage: 5, state: "open" });
        expect(Number(filled.account.balance)).toBeGreaterThan(900);
    });

    test("11 orders in a minute hits the rate limit", async () => {
        const { socket } = await person("5000");
        const results: Ack<unknown>[] = [];
        for (let i = 0; i < 11; i++)
            results.push((await socket.timeout(5000).emitWithAck("perp:order", payload())) as Ack<unknown>);

        expect(results[10]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
        expect(results.slice(0, 10).filter((r) => !r.ok && r.error.code === "rate_limited")).toHaveLength(0);
    });

    test("perp:close acks and pushes perp:update with the settled position", async () => {
        const { socket, updates } = await person();
        await socket.timeout(5000).emitWithAck("perp:order", payload());
        await expect.poll(() => updates.find((u) => u.order.state === "filled")).toBeTruthy();
        const positionId = updates.find((u) => u.order.state === "filled")!.position!.id;

        const acked = (await socket
            .timeout(5000)
            .emitWithAck("perp:close", { requestId: randomUUID(), positionId })) as Ack<{ order: PerpOrderView }>;
        expect(acked).toMatchObject({ ok: true, data: { order: { kind: "close", state: "placing" } } });
        await expect.poll(() => updates.find((u) => u.order.kind === "close" && u.order.state === "done")).toBeTruthy();
        const settled = updates.find((u) => u.order.kind === "close" && u.order.state === "done")!;
        expect(settled.position).toMatchObject({ id: positionId, state: "closed" });
        expect(settled.order.creditedUSD).not.toBeNull();
    });

    test("bind emits perps", async () => {
        const first = await person();
        const acked = (await first.socket
            .timeout(5000)
            .emitWithAck("perp:order", payload({ asset: "ETH" }))) as Ack<unknown>;
        expect(acked.ok).toBe(true);
        await expect.poll(() => first.updates.some((u) => u.order.state === "filled")).toBe(true);

        const second = await person("0", first.user);
        await expect.poll(() => second.lists.length).toBe(1);
        expect(second.lists[0]!.positions).toHaveLength(1);
        expect(second.lists[0]!.positions[0]).toMatchObject({ asset: "ETH", state: "open" });
    });
});

describe("every market Hyperliquid lists", () => {
    const tick = () => stack.server.services.perpMarkets.tick();
    // Listed once for this block; the stack is torn down after the file.
    beforeAll(async () => {
        stack.hyperliquid.listMarket({ name: "kPEPE", szDecimals: 0, maxLeverage: 5, markPx: 0.004123 });
        stack.hyperliquid.setBook("kPEPE", {
            bids: [{ price: 0.004122, size: 50_000_000 }],
            asks: [{ price: 0.004124, size: 50_000_000 }],
        });
        await tick();
    });

    test("kPEPE, a thousand-coin market that was just listed, quotes and fills in its own units", async () => {
        const { socket, updates } = await person();

        const quote = (await socket.timeout(5000).emitWithAck("perp:quote", {
            asset: "kPEPE",
            side: "long",
            leverage: 3,
            collateralUSD: "100",
        })) as Ack<PerpQuoteView>;
        expect(quote.ok).toBe(true);
        if (!quote.ok) return;
        // $99 at 3x is about $297 of kPEPE, whole units only
        expect(quote.data.sizeCoin).toMatch(/^\d+$/);
        expect(Number(quote.data.sizeCoin)).toBeGreaterThan(70_000);
        expect(Number(quote.data.sizeCoin)).toBeLessThan(72_100);
        expect(Number(quote.data.entryPx)).toBeCloseTo(0.004124, 6);
        expect(Number(quote.data.liquidationPx)).toBeLessThan(0.004123);

        const acked = (await socket
            .timeout(5000)
            .emitWithAck("perp:order", payload({ asset: "kPEPE", leverage: 3 }))) as Ack<unknown>;
        expect(acked.ok).toBe(true);
        await expect.poll(() => updates.find((u) => u.order.state === "filled")).toBeTruthy();
        const filled = updates.find((u) => u.order.state === "filled")!;
        expect(filled.position).toMatchObject({ asset: "kPEPE", side: "long", leverage: 3, state: "open" });
        expect(filled.position!.sizeCoin).toMatch(/^\d+$/);
        expect(Number(filled.position!.entryPx)).toBeCloseTo(0.004123, 6);
    });

    test("a market Hyperliquid delists leaves the list and can't be quoted", async () => {
        const listed = async () =>
            (
                (await (await fetch(`${stack.url}/perps/markets`)).json()) as { markets: { asset: string }[] }
            ).markets.map((m) => m.asset);
        await tick();
        expect(await listed()).toContain("DOGE");
        expect(await listed()).toContain("kPEPE");

        stack.hyperliquid.delist("DOGE");
        await tick();
        expect(await listed()).not.toContain("DOGE");
        expect(await listed()).toContain("kPEPE");
        const { socket } = await person();
        const quote = (await socket.timeout(5000).emitWithAck("perp:quote", {
            asset: "DOGE",
            side: "long",
            leverage: 3,
            collateralUSD: "100",
        })) as Ack<PerpQuoteView>;
        expect(quote).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
});
