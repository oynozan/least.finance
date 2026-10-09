import { expect, test } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import type { BridgeProvider, Quote, QuoteRequest } from "../../src/crosschain/providers/types.ts";
import { bestQuote } from "../../src/crosschain/quotes.ts";

const ETH = coinByKey("ethereum:ETH");
const ARC_USDC_VIEW = "0x3600000000000000000000000000000000000000";
const LOOKALIKE_USDC = "0x1111111111111111111111111111111111111111";
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";
const SOMEONE_ELSE = "0x0000000000000000000000000000000000000bad";

const request: QuoteRequest = {
    coin: ETH,
    amount: 10n ** 18n,
    sender: WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: WALLET,
};

const quote = (overrides: Partial<Quote> = {}): Quote => ({
    provider: "stub",
    ref: "ref",
    coin: ETH.key,
    amountIn: request.amount,
    usdcOut: 3000n * 10n ** 18n,
    etaSeconds: 30,
    destinationToken: ARC_USDC_VIEW,
    recipient: request.recipient,
    refundTo: request.refundTo,
    txs: [{ chainId: ETH.chainId, to: "0x00000000000000000000000000000000000b01d0", data: "0x", value: 10n ** 18n }],
    ...overrides,
});

const stub = (name: string, make: (signal: AbortSignal) => Promise<Quote>): BridgeProvider => ({
    name,
    supports: () => true,
    quote: (_request, signal) => make(signal),
    status: async () => ({ stage: "waiting" }),
});

const quoting = (name: string, overrides: Partial<Quote> = {}) =>
    stub(name, async () => quote({ provider: name, ...overrides }));

test("the best USDC output wins, and a tie goes to the faster route", async () => {
    const providers = [
        quoting("low", { usdcOut: 2990n * 10n ** 18n, etaSeconds: 5 }),
        quoting("slow", { usdcOut: 3000n * 10n ** 18n, etaSeconds: 60 }),
        quoting("fast", { usdcOut: 3000n * 10n ** 18n, etaSeconds: 20 }),
    ];

    expect((await bestQuote(providers, request)).provider).toBe("fast");
});

test("a provider slower than the timeout is left out", async () => {
    let slowSignal: AbortSignal | undefined;
    const slow = stub("slow", (signal) => {
        slowSignal = signal;
        return new Promise((resolve) =>
            setTimeout(() => resolve(quote({ provider: "slow", usdcOut: 9n * 10n ** 21n })), 500),
        );
    });
    const quick = quoting("quick", { usdcOut: 2000n * 10n ** 18n });

    const best = await bestQuote([slow, quick], request, { timeoutMs: 50 });

    expect(best.provider).toBe("quick");
    expect(slowSignal?.aborted).toBe(true);
});

test("a quote paying a lookalike USDC is dropped even when it pays the most", async () => {
    const providers = [
        quoting("lookalike", { destinationToken: LOOKALIKE_USDC, usdcOut: 9n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request)).provider).toBe("honest");
});

test("a quote paying someone else, or refunding someone else, is dropped", async () => {
    const providers = [
        quoting("pays-other", { recipient: SOMEONE_ELSE, usdcOut: 9n * 10n ** 21n }),
        quoting("refunds-other", { refundTo: SOMEONE_ELSE, usdcOut: 8n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request)).provider).toBe("honest");
});

test("a transaction on another chain is dropped", async () => {
    const [tx] = quote().txs;
    const providers = [
        quoting("wrong-chain", { txs: [tx!, { ...tx!, chainId: 56 }], usdcOut: 9n * 10n ** 21n }),
        quoting("right-chain", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request)).provider).toBe("right-chain");
});

test("no usable quote is an unavailable error", async () => {
    const providers = [
        quoting("pays-nothing", { usdcOut: 0n }),
        stub("down", () => Promise.reject(new Error("boom"))),
        { ...quoting("unsupported"), supports: () => false },
    ];

    await expect(bestQuote(providers, request)).rejects.toMatchObject({
        code: "unavailable",
        message: "No route for this deposit right now.",
    });
    await expect(bestQuote([], request)).rejects.toMatchObject({ code: "unavailable" });
});
