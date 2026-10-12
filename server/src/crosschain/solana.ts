import type { CoinBalance } from "../protocol.ts";
import { SOLANA_COINS, formatCoinAmount } from "./catalog.ts";
import type { PriceFeed } from "./prices.ts";

export type SolanaRpc = {
    /** Lamports. */
    getBalance(owner: string): Promise<bigint>;
    /** Base units of the mint, summed over the owner's token accounts. */
    getTokenBalance(owner: string, mint: string): Promise<bigint>;
};

/** Plain JSON-RPC over fetch; each URL is tried in order until one answers. */
export function createSolanaRpc(
    urls: readonly string[],
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SolanaRpc {
    const { fetch: send = fetch, timeoutMs = 10_000 } = options;

    async function call<T>(method: string, params: unknown[]): Promise<T> {
        let failure: unknown = new Error("No Solana RPC URL is configured");
        for (const url of urls) {
            try {
                const response = await send(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!response.ok) throw new Error(`Solana RPC answered ${response.status}`);
                const body = (await response.json()) as { result?: T; error?: { message?: string } };
                if (body.result === undefined) throw new Error(body.error?.message ?? "Solana RPC gave no result");
                return body.result;
            } catch (error) {
                failure = error;
            }
        }
        throw failure;
    }

    return {
        async getBalance(owner) {
            return BigInt((await call<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }])).value);
        },
        async getTokenBalance(owner, mint) {
            const { value } = await call<{
                value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
            }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
            return value.reduce((sum, { account }) => sum + BigInt(account.data.parsed.info.tokenAmount.amount), 0n);
        },
    };
}

/** The wallet's SOL and USDC; a failed read gives null amounts, never an error. The owner is kept as given. */
export async function readSolanaBalances(
    { solana, prices }: { solana: SolanaRpc; prices: PriceFeed },
    owner: string,
): Promise<CoinBalance[]> {
    const [held, usd] = await Promise.all([
        Promise.all(
            SOLANA_COINS.map(async (coin) => {
                try {
                    return coin.mint ? await solana.getTokenBalance(owner, coin.mint) : await solana.getBalance(owner);
                } catch {
                    return null;
                }
            }),
        ),
        prices.usd(SOLANA_COINS).catch(() => new Map<string, number>()),
    ]);

    return SOLANA_COINS.map((coin, i): CoinBalance => {
        const base = {
            coin: coin.key,
            chain: coin.chain,
            chainId: coin.chainId,
            chainName: coin.chainName,
            symbol: coin.symbol,
            decimals: coin.decimals,
            wallet: owner,
        };
        const units = held[i];
        if (units === null) return { ...base, amount: null, spendable: null, usd: null };
        const price = usd.get(coin.key);
        const amount = formatCoinAmount(coin, units);
        return {
            ...base,
            amount,
            spendable: formatCoinAmount(coin, units > coin.gasReserve ? units - coin.gasReserve : 0n),
            usd: price === undefined ? null : Number(amount) * price,
        };
    });
}
