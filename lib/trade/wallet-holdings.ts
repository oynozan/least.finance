import { sameWallet } from "@/lib/account/balances";
import { NETWORKS } from "@/server/src/swaps/coins";
import type { SwapHoldingRow, SwapHoldingsView } from "@/server/src/protocol";
import type { WalletHoldings } from "./context";
import type { NetworkId } from "./networks";

const KNOWN = new Set<string>(NETWORKS.map((network) => network.id));

const cacheKey = (userId: string) => `swap-holdings:${userId}`;

const isRow = (value: unknown): value is SwapHoldingRow => {
    const row = value as Partial<SwapHoldingRow> | null;
    return (
        typeof row === "object" &&
        row !== null &&
        typeof row.wallet === "string" &&
        typeof row.network === "string" &&
        typeof row.symbol === "string" &&
        typeof row.amount === "string" &&
        (row.usd === null || typeof row.usd === "number")
    );
};

/** The view when it has the shape of one, without any row that doesn't; null otherwise. */
export function validHoldings(value: unknown): SwapHoldingsView | null {
    const view = value as Partial<SwapHoldingsView> | null;
    if (typeof view !== "object" || view === null || typeof view.readAt !== "string" || !Array.isArray(view.rows)) {
        return null;
    }
    return { readAt: view.readAt, rows: view.rows.filter(isRow) };
}

/** The last holdings kept for this person, or null when there are none or storage is unavailable. */
export function loadCachedSwapHoldings(userId: string): SwapHoldingsView | null {
    try {
        const raw = localStorage.getItem(cacheKey(userId));
        return raw ? validHoldings(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

export function saveCachedSwapHoldings(userId: string, view: SwapHoldingsView): void {
    try {
        localStorage.setItem(cacheKey(userId), JSON.stringify(view));
    } catch {
        // Storage is blocked or full; the caps work without a cache.
    }
}

/** Coin units the signing wallets hold per coin and network; an EVM address matches whatever its casing, a Solana one exactly. */
export function walletHoldings(
    rows: readonly SwapHoldingRow[],
    signers: { evm?: string; solana?: string },
): WalletHoldings {
    const held: Record<string, Partial<Record<NetworkId, number>>> = {};
    for (const row of rows) {
        const signer = row.network === "solana" ? signers.solana : signers.evm;
        if (!signer || !KNOWN.has(row.network) || !sameWallet(row.wallet, signer)) continue;
        const units = Number(row.amount);
        if (!(units > 0) || !Number.isFinite(units)) continue;
        const coin = (held[row.symbol] ??= {});
        coin[row.network] = (coin[row.network] ?? 0) + units;
    }
    return held;
}
