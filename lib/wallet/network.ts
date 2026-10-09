/** A wallet's network: an EVM chain ID, or Solana. */
export type Network = number | "solana";

const NAMES: Record<number, string> = {
    5042: "Arc",
    1: "Ethereum",
    56: "BNB Chain",
    8453: "Base",
    42161: "Arbitrum",
    10: "Optimism",
    137: "Polygon",
    43114: "Avalanche",
};

/** The chain in an EIP-155 CAIP-2 ID such as "eip155:56"; anything else has none. */
export function chainIdOf(caip2: string): number | undefined {
    const match = /^eip155:(\d+)$/.exec(caip2);
    return match ? Number(match[1]) : undefined;
}

export function networkName(network: Network | undefined): string {
    if (network === undefined) return "Unknown network";
    if (network === "solana") return "Solana";
    return NAMES[network] ?? `Chain ${network}`;
}
