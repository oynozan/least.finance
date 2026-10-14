import { afterEach, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";

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

/** Exactly one open, at most one refund, the hold gone and the books balanced. */
async function expectSettledOnce(h: PerpHarness, accountId: Parameters<PerpHarness["state"]>[0]) {
    const s = await h.state(accountId);
    expect(s.kinds.filter((k) => k === "perp_open")).toHaveLength(1);
    expect(s.kinds.filter((k) => k === "perp_refund").length).toBeLessThanOrEqual(1);
    expect(s.sum).toBe(s.balance);
    expect(await h.heldE6()).toBe(0n);
    return s;
}

test("after the debit", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.crashAt("usdSend", 1, "before");
    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "funding" && h.crashed());

    await h.build().recover();
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    const s = await expectSettledOnce(h, account._id);
    expect(s.balance).toBe(wei("1000"));
    // The unsent funding is made certain by sending it with its stored nonce, then swept back
    expect(h.fake.usdSends.map((send) => send.to)).toEqual([await h.addressOf(account._id), h.master]);
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
});

test("after the transfer", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.crashAt("usdSend", 1, "after");
    const { order } = await h.place(account);
    await h.until(async () => h.fake.usdSends.length === 1);

    await h.build().recover();
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    const s = await expectSettledOnce(h, account._id);
    expect(s.balance).toBe(wei("1000"));
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    expect(h.fake.usdSends.map((send) => send.to)).toEqual([await h.addressOf(account._id), h.master]);
});

test("after posting with no reply", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder("drop");
    const { order } = await h.place(account);
    await h.until(async () => h.fake.orders.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await h.orderOf(order._id)).state).toBe("posted");

    const successor = h.build();
    await successor.recover();
    await successor.recover();
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    const s = await expectSettledOnce(h, account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(await h.database.collections.perpPositions.countDocuments({ accountId: account._id })).toBe(1);
    expect(h.fake.orders).toHaveLength(1);
});

test("during the sweep", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.crashAt("usdSend", 2, "after");
    const { order } = await h.place(account);
    await h.until(async () => h.fake.usdSends.length === 2);
    await h.until(async () => (await h.orderOf(order._id)).state === "sweeping");
    const stored = (await h.orderOf(order._id)).steps.sweepNonce;

    await h.build().recover();
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    expect(done.steps.sweepNonce).toBe(stored);
    const s = await expectSettledOnce(h, account._id);
    expect(h.fake.usdSends).toHaveLength(2);
    expect(fromDecimal(s.rows[2]!.amount)).toBeGreaterThan(0n);
    expect(await h.database.collections.perpPositions.countDocuments({ accountId: account._id })).toBe(1);
});

test("Hyperliquid not answering to the transfer refunds with 'Hyperliquid isn't answering. Nothing was spent.'", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.failUsdSend(true);
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    expect(done.reason).toBe("Hyperliquid isn't answering. Nothing was spent.");
    const s = await expectSettledOnce(h, account._id);
    expect(s.balance).toBe(wei("1000"));
    expect(h.fake.orders).toHaveLength(0);
});
