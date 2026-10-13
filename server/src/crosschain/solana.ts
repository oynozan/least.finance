import { base58 } from "@scure/base";
import type { CoinBalance } from "../protocol.ts";
import { SOLANA_COINS, formatCoinAmount } from "./catalog.ts";
import type { PriceFeed } from "./prices.ts";

export type SolanaRpc = {
    /** Lamports. */
    getBalance(owner: string): Promise<bigint>;
    /** Base units of the mint, summed over the owner's token accounts. */
    getTokenBalance(owner: string, mint: string): Promise<bigint>;
    getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    /** One entry per signature, null when the cluster doesn't know it. */
    getSignatureStatuses(
        signatures: string[],
    ): Promise<({ confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null)[]>;
    /** The address list of each lookup table; a missing table is left out. */
    getAddressLookupTables(addresses: string[]): Promise<{ address: string; addresses: string[] }[]>;
    /** Null when the account doesn't exist. */
    getAccountInfo(address: string): Promise<{ owner: string; lamports: bigint } | null>;
};

const LOOKUP_TABLE_HEADER_BYTES = 56;

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
        async getLatestBlockhash() {
            const { value } = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
                "getLatestBlockhash",
                [{ commitment: "confirmed" }],
            );
            return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
        },
        async getSignatureStatuses(signatures) {
            const { value } = await call<{
                value: ({ confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null)[];
            }>("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
            return value.map((status) =>
                status ? { confirmationStatus: status.confirmationStatus, err: status.err } : null,
            );
        },
        async getAddressLookupTables(addresses) {
            const { value } = await call<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
                addresses,
                { encoding: "base64", commitment: "confirmed" },
            ]);
            const tables: { address: string; addresses: string[] }[] = [];
            value.forEach((account, i) => {
                if (!account) return;
                const data = Buffer.from(account.data[0], "base64");
                const list: string[] = [];
                for (let at = LOOKUP_TABLE_HEADER_BYTES; at + 32 <= data.length; at += 32) {
                    list.push(base58.encode(data.subarray(at, at + 32)));
                }
                tables.push({ address: addresses[i]!, addresses: list });
            });
            return tables;
        },
        async getAccountInfo(address) {
            const { value } = await call<{ value: { owner: string; lamports: number } | null }>("getAccountInfo", [
                address,
                { encoding: "base64", commitment: "confirmed" },
            ]);
            return value ? { owner: value.owner, lamports: BigInt(value.lamports) } : null;
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
        const units = held[i]!;
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
