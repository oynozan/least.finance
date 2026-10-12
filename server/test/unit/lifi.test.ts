import { afterEach, expect, test } from "vitest";
import { createLifi } from "../../src/swaps/lifi.ts";
import { NATIVE_EVM } from "../../src/swaps/coins.ts";
import { startFakeLifi, type FakeLifi } from "../support/fake-lifi.ts";

let fake: FakeLifi | undefined;
afterEach(async () => {
    await fake?.stop();
    fake = undefined;
});

const answering = (tokens: Record<string, unknown>) => async () => Response.json({ tokens });

test("reads tokens with prices", async () => {
    fake = await startFakeLifi({ prices: { ETH: 3210.4 } });
    const lifi = createLifi({ url: fake.url, apiKey: "k" });

    const tokens = await lifi.tokens([1, 8453]);

    expect(fake.requests).toEqual(["GET /v1/tokens?chains=1,8453&chainTypes=EVM,SVM"]);
    expect(new Set(tokens.map((token) => token.chainId))).toEqual(new Set([1, 8453]));
    expect(tokens).toContainEqual({ chainId: 1, address: NATIVE_EVM, symbol: "ETH", decimals: 18, priceUSD: 3210.4 });
    expect(tokens.every((token) => token.priceUSD === null || token.priceUSD > 0)).toBe(true);
});

test("drops a malformed token, keeps the rest", async () => {
    const good = { chainId: 1, address: "0xa", symbol: "OK", decimals: 18, priceUSD: "1.5" };
    const lifi = createLifi({
        url: "http://lifi.test",
        fetch: answering({
            "1": [
                good,
                null,
                "text",
                { ...good, address: undefined },
                { ...good, symbol: 7 },
                { ...good, decimals: "18" },
                { ...good, chainId: "1" },
                { ...good, address: "0xb", symbol: "NOPRICE", priceUSD: undefined },
                { ...good, address: "0xc", symbol: "BADPRICE", priceUSD: "n/a" },
                { ...good, address: "0xd", symbol: "ZERO", priceUSD: "0" },
            ],
            "10": "not a list",
        }),
    });

    expect(await lifi.tokens([1, 10])).toEqual([
        { chainId: 1, address: "0xa", symbol: "OK", decimals: 18, priceUSD: 1.5 },
        { chainId: 1, address: "0xb", symbol: "NOPRICE", decimals: 18, priceUSD: null },
        { chainId: 1, address: "0xc", symbol: "BADPRICE", decimals: 18, priceUSD: null },
        { chainId: 1, address: "0xd", symbol: "ZERO", decimals: 18, priceUSD: null },
    ]);
});

test("sends the key only when set", async () => {
    fake = await startFakeLifi();

    await createLifi({ url: fake.url, apiKey: "k" }).tokens([1]);
    expect(fake.keys).toEqual(["k"]);

    await createLifi({ url: fake.url }).tokens([1]);
    expect(fake.keys).toEqual(["k", null]);
});

test("a 500 throws", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });

    fake.failNext("/v1/tokens");
    await expect(lifi.tokens([1])).rejects.toThrow(/500/);
    expect(await lifi.tokens([1])).not.toHaveLength(0);
});

test("a slow answer times out", async () => {
    const lifi = createLifi({
        url: "http://lifi.test",
        timeoutMs: 20,
        fetch: (_input, init) =>
            new Promise((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
    });

    await expect(lifi.tokens([1])).rejects.toThrow();
});
