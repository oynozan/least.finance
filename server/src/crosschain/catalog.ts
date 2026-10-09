import { formatUnits, parseUnits, type Address } from "viem";
import { ARC_CHAIN_ID, NATIVE_DECIMALS } from "../chain/arc.ts";
import { AppError } from "../errors.ts";

export type ChainKey = "ethereum" | "bnb" | "arc";

export type Coin = {
    /** `<chain>:<symbol>`, like "ethereum:ETH" or "bnb:USDT". */
    key: string;
    chain: ChainKey;
    chainId: number;
    chainName: string;
    symbol: string;
    /** The ERC-20 contract, or null for the chain's native coin. */
    token: Address | null;
    decimals: number;
    /** Units kept back for gas when sending the whole balance; 0n for tokens. */
    gasReserve: bigint;
};

const CHAINS = {
    ethereum: { chainId: 1, chainName: "Ethereum" },
    bnb: { chainId: 56, chainName: "BNB Chain" },
    arc: { chainId: ARC_CHAIN_ID, chainName: "Arc" },
} as const satisfies Record<ChainKey, { chainId: number; chainName: string }>;

const defineCoin = (
    chain: ChainKey,
    symbol: string,
    token: Address | null,
    decimals: number,
    gasReserve = "0",
): Coin => ({
    key: `${chain}:${symbol}`,
    chain,
    ...CHAINS[chain],
    symbol,
    token,
    decimals,
    gasReserve: parseUnits(gasReserve, decimals),
});

/** There's no USDT on Arc: USDC is the only coin there. */
export const COINS: readonly Coin[] = [
    defineCoin("ethereum", "ETH", null, 18, "0.002"),
    defineCoin("ethereum", "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
    defineCoin("ethereum", "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
    defineCoin("bnb", "BNB", null, 18, "0.002"),
    defineCoin("bnb", "USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18),
    defineCoin("bnb", "USDT", "0x55d398326f99059fF775485246999027B3197955", 18),
    defineCoin("arc", "USDC", null, NATIVE_DECIMALS, "0.01"),
];

const BY_KEY = new Map(COINS.map((c) => [c.key, c]));

export const ARC_USDC = BY_KEY.get("arc:USDC")!;

/** The addresses providers use for native USDC on Arc: its ERC-20 view and the zero address. */
export const ARC_USDC_TOKENS: readonly Address[] = [
    "0x3600000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
];

export function coinByKey(key: string): Coin {
    const found = BY_KEY.get(key);
    if (!found) throw new AppError("bad_request", `Invalid coin: ${key}`);
    return found;
}

/** A positive decimal string in the coin's smallest unit; it never rounds, which viem's parseUnits would. */
export function parseCoinAmount(coin: Coin, amount: string): bigint {
    const match = /^\d+(?:\.(\d+))?$/.exec(amount);
    const units = match && (match[1]?.length ?? 0) <= coin.decimals ? parseUnits(amount, coin.decimals) : 0n;
    if (units <= 0n) throw new AppError("bad_request", `Invalid amount: ${amount}`);
    return units;
}

export const formatCoinAmount = (coin: Coin, units: bigint): string => formatUnits(units, coin.decimals);

/** A provider's amount of Arc USDC (6 decimals in its ERC-20 view) as the 18-decimal wei the app credits. */
export const toArcWei = (amount: bigint, decimals: number): bigint =>
    amount * 10n ** BigInt(NATIVE_DECIMALS - decimals);
