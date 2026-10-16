import { expect, test } from "@playwright/test";
import { createCoinsStore } from "@/components/trade/coins-store";
import { TOKENS } from "@/lib/trade/catalog";
import { loadCachedCatalog, toTokens } from "@/lib/trade/live-coins";
import type { SwapCatalogView } from "@/server/src/protocol";
import { PRICED_TOKENS, PRICES } from "./trade-fixtures";

const view = (patch: (coin: SwapCatalogView["coins"][number]) => unknown = (coin) => coin): SwapCatalogView =>
    ({
        coins: PRICED_TOKENS.map((token) =>
            patch({
                symbol: token.symbol,
                name: token.name,
                priceUSD: token.priceUSD,
                home: token.home,
                networks: token.networks.map(({ network, label, wrapped }) => ({
                    network,
                    ...(label && { label }),
                    ...(wrapped && { wrapped }),
                })),
            }),
        ),
        readAt: "2026-10-13T09:00:00.000Z",
    }) as SwapCatalogView;

const priceOf = (tokens: { symbol: string; priceUSD: number | null }[], symbol: string) =>
    tokens.find((token) => token.symbol === symbol)?.priceUSD;

test.describe("live coins", () => {
    test("toTokens takes live prices and leaves a coin it can't price without one", () => {
        const live: Record<string, unknown> = {
            ETH: 3500.5,
            SOL: null,
            BTC: "97300",
            LINK: 0,
            DOGE: -1,
            AVAX: Infinity,
            ARB: 0.9,
        };
        const tokens = toTokens(
            view((coin) => ({ ...coin, priceUSD: coin.symbol in live ? live[coin.symbol] : coin.priceUSD })),
            TOKENS,
        );
        expect(tokens.map((t) => t.symbol)).toEqual(TOKENS.map((t) => t.symbol));
        expect(priceOf(tokens, "ETH")).toBe(3500.5);
        expect(priceOf(tokens, "ARB")).toBe(0.9);
        // A price that is missing, not a positive number, or not finite is no price, never a made-up one.
        for (const symbol of ["SOL", "BTC", "LINK", "DOGE", "AVAX"]) {
            expect(priceOf(tokens, symbol), symbol).toBeNull();
        }
        // A price is the one thing a view changes: networks keep their gas reserve.
        const eth = tokens.find((t) => t.symbol === "ETH")!;
        expect(eth.networks).toEqual(TOKENS.find((t) => t.symbol === "ETH")!.networks);
        expect(eth.networks[0]).toMatchObject({ network: "ethereum", reserve: 0.002 });
        for (const { symbol, priceUSD } of tokens)
            expect(priceUSD === null || (Number.isFinite(priceUSD) && priceUSD > 0), symbol).toBe(true);
    });

    test("toTokens ignores an unknown network or coin", () => {
        const ghost = {
            symbol: "ZZZ",
            name: "Ghost",
            priceUSD: 5,
            home: "ethereum",
            networks: [{ network: "ethereum" }],
        };
        const patched = view((coin) => {
            if (coin.symbol === "ETH") {
                return {
                    ...coin,
                    networks: [
                        { network: "tron" },
                        null,
                        { network: "base" },
                        { network: "base" },
                        { network: "ethereum", label: "Ether", wrapped: true },
                    ],
                };
            }
            // Every network unknown: the coin keeps its built-in ones.
            if (coin.symbol === "LINK") return { ...coin, networks: [{ network: "zora" }], home: "zora" };
            // A home the coin isn't on is replaced by one it is on.
            if (coin.symbol === "ARB") return { ...coin, networks: [{ network: "ethereum" }], home: "base" };
            return coin;
        });
        const tokens = toTokens({ ...patched, coins: [...patched.coins, ghost, null, 7, {}] }, TOKENS);
        expect(tokens.map((t) => t.symbol)).toEqual(TOKENS.map((t) => t.symbol));
        const eth = tokens.find((t) => t.symbol === "ETH")!;
        expect(eth.networks.map((n) => n.network)).toEqual(["base", "ethereum"]);
        expect(eth.networks[1]).toMatchObject({ label: "Ether", wrapped: true, reserve: 0.002 });
        expect(tokens.find((t) => t.symbol === "LINK")).toEqual({
            ...TOKENS.find((t) => t.symbol === "LINK"),
            priceUSD: PRICES.LINK,
        });
        const arb = tokens.find((t) => t.symbol === "ARB")!;
        expect(arb.home).toBe("ethereum");
        expect(arb.networks.map((n) => n.network)).toEqual(["ethereum"]);
    });

    test("a malformed catalog gives the built-in tokens", () => {
        for (const bad of [null, undefined, "catalog", 42, {}, [], { coins: "no" }, { coins: null }, { coins: {} }]) {
            expect(toTokens(bad, TOKENS), JSON.stringify(bad)).toEqual(TOKENS);
        }
        // A view of nothing usable is the built-in coins too, with no NaN or zero prices.
        const junk = toTokens(
            { coins: [null, 7, "ETH", { symbol: 1 }, { symbol: "ETH", priceUSD: "x", networks: 3 }] },
            TOKENS,
        );
        expect(junk).toEqual(TOKENS);
        // The result never aliases the built-in list.
        expect(toTokens(null, TOKENS)).not.toBe(TOKENS);
    });
});

function withStorage(store: Map<string, string>) {
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
    };
}

test.describe("cached views", () => {
    test.afterEach(() => {
        delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    test("a throwing localStorage gives no catalog cache", () => {
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
        };
        expect(loadCachedCatalog()).toBeNull();
    });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withPage(store = new Map<string, string>()) {
    (globalThis as { document?: unknown }).document = {
        visibilityState: "visible",
        addEventListener() {},
        removeEventListener() {},
    };
    withStorage(store);
    return store;
}

test.describe("the coins store", () => {
    test.afterEach(() => {
        delete (globalThis as { document?: unknown }).document;
        delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    test("it caches the catalog and shows the cache before the network answers", async () => {
        const store = withPage();
        const live = view();
        const first = createCoinsStore({ apiUrl: "http://api", fetch: async () => new Response(JSON.stringify(live)) });
        expect(first.getSnapshot().view).toBeNull();
        first.start();
        await wait(50);
        first.stop();
        expect(first.getSnapshot().view).toEqual(live);
        expect(store.has("swaps:catalog")).toBe(true);
        expect(loadCachedCatalog()).toEqual(live);

        // A new page load: the cache is in at once, and an offline server leaves it be.
        const second = createCoinsStore({
            apiUrl: "http://api",
            fetch: async () => {
                throw new Error("offline");
            },
        });
        second.start();
        expect(second.getSnapshot().view).toEqual(live);
        await wait(50);
        second.stop();
        expect(second.getSnapshot().view).toEqual(live);
    });

    test("it asks the server's catalog again on its interval, and a bad answer changes nothing", async () => {
        withPage();
        const asked: string[] = [];
        const answers: (unknown | Error)[] = [
            view(),
            view((coin) => ({ ...coin, priceUSD: coin.symbol === "ETH" ? 4000 : coin.priceUSD })),
            { coins: "no" },
            // A server still warming up has no prices; the ones in hand stay.
            { ...view((coin) => ({ ...coin, priceUSD: null })), readAt: null },
        ];
        const store = createCoinsStore({
            apiUrl: "http://api",
            refreshMs: 40,
            fetch: async (input) => {
                asked.push(String(input));
                const next = answers[Math.min(asked.length - 1, answers.length - 1)];
                return new Response(JSON.stringify(next));
            },
        });
        store.start();
        await wait(20);
        expect(priceOf(toTokens(store.getSnapshot().view, TOKENS), "ETH")).toBe(PRICES.ETH);
        await wait(60);
        expect(priceOf(toTokens(store.getSnapshot().view, TOKENS), "ETH")).toBe(4000);
        await wait(250);
        store.stop();
        expect(asked.length).toBeGreaterThanOrEqual(4);
        expect(new Set(asked)).toEqual(new Set(["http://api/swaps/catalog"]));
        // Neither the malformed answer nor the warming one replaced the view.
        expect(priceOf(toTokens(store.getSnapshot().view, TOKENS), "ETH")).toBe(4000);
    });

    test("it stops asking once stopped", async () => {
        withPage();
        let asked = 0;
        const store = createCoinsStore({
            apiUrl: "http://api",
            refreshMs: 20,
            fetch: async () => {
                asked += 1;
                return new Response(JSON.stringify(view()));
            },
        });
        store.start();
        await wait(70);
        store.stop();
        const seen = asked;
        await wait(100);
        expect(asked).toBe(seen);
    });
});
