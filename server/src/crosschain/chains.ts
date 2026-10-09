import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { bsc, mainnet } from "viem/chains";

export type SourceChainKey = "ethereum" | "bnb";

export type SourceClients = Record<SourceChainKey, PublicClient>;

/** Reads from the chains deposits are bridged from; each falls through its RPCs in order. */
export function createSourceClients(urls: Record<SourceChainKey, readonly string[]>): SourceClients {
    const client = (chain: typeof mainnet | typeof bsc, rpcUrls: readonly string[]): PublicClient =>
        createPublicClient({
            chain,
            transport: fallback(rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
        });
    return {
        ethereum: client(mainnet, urls.ethereum),
        bnb: client(bsc, urls.bnb),
    };
}
