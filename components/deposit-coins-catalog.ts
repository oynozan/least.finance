// A client-side mirror of the coin keys, symbols and chain names in server/src/crosschain/catalog.ts.
import type { CoinBalance } from "@/server/src/protocol";

type CatalogCoin = Pick<CoinBalance, "coin" | "chain" | "chainId" | "chainName" | "symbol" | "decimals">;

export const EVM_CATALOG: readonly CatalogCoin[] = [
    { coin: "ethereum:ETH", chain: "ethereum", chainId: 1, chainName: "Ethereum", symbol: "ETH", decimals: 18 },
    { coin: "ethereum:USDC", chain: "ethereum", chainId: 1, chainName: "Ethereum", symbol: "USDC", decimals: 6 },
    { coin: "ethereum:USDT", chain: "ethereum", chainId: 1, chainName: "Ethereum", symbol: "USDT", decimals: 6 },
    { coin: "bnb:BNB", chain: "bnb", chainId: 56, chainName: "BNB Chain", symbol: "BNB", decimals: 18 },
    { coin: "bnb:USDC", chain: "bnb", chainId: 56, chainName: "BNB Chain", symbol: "USDC", decimals: 18 },
    { coin: "bnb:USDT", chain: "bnb", chainId: 56, chainName: "BNB Chain", symbol: "USDT", decimals: 18 },
    { coin: "arc:USDC", chain: "arc", chainId: 5042, chainName: "Arc", symbol: "USDC", decimals: 18 },
];

export const SOLANA_CATALOG: readonly CatalogCoin[] = [
    { coin: "solana:SOL", chain: "solana", chainId: null, chainName: "Solana", symbol: "SOL", decimals: 9 },
    { coin: "solana:USDC", chain: "solana", chainId: null, chainName: "Solana", symbol: "USDC", decimals: 6 },
];
