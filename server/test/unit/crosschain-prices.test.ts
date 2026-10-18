import { afterEach, expect, test, vi } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import { fixedPrices, lifiPrices } from "../../src/crosschain/prices.ts";

afterEach(() => vi.useRealTimers());

const ETH = coinByKey("ethereum:ETH");
const BNB_USDT = coinByKey("bnb:USDT");

type FetchInput = Parameters<typeof fetch>[0];

const priceResponse = (priceUSD: string) => new Response(JSON.stringify({ priceUSD }), { status: 200 });

test("two reads within the TTL make one request per coin", async () => {
    const fetch = vi.fn(async () => priceResponse("3000.5"));
    const feed = lifiPrices({ fetch });

    expect(await feed.usd([ETH, BNB_USDT])).toEqual(
        new Map([
            ["ethereum:ETH", 3000.5],
            ["bnb:USDT", 3000.5],
        ]),
    );
    await feed.usd([ETH, BNB_USDT]);

    expect(fetch).toHaveBeenCalledTimes(2);
});

test("a coin is read again once its TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async () => priceResponse("1"));
    const feed = lifiPrices({ fetch, ttlMs: 1000 });

    await feed.usd([ETH]);
    vi.advanceTimersByTime(999);
    await feed.usd([ETH]);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await feed.usd([ETH]);
    expect(fetch).toHaveBeenCalledTimes(2);
});

test("a failed lookup leaves the coin out, and the next read asks again", async () => {
    const fetch = vi.fn(async (input: FetchInput) =>
        String(input).includes("chain=56") ? new Response("down", { status: 500 }) : priceResponse("3000"),
    );
    const feed = lifiPrices({ fetch });

    expect(await feed.usd([ETH, BNB_USDT])).toEqual(new Map([["ethereum:ETH", 3000]]));
    await feed.usd([ETH, BNB_USDT]);

    expect(fetch).toHaveBeenCalledTimes(3);
});

test("a lookup that fails is logged with the coin and the status, once a minute per coin", async () => {
    const logger = { warn: vi.fn() };
    const fetch = vi.fn(async (_input: FetchInput) => new Response("down", { status: 429 }));
    const feed = lifiPrices({ fetch, logger });
    await feed.usd([ETH]);
    await feed.usd([ETH]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
        { op: "prices.lifi", coin: "ethereum:ETH", status: 429 },
        "Couldn't get a price from LI.FI",
    );
});

test("a lookup that throws, or answers without a usable price, leaves the coin out", async () => {
    const answers = [
        () => Promise.reject(new Error("offline")),
        async () => new Response("<html>", { status: 200 }),
        async () => new Response(JSON.stringify({}), { status: 200 }),
        async () => priceResponse("0"),
        async () => priceResponse("not a number"),
    ];
    for (const answer of answers) {
        expect(await lifiPrices({ fetch: vi.fn(answer) }).usd([ETH])).toEqual(new Map());
    }
});

test("the request names the coin's chain and token, or the zero address for a native coin", async () => {
    const fetch = vi.fn(async (_input: FetchInput) => priceResponse("1"));
    await lifiPrices({ fetch }).usd([BNB_USDT, ETH]);

    const searchOf = (chainId: number) => {
        const url = fetch.mock.calls
            .map(([input]) => new URL(String(input)))
            .find((u) => u.searchParams.get("chain") === String(chainId));
        expect(`${url?.origin}${url?.pathname}`).toBe("https://li.quest/v1/token");
        return url?.searchParams.get("token");
    };
    expect(searchOf(56)).toBe("0x55d398326f99059fF775485246999027B3197955");
    expect(searchOf(1)).toBe("0x0000000000000000000000000000000000000000");
});

test("fixed prices are keyed by symbol and cover every chain's coin of that symbol", async () => {
    const feed = fixedPrices({ ETH: 3000, USDT: 1 });
    expect(await feed.usd([ETH, coinByKey("ethereum:USDT"), BNB_USDT, coinByKey("arc:USDC")])).toEqual(
        new Map([
            ["ethereum:ETH", 3000],
            ["ethereum:USDT", 1],
            ["bnb:USDT", 1],
        ]),
    );
});

test("Solana coins are priced on LI.FI's Solana chain, by mint or the system program for SOL", async () => {
    const fetch = vi.fn(async (_input: FetchInput) => priceResponse("1"));

    await lifiPrices({ fetch }).usd([coinByKey("solana:USDC"), coinByKey("solana:SOL")]);

    const urls = fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams);
    expect(urls.map((q) => [q.get("chain"), q.get("token")])).toEqual([
        ["1151111081099710", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        ["1151111081099710", "11111111111111111111111111111111"],
    ]);
});
