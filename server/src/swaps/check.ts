import { COINS, NATIVE_EVM, NETWORKS, type CoinEntry, type NetworkId } from "./coins.ts";
import type { LifiQuote } from "./lifi.ts";
import { solanaFeePayer } from "./solana-tx.ts";

/** What the person asked for, against which every field of LI.FI's quote is held. */
export type QuoteWant = {
    fromNetwork: NetworkId;
    from: CoinEntry;
    toNetwork: NetworkId;
    to: CoinEntry;
    fromAddress: string;
    toAddress: string;
    fromUnits: bigint;
    /** The LI.FI diamond of the source network; null when LI.FI lists none. */
    diamond: string | null;
};

type Log = { warn(context: object, message: string): void };

/** The first rule a quote broke, with what we asked for and what LI.FI built. */
export type Broken = { rule: string; expected: string; got: string };

export const broke = (rule: string, expected: unknown, got: unknown): Broken => ({
    rule,
    expected: String(expected),
    got: String(got),
});

/** A quote that isn't the swap we asked for. No person sees it: it is logged and stored as the hedge's reason. */
export class QuoteRejected extends Error {
    readonly rule: string;
    readonly expected: string;
    readonly got: string;

    constructor(broken: Broken) {
        super(
            `LI.FI's quote didn't match the sell we asked for (${broken.rule}: expected ${broken.expected}, got ${broken.got}), so nothing was sent.`,
        );
        this.name = "QuoteRejected";
        this.rule = broken.rule;
        this.expected = broken.expected;
        this.got = broken.got;
    }
}

// A native coin's transaction value is in 18-decimal wei, whatever decimals its token interface has
const NATIVE_DECIMALS = 18;

const networkOf = (id: NetworkId) => NETWORKS.find((network) => network.id === id)!;

// EVM addresses compare without case, Solana's exactly
const same = (network: NetworkId, a: string, b: string) =>
    networkOf(network).kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;

// The first rule the quote breaks, or null
function brokenRule(quote: LifiQuote, want: QuoteWant): Broken | null {
    const from = networkOf(want.fromNetwork);
    const to = networkOf(want.toNetwork);
    if (quote.fromChainId !== from.chainId) return broke("source chain", from.chainId, quote.fromChainId);
    if (quote.toChainId !== to.chainId) return broke("destination chain", to.chainId, quote.toChainId);
    if (!same(want.fromNetwork, quote.fromToken, want.from.address))
        return broke("source token", want.from.address, quote.fromToken);
    if (!same(want.toNetwork, quote.toToken, want.to.address))
        return broke("destination token", want.to.address, quote.toToken);
    if (!same(want.fromNetwork, quote.fromAddress, want.fromAddress))
        return broke("sender", want.fromAddress, quote.fromAddress);
    if (!same(want.toNetwork, quote.toAddress, want.toAddress))
        return broke("receiver", want.toAddress, quote.toAddress);
    if (quote.fromAmount !== want.fromUnits.toString()) return broke("amount", want.fromUnits, quote.fromAmount);

    const { tx } = quote;
    if (from.kind === "solana") {
        if (tx.kind !== "solana") return broke("transaction kind", "solana", tx.kind);
        let payer: string;
        try {
            payer = solanaFeePayer(tx.data);
        } catch {
            return broke("transaction decoding", "a readable transaction", "an unreadable one");
        }
        return payer === want.fromAddress ? null : broke("fee payer", want.fromAddress, payer);
    }

    if (tx.kind !== "evm") return broke("transaction kind", "evm", tx.kind);
    if (tx.chainId !== from.chainId) return broke("transaction chain", from.chainId, tx.chainId);
    if (!same(want.fromNetwork, tx.from, want.fromAddress))
        return broke("transaction sender", want.fromAddress, tx.from);
    if (want.diamond === null || !same(want.fromNetwork, tx.to, want.diamond))
        return broke("diamond", want.diamond ?? "none listed by LI.FI", tx.to);
    if (!/^\d+$/.test(tx.value)) return broke("value", "a whole number", tx.value);
    const most = mostValue(quote, tx.value, want);
    return most === null ? null : broke("value", `at most ${most}`, tx.value);
}

// The native coin a bridge charges on top of the amount, which the transaction may carry as value
function nativeExtra(quote: LifiQuote, network: NetworkId): bigint {
    const coin = COINS.flatMap((candidate) => candidate.entries).find(
        (entry) => entry.network === network && entry.reserve !== undefined,
    );
    return quote.fees
        .filter((fee) => !fee.included && /^\d+$/.test(fee.amount))
        .filter((fee) => same(network, fee.token, NATIVE_EVM) || (coin && same(network, fee.token, coin.address)))
        .reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
}

// What the transaction may move as value: a token input only the native fee, a native input also its amount.
// Null when the value is within it, else the most it may be.
function mostValue(quote: LifiQuote, value: string, want: QuoteWant): string | null {
    const sent = BigInt(value);
    const extra = nativeExtra(quote, want.fromNetwork);
    if (want.from.address === NATIVE_EVM) {
        const scale = 10n ** BigInt(NATIVE_DECIMALS - want.from.decimals);
        const most = want.fromUnits * scale + extra;
        return sent <= most ? null : most.toString();
    }
    if (want.from.reserve !== undefined) {
        // Arc's USDC is both a token and the gas coin: its value (18 decimals) carries the input or the approval does, never both
        const input = want.fromUnits * 10n ** BigInt(NATIVE_DECIMALS - want.from.decimals);
        if (sent >= input) return quote.skipApproval && sent <= input + extra ? null : (input + extra).toString();
    }
    return sent <= extra ? null : extra.toString();
}

/** Throws QuoteRejected unless the transaction LI.FI built is the swap the person asked for, from their wallet to theirs; the log line carries both sides. */
export function checkQuote(quote: LifiQuote, want: QuoteWant, logger: Log): void {
    const broken = brokenRule(quote, want);
    if (broken === null) return;
    logger.warn(
        {
            event: "quote:rejected",
            rule: broken.rule,
            expected: broken.expected,
            got: broken.got,
            quote: quote.id,
            tool: quote.tool,
            want: {
                fromNetwork: want.fromNetwork,
                fromToken: want.from.address,
                fromAddress: want.fromAddress,
                fromUnits: want.fromUnits.toString(),
                toNetwork: want.toNetwork,
                toToken: want.to.address,
                toAddress: want.toAddress,
                diamond: want.diamond,
            },
            quoted: {
                fromChainId: quote.fromChainId,
                toChainId: quote.toChainId,
                fromToken: quote.fromToken,
                toToken: quote.toToken,
                fromAddress: quote.fromAddress,
                toAddress: quote.toAddress,
                fromAmount: quote.fromAmount,
            },
        },
        `Refused a swap quote: its ${broken.rule} doesn't match`,
    );
    throw new QuoteRejected(broken);
}
