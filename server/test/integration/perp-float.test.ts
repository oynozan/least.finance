import { afterEach, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

async function fresh(master: string) {
    const h = await perpHarness();
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    await h.fundMaster(master);
    return h;
}
const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    if (!isAppError(error)) throw new Error(`Expected an AppError, got ${String(error)}`);
    return { code: error.code, message: error.message };
};

test("short float refuses before any money moves, with 'Long and short are limited to $X right now. Nothing was spent.'", async () => {
    const h = await fresh("50");
    const account = await h.seedAccount("1000");

    expect(await failure(h.place(account))).toEqual({
        code: "float_short",
        message: "Long and short are limited to $48 right now. Try a smaller amount. Nothing was spent.",
    });
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
    expect(await h.heldE6()).toBe(0n);
    expect(h.fake.requests.filter((r) => r.startsWith("exchange"))).toEqual([]);
    expect(h.service.maxOrderUSD()).toBe(48);
});

test("the hold is released exactly once on fill, on reject and on recovery", async () => {
    const h = await fresh("500");
    const [a, b, c] = await Promise.all([h.seedAccount("1000"), h.seedAccount("1000"), h.seedAccount("1000")]);

    await h.settled((await h.place(a)).order._id);
    expect(await h.heldE6()).toBe(0n);

    h.fake.nextOrder({ reject: "Insufficient margin to place order." });
    await h.settled((await h.place(b)).order._id);
    expect(await h.heldE6()).toBe(0n);

    h.crashAt("usdSend", 1, "after");
    const stuck = (await h.place(c)).order;
    await h.until(async () => (await h.orderOf(stuck._id)).state === "funding" && h.crashed());
    expect(await h.heldE6()).toBe(wei("101") / 10n ** 12n);
    await h.build().recover();
    await h.settled(stuck._id);
    expect(await h.heldE6()).toBe(0n);
    expect(fromDecimal((await h.state(c._id)).rows[2]!.amount)).toBe(wei("100"));
});

test("a stale float read refuses", async () => {
    const h = await fresh("500");
    const account = await h.seedAccount("1000");
    h.clock.at += 200_000;
    h.failing.add("state");

    expect(await failure(h.place(account))).toEqual({
        code: "unavailable",
        message:
            "Hyperliquid's balance can't be read right now, so no new positions can open. Try again in a minute. Nothing was spent.",
    });
    // The refusal is logged once, with the numbers and the age of the last read
    const logged = h.lines.filter((line) => line.event === "perp.float.short");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 40, stale: true, requestedE6: "101000000", maxOrderUSD: 0 });
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
});

test("low and high float levels log a warning", async () => {
    const h = await fresh("200");
    const warnings = () => h.lines.filter((line) => line.level === 40).map((line) => line.msg);

    h.fake.reset();
    h.fake.fund(h.master, 40_000_000n);
    await h.service.refreshFloat();
    h.fake.fund(h.master, 500_000_000n);
    await h.service.refreshFloat();

    expect(warnings()).toEqual(["The Hyperliquid float is low", "The Hyperliquid float is high"]);
});
