import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from "viem/chains";
import { arcChain } from "../chain/arc.ts";
import type { NetworkId } from "./coins.ts";

export type EvmNetworkId = Exclude<NetworkId, "solana">;

/** One client per EVM network the inventory wallet and the hedger trade on, each falling through its RPCs in order and failing fast. */
export function createSwapClients(urls: Record<EvmNetworkId, readonly string[]>): Record<EvmNetworkId, PublicClient> {
    const client = (chain: Chain, rpcUrls: readonly string[]): PublicClient =>
        createPublicClient({
            chain,
            transport: fallback(
                rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 0 })),
                { retryCount: 0 },
            ),
        });
    return {
        ethereum: client(mainnet, urls.ethereum),
        arbitrum: client(arbitrum, urls.arbitrum),
        base: client(base, urls.base),
        optimism: client(optimism, urls.optimism),
        polygon: client(polygon, urls.polygon),
        bnb: client(bsc, urls.bnb),
        avalanche: client(avalanche, urls.avalanche),
        arc: client(arcChain(urls.arc), urls.arc),
    };
}
