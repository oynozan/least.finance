import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterEach, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
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
    h.fake.setMark("ETH", 3000);
    await h.markets.tick();
    await h.fundMaster("500");
    return h;
}

/** A tracker whose clock runs `ahead` ms in front, so orders look old. */
const trackerAhead = (h: PerpHarness, ahead: number) =>
    new PerpTracker({
        service: h.service,
        client: h.client,
        collections: h.database.collections,
        config: h.config,
        logger: pino({ level: "silent" }),
        bus: h.bus,
        now: () => Date.now() + ahead,
    });

test("an open whose unwind throws is settled by the tracker without a restart", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.failing.add("usdSend");
    h.failing.add("state");

    const { order } = await h.place(account);
    await h.until(async () => !h.service.submitting(order._id));
    expect((await h.orderOf(order._id)).state).toBe("funding");

    h.failing.clear();
    await trackerAhead(h, 0).pass(Date.now());
    expect((await h.orderOf(order._id)).state).toBe("funding");

    await trackerAhead(h, 61_000).pass(Date.now() + 61_000);

    expect((await h.orderOf(order._id)).state).toBe("rejected");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(s.balance).toBe(wei("1000"));
    expect(await h.heldE6()).toBe(0n);
});

test("a stuck funding order does not block a close on the same address forever", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const first = await h.place(account, { asset: "BTC", collateralUSD: "100" });
    await h.settled(first.order._id);
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;

    h.failing.add("usdSend");
    const stuck = await h.place(account, { asset: "ETH", collateralUSD: "50" });
    await h.until(async () => !h.service.submitting(stuck.order._id));
    h.failing.clear();

    const { order: close } = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    await h.until(async () => !h.service.submitting(close._id));
    expect((await h.orderOf(close._id)).state).toBe("posted");

    const tracker = trackerAhead(h, 61_000);
    await tracker.pass(Date.now() + 61_000);
    await tracker.pass(Date.now() + 71_000);

    expect((await h.orderOf(stuck.order._id)).state).toBe("rejected");
    expect((await h.orderOf(close._id)).state).toBe("done");
    const s = await h.state(account._id);
    expect(s.kinds.filter((k) => k === "perp_close")).toHaveLength(1);
    expect(s.kinds.filter((k) => k === "perp_open")).toHaveLength(2);
    expect(s.sum).toBe(s.balance);
});

test("a sweep Hyperliquid refuses is re-planned with a fresh nonce and the credit follows the new amount", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder({ partial: "0.003" });
    h.fake.nextUsdSend(2, "refuse");
    h.fake.nextUsdSend(3, "refuse");

    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "sweeping" && !h.service.submitting(order._id));
    const stuck = await h.orderOf(order._id);
    const address = await h.addressOf(account._id);
    const planned = BigInt(stuck.steps.sweepE6 as string);
    expect(planned).toBeGreaterThan(e6("40"));
    h.fake.fund(address, -e6("20"));
    const masterBefore = h.fake.account(h.master)!.freeE6;

    await h.service.retrySweep(stuck);

    const done = await h.orderOf(order._id);
    expect(done.state).toBe("filled");
    expect(done.steps.sweepNonce).not.toBe(stuck.steps.sweepNonce);
    const swept = BigInt(done.steps.sweepE6 as string);
    expect(swept).toBe(planned - e6("20"));
    expect(fromDecimal(done.credited!)).toBe(swept * 10n ** 12n);
    expect(h.fake.account(h.master)!.freeE6 - masterBefore).toBe(swept);
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(fromDecimal(s.rows[2]!.amount)).toBe(swept * 10n ** 12n);
    expect(h.lines.some((line) => line.level === 50 && JSON.stringify(line).includes(order._id.toHexString()))).toBe(
        true,
    );
});

test("a duplicate answer after a refused send with the same nonce is not taken as landed", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.refusalConsumesNonce(true);
    h.fake.nextOrder({ partial: "0.003" });
    h.fake.nextUsdSend(2, "refuse");
    h.fake.nextUsdSend(3, "refuse");

    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "sweeping" && !h.service.submitting(order._id));
    const stuck = await h.orderOf(order._id);
    const masterBefore = h.fake.account(h.master)!.freeE6;
    expect((await h.state(account._id)).kinds).toEqual(["deposit", "perp_open"]);

    // The stored nonce was used up by the refusal, so the repeat answers duplicate
    await h.service.retrySweep(stuck);

    const done = await h.orderOf(order._id);
    expect(done.state).toBe("filled");
    const swept = BigInt(done.steps.sweepE6 as string);
    expect(h.fake.account(h.master)!.freeE6 - masterBefore).toBe(swept);
    expect(fromDecimal(done.credited!)).toBe(swept * 10n ** 12n);
    const toMaster = h.fake.usdSends.filter((send) => send.to === h.master);
    expect(toMaster).toHaveLength(1);
    expect(toMaster[0]!.amountE6).toBe(swept);
});

test("an order missing on the first lookup stays posted until its expiry, then settles from fills", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder("drop");
    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "posted" && !h.service.submitting(order._id));
    h.fake.hideOrderStatus(true);
    const posted = await h.orderOf(order._id);
    const expiresAt = posted.steps.expiresAt as Date;
    expect(h.fake.orders[0]!.expiresAfter).toBe(expiresAt.getTime());
    expect(expiresAt.getTime() - (posted.steps.postedAt as Date).getTime()).toBe(30_000);

    await h.service.settlePosted(posted);
    expect((await h.orderOf(order._id)).state).toBe("posted");
    h.clock.at += 34_000;
    await h.service.settlePosted(posted);
    expect((await h.orderOf(order._id)).state).toBe("posted");

    h.clock.at += 2_000;
    await h.service.settlePosted(posted);
    const done = await h.orderOf(order._id);
    expect(done.state).toBe("filled");
    expect(await h.database.collections.perpPositions.countDocuments({ accountId: account._id })).toBe(1);
    expect(h.fake.account(await h.addressOf(account._id))!.positions).toHaveLength(1);
    const s = await h.state(account._id);
    expect(s.sum).toBe(s.balance);
    expect(s.balance).toBeLessThan(wei("1000"));
});

test("an order the exchange refuses after its expiry is not placed", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.clock.at -= 120_000;

    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    expect(h.fake.account(await h.addressOf(account._id))!.positions).toHaveLength(0);
    expect((await h.state(account._id)).balance).toBe(wei("1000"));
});
