import { readFileSync } from "node:fs";
import { zeroAddress } from "viem";
import { expect, test } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import { createAcross } from "../../src/crosschain/providers/across.ts";
import type { QuoteRequest } from "../../src/crosschain/providers/types.ts";
import { checkQuote } from "../../src/crosschain/quotes.ts";

const ARC_USDC_VIEW = "0x3600000000000000000000000000000000000000";
const FEE_KEY = /fee|referr|affiliate/i;

// The addresses the fixtures were recorded for
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";

const ETH = coinByKey("ethereum:ETH");
const BNB_USDT = coinByKey("bnb:USDT");

const ETH_REQUEST: QuoteRequest = {
    coin: ETH,
    amount: 10n ** 16n,
    sender: WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: WALLET,
};
const USDT_REQUEST: QuoteRequest = { ...ETH_REQUEST, coin: BNB_USDT, amount: 10n * 10n ** 18n };

const fixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/across/${name}.json`, import.meta.url), "utf8"));

// A fetch that answers every call with the body and notes what it was asked
function serving(body: unknown, status = 200) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const stub: typeof fetch = async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init ?? {} });
        return Response.json(body, { status });
    };
    return { fetch: stub, calls };
}

const signal = () => new AbortController().signal;

test("the request pays the account on Arc, refunds the wallet, and carries no fee", async () => {
    const { fetch, calls } = serving(fixture("quote-eth"));

    await createAcross({ fetch }).quote(ETH_REQUEST, signal());

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://app.across.to/api/swap/approval");
    expect(init.method ?? "GET").toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual({
        tradeType: "exactInput",
        amount: "10000000000000000",
        inputToken: zeroAddress,
        outputToken: ARC_USDC_VIEW,
        originChainId: "1",
        destinationChainId: "5042",
        depositor: WALLET,
        recipient: DEPOSIT_ADDRESS,
        refundAddress: WALLET,
    });
    expect([...url.searchParams.keys()].filter((key) => FEE_KEY.test(key))).toEqual([]);
});

test("a token is asked for by its contract, and the integrator ID and base URL are used when given", async () => {
    const { fetch, calls } = serving(fixture("quote-bnb-usdt"));

    await createAcross({ integratorId: "0xabcd", baseUrl: "http://across.test", fetch }).quote(USDT_REQUEST, signal());

    const { url } = calls[0]!;
    expect(url.origin + url.pathname).toBe("http://across.test/api/swap/approval");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
        integratorId: "0xabcd",
        originChainId: "56",
        inputToken: BNB_USDT.token,
        amount: "10000000000000000000",
    });
    expect([...url.searchParams.keys()].filter((key) => FEE_KEY.test(key))).toEqual([]);

    const anonymous = serving(fixture("quote-bnb-usdt"));
    await createAcross({ fetch: anonymous.fetch }).quote(USDT_REQUEST, signal());
    expect(anonymous.calls[0]!.url.searchParams.has("integratorId")).toBe(false);
});

test("the API key goes in a Bearer header on quotes and statuses, and is left out without one", async () => {
    const hash = `0x${"cd".repeat(32)}` as const;
    const keyed = serving(fixture("quote-eth"));
    const across = createAcross({ apiKey: "across-key", fetch: keyed.fetch });
    await across.quote(ETH_REQUEST, signal());
    await across.status({ ref: "r" }, hash, ETH).catch(() => undefined);
    expect(keyed.calls.map(({ init }) => new Headers(init.headers).get("authorization"))).toEqual([
        "Bearer across-key",
        "Bearer across-key",
    ]);
    expect(keyed.calls[0]!.url.searchParams.has("apiKey")).toBe(false);

    const anonymous = serving(fixture("quote-eth"));
    await createAcross({ fetch: anonymous.fetch }).quote(ETH_REQUEST, signal());
    expect(new Headers(anonymous.calls[0]!.init.headers).has("authorization")).toBe(false);
});

test("the quote is in Arc wei, with transactions in signing order", async () => {
    const { fetch } = serving(fixture("quote-bnb-usdt"));

    const quote = await createAcross({ fetch }).quote(USDT_REQUEST, signal());

    expect(quote.provider).toBe("across");
    expect(quote.ref).toBe(fixture("quote-bnb-usdt").id);
    // 10 USDT in is about 10 USDC out, and Across counts USDC on Arc in 6 decimals
    expect(quote.usdcOut).toBeGreaterThan(9n * 10n ** 18n);
    expect(quote.usdcOut).toBeLessThan(11n * 10n ** 18n);
    expect(quote.usdcOut % 10n ** 12n).toBe(0n);
    expect(quote.etaSeconds).toBeGreaterThan(0);

    expect(quote.txs.map((tx) => tx.chainId)).toEqual([56, 56]);
    const [approval, swap] = quote.txs;
    expect(approval!.to.toLowerCase()).toBe(BNB_USDT.token!.toLowerCase());
    expect(approval!.data.startsWith("0x095ea7b3")).toBe(true);
    expect(swap!.data).toBe(fixture("quote-bnb-usdt").swapTx.data);
    expect([approval!.value, swap!.value]).toEqual([0n, 0n]);
});

test("a native coin is sent as the transaction's value, with nothing to approve", async () => {
    const { fetch } = serving(fixture("quote-eth"));

    const quote = await createAcross({ fetch }).quote(ETH_REQUEST, signal());

    expect(quote.txs).toHaveLength(1);
    expect(quote.txs[0]).toMatchObject({ chainId: 1, value: 10n ** 16n });
});

test("the quote says what Across will do, so the checks can hold it to the request", async () => {
    const { fetch } = serving(fixture("quote-bnb-usdt"));
    const quote = await createAcross({ fetch }).quote(USDT_REQUEST, signal());

    expect(quote).toMatchObject({
        coin: "bnb:USDT",
        amountIn: USDT_REQUEST.amount,
        recipient: DEPOSIT_ADDRESS,
        refundTo: WALLET,
        destinationToken: ARC_USDC_VIEW,
    });
    expect(checkQuote(quote, USDT_REQUEST)).toBe(true);

    const other = fixture("quote-bnb-usdt");
    other.inputAmount = "1";
    const tampered = await createAcross({ fetch: serving(other).fetch }).quote(USDT_REQUEST, signal());
    expect(checkQuote(tampered, USDT_REQUEST)).toBe(false);
});

test("a quote whose transaction doesn't carry the account's address as the recipient is an error", async () => {
    // Across doesn't say who is paid, so the only place to see it is the calldata
    const elsewhere = fixture("quote-eth");
    elsewhere.swapTx.data = elsewhere.swapTx.data.replaceAll(DEPOSIT_ADDRESS.slice(2), "0".repeat(37) + "bad");

    await expect(createAcross({ fetch: serving(elsewhere).fetch }).quote(ETH_REQUEST, signal())).rejects.toThrow(
        /recipient/,
    );
});

test("a quote Across can't give is an error", async () => {
    await expect(
        createAcross({ fetch: serving({ message: "no route" }, 400).fetch }).quote(ETH_REQUEST, signal()),
    ).rejects.toThrow(/400/);
});

test("it supports the Ethereum and BNB Chain coins only", () => {
    const across = createAcross({});

    expect(across.name).toBe("across");
    expect(across.supports(coinByKey("ethereum:USDT"))).toBe(true);
    expect(across.supports(coinByKey("bnb:USDC"))).toBe(true);
    expect(across.supports(coinByKey("arc:USDC"))).toBe(false);
    expect(across.supports(coinByKey("solana:SOL"))).toBe(false);
});

test("each status maps to a stage", async () => {
    const HASH = "0x20e25fd9ac63939066c4c5ddd52c13b8682bf2d39653f761af428c1f68c9b851";
    const stage = async (body: unknown, httpStatus = 200) => {
        const { fetch, calls } = serving(body, httpStatus);
        const status = await createAcross({ fetch }).status({ ref: "ignored" }, HASH, BNB_USDT);
        expect(calls[0]!.url.pathname + calls[0]!.url.search).toBe(
            `/api/deposit/status?originChainId=56&depositTxHash=${HASH}`,
        );
        return status;
    };

    expect(await stage({ status: "pending" })).toEqual({ stage: "pending" });
    expect(await stage(fixture("status-filled"))).toEqual({
        stage: "filled",
        fillTxHash: fixture("status-filled").fillTx,
    });
    expect(await stage({ status: "refunded" })).toEqual({ stage: "refunded" });
    expect(await stage({ status: "expired" })).toEqual({ stage: "failed" });
});

test("a deposit that hasn't been reported, or that Across hasn't seen yet, is waiting", async () => {
    const unreported = serving({});
    expect(await createAcross({ fetch: unreported.fetch }).status({ ref: "r" }, null, ETH)).toEqual({
        stage: "waiting",
    });
    expect(unreported.calls).toHaveLength(0);

    const unseen = serving({ error: "DepositNotFoundException", message: "Deposit not found" }, 404);
    const hash = `0x${"cd".repeat(32)}` as const;
    expect(await createAcross({ fetch: unseen.fetch }).status({ ref: "r" }, hash, ETH)).toEqual({ stage: "waiting" });
});

test("a status Across doesn't know, or can't answer, is an error rather than a guess", async () => {
    const hash = `0x${"cd".repeat(32)}` as const;
    const ask = (body: unknown, status = 200) =>
        createAcross({ fetch: serving(body, status).fetch }).status({ ref: "r" }, hash, ETH);

    await expect(ask({ status: "slowFillRequested" })).rejects.toThrow();
    await expect(ask({ error: "UnknownError" }, 500)).rejects.toThrow(/500/);
});
