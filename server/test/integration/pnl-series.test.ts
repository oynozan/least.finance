import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { formatUsdc } from "../../src/db/money.ts";
import { PnlService } from "../../src/pnl/pnl.ts";
import type { PnlPoint } from "../../src/protocol.ts";
import { seedRows } from "../support/history-seed.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const ago = (days: number) => new Date(NOW - days * DAY);

let database: Database;
let service: PnlService;
const lines: Array<{ msg: string; accountId?: string; ms?: number; rows?: Record<string, number> }> = [];

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    service = new PnlService({ collections: database.collections, logger, now: () => NOW });
});
afterAll(() => database.close());

const total = (points: PnlPoint[], key: "pnl" | "net") =>
    formatUsdc(points.reduce((sum, point) => sum + parseUnits(point[key], 18), 0n));
const logged = (id: ObjectId) =>
    lines.filter((line) => line.msg === "pnl.series" && line.accountId === id.toHexString());

test("the regression: old history is in the 7D and 30D starting balance and in All", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "deposit", usdc: "500", at: ago(500) },
        { kind: "prediction", state: "lost", cost: "100", openedAt: ago(401), settledAt: ago(400) },
        { kind: "perp", state: "liquidated", collateral: "40", proceeds: "0", openedAt: ago(201), settledAt: ago(200) },
        { kind: "perp", state: "closed", collateral: "50", proceeds: "80", openedAt: ago(51), settledAt: ago(50) },
        { kind: "deposit", usdc: "20", at: ago(10) },
    ]);

    const { ranges } = await service.series(id, "UTC", NOW);

    expect(ranges["7D"].points).toHaveLength(7);
    expect(ranges["7D"].points.map((point) => point.balance)).toEqual(Array(7).fill("410"));
    expect(ranges["30D"].points).toHaveLength(30);
    expect(ranges["30D"].points[0]!.balance).toBe("390");
    expect(ranges["30D"].points.at(-1)!.balance).toBe("410");
    expect(total(ranges["7D"].points, "pnl")).toBe("0");
    expect(total(ranges["30D"].points, "pnl")).toBe("0");
    expect(ranges.All.unit).toBe("week");
    expect(total(ranges.All.points, "pnl")).toBe("-110");
    expect(ranges.All.points.at(-1)!.balance).toBe("410");
});

test("a withdrawal in sending counts; a failed one does not; a Solana withdrawal in forwarding counts", async () => {
    const id = new ObjectId();
    const [, , solana] = await seedRows(database.collections, id, [
        { kind: "withdrawal", usdc: "10", at: ago(0), state: "sending" },
        { kind: "withdrawal", usdc: "7", at: ago(0), state: "failed" },
        { kind: "withdrawal", usdc: "3", at: ago(0), state: "forwarding" },
    ]);
    await database.collections.withdrawals.updateOne({ _id: solana! }, { $set: { network: "solana" } });

    const today = (await service.series(id, "UTC", NOW)).ranges["7D"].points.at(-1)!;

    expect(today.net).toBe("-13");
    expect(today.balance).toBe("-13");
    expect(today.pnl).toBe("0");
});

test("a lost prediction and a zero-proceeds liquidation show in pnl", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "prediction", state: "lost", cost: "12", openedAt: ago(3), settledAt: ago(1) },
        { kind: "perp", state: "liquidated", collateral: "30", proceeds: "0", openedAt: ago(3), settledAt: ago(2) },
    ]);

    const points = (await service.series(id, "UTC", NOW)).ranges["7D"].points;

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "0", "-30", "-12", "0"]);
    expect(points.map((point) => point.net)).toEqual(Array(7).fill("0"));
    expect(points.at(-1)!.balance).toBe("-42");
});

test("a won position is payout minus cost and a closed one proceeds minus cost", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "prediction", state: "won", cost: "10", payout: "25", openedAt: ago(5), settledAt: ago(1) },
        { kind: "prediction", state: "closed", cost: "10", proceeds: "4", openedAt: ago(5), settledAt: ago(2) },
        { kind: "perp", state: "closed", collateral: "20", proceeds: "26", openedAt: ago(5), settledAt: ago(3) },
    ]);

    const points = (await service.series(id, "UTC", NOW)).ranges["7D"].points;

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "6", "-6", "15", "0"]);
    expect(points.at(-1)!.balance).toBe("15");
});

test("a settled position without proceeds or payout counts them as 0", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "prediction", state: "closed", cost: "8", openedAt: ago(4), settledAt: ago(1) },
        { kind: "prediction", state: "won", cost: "5", openedAt: ago(4), settledAt: ago(2) },
    ]);
    await database.collections.positions.updateMany(
        { accountId: id },
        { $set: { proceeds: null, payout: null, settledAt: null, updatedAt: ago(2) } },
    );

    const points = (await service.series(id, "UTC", NOW)).ranges["7D"].points;

    expect(points[4]!.pnl).toBe("-13");
    expect(points.at(-1)!.balance).toBe("-13");
});

test("open and closing positions are not events", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "deposit", usdc: "100", at: ago(2) },
        { kind: "prediction", state: "open", cost: "50", openedAt: ago(1) },
        { kind: "prediction", state: "closing", cost: "40", openedAt: ago(1) },
        { kind: "perp", state: "open", collateral: "30", openedAt: ago(1) },
        { kind: "perp", state: "closing", collateral: "20", openedAt: ago(1) },
        { kind: "swap", at: ago(1) },
    ]);

    const { ranges } = await service.series(id, "UTC", NOW);

    expect(ranges["7D"].points.at(-1)!.balance).toBe("100");
    expect(total(ranges.All.points, "pnl")).toBe("0");
    expect(total(ranges.All.points, "net")).toBe("100");
});

test("a partial sale adds soldPart.proceeds minus soldPart.cost at soldPart.at", async () => {
    const id = new ObjectId();
    const [, , dropped] = await seedRows(database.collections, id, [
        { kind: "sale", cost: "6", proceeds: "5.76", at: ago(2) },
        { kind: "sale", cost: "4", proceeds: "5", at: ago(0) },
        { kind: "sale", cost: "9", proceeds: "1", at: ago(1) },
    ]);
    await database.collections.predictionOrders.updateOne({ _id: dropped! }, { $unset: { soldPart: "" } });

    const points = (await service.series(id, "UTC", NOW)).ranges["7D"].points;

    expect(points.map((point) => point.pnl)).toEqual(["0", "0", "0", "0", "-0.24", "0", "1"]);
    expect(points.at(-1)!.balance).toBe("0.76");
    expect(logged(id)[0]!.rows!.sales).toBe(2);
});

test("the figures are the same in every range today", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "deposit", usdc: "300", at: ago(120) },
        { kind: "prediction", state: "won", cost: "10", payout: "30", openedAt: ago(61), settledAt: ago(60) },
        { kind: "withdrawal", usdc: "25", at: ago(20), state: "sent" },
        { kind: "sale", cost: "6", proceeds: "5", at: ago(3) },
        { kind: "perp", state: "closed", collateral: "50", proceeds: "35", openedAt: ago(2), settledAt: ago(1) },
    ]);

    const { ranges } = await service.series(id, "UTC", NOW);

    const last = [ranges["7D"], ranges["30D"], ranges.All].map((range) => range.points.at(-1)!.balance);
    expect(last).toEqual(["279", "279", "279"]);
});

test("days are cut in the zone that was asked for", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "deposit", usdc: "9", at: new Date(Date.UTC(2026, 9, 13, 23, 30)) },
    ]);

    const utc = await service.series(id, "UTC", NOW);
    const tokyo = await service.series(id, "Asia/Tokyo", NOW);

    expect(utc.tz).toBe("UTC");
    expect(utc.ranges["7D"].points.map((point) => point.net).slice(-3)).toEqual(["0", "9", "0"]);
    expect(tokyo.tz).toBe("Asia/Tokyo");
    expect(tokyo.ranges["7D"].points.map((point) => point.net).slice(-3)).toEqual(["0", "0", "9"]);
});

test("concurrent identical requests share one run", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "deposit", usdc: "10", at: ago(30) },
        { kind: "deposit", usdc: "20", at: ago(20) },
        { kind: "withdrawal", usdc: "5", at: ago(10) },
        { kind: "prediction", state: "lost", cost: "3", openedAt: ago(9), settledAt: ago(8) },
        { kind: "sale", cost: "2", proceeds: "3", at: ago(7) },
        { kind: "perp", state: "closed", collateral: "4", proceeds: "5", openedAt: ago(6), settledAt: ago(5) },
    ]);

    const [first, second] = await Promise.all([service.series(id, "UTC", NOW), service.series(id, "UTC", NOW)]);

    expect(second).toEqual(first);
    expect(logged(id)).toHaveLength(1);
    const line = logged(id)[0]!;
    expect(typeof line.ms).toBe("number");
    expect(line.rows).toEqual({ deposits: 2, withdrawals: 1, positions: 1, sales: 1, perps: 1 });

    await service.series(id, "UTC", NOW);
    expect(logged(id)).toHaveLength(2);
});

test("a run that fails is not served to the next request", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [{ kind: "deposit", usdc: "10", at: ago(1) }]);
    const find = vi.spyOn(database.collections.deposits, "find").mockImplementationOnce(() => {
        throw new Error("db down");
    });
    try {
        const settled = await Promise.allSettled([service.series(id, "UTC", NOW), service.series(id, "UTC", NOW)]);

        expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(settled.map((result) => (result as PromiseRejectedResult).reason.message)).toEqual([
            "db down",
            "db down",
        ]);
        const again = await service.series(id, "UTC", NOW);
        expect(again.ranges["7D"].points.at(-1)!.balance).toBe("10");
    } finally {
        find.mockRestore();
    }
});

test("an event with zero net and zero pnl still sets where All starts", async () => {
    const id = new ObjectId();
    await seedRows(database.collections, id, [
        { kind: "perp", state: "closed", collateral: "5", proceeds: "5", openedAt: ago(101), settledAt: ago(100) },
        { kind: "deposit", usdc: "10", at: ago(0) },
    ]);

    const all = (await service.series(id, "UTC", NOW)).ranges.All;

    expect(all.unit).toBe("week");
    expect(all.points[0]!.start).toBe("2026-07-06");
    expect(all.points).toHaveLength(15);
    expect(total(all.points, "pnl")).toBe("0");
});

test("a zone Intl rejects answers in UTC", async () => {
    const id = new ObjectId();

    expect((await service.series(id, "Not/AZone", NOW)).tz).toBe("UTC");
    expect((await service.series(id, "", NOW)).tz).toBe("UTC");
});

test("no account rows give three ranges of zeros", async () => {
    const { tz, ranges } = await service.series(new ObjectId(), "UTC", NOW);

    expect(tz).toBe("UTC");
    expect(ranges["7D"].points).toHaveLength(7);
    expect(ranges["30D"].points).toHaveLength(30);
    expect(ranges.All.points).toHaveLength(7);
    for (const range of [ranges["7D"], ranges["30D"], ranges.All]) {
        expect(range.unit).toBe("day");
        for (const point of range.points) expect(point).toMatchObject({ balance: "0", pnl: "0", net: "0" });
    }
    expect(ranges["7D"].points.at(-1)!.start).toBe("2026-10-14");
});
