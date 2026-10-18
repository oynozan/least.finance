import { expect, test, vi } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import type { BridgeProvider, Quote, QuoteRequest, SourceTx } from "../../src/crosschain/providers/types.ts";
import { AppError } from "../../src/errors.ts";
import { QuoteTimeout, UpstreamRefusal } from "../../src/crosschain/failures.ts";
import { bestQuote, checkQuote, quoteMismatch } from "../../src/crosschain/quotes.ts";

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

const logs = () => ({ error: vi.fn(), warn: vi.fn() });

test("no usable quote says what each bridge did, and logs it once with the ref the person is shown", async () => {
    const logger = logs();
    const providers = [
        quoting("pays-nothing", { usdcOut: 0n }),
        stub("down", () => Promise.reject(new Error("boom"))),
        { ...quoting("unsupported"), supports: () => false },
    ];

    const failure = await bestQuote(providers, request, { ...OPTIONS, logger }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "no_route", logged: true });
    const ref = /ref ([0-9a-f]{6})/.exec((failure as Error).message)?.[1];
    expect((failure as Error).message).toBe(
        `pays-nothing's quote didn't match your request, so nothing was sent (ref ${ref}).`,
    );
    expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ op: "deposit.quote.rejected", provider: "pays-nothing", check: "usdcOut", ref }),
        "Refused a bridge quote that does not match the request",
    );
    expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
            op: "deposit.quote",
            provider: "down",
            err: expect.any(Error),
            coin: "ethereum:ETH",
        }),
        "down failed to give a deposit quote",
    );

    const none = await bestQuote([], request, OPTIONS).catch((error: unknown) => error);
    expect(none).toMatchObject({ code: "no_route", message: "No bridge carries ETH from Ethereum to Arc." });
});

test("a bridge's refusal reaches the person as its plain sentence and the log as its verbatim code and words", async () => {
    const logger = logs();
    const refusal = new UpstreamRefusal({
        provider: "relay",
        status: 400,
        code: "AMOUNT_TOO_LOW",
        message: "Amount is below Relay's minimum of 0.01",
    });
    const providers = [
        stub("relay", () => Promise.reject(refusal)),
        stub("across", () => Promise.reject(new Error("boom"))),
    ];

    await expect(bestQuote(providers, request, { ...OPTIONS, logger })).rejects.toMatchObject({
        code: "no_route",
        message: "Relay's minimum for this route is higher than that. Try a larger amount.",
    });
    expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
            op: "deposit.quote",
            provider: "relay",
            upstreamStatus: 400,
            upstreamCode: "AMOUNT_TOO_LOW",
            upstreamMessage: "Amount is below Relay's minimum of 0.01",
            amount: String(request.amount),
            sender: WALLET,
        }),
        "Relay refused a deposit quote",
    );
});

test("a refusal nobody recognises is shown in the bridge's own words, quoted", async () => {
    const refusal = new UpstreamRefusal({ provider: "across", status: 400, code: "WEIRD", message: "Something odd." });
    await expect(bestQuote([stub("across", () => Promise.reject(refusal))], request, OPTIONS)).rejects.toMatchObject({
        message: 'Across refused the deposit: "Something odd".',
    });
});

test("bridges that were too slow are told apart from ones that failed", async () => {
    const logger = logs();
    const slow = [stub("relay", () => Promise.reject(new QuoteTimeout("relay", 3000)))];
    await expect(bestQuote(slow, request, { ...OPTIONS, logger })).rejects.toMatchObject({
        code: "unavailable",
        message: "No bridge answered within 3 seconds. Try again.",
    });
    expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ op: "deposit.quote", provider: "relay", timeoutMs: 3000 }),
        "Relay didn't answer a deposit quote in time",
    );
});

test("a provider's own refusal, such as a deposit too small for Circle's fee, survives with its words", async () => {
    const small = new AppError("bad_request", "That's too small to cover Circle's fee of 0.2 USDC.");
    await expect(bestQuote([stub("cctp", () => Promise.reject(small))], request, OPTIONS)).rejects.toMatchObject({
        code: "bad_request",
        message: "That's too small to cover Circle's fee of 0.2 USDC.",
        logged: true,
    });
});

test("quoteMismatch names the first thing a quote gets wrong, with what was wanted and what came", () => {
    expect(quoteMismatch(quote(), request, [])).toBeNull();
    expect(quoteMismatch(quote({ recipient: SOMEONE_ELSE }), request, [])).toEqual({
        check: "recipient",
        expected: DEPOSIT_ADDRESS,
        got: SOMEONE_ELSE,
    });
    expect(quoteMismatch(quote({ destinationToken: LOOKALIKE_USDC }), request, [])).toMatchObject({
        check: "destinationToken",
        got: LOOKALIKE_USDC,
    });
});

const SOL_USDC = coinByKey("solana:USDC");
const SOLANA_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const UNLISTED = "Unlisted1111111111111111111111111111111111";
const ALLOWED = [DEPOSITORY, SYSTEM, TOKEN, ATA, COMPUTE_BUDGET];
const DEPOSIT_NATIVE = "0d9e0ddf5fd51c06";
const DEPOSIT_TOKEN = "0b9c60da27a3b413";

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
const le = (n: bigint, bytes: number) =>
    n
        .toString(16)
        .padStart(bytes * 2, "0")
        .match(/../g)!
        .reverse()
        .join("");
const u64 = (n: bigint) => le(n, 8);
const ID = "ab".repeat(32);

// Relay's depository deposits, laid out as in relay-depository's lib.rs: discriminator, u64 amount, 32-byte id.
const depositNative = (sender: string, amount: bigint): Ix => ({
    programId: DEPOSITORY,
    keys: [OTHER_WALLET, sender, sender, OTHER_WALLET, SYSTEM].map(key),
    data: `0x${DEPOSIT_NATIVE}${u64(amount)}${ID}`,
});
const depositToken = (sender: string, amount: bigint, mint = SOL_USDC.mint!): Ix => ({
    programId: DEPOSITORY,
    keys: [OTHER_WALLET, sender, sender, OTHER_WALLET, mint, OTHER_WALLET, OTHER_WALLET, TOKEN, ATA, SYSTEM].map(key),
    data: `0x${DEPOSIT_TOKEN}${u64(amount)}${ID}`,
});
const computeLimit = (units: number): Ix => ({
    programId: COMPUTE_BUDGET,
    keys: [],
    data: `0x02${le(BigInt(units), 4)}`,
});
const computePrice = (microLamports: bigint): Ix => ({
    programId: COMPUTE_BUDGET,
    keys: [],
    data: `0x03${u64(microLamports)}`,
});
const createAta = (payer: string, data: `0x${string}` = "0x"): Ix => ({
    programId: ATA,
    keys: [payer, OTHER_WALLET, payer, SOL_USDC.mint!, SYSTEM, TOKEN].map(key),
    data,
});
const systemTransfer = (from: string, lamports: bigint): Ix => ({
    programId: SYSTEM,
    keys: [key(from), key(OTHER_WALLET)],
    data: `0x02000000${u64(lamports)}`,
});
const tokenIx = (tag: string, rest = ""): Ix => ({
    programId: TOKEN,
    keys: [OTHER_WALLET, OTHER_WALLET, SOLANA_WALLET].map(key),
    data: `0x${tag}${rest}`,
});
const deposit = depositToken(SOLANA_WALLET, solanaRequest.amount);
const solanaQuote = (instructions: Ix[], overrides: Partial<Quote> = {}): Quote =>
    quote({
        coin: SOL_USDC.key,
        amountIn: solanaRequest.amount,
        refundTo: SOLANA_WALLET,
        txs: [{ kind: "solana", instructions, lookupTables: [] }],
        ...overrides,
    });
const solQuote = (instructions: Ix[]) => solanaQuote(instructions, { coin: "solana:SOL", amountIn: solanaSol.amount });

test("a real-shaped Relay USDC quote and SOL quote pass", () => {
    const usdc = solanaQuote([
        computeLimit(200_000),
        computePrice(1_000n),
        createAta(SOLANA_WALLET),
        createAta(SOLANA_WALLET, "0x01"),
        deposit,
    ]);
    const sol = solQuote([computeLimit(200_000), computePrice(1_000n), depositNative(SOLANA_WALLET, 1_000_000_000n)]);

    expect(checkQuote(usdc, solanaRequest, ALLOWED)).toBe(true);
    expect(checkQuote(sol, solanaSol, ALLOWED)).toBe(true);
    expect(checkQuote(solanaQuote([depositToken(SOLANA_WALLET, 9_000_000n)]), solanaRequest, ALLOWED)).toBe(true);
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

test("the review's five tampered quotes are refused", () => {
    const u64Max = "ff".repeat(8);
    const tampered: [string, Quote, QuoteRequest][] = [
        [
            "a depository deposit plus a Token transfer out of the wallet",
            solanaQuote([deposit, tokenIx("03", u64(solanaRequest.amount))]),
            solanaRequest,
        ],
        [
            "a depository call at 100 times the amount",
            solanaQuote([depositToken(SOLANA_WALLET, solanaRequest.amount * 100n)]),
            solanaRequest,
        ],
        ["an unlimited Token Approve", solanaQuote([deposit, tokenIx("04", u64Max)]), solanaRequest],
        ["a Token SetAuthority", solanaQuote([deposit, tokenIx("06", "0201" + "11".repeat(32))]), solanaRequest],
        [
            "a System Assign",
            solQuote([
                depositNative(SOLANA_WALLET, solanaSol.amount),
                { ...systemTransfer(SOLANA_WALLET, 0n), data: `0x01000000${"22".repeat(32)}` },
            ]),
            solanaSol,
        ],
    ];

    for (const [name, tamperedQuote, asked] of tampered) {
        expect(checkQuote(tamperedQuote, asked, ALLOWED), name).toBe(false);
    }
});

test("a second full-amount transfer next to the deposit is refused", () => {
    const sol = solQuote([depositNative(SOLANA_WALLET, 1_000_000_000n), systemTransfer(SOLANA_WALLET, 1_000_000_000n)]);
    const usdc = solanaQuote([deposit, tokenIx("0c", u64(solanaRequest.amount) + "06")]);

    expect(checkQuote(sol, solanaSol, ALLOWED)).toBe(false);
    expect(checkQuote(usdc, solanaRequest, ALLOWED)).toBe(false);
});

test("top-level System and Token instructions are refused, whatever they are", () => {
    for (const ix of [
        systemTransfer(OTHER_WALLET, 1n),
        { ...systemTransfer(SOLANA_WALLET, 0n), data: "0x00000000" as const },
        { ...systemTransfer(SOLANA_WALLET, 0n), data: "0x03000000" as const },
        { ...systemTransfer(SOLANA_WALLET, 0n), data: "0x0a000000" as const },
        tokenIx("09"),
        tokenIx("0d", u64(1n) + "06"),
        tokenIx("03", u64(1n)),
    ]) {
        expect(checkQuote(solanaQuote([deposit, ix]), solanaRequest, ALLOWED)).toBe(false);
    }
});

test("deposits are summed across instructions and transactions against the deposit amount", () => {
    const half = depositToken(SOLANA_WALLET, 5_000_000n);
    const split = (ixs: Ix[]) => ({ kind: "solana" as const, instructions: ixs, lookupTables: [] });

    expect(checkQuote(solanaQuote([half, half]), solanaRequest, ALLOWED)).toBe(true);
    expect(checkQuote(solanaQuote([half, half, depositToken(SOLANA_WALLET, 1n)]), solanaRequest, ALLOWED)).toBe(false);
    const acrossTxs = solanaQuote([]);
    acrossTxs.txs = [split([deposit]), split([depositToken(SOLANA_WALLET, 1n)])];
    expect(checkQuote(acrossTxs, solanaRequest, ALLOWED)).toBe(false);
    expect(checkQuote(solQuote([depositNative(SOLANA_WALLET, 1_000_010_001n)]), solanaSol, ALLOWED)).toBe(false);
});

test("a depository deposit must be from the wallet, in the quoted coin, with a deposit instruction", () => {
    const wrongMint = depositToken(SOLANA_WALLET, 1n, OTHER_WALLET);
    const wrongSender = depositToken(OTHER_WALLET, 1n);
    const nativeForUsdc = depositNative(SOLANA_WALLET, 1n);
    const tokenForSol = depositToken(SOLANA_WALLET, 1n);
    const other = { ...deposit, data: `0x${"00".repeat(8)}${u64(1n)}${ID}` as const };
    const short = { ...deposit, data: `0x${DEPOSIT_TOKEN}${u64(1n)}` as const };

    for (const ix of [wrongMint, wrongSender, nativeForUsdc, other, short]) {
        expect(checkQuote(solanaQuote([ix]), solanaRequest, ALLOWED)).toBe(false);
    }
    expect(checkQuote(solQuote([tokenForSol]), solanaSol, ALLOWED)).toBe(false);
    expect(checkQuote(solQuote([depositNative(OTHER_WALLET, 1n)]), solanaSol, ALLOWED)).toBe(false);
});

test("Compute Budget keeps to a unit limit and a capped unit price", () => {
    expect(checkQuote(solanaQuote([computePrice(1_000_000n), deposit]), solanaRequest, ALLOWED)).toBe(true);
    expect(checkQuote(solanaQuote([computePrice(1_000_001n), deposit]), solanaRequest, ALLOWED)).toBe(false);
    expect(checkQuote(solanaQuote([computeLimit(1_400_001), deposit]), solanaRequest, ALLOWED)).toBe(false);
    for (const data of ["0x00", "0x01", "0x04", "0x0200"] as const) {
        const ix = { programId: COMPUTE_BUDGET, keys: [], data };
        expect(checkQuote(solanaQuote([ix, deposit]), solanaRequest, ALLOWED)).toBe(false);
    }
});

test("Associated Token creates only, and only with the wallet paying", () => {
    expect(checkQuote(solanaQuote([createAta(OTHER_WALLET), deposit]), solanaRequest, ALLOWED)).toBe(false);
    expect(checkQuote(solanaQuote([createAta(SOLANA_WALLET, "0x02"), deposit]), solanaRequest, ALLOWED)).toBe(false);
    expect(checkQuote(solanaQuote([createAta(SOLANA_WALLET, "0x0100"), deposit]), solanaRequest, ALLOWED)).toBe(false);
});

test("an uppercase-hex deposit above the quoted amount is refused", () => {
    const upper = (ix: Ix): Ix => ({ ...ix, data: `0x${ix.data.slice(2).toUpperCase()}` });

    expect(checkQuote(solanaQuote([upper(depositToken(SOLANA_WALLET, 10_000_001n))]), solanaRequest, ALLOWED)).toBe(
        false,
    );
    expect(checkQuote(solanaQuote([upper(depositToken(SOLANA_WALLET, 10_000_000n))]), solanaRequest, ALLOWED)).toBe(
        true,
    );
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
