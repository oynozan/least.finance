import { readFileSync } from "node:fs";
import { zeroAddress } from "viem";
import { expect, test } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import { createRelay } from "../../src/crosschain/providers/relay.ts";
import type { QuoteRequest, SourceTx } from "../../src/crosschain/providers/types.ts";
import { checkQuote } from "../../src/crosschain/quotes.ts";

const ARC_USDC_VIEW = "0x3600000000000000000000000000000000000000";
const FEE_KEY = /fee|referr|affiliate/i;

// The addresses the fixtures were recorded for
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";

const ETH = coinByKey("ethereum:ETH");
const BNB_USDT = coinByKey("bnb:USDT");
const SOL = coinByKey("solana:SOL");
const SOL_USDC = coinByKey("solana:USDC");

const SOLANA_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const SOLANA_USDC_REQUEST: QuoteRequest = {
    coin: SOL_USDC,
    amount: 10_000_000n,
    sender: SOLANA_WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: SOLANA_WALLET,
};
const SOL_REQUEST: QuoteRequest = { ...SOLANA_USDC_REQUEST, coin: SOL, amount: 100_000_000n };
const ALLOWED = [DEPOSITORY, "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"];

const ETH_REQUEST: QuoteRequest = {
    coin: ETH,
    amount: 10n ** 16n,
    sender: WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: WALLET,
};
const USDT_REQUEST: QuoteRequest = { ...ETH_REQUEST, coin: BNB_USDT, amount: 10n * 10n ** 18n };

// The quote's transactions, each narrowed to an EVM one
const evmTxs = (quote: { txs: SourceTx[] }) =>
    quote.txs.map((tx) => {
        if (tx.kind !== "evm") throw new Error("expected an EVM transaction");
        return tx;
    });

const fixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/relay/${name}.json`, import.meta.url), "utf8"));

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

    await createRelay({ fetch }).quote(ETH_REQUEST, signal());

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.href).toBe("https://api.relay.link/quote/v2");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
        user: WALLET,
        recipient: DEPOSIT_ADDRESS,
        refundTo: WALLET,
        originChainId: 1,
        destinationChainId: 5042,
        originCurrency: zeroAddress,
        destinationCurrency: ARC_USDC_VIEW,
        amount: "10000000000000000",
        tradeType: "EXACT_INPUT",
    });
    expect(Object.keys(body).filter((key) => FEE_KEY.test(key))).toEqual([]);
    expect(Object.keys(init.headers ?? {}).filter((key) => FEE_KEY.test(key))).toEqual([]);
});

test("a token is asked for by its contract, and the key and base URL are used when given", async () => {
    const { fetch, calls } = serving(fixture("quote-bnb-usdt"));

    await createRelay({ apiKey: "secret", baseUrl: "http://relay.test", fetch }).quote(USDT_REQUEST, signal());

    const { url, init } = calls[0]!;
    expect(url.href).toBe("http://relay.test/quote/v2");
    expect(init.headers).toMatchObject({ "x-api-key": "secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({
        originChainId: 56,
        originCurrency: BNB_USDT.token,
        amount: "10000000000000000000",
    });

    const keyless = serving(fixture("quote-bnb-usdt"));
    await createRelay({ fetch: keyless.fetch }).quote(USDT_REQUEST, signal());
    expect(Object.keys(keyless.calls[0]!.init.headers ?? {})).not.toContain("x-api-key");
});

test("the quote is in Arc wei, with transactions in signing order", async () => {
    const { fetch } = serving(fixture("quote-bnb-usdt"));

    const quote = await createRelay({ fetch }).quote(USDT_REQUEST, signal());

    expect(quote.provider).toBe("relay");
    expect(quote.ref).toBe(fixture("quote-bnb-usdt").steps[0].requestId);
    // 10 USDT in is about 10 USDC out, and Relay counts USDC on Arc in 6 decimals
    expect(quote.usdcOut).toBeGreaterThan(9n * 10n ** 18n);
    expect(quote.usdcOut).toBeLessThan(11n * 10n ** 18n);
    expect(quote.usdcOut % 10n ** 12n).toBe(0n);
    expect(quote.etaSeconds).toBeGreaterThan(0);

    expect(evmTxs(quote).map((tx) => tx.chainId)).toEqual([56, 56]);
    const [approval, deposit] = evmTxs(quote);
    expect(approval!.to.toLowerCase()).toBe(BNB_USDT.token!.toLowerCase());
    expect(approval!.data.startsWith("0x095ea7b3")).toBe(true);
    expect(deposit!.to.toLowerCase()).not.toBe(BNB_USDT.token!.toLowerCase());
    expect([approval!.value, deposit!.value]).toEqual([0n, 0n]);
});

test("a native coin is sent as the transaction's value", async () => {
    const { fetch } = serving(fixture("quote-eth"));

    const quote = await createRelay({ fetch }).quote(ETH_REQUEST, signal());

    expect(quote.txs).toHaveLength(1);
    expect(quote.txs[0]).toMatchObject({ chainId: 1, value: 10n ** 16n });
});

test("the quote says what Relay will do, so the checks can hold it to the request", async () => {
    const { fetch } = serving(fixture("quote-bnb-usdt"));
    const quote = await createRelay({ fetch }).quote(USDT_REQUEST, signal());

    expect(quote).toMatchObject({
        coin: "bnb:USDT",
        amountIn: USDT_REQUEST.amount,
        recipient: DEPOSIT_ADDRESS,
        refundTo: WALLET,
        destinationToken: ARC_USDC_VIEW,
    });
    expect(checkQuote(quote, USDT_REQUEST, [])).toBe(true);

    const elsewhere = fixture("quote-bnb-usdt");
    elsewhere.details.recipient = "0x0000000000000000000000000000000000000bad";
    const tampered = await createRelay({ fetch: serving(elsewhere).fetch }).quote(USDT_REQUEST, signal());
    expect(checkQuote(tampered, USDT_REQUEST, [])).toBe(false);
});

test("a quote Relay can't give, or can't be signed as transactions, is an error", async () => {
    await expect(
        createRelay({ fetch: serving({ message: "no route" }, 400).fetch }).quote(ETH_REQUEST, signal()),
    ).rejects.toThrow(/400/);

    const signing = fixture("quote-eth");
    signing.steps[0].kind = "signature";
    await expect(createRelay({ fetch: serving(signing).fetch }).quote(ETH_REQUEST, signal())).rejects.toThrow();
});

test("it supports the Ethereum, BNB Chain and Solana coins, not Arc", () => {
    const relay = createRelay({});

    expect(relay.name).toBe("relay");
    expect(relay.supports(coinByKey("ethereum:USDC"))).toBe(true);
    expect(relay.supports(coinByKey("bnb:BNB"))).toBe(true);
    expect(relay.supports(coinByKey("arc:USDC"))).toBe(false);
    expect(relay.supports(coinByKey("solana:SOL"))).toBe(true);
});

test("each status maps to a stage", async () => {
    const REF = "0x179156429202aa755b4c9c25b4fc8065fcc2d613770e06cb89bf3327f86e355b";
    const stage = async (body: unknown) => {
        const { fetch, calls } = serving(body);
        const status = await createRelay({ apiKey: "secret", fetch }).status({ ref: REF }, null, ETH);
        expect(calls[0]!.url.pathname + calls[0]!.url.search).toBe(`/intents/status/v3?requestId=${REF}`);
        expect(calls[0]!.init.headers).toMatchObject({ "x-api-key": "secret" });
        return status;
    };

    expect(await stage({ status: "waiting" })).toEqual({ stage: "waiting" });
    for (const status of ["pending", "depositing", "submitted", "delayed"]) {
        expect(await stage({ status })).toEqual({ stage: "pending" });
    }
    expect(await stage(fixture("status-filled"))).toEqual({
        stage: "filled",
        fillTxHash: fixture("status-filled").txHashes[0],
    });
    expect(await stage({ status: "refund", txHashes: ["0x" + "ab".repeat(32)] })).toEqual({ stage: "refunded" });
    expect(await stage({ status: "failure" })).toEqual({ stage: "failed" });
});

test("a status Relay doesn't know, or can't answer, is an error rather than a guess", async () => {
    const ask = (body: unknown, status = 200) =>
        createRelay({ fetch: serving(body, status).fetch }).status({ ref: "0x01" }, null, ETH);

    await expect(ask({ status: "unknown" })).rejects.toThrow();
    await expect(ask({ message: "down" }, 503)).rejects.toThrow(/503/);
});

test("a Solana USDC request uses chain 792703809, the USDC mint, includeComputeUnitLimit true and the wallet as user and refundTo", async () => {
    const { fetch, calls } = serving(fixture("quote-solana-usdc"));

    await createRelay({ fetch }).quote(SOLANA_USDC_REQUEST, signal());

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        user: SOLANA_WALLET,
        recipient: DEPOSIT_ADDRESS,
        refundTo: SOLANA_WALLET,
        originChainId: 792703809,
        destinationChainId: 5042,
        originCurrency: SOL_USDC.mint,
        destinationCurrency: ARC_USDC_VIEW,
        amount: "10000000",
        tradeType: "EXACT_INPUT",
        includeComputeUnitLimit: true,
    });
});

test("a SOL request uses 11111111111111111111111111111111 as originCurrency", async () => {
    const { fetch, calls } = serving(fixture("quote-solana-sol"));

    const quote = await createRelay({ fetch }).quote(SOL_REQUEST, signal());

    expect(JSON.parse(String(calls[0]!.init.body)).originCurrency).toBe("11111111111111111111111111111111");
    expect(quote.coin).toBe("solana:SOL");
    expect(checkQuote(quote, SOL_REQUEST, ALLOWED)).toBe(true);
});

test("the Solana fixture parses into one kind: solana transaction with its instructions and lookup tables", async () => {
    const { fetch } = serving(fixture("quote-solana-usdc"));

    const quote = await createRelay({ fetch }).quote(SOLANA_USDC_REQUEST, signal());

    expect(quote.refundTo).toBe(SOLANA_WALLET);
    expect(quote.coin).toBe("solana:USDC");
    expect(quote.usdcOut).toBe(9_980_000n * 10n ** 12n);
    expect(quote.txs).toHaveLength(1);
    const [tx] = quote.txs;
    expect(tx).toMatchObject({ kind: "solana", lookupTables: ["4sKLJ1Qoudh8PJyqBeuKocYdsZvxTcRShUt9aKqwhgvC"] });
    if (tx?.kind !== "solana") throw new Error("not a Solana transaction");
    expect(tx.instructions.map((ix) => ix.programId)).toEqual([
        "ComputeBudget111111111111111111111111111111",
        DEPOSITORY,
    ]);
    expect(tx.instructions[1]).toMatchObject({
        keys: [{ pubkey: SOLANA_WALLET, isSigner: true, isWritable: true }, expect.anything()],
        data: "0xa1b2c3d40000000000000000",
    });
    expect(checkQuote(quote, SOLANA_USDC_REQUEST, ALLOWED)).toBe(true);
});

test("uppercase hex instruction data from Relay is lowercased", async () => {
    const body = JSON.parse(JSON.stringify(fixture("quote-solana-usdc")));
    const item = body.steps[0].items[0].data.instructions[1];
    item.data = "A1B2C3D40000000000000000";
    const quote = await createRelay({ fetch: serving(body).fetch }).quote(SOLANA_USDC_REQUEST, signal());

    const [tx] = quote.txs;
    if (tx?.kind !== "solana") throw new Error("not a Solana transaction");
    expect(tx.instructions[1]?.data).toBe("0xa1b2c3d40000000000000000");
});

test("supports accepts solana:SOL and solana:USDC", () => {
    const relay = createRelay({});

    expect(relay.supports(SOL)).toBe(true);
    expect(relay.supports(SOL_USDC)).toBe(true);
});

test("SOLANA_TX_TOO_LARGE becomes unavailable with the 'Try a smaller route' message", async () => {
    const body = { message: "Transaction too large", errorCode: "SOLANA_TX_TOO_LARGE" };

    await expect(
        createRelay({ fetch: serving(body, 400).fetch }).quote(SOLANA_USDC_REQUEST, signal()),
    ).rejects.toMatchObject({
        code: "unavailable",
        message: "This deposit can't be sent from Solana right now. Try a smaller route.",
    });
});

test("status needs only the requestId for a Solana order", async () => {
    const { fetch, calls } = serving({ status: "pending" });

    const status = await createRelay({ fetch }).status({ ref: "0xab" }, null, SOL_USDC);

    expect(status).toEqual({ stage: "pending" });
    expect(calls[0]!.url.search).toBe("?requestId=0xab");
});
