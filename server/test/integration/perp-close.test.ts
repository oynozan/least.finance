import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { afterEach, expect, test } from "vitest";
import type { AccountDoc, PerpPositionDoc } from "../../src/db/mongo.ts";
import { fromDecimal } from "../../src/db/money.ts";
import { ourFeeOf } from "../../src/perps/math.ts";
import { isAppError } from "../../src/errors.ts";
import { perpHarness, type PerpHarness } from "../support/perp-harness.ts";
import { PerpTracker } from "../../src/perps/tracker.ts";
import { pino } from "pino";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

async function fresh(o: Parameters<typeof perpHarness>[0] = {}) {
    const h = await perpHarness(o);
    open.push(h);
    h.fake.setMark("BTC", 65000);
    h.fake.setMark("ETH", 3000);
    await h.markets.tick();
    await h.fundMaster("500");
    return h;
}

async function held(h: PerpHarness, account: AccountDoc, request: Parameters<PerpHarness["place"]>[1] = {}) {
    const { order } = await h.place(account, request);
    await h.settled(order._id);
    return (await h.database.collections.perpPositions.findOne({
        accountId: account._id,
        asset: request.asset ?? "BTC",
    }))!;
}

const closeOf = (h: PerpHarness, account: AccountDoc, position: PerpPositionDoc) =>
    h.service.close(account, { requestId: randomUUID(), positionId: position._id.toHexString() });

async function finished(h: PerpHarness, id: ObjectId) {
    await h.until(async () => ["done", "rejected"].includes((await h.orderOf(id)).state));
    return h.orderOf(id);
}

const positionOf = (h: PerpHarness, id: ObjectId) =>
    h.database.collections.perpPositions.findOne({ _id: id }) as Promise<PerpPositionDoc>;

test("a close sweeps then credits the swept amount once (perp_close), proceeds and realizedPnl = proceeds - collateral", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const before = h.fake.account(h.master)!.freeE6;
    const { order } = await closeOf(h, account, position);
    expect(order).toMatchObject({ kind: "close", state: "placing" });
    const done = await finished(h, order._id);

    expect(done.state).toBe("done");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund", "perp_close"]);
    const credit = fromDecimal(s.rows[3]!.amount);
    expect(credit).toBe(fromDecimal(done.credited!));
    expect((h.fake.account(h.master)!.freeE6 - before) * 10n ** 12n).toBe(credit);
    expect(s.sum).toBe(s.balance);

    const closed = await positionOf(h, position._id);
    expect(closed).toMatchObject({ state: "closed", active: false });
    expect(fromDecimal(closed.proceeds!)).toBe(credit);
    expect(fromDecimal(closed.realizedPnl!)).toBe((credit - fromDecimal(position.collateral)) / 10n ** 12n);
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    expect(h.fake.account(await h.addressOf(account._id))!.positions).toHaveLength(0);
});

test("the close limit is mark x 0.97 for a long and x 1.03 for a short and reduce-only", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const long = await held(h, account);
    await finished(h, (await closeOf(h, account, long)).order._id);
    const short = await held(h, account, { asset: "ETH", side: "short" });
    await finished(h, (await closeOf(h, account, short)).order._id);

    const closes = h.fake.orders.filter((o) => o.reduceOnly);
    expect(closes).toMatchObject([
        { asset: "BTC", isBuy: false, px: "63050", sz: "0.00767" },
        { asset: "ETH", isBuy: true, px: "3090" },
    ]);
});

test("a partial close leaves the position open and credits nothing", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.nextOrder({ partial: "0.003" });
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("done");
    expect(done.credited).toBeNull();
    expect(done.fill?.sizeCoin).toBe("0.003");
    expect((await h.state(account._id)).kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true, sizeCoin: "0.00467" });

    const again = await closeOf(h, account, await positionOf(h, position._id));
    expect((await finished(h, again.order._id)).state).toBe("done");
    expect((await h.state(account._id)).kinds).toContain("perp_close");
    expect((await positionOf(h, position._id)).state).toBe("closed");
});

test("a rejected close restores open", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.nextOrder({ reject: "Order could not immediately match against any resting orders." });
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("rejected");
    expect(done.reason).toBe("Couldn't close right now. Your position is still open.");
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
    expect((await h.state(account._id)).kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    const retry = await closeOf(h, account, position);
    expect((await finished(h, retry.order._id)).state).toBe("done");
});

test("a failed sweep credits nothing and leaves the order sweeping", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.failUsdSend(true);
    const { order } = await closeOf(h, account, position);
    await h.until(async () => (await h.orderOf(order._id)).state === "sweeping" && !h.service.submitting(order._id));

    expect((await h.state(account._id)).kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect((await positionOf(h, position._id)).state).toBe("closing");

    h.fake.failUsdSend(false);
    const tracker = new PerpTracker({
        service: h.service,
        client: h.client,
        collections: h.database.collections,
        config: h.config,
        logger: pino({ level: "silent" }),
        bus: h.bus,
    });
    await tracker.pass(Date.now());
    await tracker.pass(Date.now() + 10_000);
    expect((await h.orderOf(order._id)).state).toBe("done");
    expect((await h.state(account._id)).kinds.filter((k) => k === "perp_close")).toHaveLength(1);
    expect((await positionOf(h, position._id)).state).toBe("closed");
});

test("closing twice at once is one close", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const [a, b] = await Promise.all([closeOf(h, account, position), closeOf(h, account, position)]);
    expect(a.order._id.equals(b.order._id)).toBe(true);
    await finished(h, a.order._id);

    expect(await h.database.collections.perpOrders.countDocuments({ kind: "close" })).toBe(1);
    expect(h.fake.orders.filter((o) => o.reduceOnly)).toHaveLength(1);
    expect((await h.state(account._id)).kinds.filter((k) => k === "perp_close")).toHaveLength(1);
    const error = await closeOf(h, account, position).catch((e: unknown) => e);
    expect(isAppError(error)).toBe(true);
});

test("trading off still closes", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.config.PERPS_TRADING = "off";
    const { order } = await closeOf(h, account, position);
    expect((await finished(h, order._id)).state).toBe("done");
    expect((await positionOf(h, position._id)).state).toBe("closed");
});

test("an account with an open position merges and the survivor can close it from the position's own index", async () => {
    const h = await fresh();
    const survivor = await h.seedAccount("1000");
    const merged = await h.seedAccount("1000");
    await held(h, survivor, { asset: "ETH" });
    const position = await held(h, merged);
    const { perpAccounts, perpOrders, perpPositions } = h.database.collections;
    const own = (await perpAccounts.findOne({ accountId: merged._id }))!;
    for (const collection of [perpAccounts, perpOrders, perpPositions])
        await (collection as typeof perpOrders).updateMany(
            { accountId: merged._id },
            { $set: { accountId: survivor._id } },
        );
    expect((await perpAccounts.findOne({ accountId: survivor._id }, { sort: { index: 1 } }))!.index).toBeLessThan(
        own.index,
    );

    const { order } = await closeOf(h, survivor, position);
    expect((await finished(h, order._id)).state).toBe("done");
    expect(h.fake.orders.filter((o) => o.reduceOnly).map((o) => o.signer)).toEqual([own.address.toLowerCase()]);
    expect((await h.state(survivor._id)).kinds).toContain("perp_close");
    expect((await positionOf(h, position._id)).state).toBe("closed");
});

test("a position under $10 the fake refuses stays open with the too-small message and an error log", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.nextOrder({ reject: "Order must have minimum value of $10." });
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("rejected");
    expect(done.reason).toBe("Too small to close right now.");
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
    expect((await h.service.positions(account)).positions[0]!.notice).toBe("Too small to close right now.");
    await h.until(async () => h.lines.some((l) => l.level >= 50 && /too small/i.test(l.msg)));
});

test("a close leaves our fee on the person's Hyperliquid account and credits none of it", async () => {
    const h = await fresh({ feeBps: 100 });
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    console.log(
        "FREE AFTER OPEN",
        h.fake.account(await h.addressOf(account._id)),
        await h.database.collections.perpOrders.find({}).toArray(),
    );
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    const opened = (await h.database.collections.perpOrders.findOne({ accountId: account._id, kind: "open" }))!;
    const fee = ourFeeOf(fromDecimal(opened.notionalE6), 0.01);
    expect(fee).toBeGreaterThan(0n);
    const free = h.fake.account(await h.addressOf(account._id))!.freeE6;
    expect(done.state).toBe("done");
    expect(free).toBe(fee);
    expect(fromDecimal(done.credited!) + fee * 10n ** 12n).toBeLessThanOrEqual(fromDecimal(position.collateral));
});
