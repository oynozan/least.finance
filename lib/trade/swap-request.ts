import { NETWORKS } from "@/server/src/swaps/coins";
import type { SwapRequest } from "@/server/src/protocol";
import { QUOTE } from "./catalog";
import type { TradeCtx } from "./context";
import type { TransactionIntent } from "./intent";
import type { NetworkId } from "./networks";
import { buyPayNetwork } from "./operations/shared";

/** The wallets that sign: the EVM one for the eight EVM networks, the Solana one for Solana. */
export type Signers = { evm?: string; solana?: string };

/** The intents a real swap carries out. */
export type SwapIntent = Extract<TransactionIntent, { type: "swap" | "spot" }>;

export const isSwapIntent = (intent: TransactionIntent | null | undefined): intent is SwapIntent =>
    intent?.type === "swap" || intent?.type === "spot";

/** Whether a network is an EVM one or Solana. */
export const kindOf = (network: NetworkId): "evm" | "solana" =>
    NETWORKS.find((n) => n.id === network)?.kind === "solana" ? "solana" : "evm";

/** The two sides of the swap an intent asks for: Buy pays USDC for the coin, Sell turns the coin into USDC. */
export function swapSides(intent: SwapIntent, ctx: TradeCtx): Pick<SwapRequest, "from" | "to"> {
    if (intent.type === "swap") {
        return {
            from: { token: intent.fromToken, network: intent.fromNetwork },
            to: { token: intent.toToken, network: intent.toNetwork },
        };
    }
    if (intent.side === "buy") {
        const payFrom = buyPayNetwork(ctx, intent.network, Number(intent.amountUSD)) ?? intent.network;
        return { from: { token: QUOTE, network: payFrom }, to: { token: intent.token, network: intent.network } };
    }
    return { from: { token: intent.token, network: intent.network }, to: { token: QUOTE, network: intent.network } };
}

/** The request for an intent, or the kind of wallet still to connect. */
export function toSwapRequest(
    intent: SwapIntent,
    ctx: TradeCtx,
    signers: Signers,
): SwapRequest | { missing: "evm" | "solana" } {
    const { from, to } = swapSides(intent, ctx);
    const wallet = signers[kindOf(from.network)];
    if (!wallet) return { missing: kindOf(from.network) };
    const receiver = signers[kindOf(to.network)];
    if (!receiver) return { missing: kindOf(to.network) };
    return { from, to, amountUSD: intent.amountUSD, wallet, receiver };
}
