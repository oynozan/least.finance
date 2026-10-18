import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createDefiLlama, LLAMA_IDS, LlamaError } from "../../src/prices/defillama.ts";
import { COINS } from "../../src/swaps/coins.ts";

const ETH = "coingecko:ethereum";
const USDC = "coingecko:usd-coin";

const recorded = JSON.parse(readFileSync(new URL("../fixtures/defillama/chart.json", import.meta.url), "utf8"));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test("every swap coin has a DefiLlama id", () => {
    expect(Object.keys(LLAMA_IDS).sort()).toEqual(COINS.map((coin) => coin.symbol).sort());
});

test("a recorded chart reads as each coin's points in ms, oldest first", async () => {
    const fetch = vi.fn(async () => json(recorded));
    const llama = createDefiLlama({ url: "https://coins.llama.fi/", fetch });

    const found = await llama.chart({ ids: [ETH, USDC], end: 1_791_892_800, span: 6, period: "1h" });

    expect(fetch).toHaveBeenCalledWith(
        "https://coins.llama.fi/chart/coingecko:ethereum,coingecko:usd-coin?end=1791892800&span=6&period=1h",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(found.get(ETH)).toHaveLength(6);
    expect(found.get(ETH)![0]).toEqual([1_791_874_800_000, 2532.429633604665]);
    expect(found.get(ETH)!.at(-1)![0]).toBe(1_791_892_800_000);
    expect(found.get(USDC)).toHaveLength(6);
    expect(found.get(USDC)!.every(([, usd]) => Math.abs(usd - 1) < 0.01)).toBe(true);
});

test("a coin DefiLlama doesn't price is left out, and unusable points are dropped", async () => {
    const llama = createDefiLlama({
        url: "https://coins.llama.fi",
        fetch: async () =>
            json({
                coins: {
                    [ETH]: {
                        prices: [
                            { timestamp: 3, price: 3 },
                            { timestamp: 1, price: 1 },
                            { timestamp: 2, price: 0 },
                            { timestamp: 4, price: -1 },
                            { timestamp: 1, price: 1.5 },
                        ],
                    },
                },
            }),
    });

    const found = await llama.chart({ ids: [ETH, USDC], end: 4, span: 4, period: "1h" });

    expect(found.get(ETH)).toEqual([
        [1_000, 1.5],
        [3_000, 3],
    ]);
    expect(found.has(USDC)).toBe(false);
});

test("a chart over 500 points is refused before it's sent", async () => {
    const fetch = vi.fn();
    const llama = createDefiLlama({ url: "https://coins.llama.fi", fetch });

    await expect(llama.chart({ ids: [ETH, USDC], end: 1, span: 251, period: "1h" })).rejects.toThrow(/502 points/);
    expect(fetch).not.toHaveBeenCalled();
});

test("a 429 carries its Retry-After", async () => {
    const llama = createDefiLlama({
        url: "https://coins.llama.fi",
        fetch: async () => new Response("Slow down", { status: 429, headers: { "retry-after": "120" } }),
    });

    const error = await llama.chart({ ids: [ETH], end: 1, span: 1, period: "1h" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlamaError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000 });
});

test("no failure names the URL, which holds the key on DefiLlama Pro", async () => {
    const failing: (() => Promise<Response>)[] = [
        async () => new Response("Bad gateway", { status: 502 }),
        async () => new Response("<html>", { status: 200 }),
        async () => json({ coins: { [ETH]: { prices: "none" } } }),
    ];
    const urls = ["https://pro-api.llama.fi/secret-key/coins", "http://127.0.0.1:9/secret-key/coins"];
    const errors: unknown[] = [];
    for (const answer of failing) {
        const llama = createDefiLlama({ url: urls[0]!, fetch: answer });
        errors.push(await llama.chart({ ids: [ETH], end: 1, span: 1, period: "1h" }).catch((e: unknown) => e));
    }
    // A real refused connection, so Node's own fetch error is checked too
    const refused = createDefiLlama({ url: urls[1]! });
    errors.push(await refused.chart({ ids: [ETH], end: 1, span: 1, period: "1h" }).catch((e: unknown) => e));

    for (const error of errors) {
        expect(error).toBeInstanceOf(LlamaError);
        const { message, stack, cause } = error as LlamaError;
        const causeText = cause instanceof Error ? `${cause.message} ${cause.stack} ${String(cause.cause)}` : "";
        expect(`${message} ${stack} ${causeText}`).not.toContain("secret-key");
    }
});

test("a refusal keeps DefiLlama's own words and what was asked, never the URL", async () => {
    const llama = createDefiLlama({
        url: "https://pro-api.llama.fi/SECRETKEY/coins",
        fetch: async () =>
            new Response(JSON.stringify({ message: "Too many requests" }), {
                status: 429,
                headers: { "retry-after": "60" },
            }),
    });
    const error = (await llama
        .chart({ ids: [ETH, USDC], end: 4, span: 4, period: "1h" })
        .catch((e: unknown) => e)) as LlamaError;
    expect(error.message).toBe('DefiLlama answered 429: "Too many requests" (2 coins, 4 points, every 1h)');
    expect(error.message).not.toContain("SECRETKEY");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(60_000);
});

test("a timeout and a refused connection are told apart", async () => {
    const timedOut = createDefiLlama({
        url: "https://coins.llama.fi",
        fetch: async () => {
            throw new DOMException("timed out", "TimeoutError");
        },
    });
    await expect(timedOut.chart({ ids: [ETH], end: 4, span: 4, period: "1h" })).rejects.toThrow(
        "DefiLlama didn't answer within 10 s (1 coins, 4 points, every 1h)",
    );
    const refused = createDefiLlama({
        url: "https://coins.llama.fi",
        fetch: async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        },
    });
    await expect(refused.chart({ ids: [ETH], end: 4, span: 4, period: "1h" })).rejects.toThrow(
        "Couldn't reach DefiLlama (ENOTFOUND)",
    );
});
