import { NETWORKS, type NetworkId } from "@/server/src/swaps/coins";
import type { Network } from "@/lib/wallet/network";

export type { NetworkId };

/** The network's display name, or its id when the catalog doesn't list it */
export const networkName = (id: NetworkId): string => NETWORKS.find((n) => n.id === id)?.name ?? id;

/** The wallet `Network` that `NetworkLogo` draws for a swap network */
export function logoNetwork(id: NetworkId): Network {
    const network = NETWORKS.find((n) => n.id === id);
    return network?.kind === "evm" ? network.chainId : "solana";
}
