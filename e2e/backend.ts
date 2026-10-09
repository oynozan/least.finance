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

/** A Privy user owning `address`, its real access token, and (for an Ethereum wallet) USDC in it to deposit. */
export const signUp = (address: string, usdc = "20000") =>
    call<{ userId: string; token: string }>("/users", { address, usdc });

export type SeededDeposit = { amount: string; daysAgo: number };

/** Deposit history, written straight to the account as if credited over time. */
export const seedDeposits = (address: string, deposits: SeededDeposit[]) =>
    call<{ depositAddress: string; balance: string }>("/seed", { address, deposits });

/** USDC sent to `to` from a wallet outside the app, such as an exchange. */
export const sendFromOutside = (to: string, usdc: string) => call<{ txHash: string }>("/send", { to, usdc });

/** The account as the server holds it, or null before the wallet connects. */
export const accountOf = (address: string) =>
    call<{ depositAddress: string; balance: string } | null>("/account", { address });

/** A JSON-RPC call to the test chain. */
export const chainRpc = (method: string, params: unknown[] = []) =>
    call<{ result?: unknown; error?: { code: number; message: string } }>("/rpc", { method, params });
