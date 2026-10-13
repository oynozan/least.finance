import { afterEach, expect, test } from "vitest";
import { createLifi, LifiError, type LifiQuoteRequest } from "../../src/swaps/lifi.ts";
import { solanaFeePayer } from "../../src/swaps/solana-tx.ts";
import { COINS, NATIVE_EVM, type NetworkId } from "../../src/swaps/coins.ts";
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

const BASE_ID = 8453;
const BASE_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const WALLET = "0x1111111111111111111111111111111111111111";
const SOLANA_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const addressOf = (symbol: string, network: NetworkId) =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((entry) => entry.network === network)!.address;

const baseRequest = (patch: Partial<LifiQuoteRequest> = {}): LifiQuoteRequest => ({
    fromChain: BASE_ID,
    toChain: BASE_ID,
    fromToken: addressOf("USDC", "base"),
    toToken: addressOf("USDT", "base"),
    fromAddress: WALLET,
    toAddress: WALLET,
    fromAmount: "50000000",
    slippage: 0.005,
    integrator: "least-finance",
    ...patch,
});

const quoteFrom = (url: string, status: number, body: unknown) =>
    createLifi({ url, fetch: async () => Response.json(body, { status }) }).quote(baseRequest());

test("a quote parses into LifiQuote", async () => {
    fake = await startFakeLifi({ prices: { USDC: 1, USDT: 1 } });
    const lifi = createLifi({ url: fake.url, apiKey: "k" });
    const request = baseRequest();

    const quote = await lifi.quote(request);

    expect(fake.quotes).toEqual([request]);
    expect(fake.requests).toEqual([
        `GET /v1/quote?fromChain=8453&toChain=8453&fromToken=${request.fromToken}&toToken=${request.toToken}&fromAddress=${WALLET}&toAddress=${WALLET}&fromAmount=50000000&slippage=0.005&integrator=least-finance`,
    ]);
    expect(fake.keys).toEqual(["k"]);
    expect(quote).toEqual({
        id: expect.any(String),
        tool: "fakebridge",
        toolName: expect.any(String),
        fromChainId: BASE_ID,
        toChainId: BASE_ID,
        fromToken: request.fromToken,
        toToken: request.toToken,
        fromAddress: WALLET,
        toAddress: WALLET,
        fromAmount: "50000000",
        toAmount: "49875000",
        toAmountMin: "49625625",
        approvalAddress: BASE_DIAMOND,
        skipApproval: false,
        etaSeconds: expect.any(Number),
        fees: [{ name: expect.any(String), amountUSD: 0.125, included: true, amount: "0", token: "" }],
        gasUSD: expect.any(Number),
        tx: {
            kind: "evm",
            chainId: BASE_ID,
            from: WALLET,
            to: BASE_DIAMOND,
            data: expect.stringMatching(/^0x/),
            value: "0",
        },
    });
    expect(quote.gasUSD).toBeGreaterThan(0);
    expect(quote.etaSeconds).toBeGreaterThan(0);
});

test("the quote carries the fee only when it is above 0", async () => {
    fake = await startFakeLifi({ prices: { USDC: 1, USDT: 1 } });
    const lifi = createLifi({ url: fake.url });

    await lifi.quote(baseRequest({ fee: 0 }));
    await lifi.quote(baseRequest({ fee: 0.01 }));

    expect(fake.requests[0]).not.toContain("fee=");
    expect(fake.requests[1]).toMatch(/&integrator=least-finance&fee=0\.01$/);
    expect(fake.keys).toEqual([null, null]);
});

test("a native input skips the approval and sends its amount as the value", async () => {
    fake = await startFakeLifi({ prices: { ETH: 3210.4, USDC: 1 } });
    const lifi = createLifi({ url: fake.url });

    const quote = await lifi.quote(
        baseRequest({ fromToken: NATIVE_EVM, toToken: addressOf("USDC", "base"), fromAmount: "10000000000000000" }),
    );

    expect(quote.skipApproval).toBe(true);
    expect(quote.tx).toMatchObject({ kind: "evm", value: "10000000000000000" });
    // 0.01 ETH at 3210.4 is 32.104 USD, less the 0.25% fee
    expect(quote.toAmount).toBe("32023740");
});

test("a Solana input carries the recorded transaction paid by the wallet", async () => {
    fake = await startFakeLifi({ prices: { SOL: 147.2, USDC: 1 } });
    const lifi = createLifi({ url: fake.url });
    const solana = 1151111081099710;

    const quote = await lifi.quote(
        baseRequest({
            fromChain: solana,
            toChain: solana,
            fromToken: addressOf("SOL", "solana"),
            toToken: addressOf("USDC", "solana"),
            fromAddress: SOLANA_WALLET,
            toAddress: SOLANA_WALLET,
            fromAmount: "1000000000",
        }),
    );

    expect(quote.tx.kind).toBe("solana");
    expect(solanaFeePayer(quote.tx.data)).toBe(SOLANA_WALLET);
    expect(quote.approvalAddress).toBeNull();
});

test("no route is LifiError no_route", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });

    fake.noRoute();
    await expect(lifi.quote(baseRequest())).rejects.toMatchObject({ name: "LifiError", kind: "no_route" });
    await expect(lifi.quote(baseRequest())).resolves.toMatchObject({ tool: "fakebridge" });

    // LI.FI's own codes for no route and for a tool that can't serve it
    for (const code of [1002, 1011]) {
        await expect(quoteFrom("http://lifi.test", 400, { code, message: "No route" })).rejects.toMatchObject({
            kind: "no_route",
        });
    }
    await expect(quoteFrom("http://lifi.test", 404, { message: "Not found" })).rejects.toMatchObject({
        kind: "no_route",
    });
    await expect(quoteFrom("http://lifi.test", 400, { code: 1000, message: "Bad" })).rejects.toMatchObject({
        kind: "unavailable",
    });
    expect(new LifiError("no_route", "x")).toBeInstanceOf(Error);
});

test("a 429 is rate_limited", async () => {
    await expect(quoteFrom("http://lifi.test", 429, { message: "Slow down" })).rejects.toMatchObject({
        kind: "rate_limited",
    });
});

test("a failing, slow or unreadable LI.FI is unavailable", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });

    fake.failNext("/v1/quote");
    await expect(lifi.quote(baseRequest())).rejects.toMatchObject({ kind: "unavailable" });

    await expect(quoteFrom("http://lifi.test", 200, { tool: "x" })).rejects.toMatchObject({ kind: "unavailable" });

    const slow = createLifi({
        url: "http://lifi.test",
        timeoutMs: 20,
        fetch: (_input, init) =>
            new Promise((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
    });
    await expect(slow.quote(baseRequest())).rejects.toBeInstanceOf(LifiError);
    await expect(slow.quote(baseRequest())).rejects.toMatchObject({ kind: "unavailable" });
});

const DONE = {
    status: "DONE",
    substatus: "COMPLETED",
    fromAddress: WALLET,
    toAddress: WALLET,
    tool: "fakebridge",
    sending: { txHash: "0xaaa", chainId: BASE_ID },
    receiving: {
        txHash: "0xbbb",
        chainId: 1,
        amount: "49875000",
        token: { address: addressOf("USDC", "ethereum"), symbol: "USDC", decimals: 6, chainId: 1 },
    },
};

test("status DONE with receiving parses, and a 404 is NOT_FOUND", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url, apiKey: "k" });
    const ask = { txHash: "0xaaa", fromChain: BASE_ID, toChain: 1, bridge: "fakebridge" };
    fake.setStatus("0xaaa", DONE);

    expect(await lifi.status(ask)).toEqual({
        status: "DONE",
        substatus: "COMPLETED",
        sendingTxHash: "0xaaa",
        fromAddress: WALLET,
        toAddress: WALLET,
        receiving: {
            txHash: "0xbbb",
            amount: "49875000",
            tokenAddress: addressOf("USDC", "ethereum"),
            tokenSymbol: "USDC",
            decimals: 6,
            chainId: 1,
        },
    });
    expect(fake.requests).toEqual(["GET /v1/status?txHash=0xaaa&fromChain=8453&toChain=1&bridge=fakebridge"]);
    expect(fake.keys).toEqual(["k"]);

    expect(await lifi.status({ ...ask, txHash: "0xunknown" })).toEqual({
        status: "NOT_FOUND",
        substatus: null,
        sendingTxHash: null,
        fromAddress: null,
        toAddress: null,
        receiving: null,
    });
});

test("a pending status has no receiving amount yet", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });
    fake.setStatus("0xaaa", {
        status: "PENDING",
        substatus: "WAIT_DESTINATION_TRANSACTION",
        sending: { txHash: "0xaaa", chainId: BASE_ID },
        receiving: { chainId: 1 },
    });

    expect(await lifi.status({ txHash: "0xaaa", fromChain: BASE_ID, toChain: 1, bridge: "fakebridge" })).toMatchObject({
        status: "PENDING",
        substatus: "WAIT_DESTINATION_TRANSACTION",
        sendingTxHash: "0xaaa",
        receiving: null,
    });
});

test("a failing status read is unavailable, and an unknown status is too", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });
    const ask = { txHash: "0xaaa", fromChain: BASE_ID, toChain: 1, bridge: "fakebridge" };

    fake.failNext("/v1/status");
    await expect(lifi.status(ask)).rejects.toMatchObject({ kind: "unavailable" });

    fake.setStatus("0xaaa", { status: "SOMETHING_NEW" });
    await expect(lifi.status(ask)).rejects.toMatchObject({ kind: "unavailable" });
});

test("chains list the diamonds and are cached for an hour", async () => {
    fake = await startFakeLifi();
    let now = 1_000_000;
    const lifi = createLifi({ url: fake.url, apiKey: "k", now: () => now });

    const chains = await lifi.chains();

    expect(chains).toContainEqual({ id: BASE_ID, diamondAddress: BASE_DIAMOND });
    expect(chains).toContainEqual({ id: 1151111081099710, diamondAddress: null });
    expect(fake.requests).toEqual(["GET /v1/chains?chainTypes=EVM,SVM"]);
    expect(fake.keys).toEqual(["k"]);

    now += 3_599_000;
    await lifi.chains();
    expect(fake.requests).toHaveLength(1);

    now += 2_000;
    await lifi.chains();
    expect(fake.requests).toHaveLength(2);
});

test("a failed chains read is not cached", async () => {
    fake = await startFakeLifi();
    const lifi = createLifi({ url: fake.url });

    fake.failNext("/v1/chains");
    await expect(lifi.chains()).rejects.toMatchObject({ kind: "unavailable" });
    expect(await lifi.chains()).not.toHaveLength(0);
});
