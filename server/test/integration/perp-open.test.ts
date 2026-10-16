import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { formatE6, fromDecimal } from "../../src/db/money.ts";
import { isAppError } from "../../src/errors.ts";
import { PERP_FEE_E6 } from "../../src/perps/fee.ts";
import { liquidationPrice } from "../../src/perps/math.ts";
import { e6, perpHarness, wei, type PerpHarness } from "../support/perp-harness.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

async function fresh(o: Parameters<typeof perpHarness>[0] = {}, master = "500") {
    const h = await perpHarness(o);
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    if (o.trading !== "off") await h.fundMaster(master);
    return h;
}
const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    if (!isAppError(error)) throw new Error(`Expected an AppError, got ${String(error)}`);
    return { code: error.code, message: error.message };
};

test("a fill debits, funds, records the real size and credits back the unused collateral", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(fromDecimal(s.rows[1]!.amount)).toBe(-wei("100"));
    const refund = fromDecimal(s.rows[2]!.amount);
    expect(refund).toBeGreaterThan(0n);
    expect(refund).toBeLessThan(wei("1"));
    expect(s.balance).toBe(wei("900") + refund);
    expect(s.sum).toBe(s.balance);

    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    const held = h.fake.account(await h.addressOf(account._id))!.positions[0]!;
    expect(position).toMatchObject({
        asset: "BTC",
        side: "long",
        leverage: 5,
        sizeCoin: "0.00759",
        entryPx: "65000",
        state: "open",
        active: true,
    });
    expect(Number(position.sizeCoin)).toBe(held.szi);
    expect(fromDecimal(position.collateral)).toBe(wei("100") - refund);
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    expect(await h.heldE6()).toBe(0n);
});

test("our $1 fee stays out of the credit after a fill", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    expect(done.steps.feeE6).toBe("1000000");
    expect(done.steps.ourFeeE6).toBe("1000000");
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    const held = fromDecimal(position.collateral) / 10n ** 12n;
    const marginE6 = h.fake.account(await h.addressOf(account._id))!.positions[0]!.marginE6;
    expect(held - BigInt(marginE6) - fromDecimal(done.fill!.feeE6)).toBe(PERP_FEE_E6);
    expect(fromDecimal(position.ourFee!)).toBe(PERP_FEE_E6);
    // The sidebar's view carries both fees the position already paid
    const view = (await h.service.positions(account)).positions[0]!;
    expect(view.feesUSD).toBe(formatE6(fromDecimal(done.fill!.feeE6) + PERP_FEE_E6));
});

test("a partial fill books the smaller size and returns the rest", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder({ partial: "0.003" });
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    expect(done.reason).toBe("Opened $195 of your $493.35. The rest is back in your balance.");
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    expect(position.sizeCoin).toBe("0.003");
    const s = await h.state(account._id);
    const refund = fromDecimal(s.rows[2]!.amount);
    expect(refund).toBeGreaterThan(wei("59"));
    expect(fromDecimal(position.collateral)).toBe(wei("100") - refund);
});

test("nothing filled is a full refund and the order is rejected with a reason", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder({ reject: "Order could not immediately match against any resting orders." });
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    expect(done.reason).toBe("The price moved, so your position didn't open. Nothing was spent.");
    const s = await h.state(account._id);
    expect(s.kinds).toEqual(["deposit", "perp_open", "perp_refund"]);
    expect(fromDecimal(s.rows[2]!.amount)).toBe(wei("100"));
    expect(s.balance).toBe(wei("1000"));
    expect(await h.database.collections.perpPositions.countDocuments()).toBe(0);
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    expect(await h.heldE6()).toBe(0n);
});

test("an error status refunds in full", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.nextOrder({ reject: "Insufficient margin to place order." });
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("rejected");
    expect(done.reason).toBe("This position couldn't be opened right now. Nothing was spent.");
    expect((await h.state(account._id)).balance).toBe(wei("1000"));
});

test("the first open for a person creates the perpAccounts row and pays the 1 USDC activation from the master; the second doesn't", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const before = h.fake.account(h.master)!.freeE6;
    const first = await h.settled((await h.place(account)).order._id);

    const row = (await h.database.collections.perpAccounts.findOne({ accountId: account._id }))!;
    expect(row.address).toBe(h.keyring.perpAddressAt(row.index));
    expect(row.activatedAt).not.toBeNull();
    const credited1 = fromDecimal(first.credited!) / 10n ** 12n;
    expect(before - h.fake.account(h.master)!.freeE6).toBe(e6("100") - credited1 - PERP_FEE_E6 + e6("1"));

    const middle = h.fake.account(h.master)!.freeE6;
    const second = await h.settled((await h.place(account, { asset: "ETH", collateralUSD: "50" })).order._id);
    expect(await h.database.collections.perpAccounts.countDocuments({ accountId: account._id })).toBe(1);
    const credited2 = fromDecimal(second.credited!) / 10n ** 12n;
    expect(middle - h.fake.account(h.master)!.freeE6).toBe(e6("50") - credited2 - PERP_FEE_E6);
});

test("a short balance after activation is topped up once, at most 1 USDC", async () => {
    const h = await fresh();
    h.fake.activationFrom("amount");
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    expect(h.fake.usdSends.slice(0, 2).map((send) => send.amountE6)).toEqual([e6("100"), e6("1")]);
    expect(h.fake.usdSends).toHaveLength(3);
    expect(await h.heldE6()).toBe(0n);
});

test("limit price is 50 bps from the book's mid on a deep book, rounded away, never the client's quote", async () => {
    const h = await fresh();
    const [a, b] = await Promise.all([h.seedAccount("1000"), h.seedAccount("1000")]);
    await h.service.quote({ asset: "BTC", side: "long", leverage: 5, collateralUSD: "100" });
    h.fake.setMark("BTC", 65100);
    await h.markets.tick();
    await h.settled((await h.place(a)).order._id);
    await h.settled((await h.place(b, { side: "short" })).order._id);

    // 65100 x 1.005 = 65425.5 up and x 0.995 = 64774.5 down
    expect(h.fake.orders.map((o) => ({ isBuy: o.isBuy, px: o.px, reduceOnly: o.reduceOnly }))).toEqual([
        { isBuy: true, px: "65426", reduceOnly: false },
        { isBuy: false, px: "64774", reduceOnly: false },
    ]);
});

test("the limit follows the book, not a mark that has drifted from it", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.fake.setBook("BTC", { bids: [{ price: 64690, size: 50 }], asks: [{ price: 64710, size: 50 }] });
    const { order } = await h.place(account, { side: "short" });
    await h.settled(order._id);

    // The mid is 64700, 0.46% under the mark: 50 bps under it is 64376.5
    expect(h.fake.orders[0]).toMatchObject({ isBuy: false, px: "64376" });
    expect((await h.orderOf(order._id)).limitPx).toBe("64376");
});

test("the quote's entry is what the book pays for the size", async () => {
    const h = await fresh();
    h.fake.setBook("BTC", {
        bids: [{ price: 64993.5, size: 5 }],
        asks: [
            { price: 65006.5, size: 0.004 },
            { price: 65260, size: 5 },
        ],
    });
    const view = await h.service.quote({ asset: "BTC", side: "long", leverage: 5, collateralUSD: "100" });

    expect(view.sizeCoin).toBe("0.00759");
    expect(Number(view.entryPx)).toBeCloseTo((0.004 * 65006.5 + 0.00359 * 65260) / 0.00759, 1);
});

test("a book too thin for the size refuses the quote and the order before anything is recorded or funded", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const thin = "This market is too thin for a position this size right now. Try a smaller amount.";
    // 0.00759 BTC wanted, 0.004 visible
    h.fake.setBook("BTC", { bids: [{ price: 64993.5, size: 5 }], asks: [{ price: 65006.5, size: 0.004 }] });
    const request = { asset: "BTC", side: "long", leverage: 5, collateralUSD: "100" } as const;

    expect(await refusal(h.service.quote(request))).toEqual({ code: "unavailable", message: thin });
    expect(await refusal(h.place(account))).toEqual({ code: "unavailable", message: thin });
    // The other side of the same book is deep
    expect((await h.service.quote({ ...request, side: "short" })).sizeCoin).toBe("0.00759");
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
    expect(h.fake.requests.filter((r) => r.startsWith("exchange"))).toEqual([]);
    expect(await h.heldE6()).toBe(0n);
});

test("a book that has the size only past the cap refuses too", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    // The last level is 3.8% above the mid, over the 300 bps cap
    h.fake.setBook("BTC", {
        bids: [{ price: 64993.5, size: 5 }],
        asks: [
            { price: 65006.5, size: 0.004 },
            { price: 67500, size: 50 },
        ],
    });
    expect((await refusal(h.place(account))).code).toBe("unavailable");
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
});

test("a book that can't be read refuses the order before anything is recorded or funded", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.failing.add("book");

    expect(await refusal(h.place(account))).toEqual({
        code: "unavailable",
        message: "Hyperliquid isn't answering. Nothing was spent.",
    });
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
    expect(h.fake.requests.filter((r) => r.startsWith("exchange"))).toEqual([]);
});

test("a book that thins after the order is accepted is posted at the widest limit and fills as it can", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    // Funding is still on its way, so this is the book the post will read
    h.fake.setBook("BTC", { bids: [{ price: 64993.5, size: 0.001 }], asks: [{ price: 65006.5, size: 0.001 }] });
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    // 300 bps over the mid of 65000
    expect(done.limitPx).toBe("66950");
    expect(h.fake.orders).toMatchObject([{ isBuy: true, px: "66950", sz: "0.00759" }]);
});

test("a book that can't be read once the order is funded still posts, at the widest limit, and fills", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    // Funding is still on its way, so this is the book the post will read
    h.failing.add("book");
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    // 300 bps over the mid of 65000
    expect(done.limitPx).toBe("66950");
    expect(h.fake.orders).toMatchObject([{ isBuy: true, px: "66950", sz: "0.00759" }]);
    expect(h.lines.some((line) => line.level === 40 && line.msg === "Couldn't read a Hyperliquid book to open")).toBe(
        true,
    );
    expect(await h.database.collections.perpPositions.countDocuments({ accountId: account._id })).toBe(1);
});

// The mark is 65000, so a book whose mid sits 1.5% under it is at 64025, and bids down to 62200 are 285 bps below that
const SUNKEN_BOOK = {
    bids: [
        { price: 64020, size: 0.00001 },
        { price: 62200, size: 5 },
    ],
    asks: [{ price: 64030, size: 5 }],
};

test("a short whose book sits 1.5% under the mark is refused when its limit is worth under $10, before anything is recorded or funded", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    // $12 at 1x is 0.00016 BTC, $10.40 at the mark; at the 3% cap under the book's mid its limit of 62104 is $9.94
    h.fake.setBook("BTC", SUNKEN_BOOK);
    const request = { asset: "BTC", side: "short", leverage: 1, collateralUSD: "12" } as const;
    const refused = {
        code: "below_minimum",
        message: "A position starts at $11. Raise the collateral or the leverage.",
    };

    expect(await refusal(h.service.quote(request))).toEqual(refused);
    expect(await refusal(h.place(account, request))).toEqual(refused);
    // The same size is worth more going long, and a deeper collateral lifts the short's limit over $10
    expect((await h.service.quote({ ...request, side: "long" })).sizeCoin).toBe("0.00016");
    expect((await h.service.quote({ ...request, collateralUSD: "13" })).sizeCoin).toBe("0.00018");
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
    expect(h.fake.requests.filter((r) => r.startsWith("exchange"))).toEqual([]);
    expect(await h.heldE6()).toBe(0n);
});

test("a short that becomes borderline once it is funded posts a limit worth $10 and fills", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account, { side: "short", leverage: 1, collateralUSD: "12" });
    // Funding is still on its way, so this is the book the post will read: its limit would be 62104, worth $9.94
    h.fake.setBook("BTC", SUNKEN_BOOK);
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    // $10.01 / 0.00016 is 62562.5, and BTC prices move in whole dollars
    expect(done.limitPx).toBe("62563");
    expect(h.fake.orders).toMatchObject([{ isBuy: false, px: "62563", sz: "0.00016" }]);
    expect(Number(h.fake.orders[0]!.px) * Number(h.fake.orders[0]!.sz)).toBeGreaterThanOrEqual(10.01);
});

test("leverage is set isolated before the order", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    await h.settled((await h.place(account, { leverage: 7 })).order._id);

    const exchange = h.fake.requests.filter((r) => r.startsWith("exchange"));
    expect(exchange.indexOf("exchange updateLeverage")).toBeGreaterThanOrEqual(0);
    expect(exchange.indexOf("exchange updateLeverage")).toBeLessThan(exchange.indexOf("exchange order"));
    expect(h.fake.account(await h.addressOf(account._id))!.positions[0]!.leverage).toBe(7);
});

test("a duplicate requestId is one order", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const requestId = randomUUID();
    const [one, two] = await Promise.all([h.place(account, { requestId }), h.place(account, { requestId })]);

    expect(one.order._id.equals(two.order._id)).toBe(true);
    await h.settled(one.order._id);
    expect((await h.state(account._id)).kinds.filter((k) => k === "perp_open")).toHaveLength(1);
    expect(h.fake.orders).toHaveLength(1);
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(1);
});

test("two concurrent opens cannot overdraw the balance", async () => {
    const h = await fresh();
    const account = await h.seedAccount("100");
    const results = await Promise.allSettled([h.place(account), h.place(account, { asset: "ETH" })]);

    const lost = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(isAppError(lost[0]!.reason) && lost[0]!.reason.code).toBe("insufficient_funds");
    const won = results.find((r) => r.status === "fulfilled")!;
    await h.settled(won.value.order._id);
    const s = await h.state(account._id);
    expect(s.sum).toBe(s.balance);
    expect(s.kinds.filter((k) => k === "perp_open")).toHaveLength(1);
});

test("two concurrent opens cannot overdraw the float", async () => {
    const h = await fresh({}, "150");
    const [a, b] = await Promise.all([h.seedAccount("1000"), h.seedAccount("1000")]);
    const results = await Promise.allSettled([h.place(a), h.place(b)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.findIndex((r) => r.status === "rejected");
    const loser = [a, b][lost]!;
    const rejection = (results[lost] as PromiseRejectedResult).reason;
    expect(isAppError(rejection) && rejection.code).toBe("float_short");
    expect((await h.state(loser._id)).kinds).toEqual(["deposit"]);
    expect(await h.database.collections.perpOrders.countDocuments({ accountId: loser._id })).toBe(0);
    const won = results.find((r) => r.status === "fulfilled")! as PromiseFulfilledResult<
        Awaited<ReturnType<PerpHarness["place"]>>
    >;
    await h.settled(won.value.order._id);
    expect(await h.heldE6()).toBe(0n);
});

test("a second position on the same asset is refused with 'You already hold a BTC position. Close it first.'", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    await h.settled((await h.place(account)).order._id);
    const before = await h.state(account._id);

    expect(await refusal(h.place(account))).toEqual({
        code: "position_busy",
        message: "You already hold a BTC position. Close it first.",
    });
    expect((await h.state(account._id)).balance).toBe(before.balance);
});

test("BTC at 25x is refused with 'BTC allows up to 20x.'", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    expect(await refusal(h.place(account, { leverage: 25 }))).toEqual({
        code: "bad_request",
        message: "BTC allows up to 20x.",
    });
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
});

test("collateral 9.99, and $10 and $11 at 1x, are refused with the two minimum messages", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    expect(await refusal(h.place(account, { collateralUSD: "9.99" }))).toEqual({
        code: "below_minimum",
        message: "Positions start at $10.",
    });
    expect(await refusal(h.place(account, { collateralUSD: "10", leverage: 1 }))).toEqual({
        code: "below_minimum",
        message: "A position starts at $11. Raise the collateral or the leverage.",
    });
    // The $1 fee comes off first, so $11 at 1x leaves a $10 position
    expect(await refusal(h.place(account, { collateralUSD: "11", leverage: 1 }))).toEqual({
        code: "below_minimum",
        message: "A position starts at $11. Raise the collateral or the leverage.",
    });
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
});

test("$12 at 1x opens a position of about $10.40, which Hyperliquid takes", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account, { collateralUSD: "12", leverage: 1 });
    const done = await h.settled(order._id);

    expect(done.state).toBe("filled");
    expect(done.sizeCoin).toBe("0.00016");
    expect(Number(fromDecimal(done.notionalE6)) / 1e6).toBeCloseTo(10.4, 2);
});

test("a coin whose size step leaves the position under the order minimum is refused, naming the step", async () => {
    const h = await fresh();
    // $12 at 1x is $11 of position; SOL's step of 0.01 at $200 rounds it down to $10
    h.fake.setMark("SOL", 200);
    await h.markets.tick();
    const account = await h.seedAccount("1000");

    expect(await refusal(h.place(account, { asset: "SOL", collateralUSD: "12", leverage: 1 }))).toEqual({
        code: "below_minimum",
        message: "SOL trades in steps of 0.01 (about $2). Raise the collateral or the leverage.",
    });
    expect(await refusal(h.service.quote({ asset: "SOL", side: "long", leverage: 1, collateralUSD: "12" }))).toEqual({
        code: "below_minimum",
        message: "SOL trades in steps of 0.01 (about $2). Raise the collateral or the leverage.",
    });
    expect(await h.database.collections.perpOrders.countDocuments()).toBe(0);
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
});

test("the fake Hyperliquid refuses an open worth under $10 and takes a reduce-only order of any size", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const order = (reduceOnly: boolean) => ({
        asset: "BTC",
        isBuy: true,
        px: "65650",
        sz: "0.00012",
        reduceOnly,
        cloid: `0x${"0".repeat(31)}${reduceOnly ? "1" : "2"}`,
    });
    await h.settled((await h.place(account)).order._id);
    const signer = h.keyring.perpSignerAt(1);

    // 0.00012 BTC is $7.80
    expect(await h.client.order(signer, order(false))).toMatchObject({
        kind: "rejected",
        message: expect.stringMatching(/minimum value of \$10/),
    });
    expect(
        await h.client.order(h.keyring.perpSignerAt(1), { ...order(true), isBuy: false, px: "64350" }),
    ).toMatchObject({
        kind: "filled",
    });
});

test("trading off refuses with 'Long and short aren't available right now.' and moves nothing", async () => {
    const h = await fresh({ trading: "off" });
    const account = await h.seedAccount("1000");
    expect(await refusal(h.place(account))).toEqual({
        code: "trading_off",
        message: "Long and short aren't available right now.",
    });
    expect((await h.state(account._id)).kinds).toEqual(["deposit"]);
    expect(h.fake.requests.filter((r) => r.startsWith("exchange"))).toEqual([]);
});

test("the quote's liquidation price matches liquidationPrice() for the same inputs", async () => {
    const h = await fresh();
    const view = await h.service.quote({ asset: "BTC", side: "long", leverage: 5, collateralUSD: "100" });

    expect(view.sizeCoin).toBe("0.00759");
    expect(view.ourFeeUSD).toBe("1");
    expect(view.fundingPerHour).toBe("0.0000125");
    const expected = liquidationPrice({
        side: "long",
        entry: Number(view.entryPx),
        sizeCoin: Number(view.sizeCoin),
        marginUSD: Number(view.marginUSD),
        notionalUSD: Number(view.notionalUSD),
        maxLeverage: 40,
    });
    expect(Math.abs(Number(view.liquidationPx) - expected)).toBeLessThan(0.5);
});
