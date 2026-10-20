import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import type { PoolRebalanceDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { createLogger } from "../../src/logger.ts";
import { poolRebalanceRow } from "../support/pool-rebalance-row.ts";
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
    const warn = vi.spyOn(h.logger, "warn");
    const error = await h.service.place(account, input("10")).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("float_short");
    // The person is told the balance can't be read, not that predictions are limited to nothing
    expect(isAppError(error) && error.message).toBe(
        "Predictions are paused: we can't read our Polymarket balance right now. Try again in a few minutes. Nothing was spent.",
    );
    // The failed read is logged once, and the pool entering its unread state once with why the read failed; the refusal adds no line
    expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ message: "down" }), floatAgeSec: 181 }),
        "Couldn't read the pool's Polymarket balance",
    );
    expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
            state: "unread",
            readAt: expect.any(String),
            lastFloatError: { message: "down", agoSec: 0 },
        }),
        "Predictions are paused: the pool's Polymarket balance can't be read",
    );
    expect(warn.mock.calls.filter(([, message]) => String(message).startsWith("Refused a prediction"))).toEqual([]);
    expect(isAppError(error) && error.logged).toBe(true);
    expect((await h.state(account._id)).balance).toBe(wei("100"));
    expect((await pool(h)).held).toBe(0n);
});

test("a float that is short refuses with the limit and logs the numbers once", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    const warn = vi.spyOn(h.logger, "warn");
    const error = await h.service.place(account, input("80")).catch((e: unknown) => e);
    expect(isAppError(error) && error.message).toBe(
        "Predictions are limited to $50 right now. Try a smaller amount, or try again later. Nothing was spent.",
    );
    expect(warn.mock.calls.filter(([, message]) => String(message).startsWith("Refused a prediction"))).toEqual([
        [
            expect.objectContaining({ code: "float_short", askedUSD: "80", freeUSD: 50, heldUSD: 0 }),
            "Refused a prediction: the pool's float is short",
        ],
    ]);
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

const capture = () => {
    const lines: Array<{ level: number; msg: string; [key: string]: unknown }> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    return { lines, logger };
};
const warnings = (lines: ReturnType<typeof capture>["lines"]) =>
    lines.filter((line) => line.level === 40).map((line) => line.msg);
const drifts = (lines: ReturnType<typeof capture>["lines"]) =>
    lines.filter((line) => line.msg === "The pool's float holds drifted");
const reserve = (h: Harness, amountE6: bigint) =>
    h.ledger.runInTransaction((session) => h.service.reserveForMove(session, amountE6));
const release = (h: Harness, reservedE6: bigint, spentE6: bigint) =>
    h.ledger.runInTransaction((session) => h.service.releaseForMove(session, reservedE6, spentE6));
/** Starts a drain the way the rebalancer does: the submitting row and its reservation in one transaction. */
const startDrain = async (h: Harness, amountE6: bigint): Promise<PoolRebalanceDoc> => {
    const row: PoolRebalanceDoc = {
        ...poolRebalanceRow({ kind: "move", now: new Date() }),
        active: true,
        amountE6: toDecimal(amountE6),
        reservedE6: toDecimal(amountE6),
    };
    await h.ledger.runInTransaction(async (session) => {
        await h.database.collections.poolRebalances.insertOne(row, { session });
        await h.service.reserveForMove(session, amountE6);
    });
    return row;
};
/** Ends a drain the way the rebalancer does: the state change and the release in one transaction. */
const endDrain = (h: Harness, row: PoolRebalanceDoc, state: "forwarding" | "failed", spentE6: bigint) =>
    h.ledger.runInTransaction(async (session) => {
        const moved = await h.database.collections.poolRebalances.findOneAndUpdate(
            { _id: row._id, state: "submitting" },
            { $set: { state } },
            { session },
        );
        if (moved) await h.service.releaseForMove(session, fromDecimal(moved.reservedE6), spentE6);
    });

test("reserveForMove holds free float, and beyond it throws float_short with nothing held", async () => {
    const h = await fresh();
    await reserve(h, 30_000_000n);
    expect(await pool(h)).toEqual({ balance: 50_000_000n, held: 30_000_000n, unread: 0n });
    expect(h.service.maxOrderUSD()).toBe(20);

    const error = await reserve(h, 30_000_000n).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("float_short");
    expect(await pool(h)).toEqual({ balance: 50_000_000n, held: 30_000_000n, unread: 0n });

    await reserve(h, 20_000_000n);
    expect((await pool(h)).held).toBe(50_000_000n);
});

test("reserveForMove counts what orders already hold", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    park(h);
    await h.service.place(account, input("20"));

    expect(codeOf(await reserve(h, 40_000_000n).catch((e: unknown) => e))).toBe("float_short");
    expect((await pool(h)).held).toBe(20_000_000n);
    await reserve(h, 30_000_000n);
    expect((await pool(h)).held).toBe(50_000_000n);
});

test("a reservation in a transaction that aborts holds nothing", async () => {
    const h = await fresh();
    const aborted = h.ledger.runInTransaction(async (session) => {
        await h.service.reserveForMove(session, 20_000_000n);
        throw new Error("the row update failed");
    });
    await expect(aborted).rejects.toThrow("the row update failed");
    expect((await pool(h)).held).toBe(0n);
});

test("reserveForMove refuses a float read that is too old, with nothing held", async () => {
    const clock = { t: Date.now() };
    const h = await fresh({ now: () => clock.t });
    clock.t += 181_000;
    expect(codeOf(await reserve(h, 10_000_000n).catch((e: unknown) => e))).toBe("float_short");
    expect((await pool(h)).held).toBe(0n);
});

test("a move reserves only a positive amount and releases only non-negative ones", async () => {
    const h = await fresh();
    await expect(reserve(h, 0n)).rejects.toThrow("positive");
    await expect(reserve(h, -5_000_000n)).rejects.toThrow("positive");
    await reserve(h, 10_000_000n);
    await expect(release(h, -5_000_000n, 0n)).rejects.toThrow("negative");
    await expect(release(h, 10_000_000n, -5_000_000n)).rejects.toThrow("negative");
    expect(await pool(h)).toEqual({ balance: 50_000_000n, held: 10_000_000n, unread: 0n });
});

test("a release as spent adds to unreadFillsE6 and the next refreshFloat clears it, so free float does not jump back before the read", async () => {
    const h = await fresh();
    await reserve(h, 20_000_000n);
    await release(h, 20_000_000n, 20_000_000n);

    const after = await pool(h);
    expect(after).toEqual({ balance: 50_000_000n, held: 0n, unread: 20_000_000n });
    expect(after.balance - after.held - after.unread).toBe(30_000_000n);
    expect(h.service.maxOrderUSD()).toBe(30);

    h.trader.setBalance(30_000_000n);
    await h.service.refreshFloat();
    expect(await pool(h)).toEqual({ balance: 30_000_000n, held: 0n, unread: 0n });
    expect(h.service.maxOrderUSD()).toBe(30);
});

test("a release with nothing spent restores free float", async () => {
    const h = await fresh();
    await reserve(h, 20_000_000n);
    expect(h.service.maxOrderUSD()).toBe(30);
    await release(h, 20_000_000n, 0n);

    expect(await pool(h)).toEqual({ balance: 50_000_000n, held: 0n, unread: 0n });
    expect(h.service.maxOrderUSD()).toBe(50);
});

test("the drift check counts a submitting drain's reservation and does not repair it away", async () => {
    const { lines, logger } = capture();
    const h = await fresh({ logger });
    const drain = await startDrain(h, 20_000_000n);

    await h.service.refreshFloat();
    expect(drifts(lines)).toEqual([]);
    expect((await pool(h)).held).toBe(20_000_000n);

    // A reservation whose row has left submitting without a release is a real drift
    await h.database.collections.poolRebalances.updateOne({ _id: drain._id }, { $set: { state: "forwarding" } });
    await h.service.refreshFloat();
    expect(drifts(lines)).toEqual([expect.objectContaining({ heldE6: "20000000", expected: "0" })]);
    expect((await pool(h)).held).toBe(0n);
});

test("the drift check adds a drain's reservation to the open buys", async () => {
    const { lines, logger } = capture();
    const h = await fresh({ logger });
    const account = await h.seedAccount("100");
    park(h);
    await h.service.place(account, input("10"));
    await startDrain(h, 20_000_000n);

    await h.service.refreshFloat();
    expect(drifts(lines)).toEqual([]);
    expect((await pool(h)).held).toBe(30_000_000n);
});

test("the low alarm fires on free float: balance 100, held 80 warns low though the balance alone does not", async () => {
    const { lines, logger } = capture();
    const h = await fresh({ logger }, 100_000_000n);
    expect(warnings(lines)).toEqual([]);

    await startDrain(h, 80_000_000n);
    await h.service.refreshFloat();
    expect(warnings(lines)).toEqual(["The pool's Polymarket float is low"]);
    expect(lines.find((line) => line.level === 40)).toMatchObject({ freeUSD: 20, targetUSD: 100 });
    expect(drifts(lines)).toEqual([]);
});

test("the high alarm reads free float", async () => {
    const { lines, logger } = capture();
    const h = await fresh({ logger }, 100_000_000n);
    h.trader.setBalance(250_000_000n);

    // 250 in the pool but 70 held: free float is 180, under the 200% alarm
    const drain = await startDrain(h, 70_000_000n);
    await h.service.refreshFloat();
    expect(warnings(lines)).toEqual([]);

    await endDrain(h, drain, "failed", 0n);
    await h.service.refreshFloat();
    expect(warnings(lines)).toEqual(["The pool's Polymarket float is high"]);
    expect(lines.find((line) => line.level === 40)).toMatchObject({ freeUSD: 250, targetUSD: 100 });
});

test("the alarm bands follow the float target the harness is given", async () => {
    const { lines, logger } = capture();
    await fresh({ logger, floatUsd: 20 }, 10_000_000n);
    expect(warnings(lines)).toEqual([]);
    await fresh({ logger, floatUsd: 20 }, 4_000_000n);
    expect(warnings(lines)).toEqual(["The pool's Polymarket float is low"]);
});

test("a read that fails with a URL in its message logs no key, in the err or in lastFloatError", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger(
        { NODE_ENV: "production", LOG_LEVEL: "warn" },
        { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    const clock = { t: Date.now() };
    const h = await fresh({ now: () => clock.t, logger });
    vi.spyOn(h.trader, "balanceE6").mockRejectedValue(
        new Error("fetch failed for https://rpc.example.com/v2/SECRETKEY123"),
    );
    clock.t += 181_000;
    await h.service.refreshFloat().catch(() => undefined);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("SECRETKEY123");
    expect(
        lines.some((line) =>
            (line.lastFloatError as { message?: string } | undefined)?.message?.includes("rpc.example.com"),
        ),
    ).toBe(true);
});

test("the recovery line counts the outage from its first failed read, not the latest", async () => {
    const { lines, logger } = capture();
    const clock = { t: Date.now() };
    const h = await fresh({ now: () => clock.t, logger });
    const read = vi.spyOn(h.trader, "balanceE6").mockRejectedValue(new Error("down"));
    await h.service.refreshFloat().catch(() => undefined);
    clock.t += 900_000;
    await h.service.refreshFloat().catch(() => undefined);
    clock.t += 900_000;
    read.mockResolvedValue(50_000_000n);
    await h.service.refreshFloat();
    const back = lines.find((line) => line.msg === "The pool's Polymarket balance can be read again");
    expect(back?.downForSec).toBe(1800);
});
