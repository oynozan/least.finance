import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { fromDecimal } from "../../src/db/money.ts";
import { e6, perpHarness, type PerpHarness } from "../support/perp-harness.ts";

const open: PerpHarness[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
});

test("our fee is charged on the filled notional and a later PERPS_FEE_BPS change does not touch it", async () => {
    const h = await perpHarness({ feeBps: 10 });
    open.push(h);
    h.fake.setMark("BTC", 65000);
    await h.markets.tick();
    await h.fundMaster("500");
    const account = await h.seedAccount("1000");

    // 0.003 BTC fills of the ordered 0.0075: 195 USDC at 10 bps
    h.fake.nextOrder({ partial: "0.003" });
    const { order } = await h.place(account);
    const filled = await h.settled(order._id);
    const address = await h.addressOf(account._id);
    const row = async () => (await h.database.collections.perpAccounts.findOne({ accountId: account._id }))!;

    expect(filled.state).toBe("filled");
    expect(filled.steps.ourFeeE6).toBe("195000");
    expect(fromDecimal((await row()).retainedE6!)).toBe(195_000n);
    expect(h.fake.account(address)!.freeE6).toBe(195_000n);

    h.config.PERPS_FEE_BPS = 50;
    const position = (await h.database.collections.perpPositions.findOne({ accountId: account._id }))!;
    const { order: close } = await h.service.close(account, {
        requestId: randomUUID(),
        positionId: position._id.toHexString(),
    });
    await h.settled(close._id);

    expect(fromDecimal((await row()).retainedE6!)).toBe(195_000n);
    expect(h.fake.account(address)!.freeE6).toBe(195_000n);
    const credited = fromDecimal((await h.orderOf(close._id)).credited!);
    expect(credited).toBeGreaterThan(e6("30") * 10n ** 12n);
});
