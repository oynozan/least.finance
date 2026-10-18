import { zeroAddress } from "viem";
import type { Coin } from "./catalog.ts";
import { throttle } from "./failures.ts";

/** Dollar prices of coins, keyed by `coin.key`. A coin whose price isn't known is left out. */
export interface PriceFeed {
    usd(coins: readonly Coin[]): Promise<Map<string, number>>;
}

const LOOKUP_TIMEOUT_MS = 5_000;
const LIFI_SOLANA_CHAIN = "1151111081099710";
const SOLANA_NATIVE_TOKEN = "11111111111111111111111111111111";

/** LI.FI's token prices, one request per coin, each kept for `ttlMs`. */
export function lifiPrices(
    options: {
        fetch?: typeof fetch;
        ttlMs?: number;
        logger?: { warn: (fields: object, message: string) => void };
    } = {},
): PriceFeed {
    const { fetch: fetchPrice = fetch, ttlMs = 60_000, logger } = options;
    const failedRecently = throttle(60_000);
    const failed = (coin: Coin, fields: object) => {
        if (failedRecently(coin.key))
            logger?.warn({ op: "prices.lifi", coin: coin.key, ...fields }, "Couldn't get a price from LI.FI");
        return null;
    };
    const cache = new Map<string, { price: number; expires: number }>();

    async function lookup(coin: Coin): Promise<number | null> {
        const cached = cache.get(coin.key);
        if (cached && cached.expires > Date.now()) return cached.price;
        try {
            const query =
                coin.chain === "solana"
                    ? new URLSearchParams({ chain: LIFI_SOLANA_CHAIN, token: coin.mint ?? SOLANA_NATIVE_TOKEN })
                    : new URLSearchParams({ chain: String(coin.chainId), token: coin.token ?? zeroAddress });
            const response = await fetchPrice(`https://li.quest/v1/token?${query}`, {
                signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            });
            if (!response.ok) return failed(coin, { status: response.status });
            const price = Number(((await response.json()) as { priceUSD?: unknown }).priceUSD);
            if (!Number.isFinite(price) || price <= 0) return failed(coin, { status: response.status, price });
            cache.set(coin.key, { price, expires: Date.now() + ttlMs });
            return price;
        } catch (error) {
            return failed(coin, { err: error });
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
