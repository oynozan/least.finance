import { createPublicClient, defineChain, erc20Abi, fallback, formatUnits, http, type Address } from "viem";

export const arc = defineChain({
    id: 5042,
    name: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: {
        default: {
            // Wallets are only handed the first, the others back up the app's reads.
            http: [
                "https://rpc.mainnet.arc.io",
                "https://rpc.blockdaemon.mainnet.arc.io",
                "https://rpc.drpc.mainnet.arc.io",
            ],
        },
    },
    blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** USDC's ERC-20 view of the native gas balance, in 6 decimals rather than the native 18. */
const USDC: Address = "0x3600000000000000000000000000000000000000";

// One try per RPC, so a read settles well inside the balance's 15s poll.
const client = createPublicClient({
    chain: arc,
    transport: fallback(
        arc.rpcUrls.default.http.map((url) => http(url, { timeout: 4_000 })),
        { retryCount: 0 },
    ),
});

export async function readUsdcBalance(owner: Address) {
    const raw = await client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
    });
    return Number(formatUnits(raw, 6));
}
