import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { PERP_FEE_E6 } from "../../src/perps/fee.ts";
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

/** A filled order posted but not yet settled: Hyperliquid applied it and its reply was dropped. */
async function postedFill(h: PerpHarness, account: Awaited<ReturnType<PerpHarness["seedAccount"]>>) {
    h.fake.nextOrder("drop");
    const { order } = await h.place(account);
    await h.until(async () => (await h.orderOf(order._id)).state === "posted" && !h.service.submitting(order._id));
    return h.orderOf(order._id);
}

test("a partial fill still pays the $1, and the master receives it with the unused collateral", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const masterBefore = h.fake.account(h.master)!.freeE6;

    // 0.003 BTC fills of the ordered 0.00759
    h.fake.nextOrder({ partial: "0.003" });
    const { order } = await h.place(account);
    const filled = await h.settled(order._id);
    const address = await h.addressOf(account._id);
    const row = (await h.database.collections.perpAccounts.findOne({ accountId: account._id }))!;
    const held = h.fake.account(address)!.positions[0]!;
    const credited = fromDecimal(filled.credited!) / 10n ** 12n;

    expect(filled.state).toBe("filled");
    expect(filled.steps.feeE6).toBe("1000000");
    expect(filled.steps.ourFeeE6).toBe("1000000");
    // Nothing is kept on the person's address: margin, Hyperliquid's fee, our fee and the credit add up to the collateral
    expect(row.retainedE6).toBeUndefined();
    expect(h.fake.account(address)!.freeE6).toBe(0n);
    expect(held.marginE6 + fromDecimal(filled.fill!.feeE6) + PERP_FEE_E6 + credited).toBe(e6("100"));
    // The master paid the collateral and the activation, and got the credit and the fee back
    expect(masterBefore - h.fake.account(h.master)!.freeE6).toBe(e6("100") + e6("1") - credited - PERP_FEE_E6);
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    expect(fromDecimal(position.ourFee!)).toBe(PERP_FEE_E6);
    expect(fromDecimal(position.collateral)).toBe(wei("100") - credited * 10n ** 12n);
});

test("an order that doesn't fill pays nothing", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const masterBefore = h.fake.account(h.master)!.freeE6;

    h.fake.nextOrder({ reject: "Order could not immediately match against any resting orders." });
    const { order } = await h.place(account);
    const rejected = await h.settled(order._id);

    expect(rejected.state).toBe("rejected");
    expect(rejected.steps.ourFeeE6).toBe("0");
    expect(fromDecimal(rejected.credited!)).toBe(wei("100"));
    expect((await h.state(account._id)).balance).toBe(wei("1000"));
    // Only the activation of the new address cost the master anything
    expect(masterBefore - h.fake.account(h.master)!.freeE6).toBe(e6("1"));
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
});

test("an order that never posted pays nothing", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    h.failing.add("updateLeverage");

    const { order } = await h.place(account);
    const unwound = await h.settled(order._id);

    expect(unwound.state).toBe("rejected");
    expect(unwound.steps.ourFeeE6).toBe("0");
    expect((await h.state(account._id)).balance).toBe(wei("1000"));
});

test("settlement charges the fee stored on the order when it was placed", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const posted = await postedFill(h, account);
    expect(posted.steps.feeE6).toBe("1000000");

    // An order placed under another fee keeps it
    await h.database.collections.perpOrders.updateOne({ _id: posted._id }, { $set: { "steps.feeE6": "2500000" } });
    await h.service.settlePosted(posted);

    const filled = await h.orderOf(posted._id);
    expect(filled.state).toBe("filled");
    expect(filled.steps.ourFeeE6).toBe("2500000");
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    expect(fromDecimal(position.ourFee!)).toBe(2_500_000n);
});

test("an order placed before the fee was stored owes none", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const posted = await postedFill(h, account);

    await h.database.collections.perpOrders.updateOne({ _id: posted._id }, { $unset: { "steps.feeE6": "" } });
    await h.service.settlePosted(posted);

    const filled = await h.orderOf(posted._id);
    expect(filled.state).toBe("filled");
    expect(filled.steps.ourFeeE6).toBe("0");
    expect(fromDecimal(filled.credited!) / 10n ** 12n).toBe(
        e6("100") -
            h.fake.account(await h.addressOf(account._id))!.positions[0]!.marginE6 -
            fromDecimal(filled.fill!.feeE6),
    );
});

test("when the address is short, the person is credited first and our fee takes the shortfall", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const posted = await postedFill(h, account);
    const address = await h.addressOf(account._id);
    const margin = h.fake.account(address)!.positions[0]!.marginE6;
    const free = h.fake.account(address)!.freeE6;

    // Half a dollar goes missing before the sweep
    h.fake.fund(address, -e6("0.5"));
    await h.service.settlePosted(posted);

    const filled = await h.orderOf(posted._id);
    expect(filled.state).toBe("filled");
    expect(BigInt(filled.steps.sweepE6 as string)).toBe(free - e6("0.5"));
    const credited = fromDecimal(filled.credited!) / 10n ** 12n;
    expect(credited).toBe(e6("100") - margin - fromDecimal(filled.fill!.feeE6) - PERP_FEE_E6);
    expect(BigInt(filled.steps.sweepE6 as string) - credited).toBe(e6("0.5"));
    expect(h.fake.account(address)!.freeE6).toBe(0n);
});

test("when the address is short and the first sweep is refused, the re-planned sweep still credits the person first", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const posted = await postedFill(h, account);
    const address = await h.addressOf(account._id);
    const margin = h.fake.account(address)!.positions[0]!.marginE6;
    const free = h.fake.account(address)!.freeE6;

    // Half a dollar goes missing before the sweep, and Hyperliquid refuses the first send of it
    h.fake.fund(address, -e6("0.5"));
    h.fake.nextUsdSend(1, "refuse");
    await h.service.settlePosted(posted);

    const filled = await h.orderOf(posted._id);
    expect(filled.state).toBe("filled");
    expect(BigInt(filled.steps.sweepE6 as string)).toBe(free - e6("0.5"));
    const credited = fromDecimal(filled.credited!) / 10n ** 12n;
    expect(credited).toBe(e6("100") - margin - fromDecimal(filled.fill!.feeE6) - PERP_FEE_E6);
    expect(BigInt(filled.steps.sweepE6 as string) - credited).toBe(e6("0.5"));
    expect(h.fake.account(address)!.freeE6).toBe(0n);
    // The refused send was re-planned, and the second went through
    expect(h.lines.some((line) => line.level === 40 && JSON.stringify(line).includes(posted._id.toHexString()))).toBe(
        true,
    );
});

test("a close after a fill finds nothing of ours to withhold from the credit", async () => {
    const h = await fresh();
    const account = await h.seedAccount("1000");
    const { order } = await h.place(account);
    await h.settled(order._id);
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;

    const { order: close } = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    const done = await h.settled(close._id);

    expect(done.state).toBe("done");
    expect(h.fake.account(await h.addressOf(account._id))!.freeE6).toBe(0n);
    // Everything the position held comes back but its two entry fees and the exit fee
    const credited = fromDecimal(done.credited!);
    expect(credited).toBeLessThan(fromDecimal(position.collateral) - PERP_FEE_E6 * 10n ** 12n);
    expect(credited).toBeGreaterThan(fromDecimal(position.collateral) - 2n * PERP_FEE_E6 * 10n ** 12n);
});
