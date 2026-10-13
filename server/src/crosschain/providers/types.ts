import type { Address, Hex } from "viem";
import type { Coin } from "../catalog.ts";

export type QuoteRequest = {
    coin: Coin;
    /** In the coin's smallest unit. */
    amount: bigint;
    /** The wallet's address on the coin's chain: 0x… on EVM, base58 on Solana. */
    sender: string;
    /** Where the USDC lands on Arc: the account's deposit address. */
    recipient: Address;
    /** Where a failed bridge pays back on the source chain: the account's wallet. */
    refundTo: string;
};

export type SolanaInstruction = {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: Hex;
};

export type SourceTx =
    | { kind: "evm"; chainId: number; to: Address; data: Hex; value: bigint }
    | { kind: "solana"; instructions: SolanaInstruction[]; lookupTables: string[] };

export type Quote = {
    provider: string;
    /** The provider's id for this bridge, enough to ask for its status later. */
    ref: string;
    /** The source coin's `key`. */
    coin: string;
    amountIn: bigint;
    /** Arc wei (18 decimals). */
    usdcOut: bigint;
    etaSeconds: number;
    destinationToken: Address;
    recipient: Address;
    refundTo: string;
    /** In signing order: an approval first. */
    txs: SourceTx[];
};

export type BridgeStage = "waiting" | "pending" | "filled" | "refunded" | "failed";

export type BridgeStatus = { stage: BridgeStage; fillTxHash?: Hex };

export interface BridgeProvider {
    readonly name: string;
    supports(coin: Coin): boolean;
    quote(request: QuoteRequest, signal: AbortSignal): Promise<Quote>;
    /** `sourceTxHash` is null before the app reports it; providers that can't look up without it return "waiting". */
    status(quote: { ref: string }, sourceTxHash: Hex | null, coin: Coin): Promise<BridgeStatus>;
}
