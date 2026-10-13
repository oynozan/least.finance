import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import type { SwapCatalogView } from "../../src/protocol.ts";
import { COINS, NATIVE_EVM, NETWORKS } from "../../src/swaps/coins.ts";
import { SwapCatalog } from "../../src/swaps/catalog.ts";
import { createLifi, type Lifi } from "../../src/swaps/lifi.ts";
import { startStack, SWAP_PRICES, type Stack } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const catalog = async () => {
    const response = await fetch(`${stack.url}/swaps/catalog`);
    return { status: response.status, headers: response.headers, view: (await response.json()) as SwapCatalogView };
};

const logger = pino({ level: "silent" });

// EVM addresses compare without case, Solana's are exact
const keyOf = (chainId: number, address: string) =>
    `${chainId}:${NETWORKS.find((network) => network.chainId === chainId)?.kind === "evm" ? address.toLowerCase() : address}`;
const tabled = new Set(
    COINS.flatMap((coin) =>
        coin.entries.map((entry) =>
            keyOf(NETWORKS.find((network) => network.id === entry.network)!.chainId, entry.address),
        ),
    ),
);

describe("swap catalog", () => {
    test("serves every coin with the fake's prices", async () => {
        const { status, headers, view } = await catalog();

        expect(status).toBe(200);
        expect(headers.get("cache-control")).toBe("no-store");
        expect(view.coins).toHaveLength(11);
        expect(view.coins.map((coin) => coin.symbol)).toEqual(COINS.map((coin) => coin.symbol));
        expect(view.coins.find((coin) => coin.symbol === "ETH")?.priceUSD).toBe(3210.4);
        expect(Object.fromEntries(view.coins.map((coin) => [coin.symbol, coin.priceUSD]))).toEqual(SWAP_PRICES);
        expect(view.coins.find((coin) => coin.symbol === "SOL")?.networks).toContainEqual({
            network: "ethereum",
            label: "Wormhole SOL",
            wrapped: true,
        });
        expect(view.readAt).toEqual(expect.any(String));
    });

    test("a look-alike's price never prices a coin", async () => {
        const real = createLifi({ url: stack.lifi.url });
        let decoys = 0;
        const withDecoys: Pick<Lifi, "tokens"> = {
            async tokens(chainIds) {
                return (await real.tokens(chainIds)).map((token) => {
                    if (tabled.has(keyOf(token.chainId, token.address))) return token;
                    decoys += 1;
                    return { ...token, priceUSD: 999 };
                });
            },
        };
        const swapCatalog = new SwapCatalog({ lifi: withDecoys, logger, syncMs: 10_000 });

        await swapCatalog.tick();

        expect(decoys).toBeGreaterThan(0);
        expect(swapCatalog.priceOf("ETH")).toBe(3210.4);
        expect(Object.fromEntries(swapCatalog.view().coins.map((coin) => [coin.symbol, coin.priceUSD]))).toEqual(
            SWAP_PRICES,
        );
    });

    test("a coin takes its home price, else its first priced entry, else none", async () => {
        const token = (chainId: number, address: string, priceUSD: number | null) => ({
            chainId,
            address,
            symbol: "ETH",
            decimals: 18,
            priceUSD,
        });
        const polygonWeth = COINS[0]!.entries.find((entry) => entry.network === "polygon")!.address;
        let listed = [token(1, NATIVE_EVM, 2500), token(42161, NATIVE_EVM, 2000)];
        const swapCatalog = new SwapCatalog({ lifi: { tokens: async () => listed }, logger, syncMs: 10_000 });

        await swapCatalog.tick();
        expect(swapCatalog.priceOf("ETH")).toBe(2500);
        expect(swapCatalog.priceOf("SOL")).toBeNull();

        listed = [token(1, NATIVE_EVM, null), token(42161, NATIVE_EVM, 2000), token(8453, NATIVE_EVM, 1900)];
        await swapCatalog.tick();
        expect(swapCatalog.priceOf("ETH")).toBe(2000);

        listed = [token(1, NATIVE_EVM, null), token(137, polygonWeth.toLowerCase(), 2100)];
        await swapCatalog.tick();
        expect(swapCatalog.priceOf("ETH")).toBe(2100);

        listed = [token(1, NATIVE_EVM, null)];
        await swapCatalog.tick();
        expect(swapCatalog.priceOf("ETH")).toBeNull();
        expect(swapCatalog.view().readAt).not.toBeNull();
    });

    test("a failed refresh keeps the last list", async () => {
        const before = (await catalog()).view;
        expect(before.readAt).not.toBeNull();

        stack.lifi.failNext("/v1/tokens");
        await stack.server.services.swapCatalog.tick();

        expect((await catalog()).view).toEqual(before);
    });

    test("a refresh with nothing in it keeps the last list", async () => {
        let answering: Pick<Lifi, "tokens"> = createLifi({ url: stack.lifi.url });
        const swapCatalog = new SwapCatalog({
            lifi: { tokens: (ids) => answering.tokens(ids) },
            logger,
            syncMs: 10_000,
        });
        await swapCatalog.tick();
        const before = swapCatalog.view();
        expect(before.readAt).not.toBeNull();

        answering = { tokens: async () => [] };
        await swapCatalog.tick();

        expect(swapCatalog.view()).toEqual(before);
    });

    test("a coin is served with no price before the first read", () => {
        const swapCatalog = new SwapCatalog({ lifi: { tokens: async () => [] }, logger, syncMs: 10_000 });

        const view = swapCatalog.view();

        expect(view.readAt).toBeNull();
        expect(view.coins).toHaveLength(11);
        expect(view.coins.every((coin) => coin.priceUSD === null)).toBe(true);
        expect(swapCatalog.priceOf("NOPE")).toBeNull();
    });

    test("the API key goes to LI.FI", async () => {
        const keyed = await startStack({
            mongoUri: inject("mongoUri"),
            anvilUrl: inject("anvilUrl"),
            env: { LIFI_API_KEY: "test-key" },
        });
        try {
            expect(keyed.lifi.keys).toContain("test-key");
            expect(stack.lifi.keys).not.toContain("test-key");
        } finally {
            await keyed.stop();
        }
    });
});
