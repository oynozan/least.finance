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

/** EIP-1193's code for a request the user turned down in their wallet. */
const USER_REJECTED = 4001;

export type SwitchableWallet = {
    chainId: string;
    switchChain(chainId: number): Promise<void>;
    getEthereumProvider(): Promise<{ request(args: { method: string }): Promise<unknown> }>;
};

export type NetworkCheck = "ready" | "declined" | "switch_failed" | "wrong_network";

/** Moves the wallet to `chainId` if it isn't there, then asks the wallet itself, right before a send. */
export async function ensureNetwork(wallet: SwitchableWallet, chainId: number): Promise<NetworkCheck> {
    if (chainIdOf(wallet.chainId) !== chainId) {
        try {
            await wallet.switchChain(chainId);
        } catch (error) {
            return (error as { code?: unknown } | null)?.code === USER_REJECTED ? "declined" : "switch_failed";
        }
    }
    const provider = await wallet.getEthereumProvider();
    const current = await provider.request({ method: "eth_chainId" });
    return typeof current === "string" && Number(current) === chainId ? "ready" : "wrong_network";
}
