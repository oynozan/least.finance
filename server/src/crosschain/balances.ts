import { erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import type { CoinBalance } from "../protocol.ts";
import { EVM_COINS, formatCoinAmount, type Coin } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
import type { PriceFeed } from "./prices.ts";

type Deps = { sources: SourceClients; arc: PublicClient; prices: PriceFeed };

/**
 * Every EVM catalog coin the wallet holds or could hold, richest first; coins with no known price go last in
 * catalog order. Each balance is its own plain call, in parallel, since a fresh chain has no Multicall3.
 * A chain whose read fails keeps its rows with null amounts; the other chains still read.
 */
export async function readBalances({ sources, arc, prices }: Deps, owner: Address): Promise<CoinBalance[]> {
    const read = (coin: Coin): Promise<bigint> => {
        const client = coin.chain === "arc" ? arc : sources[coin.chain as "ethereum" | "bnb"];
        return coin.token
            ? client.readContract({ address: coin.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
            : client.getBalance({ address: owner });
    };
    const chains = [...new Set(EVM_COINS.map((coin) => coin.chain))];
    const [settled, usd] = await Promise.all([
        Promise.all(
            chains.map(async (chain) => {
                const coins = EVM_COINS.filter((coin) => coin.chain === chain);
                try {
                    return await Promise.all(coins.map(async (coin) => ({ coin, held: await read(coin) })));
                } catch {
                    return coins.map((coin) => ({ coin, held: null }));
                }
            }),
        ),
        prices.usd(EVM_COINS).catch(() => new Map<string, number>()),
    ]);

    const wallet = getAddress(owner);
    const rows = settled.flat().map(({ coin, held }): CoinBalance => {
        const base = {
            coin: coin.key,
            chain: coin.chain,
            chainId: coin.chainId,
            chainName: coin.chainName,
            symbol: coin.symbol,
            decimals: coin.decimals,
            wallet,
        };
        if (held === null) return { ...base, amount: null, spendable: null, usd: null };
        const price = usd.get(coin.key);
        const amount = formatCoinAmount(coin, held);
        return {
            ...base,
            amount,
            spendable: formatCoinAmount(coin, held > coin.gasReserve ? held - coin.gasReserve : 0n),
            usd: price === undefined ? null : Number(amount) * price,
        };
    });
    return rows.sort((a, b) => {
        if (a.usd === null || b.usd === null) return Number(a.usd === null) - Number(b.usd === null);
        return b.usd - a.usd;
    });
}
