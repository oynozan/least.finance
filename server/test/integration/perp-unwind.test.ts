import { afterEach, expect, test } from "vitest";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a lock on one perp index runs its holders one at a time and leaves other indexes alone", async () => {
    const h = await fresh();
    const trail: string[] = [];
    const hold = (index: number, name: string) =>
        h.service.withIndexLock(index, async () => {
            trail.push(`${name} in`);
            await sleep(30);
            trail.push(`${name} out`);
            return name;
        });

    const results = await Promise.all([hold(1, "a"), hold(1, "b"), hold(2, "c")]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(trail.indexOf("a out")).toBeLessThan(trail.indexOf("b in"));
    expect(trail.indexOf("c in")).toBeLessThan(trail.indexOf("a out"));
    await expect(h.service.withIndexLock(1, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await h.service.withIndexLock(1, async () => "free again")).toBe("free again");
});

test("a funding usdSend that times out and lands after the read is credited once, never twice", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextUsdSend(1, { late: 900 });

    const { order } = await h.place(account);
    const done = await h.settled(order._id);
    await sleep(1200);

    expect(done.state).toBe("rejected");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(s.balance).toBe(wei("1000"));
    expect(s.sum).toBe(s.balance);
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    // The master is out only the activation Hyperliquid takes from a new address
    expect(h.fake.account(h.master)!.freeE6).toBe(e6("499"));
    expect(h.fake.usdSends.map((send) => send.amountE6)).toEqual([e6("100"), e6("100")]);
});

test("an unwind on a second asset never sweeps the first order's money", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder("hold");
    const first = await h.place(account, { asset: "BTC", collateralUSD: "100" });
    await h.until(
        async () => (await h.orderOf(first.order._id)).state === "posted" && !h.service.submitting(first.order._id),
    );
    const address = await h.addressOf(account._id);
    expect(h.fake.account(address)!.freeE6).toBe(e6("100"));

    h.fake.nextUsdSend(1, "lose");
    const second = await h.place(account, { asset: "ETH", collateralUSD: "50" });
    const done = await h.settled(second.order._id);

    expect(done.state).toBe("rejected");
    expect(h.fake.account(address)!.freeE6).toBe(e6("100"));
    expect((await h.orderOf(first.order._id)).state).toBe("posted");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_open", "perp_refund"]);
    expect(s.balance).toBe(wei("900"));
    expect(s.sum).toBe(s.balance);
});

test("a refused funding re-send waits for the original to land, then sweeps it back once", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextUsdSend(1, { late: 900 });
    h.fake.nextUsdSend(2, "refuse");

    const { order } = await h.place(account);
    await h.until(async () => !h.service.submitting(order._id));
    await sleep(1200);
    const address = await h.addressOf(account._id);

    expect((await h.orderOf(order._id)).state).toBe("funding");
    expect(h.fake.account(address)!.freeE6).toBe(e6("100"));

    h.clock.at += 61_000;
    await h.service.settleStuck(await h.orderOf(order._id));

    expect((await h.orderOf(order._id)).state).toBe("rejected");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(s.balance).toBe(wei("1000"));
    expect(s.sum).toBe(s.balance);
    expect(h.fake.account(address)!.freeE6).toBe(0n);
    expect(h.fake.account(h.master)!.freeE6).toBe(e6("499"));
});

test("a refused funding re-send with nothing in the ledger refunds in full once the original is old", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextUsdSend(1, "lose");
    h.fake.nextUsdSend(2, "refuse");

    const { order } = await h.place(account);
    await h.until(async () => !h.service.submitting(order._id));
    expect((await h.orderOf(order._id)).state).toBe("funding");

    h.clock.at += 61_000;
    h.fake.nextUsdSend(1, "refuse");
    await h.service.settleStuck(await h.orderOf(order._id));

    expect((await h.orderOf(order._id)).state).toBe("rejected");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(s.balance).toBe(wei("1000"));
    expect(h.fake.account(h.master)!.freeE6).toBe(e6("500"));
});

for (const source of ["sender", "amount"] as const) {
    test(`an unwind after a first funding that landed refunds the whole collateral and activates the address (activation from the ${source})`, async () => {
        const h = await fresh();
        h.fake.activationFrom(source);
        const account = await h.seedAccount("1000");
        h.failing.add("state");

        const { order } = await h.place(account);
        await h.until(async () => !h.service.submitting(order._id));
        const stuck = await h.orderOf(order._id);
        expect(stuck).toMatchObject({ state: "funding", steps: { funded: true } });
        h.failing.clear();
        await h.service.settleStuck(stuck);

        const done = await h.orderOf(order._id);
        expect(done.state).toBe("rejected");
        const s = await h.state(account._id);
        expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
        expect(s.balance).toBe(wei("1000"));
        expect(s.sum).toBe(s.balance);
        expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
        // The master is out only the activation Hyperliquid took
        expect(h.fake.account(h.master)!.freeE6).toBe(e6("499"));
        expect(await h.heldE6()).toBe(0n);

        const row = await h.database.collections.perpAccounts.findOne({ accountId: account._id });
        expect(row!.activatedAt).not.toBeNull();
        const next = await h.place(account, { collateralUSD: "50" });
        expect(next.order.steps.reservedE6).toBe(e6("50").toString());
    });
}
