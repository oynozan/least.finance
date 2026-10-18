import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { checkQuote, QuoteRejected } from "../../src/swaps/check.ts";
import { COINS, NATIVE_EVM, NETWORKS, type CoinEntry, type NetworkId } from "../../src/swaps/coins.ts";
import { createLifi, type LifiQuote } from "../../src/swaps/lifi.ts";
import { solanaFeePayer } from "../../src/swaps/solana-tx.ts";
import { startFakeLifi, type FakeLifi } from "../support/fake-lifi.ts";

type Want = Parameters<typeof checkQuote>[1];
type Logged = Parameters<typeof checkQuote>[2];
const quiet = { warn: () => undefined };
const check = (quote: LifiQuote, want: Want, logger: Logged = quiet) => checkQuote(quote, want, logger);

const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const ARC_DIAMOND = "0xA4072583658Fae592A3506A42431cb6316a8d40b";
const WALLET = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const SOLANA_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOLANA_OTHER = "11111111111111111111111111111112";

const entryOf = (symbol: string, network: NetworkId): CoinEntry =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((entry) => entry.network === network)!;
const chainOf = (network: NetworkId) => NETWORKS.find((candidate) => candidate.id === network)!.chainId;

let fake: FakeLifi;
beforeAll(async () => {
    fake = await startFakeLifi({ prices: { ETH: 3210.4, SOL: 147.2, USDC: 1, USDT: 1 } });
});
afterAll(() => fake.stop());

/** A quote from the fake LI.FI together with the want that describes it. */
async function quoted(options: {
    from: [string, NetworkId];
    to: [string, NetworkId];
    units: bigint;
    wallet?: string;
}): Promise<{ quote: LifiQuote; want: Want }> {
    const from = entryOf(...options.from);
    const to = entryOf(...options.to);
    const wallet = options.wallet ?? WALLET;
    const quote = await createLifi({ url: fake.url }).quote({
        fromChain: chainOf(from.network),
        toChain: chainOf(to.network),
        fromToken: from.address,
        toToken: to.address,
        fromAddress: wallet,
        toAddress: wallet,
        fromAmount: String(options.units),
        slippage: 0.005,
        integrator: "least-finance",
    });
    const diamond = from.network === "arc" ? ARC_DIAMOND : from.network === "solana" ? null : DIAMOND;
    return {
        quote,
        want: {
            fromNetwork: from.network,
            from,
            toNetwork: to.network,
            to,
            fromAddress: wallet,
            toAddress: wallet,
            fromUnits: options.units,
            diamond,
        },
    };
}

const evm = () => quoted({ from: ["USDC", "base"], to: ["USDT", "base"], units: 50_000_000n });
const refuses = (quote: LifiQuote, want: Want) => expect(() => check(quote, want)).toThrow(QuoteRejected);
const evmTx = (quote: LifiQuote) => {
    if (quote.tx.kind !== "evm") throw new Error("expected an EVM transaction");
    return quote.tx;
};

test("a quote that matches the want passes", async () => {
    const { quote, want } = await evm();

    expect(() => check(quote, want)).not.toThrow();
});

test("a refusal is a QuoteRejected that says what was expected and what LI.FI built, in the error and the log", async () => {
    const { quote, want } = await evm();
    const logger = { warn: vi.fn() };

    let thrown: unknown;
    try {
        check({ ...quote, fromAddress: OTHER }, want, logger);
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(QuoteRejected);
    expect(thrown).toMatchObject({ rule: "sender", expected: WALLET, got: OTHER });
    expect((thrown as Error).message).toBe(
        `LI.FI's quote didn't match the sell we asked for (sender: expected ${WALLET}, got ${OTHER}), so nothing was sent.`,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toMatch(/sender/);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
        event: "quote:rejected",
        rule: "sender",
        expected: WALLET,
        got: OTHER,
        quote: quote.id,
        tool: quote.tool,
        want: { fromAddress: WALLET, fromUnits: "50000000" },
        quoted: { fromAddress: OTHER, fromAmount: "50000000" },
    });
});

test("a wrong diamond is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, tx: { ...evmTx(quote), to: OTHER } }, want);
    refuses(quote, { ...want, diamond: OTHER });
    // LI.FI knowing no diamond for the network leaves nothing to compare with
    refuses(quote, { ...want, diamond: null });
});

test("EVM addresses compare without case, Solana's exactly", async () => {
    const { quote, want } = await evm();
    const upper = (value: string) => `0x${value.slice(2).toUpperCase()}`;

    expect(() =>
        check(
            {
                ...quote,
                fromToken: upper(quote.fromToken),
                toToken: upper(quote.toToken),
                fromAddress: upper(WALLET),
                tx: { ...evmTx(quote), from: upper(WALLET), to: upper(DIAMOND) },
            },
            want,
        ),
    ).not.toThrow();

    const sol = await quoted({
        from: ["SOL", "solana"],
        to: ["USDC", "solana"],
        units: 1_000_000_000n,
        wallet: SOLANA_WALLET,
    });
    refuses({ ...sol.quote, toToken: sol.quote.toToken.toLowerCase() }, sol.want);
});

test("a wrong chain is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, fromChainId: chainOf("ethereum") }, want);
    refuses({ ...quote, toChainId: chainOf("ethereum") }, want);
    refuses({ ...quote, tx: { ...evmTx(quote), chainId: chainOf("ethereum") } }, want);
    refuses(quote, { ...want, fromNetwork: "ethereum" });
    refuses(quote, { ...want, toNetwork: "ethereum" });
});

test("a wrong sender is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, fromAddress: OTHER }, want);
    refuses({ ...quote, tx: { ...evmTx(quote), from: OTHER } }, want);
});

test("a wrong receiver is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, toAddress: OTHER }, want);
    refuses(quote, { ...want, toAddress: OTHER });
});

test("a wrong from token is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, fromToken: entryOf("USDT", "base").address }, want);
    refuses({ ...quote, fromToken: NATIVE_EVM }, want);
});

test("a wrong to token is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, toToken: entryOf("USDC", "base").address }, want);
    refuses({ ...quote, toToken: NATIVE_EVM }, want);
});

test("a wrong amount is refused", async () => {
    const { quote, want } = await evm();

    refuses({ ...quote, fromAmount: "50000001" }, want);
    refuses({ ...quote, fromAmount: "49999999" }, want);
    refuses(quote, { ...want, fromUnits: 50_000_001n });
});

test("a wrong value is refused", async () => {
    // A token input moves no native coin
    const token = await evm();
    expect(evmTx(token.quote).value).toBe("0");
    refuses({ ...token.quote, tx: { ...evmTx(token.quote), value: "1" } }, token.want);

    // A native input moves at most its amount
    const native = await quoted({ from: ["ETH", "base"], to: ["USDC", "base"], units: 10_000_000_000_000_000n });
    expect(evmTx(native.quote).value).toBe("10000000000000000");
    expect(() => check(native.quote, native.want)).not.toThrow();
    expect(() =>
        check({ ...native.quote, tx: { ...evmTx(native.quote), value: "9999999999999999" } }, native.want),
    ).not.toThrow();
    refuses({ ...native.quote, tx: { ...evmTx(native.quote), value: "10000000000000001" } }, native.want);

    // A value that isn't a number is no value
    refuses({ ...token.quote, tx: { ...evmTx(token.quote), value: "lots" } }, token.want);
    refuses({ ...token.quote, tx: { ...evmTx(token.quote), value: "-1" } }, token.want);
});

test("Arc USDC's 18-decimal value is compared in 6 decimals", async () => {
    const { quote, want } = await quoted({ from: ["USDC", "arc"], to: ["ETH", "arc"], units: 50_000_000n });
    const tx = evmTx(quote);

    expect(tx.value).toBe("50000000000000000000");
    expect(() => check(quote, want)).not.toThrow();
    expect(() => check({ ...quote, tx: { ...tx, value: "0" } }, want)).not.toThrow();
    refuses({ ...quote, tx: { ...tx, value: "50000000000000000001" } }, want);
    // The same value compared in the token's own 6 decimals would be far over
    refuses({ ...quote, tx: { ...tx, value: String(50_000_000n * 10n ** 13n) } }, want);
});

const feeOf = (amount: string, patch: Partial<LifiQuote["fees"][number]> = {}): LifiQuote["fees"][number] => ({
    name: "Bridge fee",
    amountUSD: 1,
    included: false,
    amount,
    token: NATIVE_EVM,
    ...patch,
});
const withValue = (quote: LifiQuote, value: string, fees: LifiQuote["fees"]): LifiQuote => ({
    ...quote,
    fees,
    tx: { ...evmTx(quote), value },
});

test("a token input may carry the native fee a bridge charges on top, and not a wei more", async () => {
    const { quote, want } = await evm();
    const fees = [feeOf("500000"), feeOf("100", { included: true }), feeOf("7", { token: want.from.address })];

    expect(() => check(withValue(quote, "500000", fees), want)).not.toThrow();
    refuses(withValue(quote, "500001", fees), want);
    // A fee that is included, or paid in a token, adds nothing
    refuses(withValue(quote, "1", [feeOf("100", { included: true })]), want);
    refuses(withValue(quote, "1", [feeOf("100", { token: want.from.address })]), want);
});

test("a native input may carry its amount plus the native fee", async () => {
    const { quote, want } = await quoted({
        from: ["ETH", "base"],
        to: ["USDC", "base"],
        units: 10_000_000_000_000_000n,
    });
    const fees = [feeOf("500"), feeOf("20")];

    expect(() => check(withValue(quote, "10000000000000520", fees), want)).not.toThrow();
    refuses(withValue(quote, "10000000000000521", fees), want);
});

test("Arc USDC never carries the input as value and as an approval", async () => {
    const { quote, want } = await quoted({ from: ["USDC", "arc"], to: ["ETH", "arc"], units: 50_000_000n });
    const amount = "50000000000000000000";

    // The value carries the input, so an approval for it would charge it twice
    refuses({ ...withValue(quote, amount, []), skipApproval: false }, want);
    expect(() => check({ ...withValue(quote, amount, []), skipApproval: true }, want)).not.toThrow();
    // With no value the input travels by approval
    expect(() => check({ ...withValue(quote, "0", []), skipApproval: false }, want)).not.toThrow();
    // Under the input, only a native fee fits beside the approval
    refuses({ ...withValue(quote, "1", []), skipApproval: false }, want);
    expect(() => check({ ...withValue(quote, "1", [feeOf("1")]), skipApproval: false }, want)).not.toThrow();
    // On top of the input, the fee fits and nothing more
    expect(() =>
        check({ ...withValue(quote, "50000000000000000009", [feeOf("9")]), skipApproval: true }, want),
    ).not.toThrow();
    refuses({ ...withValue(quote, "50000000000000000010", [feeOf("9")]), skipApproval: true }, want);
});

test("a Solana quote paid by the wallet passes", async () => {
    const { quote, want } = await quoted({
        from: ["SOL", "solana"],
        to: ["USDC", "solana"],
        units: 1_000_000_000n,
        wallet: SOLANA_WALLET,
    });

    expect(quote.tx.kind).toBe("solana");
    expect(() => check(quote, want)).not.toThrow();
});

test("a Solana transaction paid by someone else is refused", async () => {
    const { quote, want } = await quoted({
        from: ["SOL", "solana"],
        to: ["USDC", "solana"],
        units: 1_000_000_000n,
        wallet: SOLANA_WALLET,
    });
    const logger = { warn: vi.fn() };

    // The recorded transaction names its own fee payer, which is not the wallet
    const recorded = readFileSync(new URL("../fixtures/lifi/solana-tx.txt", import.meta.url), "utf8").trim();
    expect(() => check({ ...quote, tx: { kind: "solana", data: recorded } }, want, logger)).toThrow(QuoteRejected);
    expect(logger.warn.mock.calls[0]?.[1]).toMatch(/fee payer/);

    refuses(quote, { ...want, fromAddress: SOLANA_OTHER, toAddress: SOLANA_OTHER });
    // Bytes that aren't a transaction are refused, not crashed on
    refuses({ ...quote, tx: { kind: "solana", data: "AAAA" } }, want);
    refuses({ ...quote, tx: { kind: "solana", data: "not base64!" } }, want);
});

test("a Solana quote carrying an EVM transaction is refused, and the other way round", async () => {
    const solana = await quoted({
        from: ["SOL", "solana"],
        to: ["USDC", "solana"],
        units: 1_000_000_000n,
        wallet: SOLANA_WALLET,
    });
    const { quote, want } = await evm();

    refuses({ ...solana.quote, tx: { ...evmTx(quote) } }, solana.want);
    refuses({ ...quote, tx: solana.quote.tx }, want);
});

test("solanaFeePayer reads the recorded transaction", () => {
    const recorded = readFileSync(new URL("../fixtures/lifi/solana-tx.txt", import.meta.url), "utf8").trim();

    expect(solanaFeePayer(recorded)).toBe(SOLANA_OTHER);
});

test("solanaFeePayer reads a legacy transaction and a v0 one", () => {
    const payer = new Uint8Array(32).fill(7);
    const other = new Uint8Array(32).fill(9);
    // One signature, then the message: [version prefix], header, account keys
    const wire = (...message: number[][]) =>
        base64.encode(Uint8Array.from([1, ...new Uint8Array(64), ...message.flat()]));
    const keys = [2, ...payer, ...other];

    expect(solanaFeePayer(wire([1, 0, 1], keys))).toBe(base58.encode(payer));
    expect(solanaFeePayer(wire([0x80], [1, 0, 1], keys))).toBe(base58.encode(payer));
    // Two signatures push the message further along
    const twoSignatures = base64.encode(Uint8Array.from([2, ...new Uint8Array(128), 1, 0, 1, ...keys]));
    expect(solanaFeePayer(twoSignatures)).toBe(base58.encode(payer));
});

test("solanaFeePayer throws on bytes that are not a transaction", () => {
    expect(() => solanaFeePayer("")).toThrow();
    expect(() => solanaFeePayer("AQ==")).toThrow();
    expect(() => solanaFeePayer(base64.encode(Uint8Array.from([1, ...new Uint8Array(64), 1, 0, 1, 1, 5])))).toThrow();
});
