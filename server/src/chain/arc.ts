import { createPublicClient, defineChain, fallback, http, parseAbiItem, type PublicClient } from "viem";

export const ARC_CHAIN_ID = 5042;

/** Arc's public RPCs; the first is the most capable, so it goes first. */
export const ARC_RPC_URLS = [
    "https://rpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
] as const;

/** USDC is Arc's native coin, with 18 decimals; its ERC-20 view at 0x3600…0000 shows the same balance in 6. */
export const NATIVE_DECIMALS = 18;

/**
 * Arc logs every native USDC movement as an ERC-20 style Transfer from this
 * system address (EIP-7708): plain sends, value a contract forwards, and
 * transfers through the ERC-20 view alike. Gas fees aren't logged. The ERC-20
 * view logs its own Transfer too, so counting both would double-credit.
 */
export const NATIVE_TRANSFER_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe" as const;

export const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** A transaction whose maxFeePerGas is under this is dropped from the mempool without an error. */
export const MIN_BASE_FEE = 20_000_000_000n;

export const arcChain = (rpcUrls: readonly string[]) =>
    defineChain({
        id: ARC_CHAIN_ID,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_DECIMALS },
        rpcUrls: { default: { http: [...rpcUrls] } },
        blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
        contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    });

export type ArcClient = PublicClient;

/** Reads fall through the RPCs in order, so one being down or rate limited doesn't stall deposits. */
export function createArcClient(rpcUrls: readonly string[]): ArcClient {
    return createPublicClient({
        chain: arcChain(rpcUrls),
        transport: fallback(
            rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1, retryDelay: 250 })),
            { rank: false, retryCount: 0 },
        ),
        pollingInterval: 500,
    });
}

/** Fails fast when the RPCs point at another chain, which would credit deposits that never happened on Arc. */
export async function assertArc(client: ArcClient) {
    const chainId = await client.getChainId();
    if (chainId !== ARC_CHAIN_ID) {
        throw new Error(`The Arc RPC reports chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
    }
}
