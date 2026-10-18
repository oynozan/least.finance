import { oneLine, USER_REJECTED } from "./failure";

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

export type SwitchableWallet = {
    chainId: string;
    switchChain(chainId: number): Promise<void>;
    getEthereumProvider(): Promise<{ request(args: { method: string }): Promise<unknown> }>;
};

/**
 * Whether the wallet is on the chain: ready, turned down by the person, or a problem with what the wallet said (its
 * error's code and words) or with the chain it ended up on.
 */
export type NetworkCheck =
    | "ready"
    | "declined"
    | { kind: "switch_failed"; code: number | null; message: string }
    | { kind: "wrong_network"; actual: Network | undefined };

/** Moves the wallet to `chainId` if it isn't there, then asks the wallet itself, right before a send. */
export async function ensureNetwork(wallet: SwitchableWallet, chainId: number): Promise<NetworkCheck> {
    if (chainIdOf(wallet.chainId) !== chainId) {
        try {
            await wallet.switchChain(chainId);
        } catch (error) {
            const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
            if (code === USER_REJECTED) return "declined";
            console.warn(`Your wallet couldn't switch to chain ${chainId}`, error);
            return {
                kind: "switch_failed",
                code: typeof code === "number" ? code : null,
                message: typeof message === "string" ? message : "",
            };
        }
    }
    const provider = await wallet.getEthereumProvider();
    const current = await provider.request({ method: "eth_chainId" });
    if (typeof current === "string" && Number(current) === chainId) return "ready";
    const actual = typeof current === "string" && Number.isFinite(Number(current)) ? Number(current) : undefined;
    return { kind: "wrong_network", actual };
}

/** What the person is told when the wallet is not on `chainId` after `ensureNetwork`. */
export function networkProblem(check: Exclude<NetworkCheck, "ready" | "declined">, chainId: number): string {
    const chain = networkName(chainId);
    if (check.kind === "wrong_network") {
        return check.actual === undefined
            ? `Your wallet didn't say which network it is on. Switch it to ${chain} and try again.`
            : `Your wallet is on ${networkName(check.actual)}, not ${chain}. Switch to ${chain} in the wallet and try again.`;
    }
    if (check.code === 4902) {
        return chainId === 5042
            ? "Your wallet doesn't know Arc yet. Add Arc (chain ID 5042) in its network settings, or connect another wallet."
            : `Your wallet doesn't know ${chain} yet. Add it in the wallet's network settings and try again.`;
    }
    if (check.code === -32002) return "Your wallet already has a request open. Answer it first, then try again.";
    const words = oneLine(check.message).replace(/\.+$/, "");
    return words
        ? `Your wallet couldn't switch to ${chain}: "${words}". Switch it there yourself and try again.`
        : `Your wallet couldn't switch to ${chain}. Switch it there yourself and try again.`;
}
