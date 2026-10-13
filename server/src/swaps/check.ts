import { AppError } from "../errors.ts";
import { NETWORKS, type CoinEntry, type NetworkId } from "./coins.ts";
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

// A native coin's transaction value is in 18-decimal wei, whatever decimals its token interface has
const NATIVE_DECIMALS = 18;

const networkOf = (id: NetworkId) => NETWORKS.find((network) => network.id === id)!;

// EVM addresses compare without case, Solana's exactly
const same = (network: NetworkId, a: string, b: string) =>
    networkOf(network).kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;

// The first rule the quote breaks, or null
function brokenRule(quote: LifiQuote, want: QuoteWant): string | null {
    const from = networkOf(want.fromNetwork);
    if (quote.fromChainId !== from.chainId) return "source chain";
    if (quote.toChainId !== networkOf(want.toNetwork).chainId) return "destination chain";
    if (!same(want.fromNetwork, quote.fromToken, want.from.address)) return "source token";
    if (!same(want.toNetwork, quote.toToken, want.to.address)) return "destination token";
    if (!same(want.fromNetwork, quote.fromAddress, want.fromAddress)) return "sender";
    if (!same(want.toNetwork, quote.toAddress, want.toAddress)) return "receiver";
    if (quote.fromAmount !== want.fromUnits.toString()) return "amount";

    const { tx } = quote;
    if (from.kind === "solana") {
        if (tx.kind !== "solana") return "transaction kind";
        let payer: string;
        try {
            payer = solanaFeePayer(tx.data);
        } catch {
            return "transaction decoding";
        }
        return payer === want.fromAddress ? null : "fee payer";
    }

    if (tx.kind !== "evm") return "transaction kind";
    if (tx.chainId !== from.chainId) return "transaction chain";
    if (!same(want.fromNetwork, tx.from, want.fromAddress)) return "transaction sender";
    if (want.diamond === null || !same(want.fromNetwork, tx.to, want.diamond)) return "diamond";
    if (!/^\d+$/.test(tx.value)) return "value";
    // Only a native coin travels as the value; only native gas coins in the table have a reserve
    const scale = 10n ** BigInt(NATIVE_DECIMALS - want.from.decimals);
    const allowed = want.from.reserve === undefined ? 0n : want.fromUnits * scale;
    return BigInt(tx.value) <= allowed ? null : "value";
}

/** Throws "unavailable" unless the transaction LI.FI built is the swap the person asked for, from their wallet to theirs. */
export function checkQuote(quote: LifiQuote, want: QuoteWant, logger?: Log): void {
    const rule = brokenRule(quote, want);
    if (rule === null) return;
    logger?.warn({ quote: quote.id, tool: quote.tool, rule }, `Refused a swap quote: ${rule} doesn't match`);
    throw new AppError("unavailable", "Swaps aren't available right now.");
}
