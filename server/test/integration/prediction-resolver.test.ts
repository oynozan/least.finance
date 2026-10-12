import { ObjectId } from "mongodb";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AccountDoc, PositionDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { createPolymarketData } from "../../src/markets/polymarket-data.ts";
import { PredictionResolver } from "../../src/predictions/resolver.ts";
import { startFakePolymarket, type FakePolymarket } from "../support/fake-polymarket.ts";
import { EVENT, predictionHarness, wei } from "../support/prediction-harness.ts";

let h: Awaited<ReturnType<typeof predictionHarness>>;
let fake: FakePolymarket;
let resolver: PredictionResolver;
beforeAll(async () => {
    h = await predictionHarness();
    fake = await startFakePolymarket();
    resolver = new PredictionResolver({
        collections: h.database.collections,
        ledger: h.ledger,
        data: createPolymarketData({ gammaUrl: fake.url, clobUrl: fake.url }),
        bus: h.bus,
        logger: h.logger,
        resolveMs: 0,
    });
});
afterAll(async () => {
    await fake.stop();
    await h.database.close();
});

let next = 0;
/** A fresh market from the recording, so one test's resolution never reaches another's. */
function market() {
    const all = [...fake.fixtures.top, ...fake.fixtures.extra].flatMap((event) => event.markets);
    const raw = all[next++]!;
    const [yes, no] = JSON.parse(raw.clobTokenIds) as string[];
    return { id: String(raw.id), yes: yes!, no: no! };
}

async function holder(m: { id: string; yes: string; no: string }, o: { token?: "yes" | "no"; sharesE6?: bigint } = {}) {
    const account = await h.seedAccount("90");
    const now = new Date();
    const position: PositionDoc = {
        _id: new ObjectId(),
        accountId: account._id,
        eventId: EVENT,
        marketId: m.id,
        tokenId: o.token === "no" ? m.no : m.yes,
        conditionId: `0xcondition-${m.id}`,
        question: "Will it rain?",
        outcome: o.token === "no" ? "NO" : "YES",
        shares: toDecimal(o.sharesE6 ?? 20_000_000n),
        cost: toDecimal(wei("10")),
        state: "open",
        proceeds: null,
        payout: null,
        openedAt: now,
        settledAt: null,
        updatedAt: now,
    };
    await h.database.collections.positions.insertOne(position);
    return { account, position };
}

const positionOf = (id: ObjectId) => h.database.collections.positions.findOne({ _id: id });
const payoutRows = (account: AccountDoc) =>
    h.database.collections.ledger.find({ accountId: account._id, kind: "prediction_payout" }).toArray();

test("a win is paid shares × 1 and the position is won", async () => {
    const m = market();
    const { account, position } = await holder(m);
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();

    const won = (await positionOf(position._id))!;
    expect(won.state).toBe("won");
    expect(fromDecimal(won.payout!)).toBe(wei("20"));
    expect(won.settledAt).toBeInstanceOf(Date);
    const rows = await payoutRows(account);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refId.equals(position._id)).toBe(true);
    const s = await h.state(account._id);
    expect(s.balance).toBe(wei("110"));
    expect(s.sum).toBe(s.balance);
});

test("a loss writes no ledger row and the position is lost", async () => {
    const m = market();
    const { account, position } = await holder(m, { token: "no" });
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();

    const lost = (await positionOf(position._id))!;
    expect(lost.state).toBe("lost");
    expect(fromDecimal(lost.payout!)).toBe(0n);
    expect(await payoutRows(account)).toHaveLength(0);
    expect((await h.state(account._id)).balance).toBe(wei("90"));
});

test("a 50/50 pays half", async () => {
    const m = market();
    const { account, position } = await holder(m, { sharesE6: 12_345_678n });
    fake.resolve(m.id, ["0.5", "0.5"]);
    await resolver.tick();

    const won = (await positionOf(position._id))!;
    expect(won.state).toBe("won");
    // floor(12.345678 × 0.5) = 6.172839
    expect(fromDecimal(won.payout!)).toBe(6_172_839n * 10n ** 12n);
    expect((await h.state(account._id)).balance).toBe(wei("90") + 6_172_839n * 10n ** 12n);
});

test("two resolver passes pay once", async () => {
    const m = market();
    const { account, position } = await holder(m);
    fake.resolve(m.id, ["1", "0"]);
    await Promise.all([resolver.tick(), resolver.tick()]);
    await resolver.tick();

    expect(await payoutRows(account)).toHaveLength(1);
    expect((await h.state(account._id)).balance).toBe(wei("110"));
    expect((await positionOf(position._id))!.state).toBe("won");
});

test("a closing position is skipped, and paid on the next pass after its sale fails", async () => {
    const m = market();
    const { account, position } = await holder(m);
    await h.database.collections.positions.updateOne({ _id: position._id }, { $set: { state: "closing" } });
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();

    expect((await positionOf(position._id))!.state).toBe("closing");
    expect((await h.state(account._id)).balance).toBe(wei("90"));

    await h.database.collections.positions.updateOne({ _id: position._id }, { $set: { state: "open" } });
    await resolver.tick();
    expect((await positionOf(position._id))!.state).toBe("won");
    expect((await h.state(account._id)).balance).toBe(wei("110"));
});

test("an unresolved or merely closed market pays nothing", async () => {
    const open = market();
    const closed = market();
    const proposed = market();
    const a = await holder(open);
    const b = await holder(closed);
    const c = await holder(proposed);
    fake.resolve(closed.id, ["1", "0"], { uma: null });
    fake.resolve(proposed.id, ["1", "0"], { uma: "proposed" });
    await resolver.tick();

    for (const { account, position } of [a, b, c]) {
        expect((await positionOf(position._id))!.state).toBe("open");
        expect((await h.state(account._id)).balance).toBe(wei("90"));
    }
    expect(await h.database.collections.predictionRedemptions.countDocuments({ marketId: closed.id })).toBe(0);
});

test("position:settled is pushed with the new balance", async () => {
    const m = market();
    const { account, position } = await holder(m);
    const pushed: { position: PositionDoc; account: AccountDoc }[] = [];
    const listener = (u: { position: PositionDoc; account: AccountDoc }) => pushed.push(u);
    h.bus.on("position:settled", listener);
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();
    h.bus.off("position:settled", listener);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.position._id.equals(position._id)).toBe(true);
    expect(pushed[0]!.position.state).toBe("won");
    expect(fromDecimal(pushed[0]!.account.balance)).toBe(wei("110"));
    expect(pushed[0]!.account._id.equals(account._id)).toBe(true);
});

test("settling queues one redemption per condition", async () => {
    const m = market();
    await holder(m);
    await holder(m, { token: "no" });
    fake.resolve(m.id, ["1", "0"]);
    await resolver.tick();
    await resolver.tick();

    const rows = await h.database.collections.predictionRedemptions
        .find({ conditionId: `0xcondition-${m.id}` })
        .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ marketId: m.id, state: "pending", transactionId: null, attempts: 0 });
});
