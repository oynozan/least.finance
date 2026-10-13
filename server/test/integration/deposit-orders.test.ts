import { ObjectId } from "mongodb";
import { getAddress } from "viem";
import { base58 } from "@scure/base";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { Ack, DepositOrderView, EvmSourceTxView, SourceTxView, WalletSession } from "../../src/protocol.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";
import { FAKE_BRIDGE_ADDRESS, FAKE_SOLANA_PROGRAM } from "../support/fake-bridge.ts";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SIGNATURE = base58.encode(new Uint8Array(64).fill(7));
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
    expect(txs.map((tx) => (tx as EvmSourceTxView).chainId)).toEqual([1, 1]);
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
    expect(BigInt((result.data.txs[0] as EvmSourceTxView).value)).toBe(500_000_000_000_000_000n);
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

test("a Solana quote is refused while SOLANA_DEPOSITS is off", async () => {
    const user = await stack.user();
    stack.privy.setUser(user.userId, [user.wallet, { address: SOLANA, chain: "solana" }]);
    const { socket } = await bind(user);
    // Binding reads balances in the background, which looks the user up too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lookups = stack.privy.userLookups;
    const order = await ask(socket, "solana:SOL", "1", SOLANA);
    expect(order).toEqual({ ok: false, error: { code: "unavailable", message: "Solana isn't open yet." } });
    const quote = await socket
        .timeout(5000)
        .emitWithAck("deposit:quote", { coin: "solana:SOL", amount: "1", wallet: SOLANA });
    expect(quote).toEqual({ ok: false, error: { code: "unavailable", message: "Solana isn't open yet." } });
    expect(stack.privy.userLookups).toBe(lookups);
});

describe("Solana deposits", () => {
    let open: Stack;
    beforeAll(async () => {
        open = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { SOLANA_DEPOSITS: "on" },
        });
    });
    afterAll(() => open?.stop());

    async function solanaUser() {
        const user = await open.user();
        open.privy.setUser(user.userId, [user.wallet, { address: SOLANA, chain: "solana" }]);
        const socket = await open.socket(user);
        const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
        if (!opened.ok) throw new Error(opened.error.code);
        return { user, socket, session: opened.data };
    }
    const quote = (socket: AppSocket, coin: string, amount: string, wallet = SOLANA) =>
        socket.timeout(5000).emitWithAck("deposit:quote", { coin, amount, wallet });
    const order = (socket: AppSocket, coin: string, amount: string, wallet = SOLANA) =>
        socket.timeout(5000).emitWithAck("deposit:order", { coin, amount, wallet }) as Promise<
            Ack<{ order: DepositOrderView; txs: SourceTxView[] }>
        >;

    test("a Solana wallet that isn't linked is forbidden", async () => {
        const user = await open.user();
        const socket = await open.socket(user);
        await socket.timeout(5000).emitWithAck("account:open", {});
        const result = await quote(socket, "solana:USDC", "10");
        expect(result).toEqual({
            ok: false,
            error: { code: "forbidden", message: "That wallet isn't linked to your account." },
        });
    });

    test("under $2 in USDC is refused", async () => {
        const { socket } = await solanaUser();
        const result = await order(socket, "solana:USDC", "1.99");
        expect(result).toEqual({
            ok: false,
            error: { code: "bad_request", message: "The smallest deposit from Solana is $2." },
        });
        expect((await order(socket, "solana:USDC", "2")).ok).toBe(true);
    });

    test("0.01 SOL priced at $150 is refused with 'The smallest deposit from Solana is $2.'", async () => {
        const { socket, session } = await solanaUser();
        const result = await order(socket, "solana:SOL", "0.01");
        expect(result).toEqual({
            ok: false,
            error: { code: "bad_request", message: "The smallest deposit from Solana is $2." },
        });
        const { depositOrders } = open.server.services.database.collections;
        expect(await depositOrders.countDocuments({ recipient: session.account.depositAddress.toLowerCase() })).toBe(0);
        expect((await order(socket, "solana:SOL", "0.02")).ok).toBe(true);
    });

    test("no route from Relay or CCTP is 'No route for this deposit right now.'", async () => {
        const { socket } = await solanaUser();
        const spy = vi.spyOn(open.solanaBridge, "quote").mockRejectedValue(new Error("no route"));
        try {
            expect(await quote(socket, "solana:USDC", "10")).toEqual({
                ok: false,
                error: { code: "unavailable", message: "No route for this deposit right now." },
            });
        } finally {
            spy.mockRestore();
        }
    });

    test("create stores the base58 wallet as given and returns instructions with the lookup tables' contents", async () => {
        const { socket } = await solanaUser();
        const table = "AddressLookupTab1e1111111111111111111111111";
        const entries = ["So11111111111111111111111111111111111111112", "SysvarC1ock11111111111111111111111111111111"];
        open.solanaRpc.setLookupTable(table, entries);
        open.solanaBridge.lookupTables = [table, "MissingTab1e1111111111111111111111111111111"];
        try {
            const result = await order(socket, "solana:USDC", "10");
            if (!result.ok) throw new Error(result.error.code);
            const [tx] = result.data.txs;
            expect(tx).toMatchObject({
                kind: "solana",
                instructions: [{ programId: FAKE_SOLANA_PROGRAM, keys: [{ pubkey: SOLANA, isSigner: true }] }],
                lookupTables: [{ address: table, addresses: entries }],
            });
            expect(result.data.order).toMatchObject({ coin: "solana:USDC", wallet: SOLANA, state: "created" });
        } finally {
            open.solanaBridge.lookupTables = [];
        }
    });

    test("the order doc keeps refundTo exactly as the wallet, not lowercased", async () => {
        const { socket } = await solanaUser();
        const result = await order(socket, "solana:USDC", "10");
        if (!result.ok) throw new Error(result.error.code);
        const doc = await open.server.services.database.collections.depositOrders.findOne({
            _id: new ObjectId(result.data.order.id),
        });
        expect(doc).toMatchObject({ wallet: SOLANA, refundTo: SOLANA, provider: "relay" });
    });

    test("deposit:source takes a base58 signature for a Solana order and refuses a 0x hash for it, and the reverse for an EVM order", async () => {
        const { user, socket } = await solanaUser();
        const solana = await order(socket, "solana:USDC", "10");
        const evm = await order(socket, "ethereum:ETH", "0.1", user.wallet);
        if (!solana.ok || !evm.ok) throw new Error("order failed");
        const report = (orderId: string, txHashes: string[]) =>
            socket.timeout(5000).emitWithAck("deposit:source", { orderId, txHashes });

        expect(await report(solana.data.order.id, [HASH])).toMatchObject({ ok: false, error: { code: "bad_request" } });
        expect(await report(evm.data.order.id, [SIGNATURE])).toMatchObject({
            ok: false,
            error: { code: "bad_request" },
        });
        expect(await report(solana.data.order.id, [SIGNATURE])).toMatchObject({
            ok: true,
            data: { state: "sent", sourceTxHashes: [SIGNATURE] },
        });
        expect(await report(evm.data.order.id, [HASH])).toMatchObject({ ok: true, data: { state: "sent" } });
    });
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

/** Ends the account's orders, so the cap on waiting ones doesn't stand in the way. */
const settleAll = (user: User) =>
    stack.server.services.database.collections.depositOrders.updateMany(
        { wallet: getAddress(user.wallet) },
        { $set: { state: "expired" } },
    );

test("orders are rate limited per person", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const acks: Ack<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
        acks.push(await ask(socket, "ethereum:USDC", "1", user.wallet));
        await settleAll(user);
    }
    expect(acks.filter((a) => a.ok)).toHaveLength(10);
    const refused = acks.filter((a) => !a.ok);
    expect(refused).toHaveLength(2);
    expect(refused.every((a) => !a.ok && a.error.code === "rate_limited")).toBe(true);
});

test("an account can have only five orders waiting to be sent", async () => {
    const user = await stack.user();
    const { socket } = await bind(user);
    const acks: Ack<{ order: DepositOrderView; txs: SourceTxView[] }>[] = [];
    for (let i = 0; i < 6; i++) acks.push(await ask(socket, "ethereum:USDC", "1", user.wallet));
    expect(acks.slice(0, 5).every((a) => a.ok)).toBe(true);
    expect(acks[5]).toMatchObject({ ok: false, error: { code: "rate_limited" } });

    // One that has gone on to its block no longer waits on the wallet.
    await stack.server.services.database.collections.depositOrders.updateOne(
        { _id: new ObjectId((acks[0] as { ok: true; data: { order: DepositOrderView } }).data.order.id) },
        { $set: { state: "in_block" } },
    );
    expect((await ask(socket, "ethereum:USDC", "1", user.wallet)).ok).toBe(true);
    await settleAll(user);
});
