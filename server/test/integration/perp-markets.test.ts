import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { loadConfig } from "../../src/config.ts";
import type { PerpMarketsView } from "../../src/protocol.ts";
import type { HyperliquidClient } from "../../src/perps/client.ts";
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
    test("lists BTC, ETH, SOL, LINK and DOGE with markPx and maxLeverage", async () => {
        const { status, headers, view } = await markets();

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(view.markets.map((m) => m.asset)).toEqual(["BTC", "ETH", "SOL", "LINK", "DOGE"]);
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

        expect(sync.view().markets.map((m) => m.asset)).toEqual(["BTC", "ETH", "SOL", "LINK"]);
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

        expect(sync.view().markets.map((m) => m.asset)).toEqual(["BTC", "ETH", "SOL", "LINK", "DOGE"]);
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
