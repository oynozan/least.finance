import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { afterEach, expect, test } from "vitest";
import type { AccountDoc, PerpOrderDoc, PerpPositionDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { AccountState, HyperliquidClient } from "../../src/perps/client.ts";
import { PerpTracker } from "../../src/perps/tracker.ts";
import { e6, perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

async function fresh() {
    const h = await perpHarness();
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    await h.fundMaster("500");
    return h;
}

const trackerOf = (h: PerpHarness, client: HyperliquidClient = h.client) =>
    new PerpTracker({
        service: h.service,
        client,
        collections: h.database.collections,
        config: h.config,
        logger: pino({ level: "silent" }),
        bus: h.bus,
    });

async function held(h: PerpHarness, account: AccountDoc) {
    const { order } = await h.place(account);
    await h.settled(order._id);
    return (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
}

const positionOf = (h: PerpHarness, id: ObjectId) =>
    h.database.collections.perpPositions.findOne({ _id: id }) as Promise<PerpPositionDoc>;

const closeOrders = (h: PerpHarness) =>
    h.database.collections.perpOrders.find({ kind: "close" }).toArray() as Promise<PerpOrderDoc[]>;

test("a liquidation settles: credits what is left (often none), marks liquidated, pushes 'Your BTC long was liquidated.'", async () => {
    const h = await fresh();
    const pushed: PerpOrderDoc[] = [];
    h.bus.on("perp:updated", ({ order }) => pushed.push(order));

    const none = await h.seedAccount("1000");
    const lost = await held(h, none);
    h.fake.liquidate(await h.addressOf(none._id), "BTC");
    await trackerOf(h).pass(Date.now());
    expect(await positionOf(h, lost._id)).toMatchObject({ state: "liquidated", active: false });
    expect((await h.state(none._id)).kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(pushed.some((o) => o.kind === "close" && o.reason === "Your BTC long was liquidated.")).toBe(true);
    expect(fromDecimal((await positionOf(h, lost._id)).proceeds!)).toBe(0n);

    const some = await h.seedAccount("1000");
    const left = await held(h, some);
    const address = await h.addressOf(some._id);
    h.fake.fund(address, e6("3"));
    h.fake.liquidate(address, "BTC");
    const before = h.fake.account(h.master)!.freeE6;
    const tracker = trackerOf(h);
    await tracker.pass(Date.now());
    await tracker.pass(Date.now() + 20_000);
    const s = await h.state(some._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund", "perp_close"]);
    expect(fromDecimal(s.rows[3]!.amount)).toBe(wei("3"));
    expect(h.fake.account(h.master)!.freeE6 - before).toBe(e6("3"));
    expect(await positionOf(h, left._id)).toMatchObject({ state: "liquidated" });
    expect(fromDecimal((await positionOf(h, left._id)).realizedPnl!)).toBe(
        (wei("3") - fromDecimal(left.collateral)) / 10n ** 12n,
    );
});

test("a position that vanishes with no liquidation fill is closed", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.liquidate(await h.addressOf(account._id), "BTC");
    const client = { ...h.client, fills: async () => [] } as HyperliquidClient;
    const tracker = trackerOf(h, client);
    await tracker.pass(Date.now());
    h.clock.at += 20_000;
    await tracker.pass(Date.now() + 20_000);

    expect(await positionOf(h, position._id)).toMatchObject({ state: "closed", active: false });
    const [order] = await closeOrders(h);
    expect(order!.reason).toBe("Your BTC long was closed.");
});

test("an order posted with a lost reply is settled from orderStatus by cloid", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder("drop");
    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "posted" && !h.service.submitting(order._id));
    expect((await h.orderOf(order._id)).state).toBe("posted");

    const tracker = trackerOf(h);
    await tracker.pass(Date.now());
    expect((await h.orderOf(order._id)).state).toBe("filled");
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;

    h.fake.nextOrder("drop");
    const { order: close } = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    await h.until(async () => (await h.orderOf(close._id)).state === "posted" && !h.service.submitting(close._id));
    await tracker.pass(Date.now() + 10_000);
    expect((await h.orderOf(close._id)).state).toBe("done");
    expect((await positionOf(h, position._id)).state).toBe("closed");
    expect((await h.state(account._id)).kinds.filter((k) => k === "perp_close")).toHaveLength(1);
});

test("fills are idempotent by tid", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const address = await h.addressOf(account._id);
    h.fake.fund(address, e6("2"));
    h.fake.liquidate(address, "BTC");
    const fills = await h.client.fills(address, 0);
    const state = await h.client.state(address);
    expect(fills.filter((f) => f.liquidation)).toHaveLength(1);

    await h.service.settleOutside(position, [...fills, ...fills], state);
    await h.service.settleOutside(position, fills, state);
    await h.service.settleOutside(await positionOf(h, position._id), fills, state);
    expect(await closeOrders(h)).toHaveLength(1);
    expect((await h.state(account._id)).kinds.filter((k) => k === "perp_close")).toHaveLength(1);
    expect((await positionOf(h, position._id)).state).toBe("liquidated");
});

test("the snapshot is written and only a non-mark change pushes", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const address = await h.addressOf(account._id);
    let funding = 0n;
    const client = {
        ...h.client,
        state: async (a: string) => {
            const state = await h.client.state(a);
            if (!state) return state;
            return { ...state, positions: state.positions.map((p) => ({ ...p, cumFundingE6: funding })) };
        },
    } as HyperliquidClient;
    const tracker = trackerOf(h, client);
    tracker.viewing(account._id, true);
    const pushes: PerpPositionDoc[] = [];
    h.bus.on("perp:updated", ({ position: p }) => p?.snapshot && pushes.push(p));
    const t = Date.now();

    await tracker.pass(t);
    let snap = (await positionOf(h, position._id)).snapshot!;
    expect(snap.markPx).toBe("65000");
    expect(snap.liquidationPx).not.toBeNull();
    expect(pushes).toHaveLength(1);

    h.fake.setMark("BTC", 66000);
    await h.markets.tick();
    await tracker.pass(t + 5_000);
    snap = (await positionOf(h, position._id)).snapshot!;
    expect(snap.markPx).toBe("66000");
    expect(fromDecimal(snap.unrealizedPnlE6)).toBeGreaterThan(0n);
    expect(pushes).toHaveLength(1);

    funding = 1_500_000n;
    await tracker.pass(t + 10_000);
    expect(pushes).toHaveLength(2);
    expect(fromDecimal((await positionOf(h, position._id)).snapshot!.cumFundingE6)).toBe(1_500_000n);
    expect(address).toBeTruthy();
});

/** Open positions on `size` made-up addresses, and a client that answers their reads from a canned state and counts them. */
async function crowdOf(h: PerpHarness, size: number) {
    const { perpAccounts, perpPositions } = h.database.collections;
    const at = new Date();
    for (let i = 0; i < size; i++) {
        const index = 10_000 + i;
        const accountId = new ObjectId();
        await perpAccounts.insertOne({
            _id: new ObjectId(),
            accountId,
            index,
            address: `0x${index.toString(16).padStart(40, "0")}`,
            activatedAt: at,
            createdAt: at,
        });
        await perpPositions.insertOne({
            _id: new ObjectId(),
            accountId,
            index,
            asset: "BTC",
            side: "long",
            leverage: 5,
            sizeCoin: "0.1",
            entryPx: "65000",
            collateral: toDecimal(wei("100")),
            openedFee: toDecimal(0n),
            state: "open",
            active: true,
            proceeds: null,
            realizedPnl: null,
            closeReason: null,
            openedAt: at,
            settledAt: null,
            updatedAt: at,
        });
    }
    let calls = 0;
    const canned: AccountState = {
        withdrawableE6: 0n,
        accountValueE6: 1n,
        positions: [
            {
                asset: "BTC",
                sizeCoin: "0.1",
                side: "long",
                entryPx: "65000",
                leverage: 5,
                liquidationPx: "50000",
                unrealizedPnlE6: 0n,
                cumFundingE6: 0n,
                marginUsedE6: 1n,
            },
        ],
    };
    const client = {
        ...h.client,
        state: async (address: string) => {
            if (!address.startsWith("0x000000000000000000000000000000000000")) return h.client.state(address);
            calls++;
            return canned;
        },
    } as HyperliquidClient;
    return { client, calls: () => calls };
}

test("a viewer's address is polled at 5 s and others stay inside the weight budget", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    await held(h, account);
    const viewer = await h.addressOf(account._id);
    let polls = 0;
    const watching = {
        ...h.client,
        state: async (address: string) => {
            if (address === viewer) polls++;
            return h.client.state(address);
        },
    } as HyperliquidClient;
    const tracker = trackerOf(h, watching);
    tracker.viewing(account._id, true);
    const t = Date.now();
    for (let s = 0; s <= 60; s++) await tracker.pass(t + s * 1000);
    expect(polls).toBeGreaterThanOrEqual(12);
    expect(polls).toBeLessThanOrEqual(13);

    const crowd = await crowdOf(h, 400);
    const rotation = trackerOf(h, crowd.client);
    for (let s = 0; s <= 180; s++) await rotation.pass(t + 100_000 + s * 1000);
    expect(crowd.calls() * 2).toBeLessThanOrEqual(600 * 3 + 120);
    expect(crowd.calls() * 2).toBeGreaterThan(600 * 3 * 0.8);
}, 60_000);

test("a crowd of open positions leaves budget to follow a posted order", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const crowd = await crowdOf(h, 100);
    const tracker = trackerOf(h, crowd.client);
    const t = Date.now();
    // Every pass has more addresses due than the refill pays for
    for (let s = 0; s <= 40; s++) await tracker.pass(t + s * 1000);

    h.fake.nextOrder("drop");
    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "posted" && !h.service.submitting(order._id));
    for (let s = 41; s <= 45; s++) await tracker.pass(t + s * 1000);

    expect((await h.orderOf(order._id)).state).toBe("filled");
}, 60_000);

test("stop() finishes within one timeout when a lookup hangs", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    await held(h, account);
    const tracker = trackerOf(h);
    tracker.viewing(account._id, true);
    h.crashAt("state", 1, "before");
    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await tracker.stop();
    expect(Date.now() - started).toBeLessThan(300);
});

test("an empty state with no reducing fill does not close a position until a second read agrees", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const address = await h.addressOf(account._id);
    h.fake.vanish(address, "BTC");
    const client = { ...h.client, fills: async () => [] } as HyperliquidClient;
    const tracker = trackerOf(h, client);

    await tracker.pass(Date.now());
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
    expect(await closeOrders(h)).toHaveLength(0);

    h.clock.at += 20_000;
    await tracker.pass(Date.now() + 20_000);
    expect(await positionOf(h, position._id)).toMatchObject({ state: "closed", active: false });

    const other = await h.seedAccount("1000");
    const back = await held(h, other);
    h.fake.vanish(await h.addressOf(other._id), "BTC");
    const closing = {
        tid: 1,
        oid: 1,
        cloid: null,
        asset: "BTC",
        sizeCoin: "0.01",
        px: "65000",
        feeE6: 0n,
        dir: "Close Long",
        liquidation: false,
        time: Date.now() + 60_000,
    };
    await trackerOf(h, { ...h.client, fills: async () => [closing] } as HyperliquidClient).pass(Date.now() + 40_000);
    expect(await positionOf(h, back._id)).toMatchObject({ state: "closed", active: false });
});
