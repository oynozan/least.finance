import { erc20Abi, type Address, type PublicClient } from "viem";
import type { CoinBalance } from "../protocol.ts";
import { COINS, formatCoinAmount, type Coin } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
import type { PriceFeed } from "./prices.ts";

type Deps = { sources: SourceClients; arc: PublicClient; prices: PriceFeed };

/**
 * Every catalog coin the wallet holds or could hold, richest first; coins with no known price go last in
 * catalog order. Each balance is its own plain call, in parallel, since a fresh chain has no Multicall3.
 */
export async function readBalances({ sources, arc, prices }: Deps, owner: Address): Promise<CoinBalance[]> {
    const read = (coin: Coin): Promise<bigint> => {
        const client = coin.chain === "arc" ? arc : sources[coin.chain];
        return coin.token
            ? client.readContract({ address: coin.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
            : client.getBalance({ address: owner });
    };
    const [holdings, usd] = await Promise.all([
        Promise.all(COINS.map(async (coin) => ({ coin, held: await read(coin) }))),
        prices.usd(COINS),
    ]);

    const rows = holdings.map(({ coin, held }): CoinBalance => {
        const price = usd.get(coin.key);
        const amount = formatCoinAmount(coin, held);
        return {
            coin: coin.key,
            symbol: coin.symbol,
            chainName: coin.chainName,
            chainId: coin.chainId,
            decimals: coin.decimals,
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
