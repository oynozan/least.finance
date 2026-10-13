import { expect, test, vi } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import type { BridgeProvider, Quote, QuoteRequest, SourceTx } from "../../src/crosschain/providers/types.ts";
import { bestQuote, checkQuote } from "../../src/crosschain/quotes.ts";

const ETH = coinByKey("ethereum:ETH");
const ARC_USDC_VIEW = "0x3600000000000000000000000000000000000000";
const LOOKALIKE_USDC = "0x1111111111111111111111111111111111111111";
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";
const SOMEONE_ELSE = "0x0000000000000000000000000000000000000bad";

const OPTIONS = { allowedPrograms: [] as string[] };

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
    txs: [
        {
            kind: "evm",
            chainId: ETH.chainId!,
            to: "0x00000000000000000000000000000000000b01d0",
            data: "0x",
            value: 10n ** 18n,
        },
    ],
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

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("fast");
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

    const best = await bestQuote([slow, quick], request, { ...OPTIONS, timeoutMs: 50 });

    expect(best.provider).toBe("quick");
    expect(slowSignal?.aborted).toBe(true);
});

test("a quote paying a lookalike USDC is dropped even when it pays the most", async () => {
    const providers = [
        quoting("lookalike", { destinationToken: LOOKALIKE_USDC, usdcOut: 9n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("honest");
});

test("a quote paying someone else, or refunding someone else, is dropped", async () => {
    const providers = [
        quoting("pays-other", { recipient: SOMEONE_ELSE, usdcOut: 9n * 10n ** 21n }),
        quoting("refunds-other", { refundTo: SOMEONE_ELSE, usdcOut: 8n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("honest");
});

test("a transaction on another chain is dropped", async () => {
    const [tx] = quote().txs as Extract<SourceTx, { kind: "evm" }>[];
    const providers = [
        quoting("wrong-chain", { txs: [tx!, { ...tx!, chainId: 56 }], usdcOut: 9n * 10n ** 21n }),
        quoting("right-chain", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("right-chain");
});

test("a quote with nothing to sign is dropped", async () => {
    const providers = [
        quoting("no-txs", { txs: [], usdcOut: 9n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("honest");
});

test("a quote for another amount or another coin is dropped", async () => {
    const providers = [
        quoting("other-amount", { amountIn: request.amount * 2n, usdcOut: 9n * 10n ** 21n }),
        quoting("other-coin", { coin: "ethereum:USDC", usdcOut: 8n * 10n ** 21n }),
        quoting("honest", { usdcOut: 2000n * 10n ** 18n }),
    ];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("honest");
});

test("no usable quote is an unavailable error", async () => {
    const providers = [
        quoting("pays-nothing", { usdcOut: 0n }),
        stub("down", () => Promise.reject(new Error("boom"))),
        { ...quoting("unsupported"), supports: () => false },
    ];

    await expect(bestQuote(providers, request, OPTIONS)).rejects.toMatchObject({
        code: "unavailable",
        message: "No route for this deposit right now.",
    });
    await expect(bestQuote([], request, OPTIONS)).rejects.toMatchObject({ code: "unavailable" });
});

const SOL_USDC = coinByKey("solana:USDC");
const SOLANA_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UNLISTED = "Unlisted1111111111111111111111111111111111";
const ALLOWED = [DEPOSITORY, SYSTEM, TOKEN, "ComputeBudget111111111111111111111111111111"];

const solanaRequest: QuoteRequest = {
    coin: SOL_USDC,
    amount: 10_000_000n,
    sender: SOLANA_WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: SOLANA_WALLET,
};
const solanaSol: QuoteRequest = { ...solanaRequest, coin: coinByKey("solana:SOL"), amount: 1_000_000_000n };

type Ix = {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: `0x${string}`;
};
const key = (pubkey: string) => ({ pubkey, isSigner: pubkey === SOLANA_WALLET, isWritable: true });
const u64 = (n: bigint) => n.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
const deposit: Ix = { programId: DEPOSITORY, keys: [key(SOLANA_WALLET)], data: "0xdeadbeef" };
const systemTransfer = (from: string, lamports: bigint): Ix => ({
    programId: SYSTEM,
    keys: [key(from), key(OTHER_WALLET)],
    data: `0x02000000${u64(lamports)}`,
});
const tokenTransfer = (tag: "03" | "0c", authority: string, amount: bigint): Ix => ({
    programId: TOKEN,
    keys:
        tag === "03"
            ? [key(OTHER_WALLET), key(OTHER_WALLET), key(authority)]
            : [key(OTHER_WALLET), key(SOL_USDC.mint!), key(OTHER_WALLET), key(authority)],
    data: `0x${tag}${u64(amount)}${tag === "0c" ? "06" : ""}`,
});
const solanaQuote = (instructions: Ix[], overrides: Partial<Quote> = {}): Quote =>
    quote({
        coin: SOL_USDC.key,
        amountIn: solanaRequest.amount,
        refundTo: SOLANA_WALLET,
        txs: [{ kind: "solana", instructions, lookupTables: [] }],
        ...overrides,
    });
const solQuote = (instructions: Ix[]) => solanaQuote(instructions, { coin: "solana:SOL", amountIn: solanaSol.amount });

test("a Solana quote passes with every program on the allowlist", () => {
    const quoted = solanaQuote([deposit, tokenTransfer("03", SOLANA_WALLET, 10_000_000n)]);

    expect(checkQuote(quoted, solanaRequest, ALLOWED)).toBe(true);
});

test("an instruction from an unlisted program drops the quote", async () => {
    const logger = { error: vi.fn() };
    const bad = solanaQuote([deposit, { ...deposit, programId: UNLISTED }], { usdcOut: 9n * 10n ** 21n });
    const good = solanaQuote([deposit], { provider: "good", usdcOut: 2000n * 10n ** 18n });
    const provider = (q: Quote, name: string): BridgeProvider => ({ ...quoting(name), quote: async () => q });

    expect(checkQuote(bad, solanaRequest, ALLOWED, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain(UNLISTED);

    const best = await bestQuote([provider(bad, "bad"), provider(good, "good")], solanaRequest, {
        allowedPrograms: ALLOWED,
    });
    expect(best.provider).toBe("good");
});

test("a Solana transaction in an EVM quote, or an EVM one in a Solana quote, is refused", () => {
    const solanaTx: SourceTx = { kind: "solana", instructions: [deposit], lookupTables: [] };

    expect(checkQuote(quote({ txs: [solanaTx] }), request, ALLOWED)).toBe(false);
    expect(checkQuote(solanaQuote([deposit], { txs: quote().txs }), solanaRequest, ALLOWED)).toBe(false);
});

test("a System transfer out of the wallet above the quoted amount is refused", () => {
    const within = solQuote([deposit, systemTransfer(SOLANA_WALLET, 1_000_000_000n)]);
    const above = solQuote([deposit, systemTransfer(SOLANA_WALLET, 1_000_000_001n)]);
    const others = solQuote([deposit, systemTransfer(OTHER_WALLET, 9_000_000_000n)]);

    expect(checkQuote(within, solanaSol, ALLOWED)).toBe(true);
    expect(checkQuote(above, solanaSol, ALLOWED)).toBe(false);
    expect(checkQuote(others, solanaSol, ALLOWED)).toBe(true);
});

test("a Token transfer above the quoted amount is refused", () => {
    for (const tag of ["03", "0c"] as const) {
        const within = solanaQuote([deposit, tokenTransfer(tag, SOLANA_WALLET, 10_000_000n)]);
        const above = solanaQuote([deposit, tokenTransfer(tag, SOLANA_WALLET, 10_000_001n)]);
        const others = solanaQuote([deposit, tokenTransfer(tag, OTHER_WALLET, 99_000_000n)]);

        expect(checkQuote(within, solanaRequest, ALLOWED)).toBe(true);
        expect(checkQuote(above, solanaRequest, ALLOWED)).toBe(false);
        expect(checkQuote(others, solanaRequest, ALLOWED)).toBe(true);
    }
});

test("Solana addresses compare exactly, not case-insensitively", () => {
    const flipped = SOLANA_WALLET.toLowerCase();

    expect(flipped).not.toBe(SOLANA_WALLET);
    expect(checkQuote(solanaQuote([deposit], { refundTo: flipped }), solanaRequest, ALLOWED)).toBe(false);
    expect(checkQuote(solanaQuote([deposit]), solanaRequest, ALLOWED)).toBe(true);
});

const tiered = (name: string, usdcOut: bigint, calls: string[]): BridgeProvider =>
    stub(name, async () => {
        calls.push(name);
        return quote({ provider: name, usdcOut });
    });

test("tiers: Relay's quote wins over a higher-paying CCTP quote", async () => {
    const calls: string[] = [];
    const providers = [tiered("cctp", 9n * 10n ** 21n, calls), tiered("relay", 2000n * 10n ** 18n, calls)];

    const best = await bestQuote(providers, request, { ...OPTIONS, tiers: [["relay"], ["cctp"]] });

    expect(best.provider).toBe("relay");
    expect(calls).toEqual(["relay"]);
});

test("tiers: CCTP is asked only when Relay gives no usable quote", async () => {
    const calls: string[] = [];
    const providers = [
        tiered("cctp", 2000n * 10n ** 18n, calls),
        stub("relay", () => Promise.reject(new Error("down"))),
    ];

    const best = await bestQuote(providers, request, { ...OPTIONS, tiers: [["relay"], ["cctp"]] });

    expect(best.provider).toBe("cctp");
    await expect(
        bestQuote([providers[1]!], request, { ...OPTIONS, tiers: [["relay"], ["cctp"]] }),
    ).rejects.toMatchObject({
        code: "unavailable",
    });
});

test("no tiers: EVM best price is unchanged", async () => {
    const calls: string[] = [];
    const providers = [tiered("a", 1000n * 10n ** 18n, calls), tiered("b", 2000n * 10n ** 18n, calls)];

    expect((await bestQuote(providers, request, OPTIONS)).provider).toBe("b");
    expect(calls.sort()).toEqual(["a", "b"]);
});
