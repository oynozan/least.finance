import { ObjectId } from "mongodb";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test, vi } from "vitest";
import type { SwapOrderDoc } from "../../src/db/mongo.ts";
import type { SwapOrderView } from "../../src/protocol.ts";
import { createSwapClients } from "../../src/swaps/clients.ts";
import { COINS, type NetworkId } from "../../src/swaps/coins.ts";
import { createLifi, type Lifi } from "../../src/swaps/lifi.ts";
import { SwapTracker } from "../../src/swaps/tracker.ts";
import { sourceChain } from "../support/source-chains.ts";
import { startStack, type Stack } from "../support/stack.ts";

const entry = (symbol: string, network: NetworkId) =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((candidate) => candidate.network === network)!;

let stack: Stack;
let clock = 1_800_000_000_000;
let statusCalls: number[] = [];
const refreshed: string[] = [];

beforeAll(async () => {
    // The stack's own tracker sleeps for an hour, so only the one built below touches these orders.
    stack = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { SWAPS_POLL_MS: "3600000" },
    });
});
afterAll(() => stack?.stop());

// Each test sees only its own orders, and the clock starts from the same instant
beforeEach(async () => {
    clock = 1_800_000_000_000;
    await stack.server.services.database.collections.swapOrders.deleteMany({});
});

const orders = () => stack.server.services.database.collections.swapOrders;

function tracker(
    options: { lifi?: Lifi; solanaStatus?: (signature: string) => Promise<{ failed: boolean } | null> } = {},
) {
    const ethereumUrl = inject("ethereumUrl");
    const refused = ["http://127.0.0.1:9"];
    const clients = createSwapClients({
        ethereum: [ethereumUrl],
        arbitrum: refused,
        base: refused,
        optimism: refused,
        polygon: refused,
        bnb: refused,
        avalanche: refused,
        arc: refused,
    });
    const real = createLifi({ url: stack.lifi.url });
    const lifi: Lifi = options.lifi ?? {
        ...real,
        status: (req) => {
            statusCalls.push(clock);
            return real.status(req);
        },
    };
    return new SwapTracker({
        collections: stack.server.services.database.collections,
        lifi,
        clients,
        bus: stack.server.services.bus,
        holdings: {
            refresh: async (account, identity, reason) => {
                refreshed.push(`${account.privyUserId}|${identity.userId}|${reason}`);
                return { read: false };
            },
        },
        solanaStatus: options.solanaStatus ?? (async () => null),
        accounts: stack.server.services.accounts,
        logger: stack.server.services.logger,
        pollMs: 1_000,
        now: () => clock,
    });
}

const hash = () => `0x${Buffer.from(generatePrivateKey().slice(2), "hex").toString("hex")}` as Hex;

/** A sent USDC on Ethereum to ETH on Base order for a fresh account, sent at the current clock. */
async function sent(patch: Partial<SwapOrderDoc> = {}) {
    const wallet = privateKeyToAddress(generatePrivateKey());
    const account = await stack.server.services.accounts.open(`did:privy:${Math.random().toString(16).slice(2)}`);
    const at = new Date(clock);
    const order: SwapOrderDoc = {
        _id: new ObjectId(),
        accountId: account._id,
        wallet,
        receiver: wallet,
        from: { token: "USDC", network: "ethereum", units: "100000000", amount: "100" },
        to: {
            token: "ETH",
            network: "base",
            units: "31000000000000000",
            minUnits: "30845000000000000",
            amount: "0.031",
            minAmount: "0.030845",
        },
        tool: "fakebridge",
        toolName: "Fake Bridge",
        fees: [],
        gasUSD: 0.05,
        etaSeconds: 30,
        state: "sent",
        txHashes: [hash()],
        received: null,
        receivedSymbol: null,
        createdAt: at,
        updatedAt: at,
        ...patch,
    };
    await orders().insertOne(order);
    return order;
}

/** The raw LI.FI status for an order, with its own addresses unless a patch says otherwise. */
function status(order: SwapOrderDoc, patch: Record<string, unknown> = {}, receiving?: Record<string, unknown>) {
    const asked = entry(order.to.token, order.to.network);
    stack.lifi.setStatus(order.txHashes.at(-1)!, {
        status: "DONE",
        substatus: "COMPLETED",
        fromAddress: order.wallet,
        toAddress: order.receiver,
        sending: { txHash: order.txHashes.at(-1) },
        receiving: {
            txHash: hash(),
            chainId: 8453,
            amount: "30900000000000000",
            token: { address: asked.address, symbol: order.to.token, decimals: asked.decimals, chainId: 8453 },
            ...receiving,
        },
        ...patch,
    });
}

const state = async (order: SwapOrderDoc) => (await orders().findOne({ _id: order._id }))!;

describe("following swaps", () => {
    test("done with the asked token", async () => {
        const order = await sent();
        status(order);
        const updates: SwapOrderView[] = [];
        stack.server.services.bus.on("swap:updated", ({ order: moved }) => {
            if (moved._id.equals(order._id)) updates.push({ state: moved.state } as SwapOrderView);
        });
        await tracker().tick();
        expect(await state(order)).toMatchObject({ state: "done", received: "0.0309", receivedSymbol: null });
        expect(updates.map((update) => update.state)).toEqual(["done"]);
    });

    test("partial when another token arrived", async () => {
        const order = await sent();
        status(
            order,
            { substatus: "PARTIAL" },
            {
                amount: "5000000",
                token: { address: entry("USDC", "base").address, symbol: "USDC", decimals: 6, chainId: 8453 },
            },
        );
        await tracker().tick();
        expect(await state(order)).toMatchObject({ state: "partial", received: "5", receivedSymbol: "USDC" });
    });

    test("DONE with a different token is partial, never done, and an unknown symbol shows the address", async () => {
        const order = await sent();
        const other = "0x1111111111111111111111111111111111111111";
        status(order, {}, { amount: "7000000", token: { address: other, symbol: "", decimals: 6, chainId: 8453 } });
        await tracker().tick();
        expect(await state(order)).toMatchObject({ state: "partial", received: "7", receivedSymbol: other });
    });

    test("refunded", async () => {
        const order = await sent();
        status(order, { status: "DONE", substatus: "REFUNDED" });
        await tracker().tick();
        expect(await state(order)).toMatchObject({ state: "refunded", received: null });

        const failedRefund = await sent();
        status(failedRefund, { status: "FAILED", substatus: "REFUNDED" });
        await tracker().tick();
        expect((await state(failedRefund)).state).toBe("refunded");
    });

    test("failed", async () => {
        const order = await sent();
        status(order, { status: "FAILED", substatus: "UNKNOWN_ERROR", receiving: null });
        await tracker().tick();
        expect((await state(order)).state).toBe("failed");
    });

    test("not found keeps it pending", async () => {
        const order = await sent();
        await tracker().tick();
        expect((await state(order)).state).toBe("sent");
        status(order, { status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION", receiving: null });
        clock += 60_000;
        const again = tracker();
        await again.tick();
        expect((await state(order)).state).toBe("sent");
    });

    test("a status for someone else's transaction is ignored", async () => {
        for (const patch of [
            { fromAddress: privateKeyToAddress(generatePrivateKey()) },
            { toAddress: privateKeyToAddress(generatePrivateKey()) },
            { sending: { txHash: hash() } },
        ]) {
            const order = await sent();
            status(order, patch);
            const warn = vi.spyOn(stack.server.services.logger, "warn");
            await tracker().tick();
            expect((await state(order)).state).toBe("sent");
            warn.mockRestore();
        }
    });

    // A transaction on the Ethereum anvil that reverted, sent by `wallet`
    async function revertedTx() {
        const chain = sourceChain(inject("ethereumUrl"), 1);
        const wallet = privateKeyToAddress(generatePrivateKey());
        const reverting = privateKeyToAddress(generatePrivateKey()) as Address;
        await chain.fund(wallet, "1");
        // Runtime code 0xfd reverts every call
        await chain.client.setCode({ address: reverting, bytecode: "0xfd" });
        const txHash = await chain.client.sendTransaction({
            account: wallet,
            to: reverting,
            data: "0x",
            gas: 100_000n,
        });
        await chain.client.waitForTransactionReceipt({ hash: txHash });
        return { wallet, txHash };
    }

    test("a reverted same-chain swap fails", async () => {
        const { wallet, txHash } = await revertedTx();
        const order = await sent({
            wallet,
            receiver: wallet,
            to: {
                token: "USDT",
                network: "ethereum",
                units: "99000000",
                minUnits: "98000000",
                amount: "99",
                minAmount: "98",
            },
            txHashes: [txHash],
        });
        await tracker().tick();
        expect((await state(order)).state).toBe("failed");
        expect(getAddress(wallet)).toBeTruthy();
    });

    test("a reverted cross-chain source transaction fails", async () => {
        const { wallet, txHash } = await revertedTx();
        const order = await sent({ wallet, receiver: wallet, txHashes: [txHash] });
        await tracker().tick();
        expect((await state(order)).state).toBe("failed");
    });

    test("a Solana swap whose signature errored fails, and one without a verdict stays sent", async () => {
        const solana = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
        const base = {
            wallet: solana,
            from: { token: "SOL", network: "solana" as const, units: "1000000000", amount: "1" },
        };
        const signature = "5".repeat(88);
        const asked: string[] = [];
        const solanaStatus = async (value: string) => {
            asked.push(value);
            return { failed: true };
        };
        const failing = await sent({ ...base, txHashes: [signature] });
        await tracker({ solanaStatus }).tick();
        expect((await state(failing)).state).toBe("failed");
        expect(asked).toEqual([signature]);

        const waiting = await sent({ ...base, txHashes: [signature] });
        await tracker({ solanaStatus: async () => ({ failed: false }) }).tick();
        expect((await state(waiting)).state).toBe("sent");
    });

    test("a Solana swap still settles through LI.FI while the Solana RPC can't be reached", async () => {
        const solana = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
        const order = await sent({
            wallet: solana,
            from: { token: "SOL", network: "solana", units: "1000000000", amount: "1" },
            txHashes: ["6".repeat(88)],
        });
        status(order);
        const solanaStatus = async (): Promise<{ failed: boolean } | null> => {
            throw new Error("every Solana RPC failed");
        };
        await tracker({ solanaStatus }).tick();
        expect((await state(order)).state).toBe("done");
    });

    test("a FAILED status without addresses settles to failed, and one for another hash does not", async () => {
        const order = await sent();
        status(order, { status: "FAILED", substatus: "UNKNOWN_ERROR", fromAddress: undefined, toAddress: undefined });
        await tracker().tick();
        expect((await state(order)).state).toBe("failed");

        const other = await sent();
        status(other, { status: "FAILED", fromAddress: undefined, toAddress: undefined, sending: { txHash: hash() } });
        await tracker().tick();
        expect((await state(other)).state).toBe("sent");
    });

    test("a same-chain status request carries no bridge, a cross-chain one does", async () => {
        const same = await sent({
            to: {
                token: "USDT",
                network: "ethereum",
                units: "99000000",
                minUnits: "98000000",
                amount: "99",
                minAmount: "98",
            },
        });
        const cross = await sent();
        stack.lifi.requests.length = 0;
        await tracker().tick();
        const asked = stack.lifi.requests.filter((request) => request.includes("/v1/status"));
        const forOrder = (order: SwapOrderDoc) => asked.find((request) => request.includes(order.txHashes[0]!))!;
        expect(forOrder(same)).not.toContain("bridge=");
        expect(forOrder(cross)).toContain("bridge=fakebridge");
    });

    test("the received amount uses the status's own decimals", async () => {
        const order = await sent();
        status(
            order,
            {},
            {
                amount: "30900000",
                token: { address: entry("ETH", "base").address, symbol: "ETH", decimals: 6, chainId: 8453 },
            },
        );
        await tracker().tick();
        expect(await state(order)).toMatchObject({ state: "done", received: "30.9" });
    });

    test("unreported orders expire after 15 minutes", async () => {
        const order = await sent({ state: "created", txHashes: [] });
        const watcher = tracker();
        clock += 14 * 60_000;
        await watcher.tick();
        expect((await state(order)).state).toBe("created");
        clock += 61_000;
        await watcher.tick();
        expect((await state(order)).state).toBe("expired");
    });

    test("sent orders give up after 24 hours", async () => {
        const order = await sent();
        const watcher = tracker();
        clock += 24 * 3_600_000 + 1_000;
        await watcher.tick();
        expect((await state(order)).state).toBe("expired");
    });

    test("a move only happens from the state it was read in", async () => {
        const order = await sent();
        status(order);
        const real = createLifi({ url: stack.lifi.url });
        // The order is failed by someone else while the status call is in flight
        const lifi: Lifi = {
            ...real,
            status: async (req) => {
                const answer = await real.status(req);
                await orders().updateOne({ _id: order._id }, { $set: { state: "failed" } });
                return answer;
            },
        };
        await tracker({ lifi }).tick();
        expect((await state(order)).state).toBe("failed");
    });

    test("polling slows down with age", async () => {
        const order = await sent();
        statusCalls = [];
        const before = stack.lifi.requests.filter((request) => request.includes("/v1/status")).length;
        const start = clock;
        const watcher = tracker();
        for (let at = 0; at <= 600_000; at += 1_000) {
            clock = start + at;
            await watcher.tick();
        }
        const ages = statusCalls.map((at) => at - start);
        const gaps = ages.slice(1).map((age, index) => age - ages[index]!);
        expect(ages[0]).toBe(0);
        expect(ages.filter((age) => age < 60_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
        for (const [index, gap] of gaps.entries()) {
            const age = ages[index + 1]!;
            expect(gap).toBeGreaterThanOrEqual(age < 60_000 ? 10_000 : age < 240_000 ? 30_000 : 60_000);
        }
        expect(ages.filter((age) => age >= 240_000).length).toBeGreaterThan(3);
        const served = stack.lifi.requests.filter((request) => request.includes("/v1/status")).length - before;
        expect(served).toBe(ages.length);
        expect(order.txHashes[0]).toBeTruthy();
    });

    test("settling refreshes holdings", async () => {
        const order = await sent();
        status(order);
        refreshed.length = 0;
        await tracker().tick();
        const account = await stack.server.services.accounts.findById(order.accountId);
        expect(refreshed).toEqual([`${account!.privyUserId}|${account!.privyUserId}|settled`]);

        const pending = await sent();
        refreshed.length = 0;
        await tracker().tick();
        expect(refreshed).toEqual([]);
        expect((await state(pending)).state).toBe("sent");
    });
});
