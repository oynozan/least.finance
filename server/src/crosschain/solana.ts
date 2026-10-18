import { base58 } from "@scure/base";
import { AppError, hostOf } from "../errors.ts";
import type { CoinBalance } from "../protocol.ts";
import { SOLANA_COINS, formatCoinAmount } from "./catalog.ts";
import { throttle } from "./failures.ts";
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
    /** Lamports an account of this many bytes must hold to stay rent-exempt. */
    getMinimumBalanceForRentExemption(bytes: number): Promise<bigint>;
    /** Null when the account doesn't exist. */
    getAccountInfo(address: string): Promise<{ owner: string; lamports: bigint } | null>;
};

const LOOKUP_TABLE_HEADER_BYTES = 56;

type RpcLog = { warn: (fields: object, message: string) => void };

/** Balance reads that fail are told once a minute per wallet and coin. */
const balanceDown = throttle(60_000);

/** Plain JSON-RPC over fetch; each URL is tried in order until one answers. */
export function createSolanaRpc(
    urls: readonly string[],
    options: { fetch?: typeof fetch; timeoutMs?: number; logger?: RpcLog } = {},
): SolanaRpc {
    const { fetch: send = fetch, timeoutMs = 10_000, logger } = options;
    const failedRecently = throttle(60_000);

    async function call<T>(method: string, params: unknown[]): Promise<T> {
        const failures: Error[] = [];
        let busy = false;
        for (const url of urls) {
            // Only the host is ever written: the URL can carry an API key
            const host = hostOf(url);
            let status: number | null = null;
            try {
                const response = await send(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                status = response.status;
                if (!response.ok) throw new Error(`Solana RPC ${host} answered ${response.status} to ${method}`);
                const body = (await response.json()) as { result?: T; error?: { message?: string } };
                if (body.result === undefined) {
                    throw new Error(`Solana RPC ${host} failed ${method}: ${body.error?.message ?? "no result"}`);
                }
                return body.result;
            } catch (error) {
                busy ||= status === 429;
                failures.push(error instanceof Error ? error : new Error(String(error)));
                if (failedRecently(`${host} ${method}`)) {
                    logger?.warn({ op: "solana.rpc", method, host, status, err: error }, "A Solana RPC call failed");
                }
            }
        }
        const cause =
            failures.length === 1
                ? failures[0]
                : new AggregateError(failures, failures.map((f) => f.message).join("; "));
        if (failures.length === 0) throw new Error("No Solana RPC URL is configured");
        throw new AppError(
            "unavailable",
            busy ? "The Solana network is busy, try again." : "Couldn't reach Solana's network. Try again shortly.",
            { cause },
        );
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
        async getMinimumBalanceForRentExemption(bytes) {
            return BigInt(await call<number>("getMinimumBalanceForRentExemption", [bytes]));
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
    { solana, prices, logger }: { solana: SolanaRpc; prices: PriceFeed; logger?: RpcLog },
    owner: string,
): Promise<CoinBalance[]> {
    const [held, usd] = await Promise.all([
        Promise.all(
            SOLANA_COINS.map(async (coin) => {
                try {
                    return coin.mint ? await solana.getTokenBalance(owner, coin.mint) : await solana.getBalance(owner);
                } catch (error) {
                    if (balanceDown(`${owner} ${coin.key}`)) {
                        logger?.warn(
                            { op: "balances.solana", wallet: owner, coin: coin.key, err: error },
                            "Couldn't read a Solana wallet's balance",
                        );
                    }
                    return null;
                }
            }),
        ),
        prices.usd(SOLANA_COINS).catch((error: unknown) => {
            if (balanceDown("prices"))
                logger?.warn({ op: "balances.prices", err: error }, "Couldn't price a wallet's coins");
            return new Map<string, number>();
        }),
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
        if (units === null) {
            const readError = `${coin.chainName} didn't answer, so this balance isn't shown.`;
            return { ...base, amount: null, spendable: null, usd: null, readError };
        }
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
