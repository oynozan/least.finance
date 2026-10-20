import { pino } from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { toDecimal } from "../../src/db/money.ts";
import { poolRebalanceRow } from "../support/pool-rebalance-row.ts";
import { predictionHarness } from "../support/prediction-harness.ts";

type Harness = Awaited<ReturnType<typeof predictionHarness>>;
const open: Harness[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(open.splice(0).map((h) => h.database.close()));
});

const capture = () => {
    const lines: Array<{ level: number; msg: string; [key: string]: unknown }> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    return { lines, logger };
};
const warns = (lines: ReturnType<typeof capture>["lines"]) => lines.filter((line) => line.level >= 40);

async function make(balanceE6: bigint | null, o: Parameters<typeof predictionHarness>[0] = {}) {
    const h = await predictionHarness(o);
    open.push(h);
    if (balanceE6 !== null) {
        h.trader.setBalance(balanceE6);
        await h.service.refreshFloat();
    }
    return h;
}
const hold = async (h: Harness, amountE6: bigint) => {
    const row = {
        ...poolRebalanceRow({ kind: "move", now: new Date() }),
        active: true as const,
        amountE6: toDecimal(amountE6),
        reservedE6: toDecimal(amountE6),
    };
    await h.ledger.runInTransaction(async (session) => {
        await h.database.collections.poolRebalances.insertOne(row, { session });
        await h.service.reserveForMove(session, amountE6);
    });
};

const TEXT = {
    low: "Predictions are paused: our Polymarket balance is too low to place orders right now.",
    settling: "Predictions are paused while earlier orders settle. Try again in a minute.",
    unread: "Predictions are paused: we can't read our Polymarket balance right now. Try again in a few minutes.",
};

test("the pool is off while trading is off", async () => {
    const h = await make(50_000_000n, { trading: "off" });
    expect(h.service.pool()).toEqual({ state: "off" });
    expect(h.service.maxOrderUSD()).toBeNull();
});

test("the pool is open with a whole-dollar limit when the balance covers the floor", async () => {
    const h = await make(50_500_000n);
    expect(h.service.pool()).toEqual({ state: "open" });
    expect(h.service.maxOrderUSD()).toBe(50);
});

test("a balance under the $1 floor is low, whatever is held", async () => {
    const h = await make(900_000n);
    expect(h.service.pool()).toEqual({ state: "low", message: TEXT.low });
    expect(h.service.maxOrderUSD()).toBe(0);
});

test("a balance that held and unread fills bring under $1 is settling", async () => {
    const h = await make(5_000_000n);
    await hold(h, 4_500_000n);
    expect(h.service.pool()).toEqual({ state: "settling", message: TEXT.settling });
    expect(h.service.maxOrderUSD()).toBe(0);
});

test("a float never read, or read too long ago, is unread and not an open limit", async () => {
    const clock = { t: Date.now() };
    const never = await make(null);
    expect(never.service.pool()).toEqual({ state: "unread", message: TEXT.unread });
    expect(never.service.maxOrderUSD()).toBe(0);

    const h = await make(50_000_000n, { now: () => clock.t });
    expect(h.service.pool().state).toBe("open");
    clock.t += 181_000;
    expect(h.service.pool()).toEqual({ state: "unread", message: TEXT.unread });
    expect(h.service.maxOrderUSD()).toBe(0);
});

test("entering a paused state logs once with the numbers, and leaving it logs once", async () => {
    const { lines, logger } = capture();
    const h = await make(50_000_000n, { logger });
    expect(warns(lines)).toEqual([]);

    h.trader.setBalance(500_000n);
    await h.service.refreshFloat();
    for (let i = 0; i < 20; i++) {
        h.service.pool();
        h.service.maxOrderUSD();
        await h.service.refreshFloat();
    }
    const entered = warns(lines).filter((line) => String(line.msg).includes("paused"));
    expect(entered).toHaveLength(1);
    expect(entered[0]).toMatchObject({ state: "low", balanceUSD: 0.5, heldUSD: 0, unreadUSD: 0, freeUSD: 0.5 });
    expect(entered[0]!.readAt).toEqual(expect.any(String));

    h.trader.setBalance(60_000_000n);
    await h.service.refreshFloat();
    await h.service.refreshFloat();
    const after = warns(lines).filter((line) => String(line.msg).includes("open again"));
    expect(after).toHaveLength(1);
});

test("low, then unreadable, then low again logs each change, with the read error", async () => {
    const clock = { t: Date.now() };
    const { lines, logger } = capture();
    const h = await make(500_000n, { logger, now: () => clock.t });
    clock.t += 181_000;
    vi.spyOn(h.trader, "balanceE6").mockRejectedValue(new Error("clob 503"));
    await h.service.refreshFloat().catch(() => undefined);
    await h.service.refreshFloat().catch(() => undefined);
    vi.restoreAllMocks();
    await h.service.refreshFloat();

    const states = warns(lines)
        .filter((line) => typeof line.state === "string")
        .map((line) => line.state);
    expect(states).toEqual(["low", "unread", "low"]);
    const unread = warns(lines).find((line) => line.state === "unread")!;
    expect(unread.lastFloatError).toMatchObject({ message: "clob 503" });
});
