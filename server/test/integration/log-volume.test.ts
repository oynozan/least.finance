import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import { createLogger } from "../../src/logger.ts";
import { startStack, type Stack } from "../support/stack.ts";

/** What production prints: the logger the server builds in production mode, at its default level, into a list. */
type Line = { level: number; msg: string; [key: string]: unknown };
const lines: Line[] = [];
const logger = createLogger(
    { NODE_ENV: "production", LOG_LEVEL: "warn" },
    { write: (line: string) => void lines.push(JSON.parse(line)) },
);

const TRADING_ENV = {
    PREDICTIONS_TRADING: "on",
    POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_BUILDER_API_KEY: "key",
    POLYMARKET_BUILDER_API_SECRET: "secret",
    POLYMARKET_BUILDER_API_PASSPHRASE: "passphrase",
    // Every background loop passes ten times a second or so, so seconds are hundreds of passes
    // The fake pool holds $1,000,000, so that is the float a healthy pool aims for
    POLYMARKET_FLOAT_USD: "1000000",
    DEPOSIT_POLL_MS: "100",
    PREDICTIONS_POLL_MS: "100",
    ORDER_POLL_MS: "100",
};

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), env: TRADING_ENV, logger });
});
afterAll(async () => {
    await stack?.stop();
});

const SKIPPED = "Polymarket markets failed our schema and were skipped";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (from: number) => lines.slice(from);
const texts = (list: Line[]) => list.map((line) => line.msg);

/** Asks the way a page open on the picker does: trending, health, charts. */
async function browse(times: number) {
    for (let i = 0; i < times; i++) {
        await Promise.all([
            fetch(`${stack.url}/markets/trending`),
            fetch(`${stack.url}/ready`),
            fetch(`${stack.url}/prices/history?range=7d`),
        ]);
    }
}

describe("log volume in production", () => {
    test("everything healthy writes nothing", async () => {
        await browse(20);
        await wait(2_500);
        await browse(20);
        // The recorded Polymarket events include a few markets our schema skips: that is one line for the whole list, however many syncs
        const unexpected = lines.filter((line) => line.msg !== SKIPPED);
        expect(texts(unexpected)).toEqual([]);
        expect(lines.length).toBeLessThanOrEqual(1);
        lines.length = 0;
    });

    test("an unreadable pool balance is one line however many passes and requests hit it, and one when it clears", async () => {
        const from = lines.length;
        const balance = vi.spyOn(stack.trader, "balanceE6").mockRejectedValue(new Error("clob 503"));
        try {
            for (let i = 0; i < 150; i++) {
                await stack.server.services.predictions.refreshFloat().catch(() => undefined);
                if (i % 10 === 0) await browse(1);
            }
            const during = since(from);
            expect(during.length).toBeGreaterThanOrEqual(1);
            expect(during.length).toBeLessThanOrEqual(3);
            expect(during[0]).toMatchObject({ level: 40, msg: "Couldn't read the pool's Polymarket balance" });
        } finally {
            balance.mockRestore();
        }
        const failing = lines.length;
        await stack.server.services.predictions.refreshFloat();
        await browse(5);
        expect(texts(since(failing))).toEqual(["The pool's Polymarket balance can be read again"]);
    });

    test("an RPC that stays down is a few lines for hundreds of scan passes, and one when it answers again", async () => {
        const from = lines.length;
        stack.emulator.failNext(1_000_000);
        await wait(6_000);
        stack.emulator.failNext(0);
        const during = since(from);
        expect(during.length).toBeGreaterThanOrEqual(1);
        expect(during.length).toBeLessThanOrEqual(4);
        expect(during.every((line) => line.level >= 40)).toBe(true);

        const failing = lines.length;
        await vi.waitFor(() => expect(texts(since(failing))).toContain("The deposit scan works again"), {
            timeout: 20_000,
        });
        await wait(1_000);
        expect(texts(since(failing)).filter((msg) => msg === "The deposit scan works again")).toHaveLength(1);
    }, 40_000);

    test("after all of that, healthy again writes nothing", async () => {
        await wait(1_500);
        const from = lines.length;
        await browse(10);
        await wait(2_000);
        expect(texts(since(from))).toEqual([]);
    });
});
