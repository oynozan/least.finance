import { expect, test } from "@playwright/test";
import { createCoinsStore } from "@/components/trade/coins-store";
import { initialState, reduce, refit, resolve } from "@/lib/sentence";
import { CATALOG, TOKENS } from "@/lib/trade/catalog";
import type { TradeCtx, WalletHoldings } from "@/lib/trade/context";
import { formatUsd } from "@/lib/trade/format";
import { networkChoices } from "@/lib/trade/operations/shared";
import { loadCachedCatalog, toTokens } from "@/lib/trade/live-coins";
import { TRADE } from "@/lib/trade/registry";
import { loadCachedSwapHoldings, saveCachedSwapHoldings, walletHoldings } from "@/lib/trade/wallet-holdings";
import type { SwapCatalogView, SwapHoldingRow, SwapHoldingsView } from "@/server/src/protocol";

const view = (patch: (coin: SwapCatalogView["coins"][number]) => unknown = (coin) => coin): SwapCatalogView =>
    ({
        coins: TOKENS.map((token) =>
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

const priceOf = (tokens: { symbol: string; priceUSD: number }[], symbol: string) =>
    tokens.find((token) => token.symbol === symbol)?.priceUSD;

test.describe("live coins", () => {
    test("toTokens takes live prices and keeps built-in ones for nulls", () => {
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
        // A price that is missing, not a positive number, or not finite is the built-in one.
        for (const symbol of ["SOL", "BTC", "LINK", "DOGE", "AVAX"]) {
            expect(priceOf(tokens, symbol), symbol).toBe(priceOf(TOKENS, symbol));
        }
        // A price is the one thing a view changes: networks keep their gas reserve.
        const eth = tokens.find((t) => t.symbol === "ETH")!;
        expect(eth.networks).toEqual(TOKENS.find((t) => t.symbol === "ETH")!.networks);
        expect(eth.networks[0]).toMatchObject({ network: "ethereum", reserve: 0.002 });
        for (const token of tokens)
            expect(Number.isFinite(token.priceUSD) && token.priceUSD > 0, token.symbol).toBe(true);
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
        expect(tokens.find((t) => t.symbol === "LINK")).toEqual(TOKENS.find((t) => t.symbol === "LINK"));
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

const A = "0xAbCdEf0000000000000000000000000000000001";
const B = "0xBbCdEf0000000000000000000000000000000002";
const S = "So11111111111111111111111111111111111111112";
const T = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const row = (wallet: string, network: SwapHoldingRow["network"], symbol: string, amount: string): SwapHoldingRow => ({
    wallet,
    network,
    symbol,
    amount,
    usd: null,
});

const rows: SwapHoldingRow[] = [
    row(A, "ethereum", "ETH", "1.5"),
    row(A, "base", "ETH", "0.25"),
    row(A, "arc", "USDC", "12"),
    row(B, "base", "ETH", "2"),
    row(B, "optimism", "ETH", "7"),
    row(S, "solana", "SOL", "3"),
    row(S, "solana", "USDC", "4"),
    row(T, "solana", "SOL", "100"),
];

test.describe("wallet holdings", () => {
    test("walletHoldings keeps only the signing wallets", () => {
        // An EVM address matches whatever its casing.
        expect(walletHoldings(rows, { evm: A.toLowerCase(), solana: S })).toEqual({
            ETH: { ethereum: 1.5, base: 0.25 },
            USDC: { arc: 12, solana: 4 },
            SOL: { solana: 3 },
        });
        // A Solana address is exact.
        expect(walletHoldings(rows, { evm: A, solana: S.toLowerCase() })).toEqual({
            ETH: { ethereum: 1.5, base: 0.25 },
            USDC: { arc: 12 },
        });
        expect(walletHoldings(rows, { solana: T })).toEqual({ SOL: { solana: 100 } });
        expect(walletHoldings(rows, {})).toEqual({});
        expect(walletHoldings([], { evm: A })).toEqual({});
        // Rows a client can't read (a bad amount, an unknown network) are skipped, not summed in.
        expect(
            walletHoldings(
                [
                    row(A, "ethereum", "ETH", "abc"),
                    row(A, "ethereum", "LINK", "0"),
                    row(A, "zora" as never, "ETH", "5"),
                    row(A, "arbitrum", "ETH", "0.5"),
                ],
                { evm: A },
            ),
        ).toEqual({ ETH: { arbitrum: 0.5 } });
    });

    test("switching the active EVM wallet switches the holdings", () => {
        const first = walletHoldings(rows, { evm: A });
        const second = walletHoldings(rows, { evm: B });
        expect(first.ETH).toEqual({ ethereum: 1.5, base: 0.25 });
        expect(second.ETH).toEqual({ base: 2, optimism: 7 });

        // The cap is the signing wallet's, with the gas reserve held back.
        const eth = TOKENS.find((t) => t.symbol === "ETH")!.priceUSD;
        const ctxFor = (wallet: WalletHoldings): TradeCtx => ({ catalog: CATALOG, holdings: null, wallet });
        const over = (state: ReturnType<typeof initialState>, ctx: TradeCtx) =>
            resolve(
                TRADE,
                reduce(TRADE, state, { type: "slot", slot: "amountUSD", value: "99999" }, ctx),
                ctx,
            ).issues.find((issue) => issue.code === "max")?.message;
        const ctxA = ctxFor(first);
        const stateA = initialState(TRADE, "swap", ctxA);
        expect(over(stateA, ctxA)).toBe(`That's more than your ${formatUsd((1.5 - 0.002) * eth)} of ETH on Ethereum.`);

        // The pay side follows to the new wallet's biggest holding, and the cap with it.
        const ctxB = ctxFor(second);
        const stateB = refit(TRADE, stateA, ctxB);
        expect(resolve(TRADE, stateB, ctxB).intent).toMatchObject({ fromToken: "ETH", fromNetwork: "optimism" });
        expect(over(stateB, ctxB)).toBe(`That's more than your ${formatUsd((7 - 0.0002) * eth)} of ETH on Optimism.`);
    });

    test("a wallet that loads or changes after the sentence moves a pay side that is now empty", () => {
        const none: TradeCtx = { catalog: CATALOG, holdings: null, wallet: null };
        const state = initialState(TRADE, "swap", none);
        // Not loaded: nothing is empty, so the built-in default stands.
        expect(resolve(TRADE, state, none).intent).toMatchObject({ fromNetwork: "ethereum", toNetwork: "solana" });
        expect(refit(TRADE, state, none)).toBe(state);

        const base: TradeCtx = { catalog: CATALOG, holdings: null, wallet: { ETH: { base: 1 } } };
        // Until it is re-fitted, the pay side sits on a row with nothing in it.
        expect(resolve(TRADE, state, base).intent).toBeNull();
        const fitted = refit(TRADE, state, base);
        expect(resolve(TRADE, fitted, base).intent).toMatchObject({
            fromToken: "ETH",
            fromNetwork: "base",
            amountUSD: "10",
        });
        // Nothing changed: the same state comes back.
        expect(refit(TRADE, fitted, base)).toBe(fitted);

        // A network the wallet still holds stays where the user put it.
        const both: TradeCtx = { ...base, wallet: { ETH: { base: 1, arbitrum: 2 } } };
        const picked = reduce(TRADE, fitted, { type: "slot", slot: "fromNetwork", value: "arbitrum" }, both);
        expect(resolve(TRADE, refit(TRADE, picked, both), both).intent).toMatchObject({ fromNetwork: "arbitrum" });
        // A wallet that holds ETH only on Ethereum takes it back there.
        const other: TradeCtx = { ...base, wallet: { ETH: { ethereum: 3 } } };
        expect(resolve(TRADE, refit(TRADE, picked, other), other).intent).toMatchObject({ fromNetwork: "ethereum" });
    });
});

test.describe("defaults follow the wallet", () => {
    const eth = (units: WalletHoldings["ETH"]): TradeCtx => ({
        catalog: CATALOG,
        holdings: null,
        wallet: { ETH: units },
    });
    const none: TradeCtx = { catalog: CATALOG, holdings: null, wallet: null };
    const act = (type: "slot", slot: string, value: string) => ({ type, slot, value }) as const;
    const intentOf = (state: ReturnType<typeof initialState>, ctx: TradeCtx) => resolve(TRADE, state, ctx).intent;

    test("a wallet that loads after the sentence puts the pay side where it holds the most", () => {
        const state = initialState(TRADE, "swap", none);
        // Dust on Ethereum is below the gas kept back, so the sentence moves to where the ETH is
        const dust = eth({ ethereum: 0.001, arbitrum: 2 });
        expect(intentOf(refit(TRADE, state, dust), dust)).toMatchObject({ fromToken: "ETH", fromNetwork: "arbitrum" });
        // A home network that holds something still loses to a richer one
        const both = eth({ ethereum: 0.05, arbitrum: 2 });
        expect(intentOf(refit(TRADE, state, both), both)).toMatchObject({ fromNetwork: "arbitrum" });
    });

    test("a signer that changes takes the new wallet's richest network", () => {
        const first = eth({ ethereum: 1.5 });
        const state = initialState(TRADE, "swap", first);
        expect(intentOf(state, first)).toMatchObject({ fromNetwork: "ethereum" });
        const second = eth({ ethereum: 0.001, optimism: 7 });
        expect(intentOf(refit(TRADE, state, second), second)).toMatchObject({ fromNetwork: "optimism" });
    });

    test("a network the person picked survives a load where it still fits", () => {
        const state = reduce(TRADE, initialState(TRADE, "swap", none), act("slot", "fromNetwork", "base"), none);
        const loaded = eth({ ethereum: 1, base: 0.5, arbitrum: 2 });
        expect(intentOf(refit(TRADE, state, loaded), loaded)).toMatchObject({ fromNetwork: "base" });
        // Where it no longer fits, it is repaired
        const gone = eth({ ethereum: 1, arbitrum: 2 });
        expect(intentOf(refit(TRADE, state, gone), gone)).toMatchObject({ fromNetwork: "arbitrum" });
    });

    test("an amount and a leverage the person chose survive a refit and a verb round trip", () => {
        let state = initialState(TRADE, "swap", none);
        state = reduce(TRADE, state, act("slot", "amountUSD", "25"), none);
        state = reduce(TRADE, state, { type: "verb", verbId: "long" }, none);
        state = reduce(TRADE, state, act("slot", "leverage", "10"), none);
        state = reduce(TRADE, state, { type: "verb", verbId: "swap" }, none);
        const loaded = eth({ arbitrum: 2 });
        state = refit(TRADE, state, loaded);
        expect(intentOf(state, loaded)).toMatchObject({ fromNetwork: "arbitrum", amountUSD: "25" });
        state = reduce(TRADE, state, { type: "verb", verbId: "long" }, loaded);
        expect(intentOf(state, loaded)).toMatchObject({ type: "perp", leverage: 10 });
    });

    test("Sell moves off an ETH network holding only gas", () => {
        const sold = (ctx: TradeCtx) =>
            reduce(TRADE, initialState(TRADE, "sell", ctx), act("slot", "token", "ETH"), ctx);
        const wallet = eth({ ethereum: 0.001, base: 1 });
        expect(intentOf(sold(wallet), wallet)).toMatchObject({ type: "spot", token: "ETH", network: "base" });
        // The same pick before the coins load, repaired when they do
        const state = sold(none);
        expect(intentOf(state, none)).toMatchObject({ token: "ETH", network: "ethereum" });
        expect(intentOf(refit(TRADE, state, wallet), wallet)).toMatchObject({ token: "ETH", network: "base" });
    });

    test("a row with only gas money says so, an empty one says nothing is there", () => {
        const wallet = eth({ ethereum: 0.001, arbitrum: 0.0002, base: 1 });
        const rows = networkChoices(wallet, "ETH", "pay");
        expect(rows.find((c) => c.value === "ethereum")).toMatchObject({ disabled: "Too little for gas" });
        // Exactly the reserve leaves nothing to spend
        expect(rows.find((c) => c.value === "arbitrum")).toMatchObject({ disabled: "Too little for gas" });
        expect(rows.find((c) => c.value === "optimism")).toMatchObject({ disabled: "Nothing here" });
        expect(rows.find((c) => c.value === "base")?.disabled).toBeUndefined();
        // Receiving is never blocked, and a coin with no gas reserve fits at any amount
        expect(networkChoices(wallet, "ETH", "receive").every((c) => !c.disabled)).toBe(true);
        const link = networkChoices({ ...none, wallet: { LINK: { ethereum: 0.0001 } } }, "LINK", "pay");
        expect(link.find((c) => c.value === "ethereum")?.disabled).toBeUndefined();
    });
});

const holdingsView = (...held: SwapHoldingRow[]): SwapHoldingsView => ({
    readAt: "2026-10-13T09:00:00.000Z",
    rows: held,
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

    test("holdings are cached under the user and a corrupt cache is ignored", () => {
        const store = new Map<string, string>();
        withStorage(store);
        expect(loadCachedSwapHoldings("u1")).toBeNull();
        const saved = holdingsView(row(A, "ethereum", "ETH", "1"));
        saveCachedSwapHoldings("u1", saved);
        expect([...store.keys()]).toEqual(["swap-holdings:u1"]);
        expect(loadCachedSwapHoldings("u1")).toEqual(saved);
        expect(loadCachedSwapHoldings("u2")).toBeNull();
        for (const raw of ["{", "[]", '{"rows":{}}', '{"readAt":1,"rows":[]}', "null"]) {
            store.set("swap-holdings:u1", raw);
            expect(loadCachedSwapHoldings("u1"), raw).toBeNull();
        }
        // A row of the wrong shape is dropped and the rest stay.
        store.set("swap-holdings:u1", JSON.stringify({ ...saved, rows: [{ wallet: A }, null, ...saved.rows] }));
        expect(loadCachedSwapHoldings("u1")?.rows).toEqual(saved.rows);
    });

    test("a throwing localStorage gives no cache and does not throw", () => {
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
        };
        expect(loadCachedSwapHoldings("u1")).toBeNull();
        expect(loadCachedCatalog()).toBeNull();
        expect(() => saveCachedSwapHoldings("u1", holdingsView())).not.toThrow();
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
        expect(priceOf(toTokens(store.getSnapshot().view, TOKENS), "ETH")).toBe(
            TOKENS.find((t) => t.symbol === "ETH")!.priceUSD,
        );
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
