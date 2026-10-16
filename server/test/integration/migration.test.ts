import { randomUUID } from "node:crypto";
import { Decimal128, MongoClient, ObjectId } from "mongodb";
import { parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeAll, afterAll, expect, inject, test, vi } from "vitest";
import { expireOpenSwapOrders, mergeAccountsByPerson } from "../../src/db/migrations.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { Ack, DepositView, WalletSession } from "../../src/protocol.ts";
import { startStack, type Stack, type User } from "../support/stack.ts";

const wei = (usdc: string) => parseUnits(usdc, 18);
const newAddress = () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as Address;
const newDid = () => `did:privy:${randomUUID().replaceAll("-", "")}`;

let mongo: MongoClient;
beforeAll(async () => {
    mongo = await MongoClient.connect(inject("mongoUri"));
});
afterAll(() => mongo.close());

let stack: Stack | undefined;
afterEach(async () => {
    await stack?.stop();
    stack = undefined;
});

let nextIndex = 1000;
let clock = Date.UTC(2026, 0, 1);

type Seed = { id: ObjectId; address: Address; privyUserId: string; wallet: string; usdc: string };

/** An old-style account (keyed by wallet), with one deposit and its ledger entry when it holds funds. */
async function seedAccount(db: string, privyUserId: string, usdc: string): Promise<Seed> {
    const id = new ObjectId();
    const address = newAddress();
    const wallet = newAddress();
    const createdAt = new Date((clock += 60_000));
    const amount = wei(usdc);
    const funded = amount > 0n;
    const database = mongo.db(db);
    await database.collection("accounts").insertOne({
        _id: id,
        wallet,
        privyUserId,
        depositIndex: nextIndex++,
        depositAddress: address,
        balance: toDecimal(amount),
        version: funded ? 1 : 0,
        openedAtBlock: 0,
        createdAt,
        updatedAt: createdAt,
    } as never);
    if (funded) {
        const depositId = new ObjectId();
        await database.collection("deposits").insertOne({
            _id: depositId,
            accountId: id,
            chainId: 5042,
            txHash: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
            logIndex: 0,
            blockNumber: 1,
            blockHash: `0x${"11".repeat(32)}`,
            from: newAddress(),
            to: address,
            amount: toDecimal(amount),
            source: "scan",
            creditedAt: createdAt,
        } as never);
        await database.collection("ledger").insertOne({
            _id: new ObjectId(),
            accountId: id,
            kind: "deposit",
            amount: toDecimal(amount),
            balanceAfter: toDecimal(amount),
            refId: depositId,
            createdAt,
        } as never);
    }
    return { id, address, privyUserId, wallet, usdc };
}

/** Starts the stack against a database that already holds `seed`'s documents. */
async function boot(seed: (db: string) => Promise<void>) {
    const db = `test_${randomUUID().replaceAll("-", "")}`;
    await seed(db);
    stack = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        env: { MONGODB_DB: db },
    });
    return stack;
}

async function userFor(running: Stack, userId: string): Promise<User> {
    const wallet = newAddress();
    running.privy.setUser(userId, [wallet]);
    await running.chain.fund(wallet, "1000");
    return { userId, wallet, token: await running.privy.token(userId) };
}

async function openSession(running: Stack, user: User) {
    const socket = await running.socket(user);
    const result = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!result.ok) throw new Error(`account:open failed: ${result.error.code}`);
    return { socket, session: result.data };
}

const collections = (running: Stack) => running.server.services.database.collections;

test("a person's single account is re-keyed and keeps its address and balance", async () => {
    const did = newDid();
    let only!: Seed;
    const running = await boot(async (db) => {
        only = await seedAccount(db, did, "7");
    });

    const accounts = await collections(running).accounts.find({ privyUserId: did }).toArray();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).not.toHaveProperty("wallet");
    expect(running.server.services.database.migration).toEqual({ rekeyed: 1, merged: 0 });

    const { session } = await openSession(running, await userFor(running, did));
    expect(session.account.depositAddress.toLowerCase()).toBe(only.address);
    expect(session.account.balance).toBe("7");
});

test("a person's two accounts merge into the older, through the ledger", async () => {
    const did = newDid();
    let a!: Seed;
    let b!: Seed;
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        b = await seedAccount(db, did, "2");
    });

    const accounts = await collections(running).accounts.find({ privyUserId: did }).toArray();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ _id: a.id, depositAddress: a.address, formerDepositAddresses: [b.address] });
    expect(fromDecimal(accounts[0]!.balance)).toBe(wei("5"));
    expect(accounts[0]!.version).toBe(2);
    expect(running.server.services.database.migration).toEqual({ rekeyed: 1, merged: 1 });

    const { merge_in } = Object.groupBy(await collections(running).ledger.find().toArray(), (entry) => entry.kind) as {
        merge_in: { refId: ObjectId; accountId: ObjectId }[];
    };
    expect(merge_in).toHaveLength(1);
    expect(merge_in[0]).toMatchObject({ refId: b.id, accountId: a.id });

    const { session } = await openSession(running, await userFor(running, did));
    expect(session.account.depositAddress.toLowerCase()).toBe(a.address);
    expect(session.account.balance).toBe("5");
    expect(session.deposits.items).toHaveLength(2);
});

test("a merged account's deposit orders follow it to the survivor", async () => {
    const did = newDid();
    let a!: Seed;
    const orderId = new ObjectId();
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        await mongo
            .db(db)
            .collection("deposit_orders")
            .insertOne({
                _id: orderId,
                accountId: b.id,
                state: "bridging",
                recipient: b.address,
            } as never);
    });

    const order = await collections(running).depositOrders.findOne({ _id: orderId });
    expect(order?.accountId.equals(a.id)).toBe(true);
});

test("an account merge carries withdrawals over", async () => {
    const did = newDid();
    let a!: Seed;
    const withdrawalId = new ObjectId();
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        await mongo
            .db(db)
            .collection("withdrawals")
            .insertOne({
                _id: withdrawalId,
                accountId: b.id,
                requestId: randomUUID(),
                amount: toDecimal(wei("1")),
                state: "sent",
            } as never);
    });

    const withdrawal = await collections(running).withdrawals.findOne({ _id: withdrawalId });
    expect(withdrawal?.accountId.equals(a.id)).toBe(true);
});

test("a merged account's swap orders follow it to the survivor", async () => {
    const did = newDid();
    let a!: Seed;
    const swapId = new ObjectId();
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        await mongo
            .db(db)
            .collection("swap_orders")
            .insertOne({ _id: swapId, accountId: b.id, state: "done" } as never);
    });

    const swap = await collections(running).swapOrders.findOne({ _id: swapId });
    expect(swap?.accountId.equals(a.id)).toBe(true);
});

test("a swap order left open by the wallet path is expired at startup, once, and settled ones stay as they were", async () => {
    const did = newDid();
    const long = new Date(Date.UTC(2026, 9, 1));
    const ids = Object.fromEntries(
        ["created", "sent", "done", "partial", "refunded", "failed", "expired"].map((state) => [state, new ObjectId()]),
    );
    const running = await boot(async (db) => {
        const account = await seedAccount(db, did, "1");
        await mongo
            .db(db)
            .collection("swap_orders")
            .insertMany(
                Object.entries(ids).map(([state, _id]) => ({
                    _id,
                    accountId: account.id,
                    state,
                    txHashes: state === "created" ? [] : ["0xaa"],
                    createdAt: long,
                    updatedAt: long,
                })) as never,
            );
    });
    const { swapOrders } = collections(running);
    const read = async () =>
        Object.fromEntries((await swapOrders.find().toArray()).map((order) => [order._id.toHexString(), order]));

    const first = await read();
    for (const state of ["created", "sent"] as const) {
        const order = first[ids[state]!.toHexString()]!;
        expect(order.state, state).toBe("expired");
        expect(order.updatedAt.getTime(), state).toBeGreaterThan(long.getTime());
    }
    for (const state of ["done", "partial", "refunded", "failed", "expired"] as const) {
        const order = first[ids[state]!.toHexString()]!;
        expect(order.state, state).toBe(state);
        expect(order.updatedAt, state).toEqual(long);
    }

    // A second run finds nothing open, and changes nothing.
    expect(await expireOpenSwapOrders(running.server.services.database.collections)).toBe(0);
    expect(await read()).toEqual(first);
});

const orderDoc = (accountId: ObjectId, requestId: string) => ({
    _id: new ObjectId(),
    accountId,
    requestId,
    state: "posted",
});
const positionDoc = (accountId: ObjectId, tokenId: string, shares: string, cost: string, state = "open") => ({
    _id: new ObjectId(),
    accountId,
    tokenId,
    shares: Decimal128.fromString(shares),
    cost: Decimal128.fromString(cost),
    state,
});

test("merging moves prediction orders and positions", async () => {
    const did = newDid();
    let a!: Seed;
    const order = orderDoc(new ObjectId(), "r1");
    const position = positionDoc(new ObjectId(), "tok-1", "5000000", "3000000000000000000");
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        order.accountId = b.id;
        position.accountId = b.id;
        await mongo
            .db(db)
            .collection("prediction_orders")
            .insertOne(order as never);
        await mongo
            .db(db)
            .collection("positions")
            .insertOne(position as never);
    });

    const { predictionOrders, positions } = collections(running);
    expect((await predictionOrders.findOne({ _id: order._id }))?.accountId.equals(a.id)).toBe(true);
    expect((await positions.findOne({ _id: position._id }))?.accountId.equals(a.id)).toBe(true);
});

test("merging two open positions on one token sums them instead of failing", async () => {
    const did = newDid();
    let a!: Seed;
    const keep = positionDoc(new ObjectId(), "tok-1", "5000000", "3000000000000000000");
    const other = positionDoc(new ObjectId(), "tok-1", "2000000", "1000000000000000000");
    const closing = positionDoc(new ObjectId(), "tok-2", "1000000", "500000000000000000", "closing");
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        keep.accountId = a.id;
        other.accountId = b.id;
        closing.accountId = b.id;
        await mongo
            .db(db)
            .collection("positions")
            .insertMany([keep, other, closing] as never);
    });

    const { positions } = collections(running);
    const survivor = await positions.findOne({ _id: keep._id });
    expect(survivor).toMatchObject({ state: "open" });
    expect(survivor!.shares.toString()).toBe("7000000");
    expect(survivor!.cost.toString()).toBe("4000000000000000000");
    const absorbed = await positions.findOne({ _id: other._id });
    expect(absorbed).toMatchObject({ state: "closed" });
    expect(absorbed!.proceeds?.toString()).toBe("0");
    expect((await positions.findOne({ _id: closing._id }))?.accountId.equals(a.id)).toBe(true);
    expect(await positions.countDocuments({ accountId: a.id, state: { $in: ["open", "closing"] } })).toBe(2);
});

const perpAccountDoc = (accountId: ObjectId, index: number) => ({
    _id: new ObjectId(),
    accountId,
    index,
    address: newAddress(),
    activatedAt: null,
    createdAt: new Date(),
});
const perpOrderDoc = (accountId: ObjectId, requestId: string, index: number) => ({
    _id: new ObjectId(),
    accountId,
    requestId,
    kind: "open",
    index,
    asset: "BTC",
    state: "filled",
    createdAt: new Date(),
    updatedAt: new Date(),
});
const perpPositionDoc = (accountId: ObjectId, index: number, asset: string) => ({
    _id: new ObjectId(),
    accountId,
    index,
    asset,
    active: true,
    state: "open",
    openedAt: new Date(),
    updatedAt: new Date(),
});

test("merging accounts re-points perp orders, positions and accounts to the survivor", async () => {
    const did = newDid();
    let a!: Seed;
    const account = perpAccountDoc(new ObjectId(), 7);
    const order = perpOrderDoc(new ObjectId(), "r1", 7);
    const position = perpPositionDoc(new ObjectId(), 7, "BTC");
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        account.accountId = order.accountId = position.accountId = b.id;
        const database = mongo.db(db);
        await database.collection("perp_accounts").insertOne(account as never);
        await database.collection("perp_orders").insertOne(order as never);
        await database.collection("perp_positions").insertOne(position as never);
    });

    const { perpAccounts, perpOrders, perpPositions } = collections(running);
    expect((await perpAccounts.findOne({ _id: account._id }))?.accountId.equals(a.id)).toBe(true);
    expect((await perpOrders.findOne({ _id: order._id }))?.accountId.equals(a.id)).toBe(true);
    expect((await perpPositions.findOne({ _id: position._id }))?.accountId.equals(a.id)).toBe(true);
});

test("a merge never collides two open positions", async () => {
    const did = newDid();
    let a!: Seed;
    const keep = perpPositionDoc(new ObjectId(), 5, "BTC");
    const other = perpPositionDoc(new ObjectId(), 9, "BTC");
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        keep.accountId = a.id;
        other.accountId = b.id;
        await mongo
            .db(db)
            .collection("perp_positions")
            .insertMany([keep, other] as never);
    });

    const { perpPositions } = collections(running);
    expect(await perpPositions.countDocuments({ accountId: a.id, state: "open" })).toBe(2);
    expect((await perpPositions.findOne({ _id: other._id }))?.index).toBe(9);
});

test("accounts without a Privy user aren't merged together", async () => {
    const did = newDid();
    let orphans!: Seed[];
    const running = await boot(async (db) => {
        await seedAccount(db, did, "3");
        await seedAccount(db, did, "2");
        orphans = [await seedAccount(db, newDid(), "4"), await seedAccount(db, newDid(), "1")];
        await mongo
            .db(db)
            .collection("accounts")
            .updateMany({ _id: { $in: orphans.map((orphan) => orphan.id) } }, { $unset: { privyUserId: "" } });
    });
    const { accounts } = collections(running);

    expect(await accounts.find({ privyUserId: did }).toArray()).toHaveLength(1);
    for (const orphan of orphans) {
        const kept = await accounts.findOne({ _id: orphan.id });
        expect(kept).toMatchObject({ depositAddress: orphan.address });
        expect(kept).not.toHaveProperty("formerDepositAddresses");
        expect(fromDecimal(kept!.balance)).toBe(wei(orphan.usdc));
    }
    expect(await accounts.countDocuments()).toBe(3);
    expect(running.server.services.database.migration.merged).toBe(1);
});

test("USDC sent to a merged account's old address credits the survivor", async () => {
    const did = newDid();
    let b!: Seed;
    const running = await boot(async (db) => {
        await seedAccount(db, did, "3");
        b = await seedAccount(db, did, "2");
    });
    const user = await userFor(running, did);
    const { socket } = await openSession(running, user);
    const pushes: { deposit: DepositView }[] = [];
    socket.on("deposit:credited", (push) => pushes.push(push));

    await running.chain.send(user.wallet, b.address, "1");

    await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const account = await collections(running).accounts.findOne({ privyUserId: did });
    expect(fromDecimal(account!.balance)).toBe(wei("6"));
    expect(pushes[0]!.deposit.amount).toBe("1");
});

test("the ledger still explains every balance after a merge", async () => {
    const did = newDid();
    let a!: Seed;
    let b!: Seed;
    const running = await boot(async (db) => {
        a = await seedAccount(db, did, "3");
        b = await seedAccount(db, did, "2");
    });
    const { ledger, accounts } = collections(running);

    const survivor = await accounts.findOne({ _id: a.id });
    const entries = await ledger.find({ accountId: a.id }).sort({ _id: 1 }).toArray();
    let running_total = 0n;
    for (const entry of entries) {
        running_total += fromDecimal(entry.amount);
        expect(fromDecimal(entry.balanceAfter)).toBe(running_total);
    }
    expect(running_total).toBe(fromDecimal(survivor!.balance));

    const merged = await ledger.find({ accountId: b.id }).toArray();
    expect(merged.map((entry) => entry.kind).sort()).toEqual(["deposit", "merge_out"]);
    expect(merged.reduce((sum, entry) => sum + fromDecimal(entry.amount), 0n)).toBe(0n);
});

test("a database that still has wallet_unique and several accounts migrates", async () => {
    const running = await boot(async (db) => {
        await mongo.db(db).collection("accounts").createIndex({ wallet: 1 }, { unique: true, name: "wallet_unique" });
        for (const usdc of ["1", "0", "4"]) await seedAccount(db, newDid(), usdc);
    });

    const accounts = await collections(running).accounts.find().toArray();
    expect(accounts).toHaveLength(3);
    for (const account of accounts) expect(account).not.toHaveProperty("wallet");
    expect(running.server.services.database.migration).toEqual({ rekeyed: 3, merged: 0 });
});

/** Whether the winning plan for AccountService.find's query reads the person index. */
async function usesPersonIndex(running: Stack, privyUserId: string) {
    const plan = await collections(running)
        .accounts.find({ privyUserId }, { sort: { createdAt: 1, depositIndex: 1 } })
        .explain("queryPlanner");
    const text = JSON.stringify((plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
    return text.includes('"IXSCAN"') && text.includes('"privy_user_unique"');
}

test("a lookup by privyUserId uses the person index", async () => {
    const did = newDid();
    const running = await boot(async (db) => {
        await seedAccount(db, did, "1");
    });
    expect(await usesPersonIndex(running, did)).toBe(true);
});

test("a database that still has the old $type person index gets the new one", async () => {
    const did = newDid();
    const running = await boot(async (db) => {
        await mongo
            .db(db)
            .collection("accounts")
            .createIndex(
                { privyUserId: 1 },
                {
                    unique: true,
                    name: "privy_user_unique",
                    partialFilterExpression: { privyUserId: { $type: "string" } },
                },
            );
        await seedAccount(db, did, "1");
    });
    const index = (await collections(running).accounts.indexes()).find((i) => i.name === "privy_user_unique");
    expect(index?.partialFilterExpression).toEqual({ privyUserId: { $gt: "" } });
    expect(await usesPersonIndex(running, did)).toBe(true);
});

test("running the migration again changes nothing", async () => {
    const did = newDid();
    const running = await boot(async (db) => {
        await seedAccount(db, did, "3");
        await seedAccount(db, did, "2");
    });
    const { client, collections: all } = running.server.services.database;
    const before = await all.ledger.countDocuments();
    expect(before).toBe(4);

    expect(await mergeAccountsByPerson(client, all)).toEqual({ rekeyed: 0, merged: 0 });
    expect(await all.ledger.countDocuments()).toBe(before);
});

test("a merge cut short by a restart completes once", async () => {
    const did = newDid();
    const running = await boot(async (db) => {
        const a = await seedAccount(db, did, "3");
        const b = await seedAccount(db, did, "2");
        await seedAccount(db, did, "4");

        // What the first merge leaves behind when the process dies before the second.
        const database = mongo.db(db);
        const gone = await database.collection("accounts").findOneAndDelete({ _id: b.id });
        await database.collection("accounts").updateOne({ _id: a.id }, {
            $inc: { balance: gone!.balance, version: 1 },
            $addToSet: { formerDepositAddresses: b.address },
        } as never);
        const after = await database.collection("accounts").findOne({ _id: a.id });
        await database.collection("ledger").insertMany([
            {
                _id: new ObjectId(),
                accountId: b.id,
                kind: "merge_out",
                amount: toDecimal(-wei("2")),
                balanceAfter: toDecimal(0n),
                refId: b.id,
                createdAt: new Date(),
            },
            {
                _id: new ObjectId(),
                accountId: a.id,
                kind: "merge_in",
                amount: toDecimal(wei("2")),
                balanceAfter: after!.balance,
                refId: b.id,
                createdAt: new Date(),
            },
        ] as never);
        await database.collection("deposits").updateMany({ accountId: b.id }, { $set: { accountId: a.id } });
    });

    const { accounts, ledger } = collections(running);
    const left = await accounts.find({ privyUserId: did }).toArray();
    expect(left).toHaveLength(1);
    expect(fromDecimal(left[0]!.balance)).toBe(wei("9"));
    expect(left[0]!.formerDepositAddresses).toHaveLength(2);
    expect(running.server.services.database.migration.merged).toBe(1);
    expect(await ledger.countDocuments({ kind: "merge_in" })).toBe(2);
    expect(await ledger.countDocuments({ kind: "merge_out" })).toBe(2);
});

test("one person can't end up with two accounts", async () => {
    const did = newDid();
    const running = await boot(async (db) => {
        await seedAccount(db, did, "1");
    });
    const { accounts } = collections(running);
    const first = await accounts.findOne({ privyUserId: did });

    await expect(
        accounts.insertOne({
            ...first!,
            _id: new ObjectId(),
            depositIndex: nextIndex++,
            depositAddress: newAddress(),
            balance: Decimal128.fromString("0"),
        }),
    ).rejects.toMatchObject({ code: 11000 });
});

test("two first-time opens at once make one account", async () => {
    const running = await boot(async () => undefined);
    const user = await running.user();
    const [one, two] = await Promise.all([running.socket(user), running.socket(user)]);

    const [a, b] = await Promise.all([
        one.timeout(5000).emitWithAck("account:open", {}),
        two.timeout(5000).emitWithAck("account:open", {}),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.account.depositAddress).toBe(b.data.account.depositAddress);
    expect(await collections(running).accounts.countDocuments({ privyUserId: user.userId })).toBe(1);
});
