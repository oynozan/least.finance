import { getAddressDecoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

/**
 * The control API of the test backend (server/test/e2e/serve.ts), which
 * playwright.config.ts starts beside the app: the real server, on a chain
 * and a Privy of its own.
 */
export const CONTROL_URL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 4101}`;

async function call<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${CONTROL_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

/** A fresh wallet for each test, so tests sharing the backend never see each other's deposits. */
export const randomAddress = () => privateKeyToAddress(generatePrivateKey()).toLowerCase();

/** A fresh Solana wallet address (base58, case-sensitive) for a test that signs in with Solana. */
export const randomSolanaAddress = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));

/** A Privy user owning `address` (and the wallets in `also`), its real access token, and (for an Ethereum wallet) USDC in it to deposit. */
export const signUp = (address: string, usdc = "20000", also: string[] = []) =>
    call<{ userId: string; token: string }>("/users", { address, usdc, also });

export type SeededDeposit = { amount: string; daysAgo: number };

/** Deposit history, written straight to the account as if credited over time. */
export const seedDeposits = (address: string, deposits: SeededDeposit[]) =>
    call<{ depositAddress: string; balance: string }>("/seed", { address, deposits });

/** USDC sent to `to` from a wallet outside the app, such as an exchange. */
export const sendFromOutside = (to: string, usdc: string) => call<{ txHash: string }>("/send", { to, usdc });

/** The account as the server holds it, or null before the wallet connects. */
export const accountOf = (address: string) =>
    call<{ depositAddress: string; balance: string } | null>("/account", { address });

/** A JSON-RPC call to a test chain: Ethereum (1), BNB Chain (56) or, by default, Arc. */
export const chainRpc = (method: string, params: unknown[] = [], chainId?: number) =>
    call<{ result?: unknown; error?: { code: number; message: string } }>("/rpc", { method, params, chainId });

/** Sets what a wallet holds of a catalog coin such as "bnb:USDT", in the coin's own units. */
export const fundSource = (address: string, coin: string, amount: string) =>
    call<object>("/source/fund", { address, coin, amount }).then(() => undefined);

/** Moves the newest bridge order of the person who owns `address`; "filled" pays out on Arc. */
export const advanceBridge = (address: string, stage: "pending" | "filled" | "refunded" | "failed") =>
    call<object>("/bridge/advance", { address, stage }).then(() => undefined);

/** What the pool's trader does with the next order on a token; "hold" keeps it unanswered until `releaseOrder`. */
export const nextOrder = (tokenId: string, behavior: string) =>
    call<object>("/polymarket/next", { tokenId, behavior }).then(() => undefined);

/** Answers the order held on a token: "fill" or "reject:price_moved", "reject:market_closed", "reject:rejected". */
export const releaseOrder = (tokenId: string, behavior: string) =>
    call<object>("/polymarket/release", { tokenId, behavior }).then(() => undefined);

/** Closes a market with its result: prices such as ["1", "0"], or ["0.5", "0.5"] for a 50/50. */
export const resolveMarket = (marketId: string, prices: string[]) =>
    call<object>("/polymarket/resolve", { marketId, prices }).then(() => undefined);

/** Sets the pool's pUSD in whole dollars. */
export const setPoolBalance = (usd: number) => call<object>("/polymarket/balance", { usd }).then(() => undefined);

/** Resolves the newest delayed order on a token: "fill" or "cancel". */
export const settleDelayed = (tokenId: string, outcome: "fill" | "cancel") =>
    call<object>("/polymarket/settle-delayed", { tokenId, outcome }).then(() => undefined);

/** Runs one pass of the server's resolver now, so a resolved market pays out without waiting. */
export const resolveNow = () => call<object>("/predictions/resolve-now", {}).then(() => undefined);

/** Cuts the person's open position on a token down to `shares`, which leaves it too small to sell. */
export const shrinkPosition = (address: string, tokenId: string, shares: string) =>
    call<object>("/positions/shrink", { address, tokenId, shares }).then(() => undefined);
