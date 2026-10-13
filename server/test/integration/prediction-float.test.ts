import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { EVENT, predictionHarness, TOKEN, until, wei } from "../support/prediction-harness.ts";

type Harness = Awaited<ReturnType<typeof predictionHarness>>;
const open: Harness[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(open.splice(0).map((h) => h.database.close()));
});

async function fresh(o: Parameters<typeof predictionHarness>[0] = {}, balanceE6 = 50_000_000n) {
    const h = await predictionHarness(o);
    open.push(h);
    h.trader.setBalance(balanceE6);
    await h.service.refreshFloat();
    return h;
}
const input = (amountUSD: string, requestId = randomUUID()) => ({
    requestId,
    eventId: EVENT,
    tokenId: TOKEN,
    amountUSD,
});
const pool = async (h: Harness) => {
    const doc = (await h.database.collections.poolFloat.findOne({ _id: "polygon" }))!;
    return {
        balance: fromDecimal(doc.balanceE6),
        held: fromDecimal(doc.heldE6),
        unread: fromDecimal(doc.unreadFillsE6),
    };
};
/** Leaves every post open at the exchange, so no order settles on its own. */
const park = (h: Harness) => vi.spyOn(h.trader, "post").mockResolvedValue({ kind: "delayed", orderId: "parked" });
const codeOf = (error: unknown) => (isAppError(error) ? error.code : null);
const posted = (h: Harness, requestId: string) =>
    until(async () => (await h.database.collections.predictionOrders.findOne({ requestId }))?.state === "posted");

test("concurrent orders can't reserve more than the float", async () => {
    const h = await fresh();
    const accounts = await Promise.all([1, 2, 3, 4, 5].map(() => h.seedAccount("100")));
    park(h);
    const results = await Promise.allSettled(accounts.map((a) => h.service.place(a, input("20"))));

    const won = results.flatMap((r, i) => (r.status === "fulfilled" ? [accounts[i]!] : []));
    const lost = results.flatMap((r, i) =>
        r.status === "rejected" ? [{ account: accounts[i]!, reason: r.reason }] : [],
    );
    expect(won).toHaveLength(2);
    expect(lost).toHaveLength(3);
    for (const { reason } of lost) expect(codeOf(reason)).toBe("float_short");
    expect((await pool(h)).held).toBe(40_000_000n);
    for (const { account } of lost) {
        expect(await h.database.collections.predictionOrders.countDocuments({ accountId: account._id })).toBe(0);
        const s = await h.state(account._id);
        expect(s.balance).toBe(wei("100"));
        expect(s.rows.map((r) => r.kind)).toEqual(["deposit"]);
    }
    for (const account of won) expect((await h.state(account._id)).balance).toBe(wei("80"));
});

test("a fail releases the reservation so the next order fits", async () => {
    const h = await fresh();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => h.seedAccount("100")));
    park(h);
    const first = await h.service.place(a!, input("20"));
    park(h);
    const second = await h.service.place(b!, input("20"));
    await Promise.all([posted(h, first.requestId), posted(h, second.requestId)]);
    expect(codeOf(await h.service.place(c!, input("20")).catch((e: unknown) => e))).toBe("float_short");

    const order = (await h.database.collections.predictionOrders.findOne({ requestId: first.requestId }))!;
    await h.service.fail(order, "rejected", "posted");
    expect((await pool(h)).held).toBe(20_000_000n);
    await h.service.fail(order, "rejected", "posted");
    expect((await pool(h)).held).toBe(20_000_000n);

    park(h);
    await h.service.place(c!, input("20"));
    expect((await pool(h)).held).toBe(40_000_000n);
});

test("a fill releases the hold and counts as unread until the balance is read", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    park(h);
    const view = await h.service.place(account, input("20"));
    await posted(h, view.requestId);
    expect((await pool(h)).held).toBe(20_000_000n);

    // Keeps the refresh the settle starts waiting on its balance read
    let readBalance!: (e6: bigint) => void;
    vi.spyOn(h.trader, "balanceE6").mockImplementationOnce(() => new Promise((resolve) => (readBalance = resolve)));
    const order = (await h.database.collections.predictionOrders.findOne({ requestId: view.requestId }))!;
    await h.service.settle(order, 10_000_000n, 20_000_000n);

    const after = await pool(h);
    expect(after).toEqual({ balance: 50_000_000n, held: 0n, unread: 10_000_000n });
    expect(after.balance - after.held - after.unread).toBe(40_000_000n);

    // The settle's refresh installs the mocked read in the background
    await until(async () => (readBalance as ((e6: bigint) => void) | undefined) !== undefined);
    readBalance(40_000_000n);
    await until(async () => (await pool(h)).unread === 0n);
    expect(await pool(h)).toEqual({ balance: 40_000_000n, held: 0n, unread: 0n });
});

test("a refresh racing a fill never offers the same pUSD twice", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    park(h);
    const view = await h.service.place(account, input("20"));
    await posted(h, view.requestId);

    // Every balance read waits until the test answers it
    const reads: ((e6: bigint) => void)[] = [];
    vi.spyOn(h.trader, "balanceE6").mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
    const refreshing = h.service.refreshFloat();
    await until(async () => reads.length === 1);
    const order = (await h.database.collections.predictionOrders.findOne({ requestId: view.requestId }))!;
    await h.service.settle(order, 10_000_000n, 20_000_000n);
    // The first read began before the fill, so it still shows the pool's old balance
    reads[0]!(50_000_000n);
    await refreshing;

    const after = await pool(h);
    expect(after.unread).toBe(10_000_000n);
    expect(after.balance - after.held - after.unread).toBe(40_000_000n);

    // The read the settle started saw the fill, so it clears it
    await until(async () => reads.length === 2);
    reads[1]!(40_000_000n);
    await until(async () => (await pool(h)).unread === 0n);
    expect(await pool(h)).toEqual({ balance: 40_000_000n, held: 0n, unread: 0n });
});

test("a retried requestId reserves once", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    const requestId = randomUUID();
    park(h);
    await Promise.all([
        h.service.place(account, input("20", requestId)),
        h.service.place(account, input("20", requestId)),
    ]);
    await h.service.place(account, input("20", requestId));
    expect((await pool(h)).held).toBe(20_000_000n);
});

test("an order that fails after the guard reserves nothing", async () => {
    const h = await fresh();
    const account = await h.seedAccount("5");
    const error = await h.service.place(account, input("10")).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("insufficient_funds");
    expect((await pool(h)).held).toBe(0n);
});

test("a stale balance refuses orders when it can't be read again", async () => {
    const clock = { t: Date.now() };
    const h = await fresh({ now: () => clock.t });
    const account = await h.seedAccount("100");
    clock.t += 181_000;
    vi.spyOn(h.trader, "balanceE6").mockRejectedValue(new Error("down"));
    const error = await h.service.place(account, input("10")).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("float_short");
    expect((await h.state(account._id)).balance).toBe(wei("100"));
    expect((await pool(h)).held).toBe(0n);
});

test("a stale balance is read again before an order", async () => {
    const clock = { t: Date.now() };
    const h = await fresh({ now: () => clock.t });
    const account = await h.seedAccount("100");
    clock.t += 181_000;
    const view = await h.service.place(account, input("10"));
    expect(view.state).toBe("placing");
});

test("drift in the holds is reported and repaired", async () => {
    const h = await fresh();
    const error = vi.spyOn(h.logger, "error");
    await h.database.collections.poolFloat.updateOne({ _id: "polygon" }, { $inc: { heldE6: 7_000_000 as never } });
    await h.service.refreshFloat();
    expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ heldE6: "7000000" }),
        "The pool's float holds drifted",
    );
    expect((await pool(h)).held).toBe(0n);
});

test("balance equals the sum of rows after concurrent float-limited orders", async () => {
    const h = await fresh();
    const accounts = await Promise.all([1, 2, 3, 4].map(() => h.seedAccount("100")));
    park(h);
    await Promise.allSettled(accounts.map((a) => h.service.place(a, input("20"))));
    for (const account of accounts) {
        const s = await h.state(account._id);
        expect(s.sum).toBe(s.balance);
    }
});
