import { pino } from "pino";
import { expect, test } from "vitest";
import { LifiError } from "../../src/swaps/lifi.ts";
import { NATIVE_EVM } from "../../src/swaps/coins.ts";
import { SwapCatalog } from "../../src/swaps/catalog.ts";

const eth = { chainId: 1, address: NATIVE_EVM, symbol: "ETH", decimals: 18, priceUSD: 2500 };

function setup() {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    let clock = 1_000_000;
    let reading = true;
    const catalog = new SwapCatalog({
        lifi: {
            tokens: async () => {
                if (!reading) throw new Error("LI.FI is down");
                return [eth];
            },
        },
        logger,
        syncMs: 60_000,
        now: () => clock,
    });
    return {
        catalog,
        lines,
        advance: (ms: number) => (clock += ms),
        reading: (on: boolean) => (reading = on),
    };
}

test("a coin with no price says why: never read, stale, listed without a price, or not a swap coin", async () => {
    const { catalog, advance, reading } = setup();
    expect(catalog.priceStatus("ETH")).toEqual({ reason: "never_read", ageMs: null });

    await catalog.tick();
    expect(catalog.priceStatus("ETH")).toMatchObject({ reason: null, price: 2500, ageMs: 0 });
    expect(catalog.priceStatus("BTC")).toMatchObject({ reason: "no_price" });
    expect(catalog.priceStatus("NOPE")).toMatchObject({ reason: "not_listed" });

    reading(false);
    advance(4 * 60_000);
    expect(catalog.priceStatus("ETH")).toEqual({ reason: "stale", ageMs: 4 * 60_000 });
});

test("a failed read is logged with how old the prices are, then once as an error when they go stale, then once when they recover", async () => {
    const { catalog, lines, advance, reading } = setup();
    await catalog.tick();
    reading(false);

    advance(60_000);
    await catalog.tick();
    expect(lines.at(-1)).toMatchObject({
        level: 40,
        event: "swap-catalog:sync",
        consecutiveFailures: 1,
        ageMs: 60_000,
        staleInMs: 120_000,
        msg: "Couldn't read LI.FI's token list",
    });
    expect((lines.at(-1) as { err: { message: string } }).err.message).toBe("LI.FI is down");

    advance(3 * 60_000);
    await catalog.tick();
    expect(lines.at(-1)).toMatchObject({
        level: 50,
        consecutiveFailures: 2,
        msg: "Swap prices are stale: LI.FI's token list is unread, trades are refused",
    });

    advance(60_000);
    await catalog.tick();
    expect(lines.at(-1)).toMatchObject({ level: 40, consecutiveFailures: 3 });

    reading(true);
    await catalog.tick();
    expect(lines.at(-1)).toMatchObject({
        level: 30,
        failures: 3,
        msg: "LI.FI's token list is being read again, swap prices are fresh",
    });
});

test("a token list without a single swap coin says how many tokens it did list", async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    const catalog = new SwapCatalog({ lifi: { tokens: async () => [] }, logger, syncMs: 60_000 });

    await catalog.tick();

    expect((lines[0] as { err: { message: string } }).err.message).toMatch(
        /holds none of the 11 swap coins \(it listed 0 tokens on \d+ chains\)/,
    );
    expect(lines[0]).toMatchObject({ level: 50, msg: expect.stringContaining("never been read") });
});

test("a rejected API key is an error from the first failed read, not a warning until the prices go stale", async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    const catalog = new SwapCatalog({
        lifi: {
            tokens: async () => {
                throw new LifiError("unauthorized", "LI.FI rejected our API key (401)", { said: { status: 401 } });
            },
        },
        logger,
        syncMs: 60_000,
        now: () => 1_000_000,
    });
    await catalog.tick();
    await catalog.tick();
    const failed = lines.filter((line) => line.event === "swap-catalog:sync");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((line) => line.level === 50)).toBe(true);
    expect(failed.map((line) => line.msg)).toContain("LI.FI rejected our API key, so swap prices can't be read");
});
