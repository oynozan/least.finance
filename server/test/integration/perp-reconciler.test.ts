import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterEach, expect, test } from "vitest";
import type { PerpPositionDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { ourFeeOf } from "../../src/perps/math.ts";
import { PerpReconciler } from "../../src/perps/reconciler.ts";
import { e6, perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

async function fresh(o: Parameters<typeof perpHarness>[0] = {}) {
    const h = await perpHarness(o);
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    await h.fundMaster("500");
    return h;
}

/** A reconciler whose Arc side holds `arcUsdc` dollars; its log lines land in `h.lines` after the harness's own. */
function reconciler(h: PerpHarness, arcUsdc: string, tolerance = 5) {
    h.lines.length = 0;
    return new PerpReconciler({
        collections: h.database.collections,
        client: h.client,
        keyring: h.keyring,
        logger: pino({ level: "info" }, { write: (line: string) => void h.lines.push(JSON.parse(line)) }),
        config: { PERPS_RECONCILE_TOLERANCE_USD: tolerance },
        arcAssets: async () => wei(arcUsdc),
        withIndexLock: (index, fn) => h.service.withIndexLock(index, fn),
    });
}

const errors = (h: PerpHarness) => h.lines.filter((line) => line.level >= 50);

async function heldPosition(h: PerpHarness, collateralUSD = "100") {
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account, { collateralUSD });
    await h.settled(order._id);
    const position = (await h.database.collections.perpPositions.findOne({
        accountId: account._id,
    })) as PerpPositionDoc;
    return { account, position };
}

/** An idle Hyperliquid address of a person, holding `usdc` dollars. */
async function idleAddress(h: PerpHarness, usdc: string, index: number, retained = "0") {
    const address = h.keyring.perpAddressAt(index);
    await h.database.collections.perpAccounts.insertOne({
        _id: new ObjectId(),
        accountId: new ObjectId(),
        index,
        address,
        activatedAt: new Date(),
        retainedE6: toDecimal(e6(retained)),
        createdAt: new Date(),
    });
    h.fake.fund(address, e6(usdc));
    return address;
}

test("a size mismatch is logged and nothing changes", async () => {
    const h = await fresh();
    const { account, position } = await heldPosition(h);
    await h.database.collections.perpPositions.updateOne({ _id: position._id }, { $set: { sizeCoin: "9" } });
    const before = await h.state(account._id);

    const report = await reconciler(h, "100000").run();

    expect(report.mismatches).toBe(1);
    expect(errors(h)).toHaveLength(1);
    expect(errors(h)[0]!.msg).toMatch(/position/i);
    expect(await h.database.collections.perpPositions.findOne({ _id: position._id })).toMatchObject({
        sizeCoin: "9",
        state: "open",
        active: true,
    });
    expect((await h.state(account._id)).rows).toEqual(before.rows);
});

test("a stuck balance over $1 on an idle address is swept to the master and not credited", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const stuck = await idleAddress(h, "5", 77, "1.5");
    const small = await idleAddress(h, "0.5", 78);
    const masterBefore = h.masterFreeE6();

    const report = await reconciler(h, "100000").run();

    expect(report.swept).toBe(1);
    expect(h.fake.account(stuck)!.freeE6).toBe(e6("1.5"));
    expect(h.fake.account(small)!.freeE6).toBe(e6("0.5"));
    expect(h.masterFreeE6() - masterBefore).toBe(e6("3.5"));
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
    expect(await h.database.collections.ledger.countDocuments({ kind: { $regex: /^perp_/ } })).toBe(0);
    expect(h.lines.some((line) => line.level === 40 && /swept/i.test(line.msg))).toBe(true);
});

test("an order placed after the snapshot keeps its address from being swept", async () => {
    const h = await fresh();
    const stuck = await idleAddress(h, "5", 77);
    const client = {
        usdSend: h.client.usdSend.bind(h.client),
        state: async (address: string) => {
            const state = await h.client.state(address as never);
            if (address === stuck) {
                const now = new Date();
                await h.database.collections.perpOrders.insertOne({
                    _id: new ObjectId(),
                    accountId: new ObjectId(),
                    requestId: randomUUID(),
                    kind: "open",
                    index: 77,
                    asset: "BTC",
                    side: "long",
                    leverage: 5,
                    collateral: toDecimal(0n),
                    notionalE6: toDecimal(0n),
                    sizeCoin: "0",
                    cloid: "0x" + "0".repeat(32),
                    limitPx: "0",
                    state: "funding",
                    steps: {},
                    fill: null,
                    credited: null,
                    reason: null,
                    createdAt: now,
                    updatedAt: now,
                });
            }
            return state;
        },
    };
    const report = await new PerpReconciler({
        collections: h.database.collections,
        client,
        keyring: h.keyring,
        logger: pino({ level: "silent" }),
        config: { PERPS_RECONCILE_TOLERANCE_USD: 5 },
        arcAssets: async () => wei("100000"),
        withIndexLock: (index, fn) => h.service.withIndexLock(index, fn),
    }).run();

    expect(report.swept).toBe(0);
    expect(h.fake.account(stuck)!.freeE6).toBe(e6("5"));
});

test("our fee left on a closed address is retained, not swept and not owed", async () => {
    const h = await fresh({ feeBps: 100 });
    const { account, position } = await heldPosition(h);
    const { order } = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    await h.until(async () => ["done", "rejected"].includes((await h.orderOf(order._id)).state));
    const address = await h.addressOf(account._id);
    const kept = h.fake.account(address)!.freeE6;
    expect(kept).toBeGreaterThan(e6("1"));

    const report = await reconciler(h, "100000").run();

    const orders = await h.database.collections.perpOrders.find({ kind: "open", state: "filled" }).toArray();
    expect(report.ourFeeE6).toBe(orders.reduce((sum, o) => sum + ourFeeOf(fromDecimal(o.notionalE6), 0.01), 0n));
    expect(report.swept).toBe(0);
    expect(h.fake.account(address)!.freeE6).toBe(kept);
});

test("a solvency shortfall over the tolerance logs an error, one under it doesn't", async () => {
    const h = await fresh();
    await h.seedAccount("1000");

    // The master holds 500 and the people are owed 1000
    const over = await reconciler(h, "490").run();
    expect(over.shortfallE6).toBe(e6("10"));
    expect(errors(h)).toHaveLength(1);
    expect(errors(h)[0]!.msg).toMatch(/short/i);

    const under = await reconciler(h, "497").run();
    expect(under.shortfallE6).toBe(e6("3"));
    expect(errors(h)).toEqual([]);
});

test("a surplus logs nothing", async () => {
    const h = await fresh();
    await h.seedAccount("1000");

    const report = await reconciler(h, "800").run();

    expect(report.shortfallE6).toBe(0n);
    expect(h.lines.filter((line) => line.level >= 40)).toEqual([]);
});

test("in-flight rebalances count as assets", async () => {
    const h = await fresh();
    await h.seedAccount("1000");
    const row = (state: "sent" | "arrived") => ({
        _id: new ObjectId(),
        direction: "arc_to_hl" as const,
        amountE6: toDecimal(e6("20")),
        state,
        txHash: "0x01",
        createdAt: new Date(),
    });

    await h.database.collections.perpRebalances.insertOne(row("arrived"));
    expect((await reconciler(h, "480").run()).shortfallE6).toBe(e6("20"));
    expect(errors(h)).toHaveLength(1);

    await h.database.collections.perpRebalances.insertOne(row("sent"));
    expect((await reconciler(h, "480").run()).shortfallE6).toBe(0n);
    expect(errors(h)).toEqual([]);
});

test("the activation and fee totals are in the summary line", async () => {
    const h = await fresh({ feeBps: 100 });
    await heldPosition(h);

    const report = await reconciler(h, "100000").run();

    expect(report.activationE6).toBe(e6("1"));
    expect(report.ourFeeE6).toBeGreaterThan(0n);
    const line = h.lines.find((l) => l.level === 30 && /reconcil/i.test(l.msg)) as unknown as Record<string, unknown>;
    expect(line).toMatchObject({ activationE6: "1000000", ourFeeE6: report.ourFeeE6.toString() });
});

test("a Hyperliquid position with no active record is logged", async () => {
    const h = await fresh();
    const { position } = await heldPosition(h);
    await h.database.collections.perpPositions.updateOne(
        { _id: position._id },
        { $set: { active: false, state: "closed" } },
    );

    await reconciler(h, "100000").run();

    const found = errors(h).filter((line) => /no active record/i.test(line.msg));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ index: position.index, asset: "BTC" });
});

test("a rebalance sent over an hour ago is not counted and is logged", async () => {
    const h = await fresh();
    await h.seedAccount("1000");
    const row = (ageMs: number) => ({
        _id: new ObjectId(),
        direction: "arc_to_hl" as const,
        amountE6: toDecimal(e6("20")),
        state: "sent" as const,
        txHash: "0x01",
        createdAt: new Date(Date.now() - ageMs),
    });

    await h.database.collections.perpRebalances.insertOne(row(60_000));
    expect((await reconciler(h, "480").run()).shortfallE6).toBe(0n);

    await h.database.collections.perpRebalances.deleteMany({});
    await h.database.collections.perpRebalances.insertOne(row(2 * 3_600_000));
    expect((await reconciler(h, "480").run()).shortfallE6).toBe(e6("20"));
    expect(errors(h).some((line) => /sent.*hour|rebalance/i.test(line.msg))).toBe(true);
});

test("an open position's collateral is not counted as a surplus", async () => {
    const h = await fresh();
    await heldPosition(h);
    const owed = (await h.database.collections.accounts.find().toArray()).reduce(
        (sum, a) => sum + fromDecimal(a.balance) / 1_000_000_000_000n,
        0n,
    );
    const master = (await h.client.state(h.keyring.perpAddressAt(0)))!.accountValueE6;
    // The books are short by $50, which the person's $100 of collateral on Hyperliquid must not hide
    const arc = (owed - master - e6("50")) / 1_000_000n;

    const report = await reconciler(h, arc.toString()).run();

    expect(report.shortfallE6).toBe(e6("50"));
    expect(errors(h).some((line) => /short/i.test(line.msg))).toBe(true);
});
