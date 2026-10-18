import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { afterEach, expect, test, vi } from "vitest";
import type { AccountDoc, PerpPositionDoc } from "../../src/db/mongo.ts";
import { fromDecimal } from "../../src/db/money.ts";
import { PERP_FEE_E6 } from "../../src/perps/fee.ts";
import { isAppError } from "../../src/errors.ts";
import { e6, perpHarness, type PerpHarness } from "../support/perp-harness.ts";
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

test("a failing read while announcing a close is logged and does not take the process down", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const positions = h.database.collections.perpPositions;
    const read = positions.findOne.bind(positions) as (...args: unknown[]) => Promise<unknown>;
    let failed = false;
    // The announcing read is the first one without the account in its filter
    vi.spyOn(positions, "findOne").mockImplementation(((filter: { accountId?: unknown }, ...rest: unknown[]) => {
        if (failed || filter.accountId) return read(filter, ...rest);
        failed = true;
        return Promise.reject(new Error("Mongo is failing over"));
    }) as never);
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
        const { order } = await closeOf(h, account, position);
        expect((await finished(h, order._id)).state).toBe("done");
        await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
        process.off("unhandledRejection", note);
        vi.restoreAllMocks();
    }

    expect(failed).toBe(true);
    expect(unhandled).toEqual([]);
    expect(h.lines.some((line) => line.level === 40 && line.msg === "Couldn't announce a perp close")).toBe(true);
});

test("a close is limited 100 bps past the book's mid on a deep book, down for a long and up for a short, and reduce-only", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const long = await held(h, account);
    await finished(h, (await closeOf(h, account, long)).order._id);
    const short = await held(h, account, { asset: "ETH", side: "short" });
    await finished(h, (await closeOf(h, account, short)).order._id);

    const closes = h.fake.orders.filter((o) => o.reduceOnly);
    expect(closes).toMatchObject([
        { asset: "BTC", isBuy: false, px: "64350", sz: "0.00759" },
        { asset: "ETH", isBuy: true, px: "3030" },
    ]);
});

test("a close is limited from the book as it is when pressed, not from the mark", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.setBook("BTC", { bids: [{ price: 64290, size: 5 }], asks: [{ price: 64310, size: 5 }] });
    const { order } = await closeOf(h, account, position);
    await finished(h, order._id);

    // 100 bps under the mid of 64300
    expect(order.limitPx).toBe("63657");
    expect(h.fake.orders.filter((o) => o.reduceOnly)).toMatchObject([{ isBuy: false, px: "63657" }]);
});

test("a close on a book too thin for it still posts, at the widest limit, and closes", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.setBook("BTC", { bids: [{ price: 64993.5, size: 0.001 }], asks: [{ price: 65006.5, size: 0.001 }] });
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("done");
    expect(order.limitPx).toBe("61750");
    expect(h.fake.orders.filter((o) => o.reduceOnly)).toMatchObject([{ isBuy: false, px: "61750", sz: "0.00759" }]);
    expect((await positionOf(h, position._id)).state).toBe("closed");
});

test("a close whose book can't be read still posts, at the widest limit", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.failing.add("book");
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("done");
    expect(order.limitPx).toBe("61750");
    expect(
        h.lines.some((line) => line.level === 40 && line.msg.startsWith("Couldn't read a Hyperliquid book to close")),
    ).toBe(true);
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
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true, sizeCoin: "0.00459" });

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
    expect(done.reason).toBe(
        "Nobody on the book took your close at an acceptable price. Your position is still open. Try again in a moment.",
    );
    expect(done).toMatchObject({ code: "no_fill", detail: expect.stringContaining("immediately match") });
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
    // The reason stays on the position after the toast is gone
    expect((await h.service.positions(account)).positions[0]!.notice).toBe(done.reason);
    // Asking again can work, so the view doesn't block the Close button
    expect((await h.service.positions(account)).positions[0]!.closeBlocked).toBe(false);
    // Logged just after the order is stored as rejected
    await h.until(async () => h.lines.some((line) => line.event === "perp.close.refused"));
    const refused = h.lines.filter((line) => line.event === "perp.close.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
        level: 40,
        order: order._id.toHexString(),
        accountId: account._id.toHexString(),
        position: position._id.toHexString(),
        upstreamMessage: expect.stringContaining("immediately match"),
    });
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

test("a position in a market Hyperliquid has delisted isn't closed by the app, and stays open for the tracker to settle", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.delist("BTC");
    await h.markets.tick();

    const error = await closeOf(h, account, position).catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("unavailable");
    expect(await h.database.collections.perpOrders.countDocuments({ kind: "close" })).toBe(0);
    expect(h.fake.orders.filter((o) => o.reduceOnly)).toHaveLength(0);
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
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
    const tooSmall =
        "This position is under Hyperliquid's $10 minimum to close, so it can't be closed on its own. It stays open.";
    expect(done.reason).toBe(tooSmall);
    expect(done.detail).toBe("Order must have minimum value of $10.");
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open", active: true });
    expect((await h.service.positions(account)).positions[0]!.notice).toBe(tooSmall);
    // Closing it again can't work, so the view blocks the Close button
    expect((await h.service.positions(account)).positions[0]!.closeBlocked).toBe(true);
    await h.until(async () => h.lines.some((l) => l.level >= 50 && l.code === "too_small"));
});

test("a close finds our fee already with the master and credits everything left on the person's account", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const masterBefore = h.fake.account(h.master)!.freeE6;
    const position = await held(h, account);
    const address = await h.addressOf(account._id);
    const opened = (await h.database.collections.perpOrders.findOne({ accountId: account._id, kind: "open" }))!;
    const refund = fromDecimal(opened.credited!) / 10n ** 12n;
    // The master paid the collateral and the 1 USDC activation, and got the unused collateral and our fee back
    expect(h.fake.account(address)!.freeE6).toBe(0n);
    expect(masterBefore - h.fake.account(h.master)!.freeE6).toBe(e6("100") + e6("1") - refund - PERP_FEE_E6);

    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.state).toBe("done");
    expect(h.fake.account(address)!.freeE6).toBe(0n);
    expect(fromDecimal(done.credited!) + PERP_FEE_E6 * 10n ** 12n).toBeLessThanOrEqual(
        fromDecimal(position.collateral),
    );
});

test("a partial close says how much closed, keeps why, and is logged with the sizes", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.fake.nextOrder({ partial: "0.003" });
    const { order } = await closeOf(h, account, position);
    const done = await finished(h, order._id);

    expect(done.reason).toBe(
        "Closed 0.003 of 0.00759 BTC; the book was too thin for the rest. Press Close again for the rest.",
    );
    expect(done).toMatchObject({ code: "partial_close", detail: expect.stringContaining("filled 0.003 of 0.00759") });
    await h.until(async () => h.lines.some((line) => line.event === "perp.close.partial"));
    const logged = h.lines.filter((line) => line.event === "perp.close.partial");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
        order: order._id.toHexString(),
        accountId: account._id.toHexString(),
        closedSizeCoin: "0.003",
    });
});

test("a close of a position already closed says so, and is logged with the position", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    const { order } = await closeOf(h, account, position);
    await finished(h, order._id);

    const error = await closeOf(h, account, await positionOf(h, position._id)).catch((e: unknown) => e);
    expect(isAppError(error) && error.message).toBe("That position was already closed.");
    const logged = h.lines.filter((line) => line.event === "perp.close.refused" && line.reason === "closed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
        level: 40,
        accountId: account._id.toHexString(),
        position: position._id.toHexString(),
    });
});

test("a close during shutdown says the server is restarting and leaves the position open", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const position = await held(h, account);
    h.service.stopOrders();

    const error = await closeOf(h, account, position).catch((e: unknown) => e);
    expect(isAppError(error) && error.message).toBe(
        "The server is restarting. Your position is still open. Try again in a minute.",
    );
    expect(await positionOf(h, position._id)).toMatchObject({ state: "open" });
});
