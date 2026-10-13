import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Decimal128, MongoClient, ObjectId } from "mongodb";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from "vitest";
import type { Ack, SwapOrderView, SwapQuoteView, SwapRequest, SwapTxView, WalletSession } from "../../src/protocol.ts";
import { COINS, type NetworkId } from "../../src/swaps/coins.ts";
import { sourceChain } from "../support/source-chains.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";

const DIAMOND = getAddress(
    JSON.parse(readFileSync(new URL("../fixtures/lifi/chains.json", import.meta.url), "utf8")).chains.find(
        (chain: { id: number }) => chain.id === 1,
    ).diamondAddress,
);

const address = (symbol: string, network: NetworkId) =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((entry) => entry.network === network)!
        .address as Address;
const USDC = address("USDC", "ethereum");
const USDT = address("USDT", "ethereum");

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const ethereum = () => sourceChain(inject("ethereumUrl"), 1);

/** A user holding 1.5 ETH, 1000 USDC and 1000 USDT on Ethereum. */
async function holder(): Promise<User> {
    const user = await stack.user();
    const chain = ethereum();
    await chain.fund(user.wallet, "1.5");
    for (const token of [USDC, USDT]) {
        await chain.installToken(token);
        await chain.setTokenBalance(token, user.wallet, 1_000_000_000n);
    }
    return user;
}

async function bind(user: User) {
    const socket = await stack.socket(user);
    const swaps: SwapOrderView[][] = [];
    const updates: SwapOrderView[] = [];
    socket.on("swaps", ({ orders }) => swaps.push(orders));
    socket.on("swap:update", ({ order }) => updates.push(order));
    let holdings = 0;
    socket.on("swap:holdings", () => holdings++);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    await expect.poll(() => swaps.length).toBe(1);
    await expect.poll(() => holdings).toBeGreaterThan(0);
    return { socket, swaps, updates };
}

/** USDC on Ethereum to ETH on Base, for $100, received by the same wallet. */
const request = (user: User, patch: Partial<SwapRequest> = {}): SwapRequest => ({
    from: { token: "USDC", network: "ethereum" },
    to: { token: "ETH", network: "base" },
    amountUSD: "100",
    wallet: user.wallet,
    receiver: user.wallet,
    ...patch,
});

const quote = (socket: AppSocket, req: SwapRequest) =>
    socket.timeout(5000).emitWithAck("swap:quote", req) as Promise<Ack<SwapQuoteView>>;

const order = (socket: AppSocket, req: SwapRequest, reviewedMin = "0") =>
    socket.timeout(5000).emitWithAck("swap:order", { ...req, reviewedMin }) as Promise<
        Ack<{ order: SwapOrderView; txs: SwapTxView[] }>
    >;

const opened = async (socket: AppSocket, req: SwapRequest) => {
    const result = await order(socket, req);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
};

const orders = () => stack.server.services.database.collections.swapOrders;

describe("quotes", () => {
    test("a quote shows LI.FI's amounts, fees and time", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const result = await quote(socket, request(user));
        if (!result.ok) throw new Error(result.error.code);

        const toAmount = (100_000_000n * 1_000_000n * 9975n * 10n ** 18n) / (3_210_400_000n * 10_000n * 1_000_000n);
        expect(result.data).toMatchObject({
            request: request(user),
            fromAmount: "100",
            toAmount: formatUnits(toAmount, 18),
            toAmountMin: formatUnits((toAmount * 995n) / 1000n, 18),
            gasUSD: 0.05,
            etaSeconds: 30,
            tool: "Fake Bridge",
            needsApproval: true,
        });
        expect(result.data.fees).toHaveLength(1);
        expect(result.data.fees[0]!.name).toBe("LIFI Fixed Fee");
        expect(result.data.fees[0]!.usd).toBeCloseTo(0.25, 6);

        const asked = stack.lifi.quotes.at(-1)!;
        expect(asked).toMatchObject({
            fromChain: 1,
            toChain: 8453,
            fromToken: USDC,
            toToken: "0x0000000000000000000000000000000000000000",
            fromAddress: getAddress(user.wallet),
            toAddress: getAddress(user.wallet),
            fromAmount: "100000000",
            slippage: 0.005,
            integrator: "least-finance",
        });
        expect(asked).not.toHaveProperty("fee");
    });

    test("the same request within 10 s is answered from the cache", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const before = stack.lifi.quotes.length;
        const first = await quote(socket, request(user));
        const second = await quote(socket, request(user));
        expect(second).toEqual(first);
        expect(stack.lifi.quotes.length - before).toBe(1);
    });

    test("no route", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        stack.lifi.noRoute();
        expect(await quote(socket, request(user))).toEqual({
            ok: false,
            error: { code: "no_route", message: "There's no route for this swap right now." },
        });
    });

    test("LI.FI being down says swaps aren't available", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        stack.lifi.failNext("/v1/quote");
        expect(await quote(socket, request(user, { amountUSD: "101" }))).toEqual({
            ok: false,
            error: { code: "unavailable", message: "Swaps aren't available right now." },
        });
    });

    test("someone else's wallet is refused", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const stranger = privateKeyToAddress(generatePrivateKey());
        for (const patch of [{ wallet: stranger }, { receiver: stranger }]) {
            const result = await quote(socket, request(user, patch));
            expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
        }
    });

    test("an EVM receiver for Solana is refused", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const result = await quote(socket, request(user, { to: { token: "SOL", network: "solana" } }));
        expect(result).toEqual({
            ok: false,
            error: { code: "bad_request", message: "Connect a Solana wallet to receive SOL on Solana." },
        });
    });
});

describe("opening orders", () => {
    test("confirming USDC on Ethereum adds an exact approval before the swap", async () => {
        const user = await holder();
        const { socket, updates } = await bind(user);
        const { order: opened_, txs } = await opened(socket, request(user));

        expect(txs.map((tx) => (tx.kind === "evm" ? tx.purpose : tx.kind))).toEqual(["approve", "swap"]);
        expect(txs[0]).toEqual({
            kind: "evm",
            purpose: "approve",
            chainId: 1,
            to: USDC,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DIAMOND, 100_000_000n] }),
            value: "0",
        });
        expect(txs[1]).toMatchObject({ kind: "evm", purpose: "swap", chainId: 1, to: DIAMOND, value: "0" });

        expect(opened_).toMatchObject({
            state: "created",
            from: { token: "USDC", network: "ethereum", amount: "100" },
            to: { token: "ETH", network: "base", received: null, receivedSymbol: null },
            wallet: getAddress(user.wallet),
            txHashes: [],
        });
        const stored = await orders().findOne({ _id: new ObjectId(opened_.id) });
        expect(stored).toMatchObject({ state: "created", tool: "fakebridge" });
        await expect.poll(() => updates.map((update) => update.id)).toEqual([opened_.id]);
    });

    test("enough allowance means only the swap", async () => {
        const user = await holder();
        await ethereum().setAllowance(USDC, DIAMOND, 100_000_000n);
        const { socket } = await bind(user);
        const { txs } = await opened(socket, request(user));
        expect(txs.map((tx) => (tx.kind === "evm" ? tx.purpose : tx.kind))).toEqual(["swap"]);
        await ethereum().setAllowance(USDC, DIAMOND, 0n);
    });

    test("a short allowance on USDC is topped up without a reset", async () => {
        const user = await holder();
        await ethereum().setAllowance(USDC, DIAMOND, 50_000_000n);
        const { socket } = await bind(user);
        const { txs } = await opened(socket, request(user));
        expect(txs.map((tx) => (tx.kind === "evm" ? tx.purpose : tx.kind))).toEqual(["approve", "swap"]);
        await ethereum().setAllowance(USDC, DIAMOND, 0n);
    });

    test("USDT on Ethereum with an old allowance is reset to 0 first", async () => {
        const user = await holder();
        await ethereum().setAllowance(USDT, DIAMOND, 1_000_000n);
        const { socket } = await bind(user);
        const { txs } = await opened(socket, request(user, { from: { token: "USDT", network: "ethereum" } }));
        expect(txs.map((tx) => (tx.kind === "evm" ? tx.purpose : tx.kind))).toEqual(["reset", "approve", "swap"]);
        expect(txs[0]).toMatchObject({
            to: USDT,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DIAMOND, 0n] }),
        });
        expect(txs[1]).toMatchObject({
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DIAMOND, 100_000_000n] }),
        });
        await ethereum().setAllowance(USDT, DIAMOND, 0n);
    });

    test("USDT on Ethereum with no allowance needs no reset", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const { txs } = await opened(socket, request(user, { from: { token: "USDT", network: "ethereum" } }));
        expect(txs.map((tx) => (tx.kind === "evm" ? tx.purpose : tx.kind))).toEqual(["approve", "swap"]);
    });

    test("a native coin needs no approval", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const req = request(user, {
            from: { token: "ETH", network: "ethereum" },
            to: { token: "USDC", network: "base" },
        });
        const view = await quote(socket, { ...req, amountUSD: "321.04" });
        expect(view).toMatchObject({ ok: true, data: { fromAmount: "0.1", needsApproval: false } });

        const { txs } = await opened(socket, { ...req, amountUSD: "321.04" });
        expect(txs).toEqual([
            {
                kind: "evm",
                purpose: "swap",
                chainId: 1,
                to: DIAMOND,
                data: "0xdeadbeef",
                value: parseUnits("0.1", 18).toString(),
            },
        ]);
    });

    test("an amount over the wallet's balance is cut to what it holds", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const result = await quote(socket, request(user, { amountUSD: "5000" }));
        expect(result).toMatchObject({ ok: true, data: { fromAmount: "1000" } });
    });

    test("the price moved", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const reviewed = await quote(socket, request(user, { amountUSD: "102" }));
        if (!reviewed.ok) throw new Error(reviewed.error.code);

        const min = parseUnits(reviewed.data.toAmountMin, 18);
        stack.lifi.nextQuote({ estimate: { toAmountMin: String((min * 99n) / 100n) } });
        const result = await order(socket, request(user, { amountUSD: "102" }), reviewed.data.toAmountMin);
        expect(result).toEqual({
            ok: false,
            error: { code: "price_moved", message: "The price moved. Check the new amount and confirm again." },
        });
        expect(await orders().countDocuments({ wallet: getAddress(user.wallet) })).toBe(0);

        // The next quote shows the new price, not the cached one
        const again = await quote(socket, request(user, { amountUSD: "102" }));
        expect(again).toMatchObject({ ok: true, data: { toAmountMin: formatUnits((min * 99n) / 100n, 18) } });
    });

    test("a small move inside the slippage still opens", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const reviewed = await quote(socket, request(user, { amountUSD: "103" }));
        if (!reviewed.ok) throw new Error(reviewed.error.code);
        const min = parseUnits(reviewed.data.toAmountMin, 18);
        stack.lifi.nextQuote({ estimate: { toAmountMin: String((min * 998n) / 1000n) } });
        expect((await order(socket, request(user, { amountUSD: "103" }), reviewed.data.toAmountMin)).ok).toBe(true);
    });

    test("the IP is kept apart and expires", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const { order: made } = await opened(socket, request(user));

        const { db } = stack.server.services.database;
        const row = await db.collection("swap_ips").findOne({ orderId: new ObjectId(made.id) });
        expect(row?.ip).toMatch(/127\.0\.0\.1|::1/);
        const thirtyDays = 30 * 86_400_000;
        expect(Math.abs(row!.expiresAt.getTime() - (Date.now() + thirtyDays))).toBeLessThan(60_000);
        expect(await orders().findOne({ _id: new ObjectId(made.id) })).not.toHaveProperty("ip");

        const indexes = await db.collection("swap_ips").indexes();
        expect(indexes).toContainEqual(expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }));
    });

    test("a sixth unsettled swap is refused", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        for (let i = 0; i < 5; i++) await opened(socket, request(user, { amountUSD: String(10 + i) }));
        expect(await order(socket, request(user))).toEqual({
            ok: false,
            error: { code: "rate_limited", message: "Too many swaps are still waiting. Try again in a few minutes." },
        });
    });

    test("two tabs confirming the same review each get an order", async () => {
        const user = await holder();
        const one = await bind(user);
        const two = await bind(user);
        const [a, b] = await Promise.all([opened(one.socket, request(user)), opened(two.socket, request(user))]);
        expect(a.order.id).not.toBe(b.order.id);
    });
});

describe("reporting sent", () => {
    const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const sent = (socket: AppSocket, orderId: string, txHashes: string[]) =>
        socket.timeout(5000).emitWithAck("swap:sent", { orderId, txHashes }) as Promise<Ack<SwapOrderView>>;

    test("sent is reported once, and again is harmless", async () => {
        const user = await holder();
        const { socket, updates } = await bind(user);
        const { order: made } = await opened(socket, request(user));

        const first = await sent(socket, made.id, [HASH(1), HASH(2)]);
        expect(first).toMatchObject({ ok: true, data: { id: made.id, state: "sent", txHashes: [HASH(1), HASH(2)] } });
        const again = await sent(socket, made.id, [HASH(1), HASH(2)]);
        expect(again).toEqual(first);
        await expect.poll(() => updates.map((update) => update.state)).toEqual(["created", "sent"]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(updates).toHaveLength(2);
    });

    test("an expired order with no hashes is taken", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const { order: made } = await opened(socket, request(user));
        await orders().updateOne({ _id: new ObjectId(made.id) }, { $set: { state: "expired" } });

        const result = await sent(socket, made.id, [HASH(3)]);
        expect(result).toMatchObject({ ok: true, data: { state: "sent", txHashes: [HASH(3)] } });
    });

    test("another account's order is not found", async () => {
        const user = await holder();
        const { socket } = await bind(user);
        const { order: made } = await opened(socket, request(user));
        const other = await bind(await holder());
        expect(await sent(other.socket, made.id, [HASH(4)])).toMatchObject({ ok: false, error: { code: "not_found" } });
    });
});

describe("at sign-in", () => {
    test("swaps are pushed at sign-in", async () => {
        const user = await holder();
        const first = await bind(user);
        const { order: open } = await opened(first.socket, request(user));

        const day = 86_400_000;
        const settled = async (state: string, ageDays: number) => {
            const doc = {
                ...(await orders().findOne({ _id: new ObjectId(open.id) }))!,
                _id: new ObjectId(),
                state,
                createdAt: new Date(Date.now() - ageDays * day),
                updatedAt: new Date(Date.now() - ageDays * day),
            };
            await orders().insertOne(doc as never);
            return doc._id.toHexString();
        };
        const recent = await settled("done", 2);
        await settled("done", 8);

        const second = await bind(user);
        expect(second.swaps[0]!.map((view) => view.id)).toEqual([open.id, recent]);
    });
});

describe("merged accounts", () => {
    let mongo: MongoClient;
    let merged: Stack | undefined;
    beforeAll(async () => {
        mongo = await MongoClient.connect(inject("mongoUri"));
    });
    afterAll(() => mongo.close());
    afterEach(async () => {
        await merged?.stop();
        merged = undefined;
    });

    test("a merged account keeps its swaps", async () => {
        const db = `test_${randomUUID().replaceAll("-", "")}`;
        const privyUserId = `did:privy:${randomUUID().replaceAll("-", "")}`;
        const ids = [new ObjectId(), new ObjectId()];
        const now = new Date();
        let index = 5000;
        for (const _id of ids) {
            const addr = privateKeyToAddress(generatePrivateKey()).toLowerCase();
            await mongo
                .db(db)
                .collection("accounts")
                .insertOne({
                    _id,
                    privyUserId,
                    depositIndex: index++,
                    depositAddress: addr,
                    balance: Decimal128.fromString("0"),
                    version: 0,
                    openedAtBlock: 0,
                    createdAt: new Date(now.getTime() + index),
                    updatedAt: now,
                } as never);
        }
        const swapId = new ObjectId();
        await mongo
            .db(db)
            .collection("swap_orders")
            .insertOne({ _id: swapId, accountId: ids[1], state: "sent" } as never);

        merged = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { MONGODB_DB: db },
        });
        const kept = await merged.server.services.database.collections.swapOrders.findOne({ _id: swapId });
        expect(kept?.accountId.equals(ids[0]!)).toBe(true);
    });
});
