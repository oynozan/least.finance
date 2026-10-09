import { zeroAddress } from "viem";
import type { Coin } from "./catalog.ts";

/** Dollar prices of coins, keyed by `coin.key`. A coin whose price isn't known is left out. */
export interface PriceFeed {
    usd(coins: readonly Coin[]): Promise<Map<string, number>>;
}

const LOOKUP_TIMEOUT_MS = 5_000;

/** LI.FI's token prices, one request per coin, each kept for `ttlMs`. */
export function lifiPrices(options: { fetch?: typeof fetch; ttlMs?: number } = {}): PriceFeed {
    const { fetch: fetchPrice = fetch, ttlMs = 60_000 } = options;
    const cache = new Map<string, { price: number; expires: number }>();

    async function lookup(coin: Coin): Promise<number | null> {
        const cached = cache.get(coin.key);
        if (cached && cached.expires > Date.now()) return cached.price;
        try {
            const query = new URLSearchParams({ chain: String(coin.chainId), token: coin.token ?? zeroAddress });
            const response = await fetchPrice(`https://li.quest/v1/token?${query}`, {
                signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            });
            if (!response.ok) return null;
            const price = Number(((await response.json()) as { priceUSD?: unknown }).priceUSD);
            if (!Number.isFinite(price) || price <= 0) return null;
            cache.set(coin.key, { price, expires: Date.now() + ttlMs });
            return price;
        } catch {
            return null;
        }
    }

    return {
        async usd(coins) {
            const found = await Promise.all(coins.map(async (coin) => [coin.key, await lookup(coin)] as const));
            return new Map(found.filter((entry): entry is [string, number] => entry[1] !== null));
        },
    };
}

/** Fixed prices keyed by symbol, so each chain's coin of that symbol gets the same price. */
export function fixedPrices(table: Record<string, number>): PriceFeed {
    return {
        async usd(coins) {
            const found = new Map<string, number>();
            for (const coin of coins) {
                const price = table[coin.symbol];
                if (price !== undefined) found.set(coin.key, price);
            }
            return found;
        },
    };
}
