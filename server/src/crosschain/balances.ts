import { erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import { throttle } from "./failures.ts";
import type { CoinBalance } from "../protocol.ts";
import { EVM_COINS, formatCoinAmount, type Coin } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
import type { PriceFeed } from "./prices.ts";

type Deps = {
    sources: SourceClients;
    arc: PublicClient;
    prices: PriceFeed;
    logger?: { warn: (fields: object, message: string) => void };
};

/** Balances are re-read every 30 s per account, so a chain that is down is told once a minute. */
const chainDown = throttle(60_000);

/**
 * Every EVM catalog coin the wallet holds or could hold, richest first; coins with no known price go last in
 * catalog order. Each balance is its own plain call, in parallel, since a fresh chain has no Multicall3.
 * A chain whose read fails keeps its rows with null amounts; the other chains still read.
 */
export async function readBalances({ sources, arc, prices, logger }: Deps, owner: Address): Promise<CoinBalance[]> {
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
                } catch (error) {
                    if (chainDown(`${chain}`)) {
                        logger?.warn(
                            {
                                op: "balances.read",
                                chain,
                                wallet: owner,
                                coins: coins.map((coin) => coin.key),
                                err: error,
                            },
                            `Couldn't read a wallet's balances on ${chain}`,
                        );
                    }
                    return coins.map((coin) => ({ coin, held: null }));
                }
            }),
        ),
        prices.usd(EVM_COINS).catch((error: unknown) => {
            if (chainDown("prices"))
                logger?.warn({ op: "balances.prices", err: error }, "Couldn't price a wallet's coins");
            return new Map<string, number>();
        }),
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
        if (held === null) {
            const readError = `${coin.chainName} didn't answer, so this balance isn't shown.`;
            return { ...base, amount: null, spendable: null, usd: null, readError };
        }
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
