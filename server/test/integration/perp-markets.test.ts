import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { loadConfig } from "../../src/config.ts";
import type { PerpMarketsView } from "../../src/protocol.ts";
import type { HyperliquidClient, PerpMeta } from "../../src/perps/client.ts";
import { createNktkasClient } from "../../src/perps/nktkas-client.ts";
import { PerpMarkets } from "../../src/perps/markets.ts";
import { startStack, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const markets = async () => {
    const response = await fetch(`${stack.url}/perps/markets`);
    return { status: response.status, headers: response.headers, view: (await response.json()) as PerpMarketsView };
};

const logger = pino({ level: "silent" });
const config = (env: Record<string, string> = {}) =>
    loadConfig({
        NODE_ENV: "test",
        MONGODB_URI: "mongodb://localhost",
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        PRIVY_VERIFICATION_KEY: "key",
        ARC_RPC_URLS: "http://127.0.0.1:1",
        DEPOSIT_MNEMONIC: "test test test test test test test test test test test junk",
        ...env,
    });
const live = () => createNktkasClient({ url: stack.hyperliquid.url });

describe("GET /perps/markets", () => {
    test("lists every market with markPx and maxLeverage, the busiest first", async () => {
        const { status, headers, view } = await markets();

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(view.markets.map((m) => m.asset)).toEqual(["ETH", "SOL", "BTC", "DOGE", "LINK"]);
        expect(view.markets.find((m) => m.asset === "BTC")).toEqual({
            asset: "BTC",
            markPx: "66000",
            maxLeverage: 20,
            fundingRate: "0.0000125",
        });
        expect(view.markets.find((m) => m.asset === "LINK")?.maxLeverage).toBe(10);
    });

    test("maxLeverage is capped at PERPS_MAX_LEVERAGE", async () => {
        const capped = new PerpMarkets({ client: live(), config: config({ PERPS_MAX_LEVERAGE: "8" }), logger });
        await capped.tick();

        const byAsset = Object.fromEntries(capped.view().markets.map((m) => [m.asset, m.maxLeverage]));
        expect(byAsset).toEqual({ BTC: 8, ETH: 8, SOL: 8, LINK: 8, DOGE: 8 });
        expect(capped.view().markets.map((m) => m.asset)).toEqual(["ETH", "SOL", "BTC", "DOGE", "LINK"]);
        const { view } = await markets();
        expect(view.markets.find((m) => m.asset === "BTC")?.maxLeverage).toBe(20);
    });

    test("an asset Hyperliquid no longer lists is dropped", async () => {
        const client = live();
        const without: HyperliquidClient = {
            ...client,
            meta: async () => {
                const meta = await client.meta();
                return { assets: meta.assets.filter((a) => a.asset !== "DOGE") };
            },
        };
        const sync = new PerpMarkets({ client: without, config: config(), logger });
        await sync.tick();

        expect(sync.view().markets.map((m) => m.asset)).toEqual(["ETH", "SOL", "BTC", "LINK"]);
        expect(sync.byAsset("DOGE")).toBeUndefined();
        expect(sync.byAsset("BTC")?.index).toBe(0);
    });

    test("a failed sync keeps the last list", async () => {
        const client = live();
        let failing = false;
        const flaky: HyperliquidClient = {
            ...client,
            meta: () => (failing ? Promise.reject(new Error("down")) : client.meta()),
        };
        const sync = new PerpMarkets({ client: flaky, config: config(), logger });
        expect(sync.view().markets).toEqual([]);
        await sync.tick();
        failing = true;
        await sync.tick();

        expect(sync.view().markets.map((m) => m.asset)).toEqual(["ETH", "SOL", "BTC", "DOGE", "LINK"]);
    });

    test("maxOrderUSD is null while trading is off", async () => {
        const { view } = await markets();
        expect(view.maxOrderUSD).toBeNull();

        const on = new PerpMarkets({ client: live(), config: config({ PERPS_TRADING: "on" }), logger });
        await on.tick();
        expect(on.view().maxOrderUSD).toBeNull();
        on.setMaxOrderUSD(() => 150);
        expect(on.view().maxOrderUSD).toBe("150");
        const off = new PerpMarkets({ client: live(), config: config(), logger });
        off.setMaxOrderUSD(() => 150);
        expect(off.view().maxOrderUSD).toBeNull();
    });

    test("the route needs no token", async () => {
        const response = await fetch(`${stack.url}/perps/markets`, { headers: {} });
        expect(response.status).toBe(200);
    });

    test("a mark change shows on the next sync", async () => {
        stack.hyperliquid.setMark("ETH", 3300);
        await stack.server.services.perpMarkets.tick();

        const { view } = await markets();
        expect(view.markets.find((m) => m.asset === "ETH")?.markPx).toBe("3300");
        stack.hyperliquid.reset();
    });
});

const entry = (asset: string, dayNtlVlm: number, over: Partial<PerpMeta["assets"][number]> = {}) => ({
    asset,
    index: 0,
    szDecimals: 2,
    maxLeverage: 10,
    marginTables: [],
    onlyIsolated: false,
    markPx: 1,
    oraclePx: 1,
    funding: 0,
    dayNtlVlm,
    ...over,
});

describe("the market order", () => {
    const MINUTE = 60_000;
    const serving = (read: () => PerpMeta["assets"], clock: { at: number }) =>
        new PerpMarkets({
            client: { meta: async () => ({ assets: read() }) },
            config: config(),
            logger,
            now: () => clock.at,
        });
    const order = (sync: PerpMarkets) => sync.view().markets.map((m) => m.asset);

    test("lists every market with a mark, the busiest first, a tie by name", async () => {
        const sync = serving(
            () => [
                entry("AAA", 5),
                entry("kPEPE", 900, { markPx: 0.004 }),
                entry("BTC", 5_000),
                entry("ZZZ", 5),
                entry("ZERO", 9_999, { markPx: 0 }),
                entry("NAN", 9_999, { markPx: Number.NaN }),
            ],
            { at: 0 },
        );
        await sync.tick();

        expect(order(sync)).toEqual(["BTC", "kPEPE", "AAA", "ZZZ"]);
        expect(sync.byAsset("kPEPE")?.markPx).toBe(0.004);
        expect(sync.byAsset("ZERO")).toBeUndefined();
        expect(sync.view().markets[1]).toEqual({
            asset: "kPEPE",
            markPx: "0.004",
            maxLeverage: 10,
            fundingRate: "0",
        });
    });

    test("an asset with no volume figure lists last", async () => {
        const sync = serving(() => [entry("AAA", 0), entry("BBB", 10)], { at: 0 });
        await sync.tick();
        expect(order(sync)).toEqual(["BBB", "AAA"]);
    });

    test("the order holds for ten minutes while volumes move, then follows them", async () => {
        const volumes = { AAA: 300, BBB: 200, CCC: 100 };
        const clock = { at: 1_000 };
        const sync = serving(() => Object.entries(volumes).map(([asset, v]) => entry(asset, v)), clock);
        await sync.tick();
        expect(order(sync)).toEqual(["AAA", "BBB", "CCC"]);

        volumes.CCC = 900;
        clock.at += 9 * MINUTE;
        await sync.tick();
        expect(order(sync)).toEqual(["AAA", "BBB", "CCC"]);

        clock.at += MINUTE;
        await sync.tick();
        expect(order(sync)).toEqual(["CCC", "AAA", "BBB"]);
    });

    test("a mark change inside the ten minutes still shows, in the frozen order", async () => {
        let marks = 1;
        const clock = { at: 0 };
        const sync = serving(() => [entry("AAA", 2, { markPx: marks }), entry("BBB", 1)], clock);
        await sync.tick();
        marks = 7;
        clock.at += MINUTE;
        await sync.tick();
        expect(sync.view().markets[0]).toMatchObject({ asset: "AAA", markPx: "7" });
    });

    test("a newly listed asset ranks at once, without waiting for the ten minutes", async () => {
        const assets = [entry("AAA", 300), entry("BBB", 200)];
        const clock = { at: 0 };
        const sync = serving(() => assets, clock);
        await sync.tick();

        assets.push(entry("NEW", 250));
        clock.at += MINUTE;
        await sync.tick();
        expect(order(sync)).toEqual(["AAA", "NEW", "BBB"]);
    });

    test("an asset that goes away leaves the list and keeps the rest in order", async () => {
        let assets = [entry("AAA", 300), entry("BBB", 200), entry("CCC", 100)];
        const clock = { at: 0 };
        const sync = serving(() => assets, clock);
        await sync.tick();

        assets = assets.filter((a) => a.asset !== "BBB");
        clock.at += MINUTE;
        await sync.tick();
        expect(order(sync)).toEqual(["AAA", "CCC"]);
        expect(sync.byAsset("BBB")).toBeUndefined();
    });
});
