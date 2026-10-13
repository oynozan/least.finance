import { sameWallet } from "@/lib/account/balances";
import { NETWORKS } from "@/server/src/swaps/coins";
import type { SwapHoldingRow, SwapHoldingsView } from "@/server/src/protocol";
import type { WalletHoldings } from "./context";
import type { NetworkId } from "./networks";

const KNOWN = new Set<string>(NETWORKS.map((network) => network.id));

const cacheKey = (userId: string) => `swap-holdings:${userId}`;

const isPair = (value: unknown): value is SwapHoldingsView["read"][number] => {
    const pair = value as Partial<SwapHoldingsView["read"][number]> | null;
    return (
        typeof pair === "object" && pair !== null && typeof pair.wallet === "string" && typeof pair.network === "string"
    );
};

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

/** The view when it has the shape of one, without any row or pair that doesn't; one without pairs read has none read. */
export function validHoldings(value: unknown): SwapHoldingsView | null {
    const view = value as Partial<SwapHoldingsView> | null;
    if (typeof view !== "object" || view === null || typeof view.readAt !== "string" || !Array.isArray(view.rows)) {
        return null;
    }
    return {
        readAt: view.readAt,
        rows: view.rows.filter(isRow),
        read: Array.isArray(view.read) ? view.read.filter(isPair) : [],
    };
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

/** What the signing wallets hold, and their networks that were never read; an EVM address matches whatever its casing, a Solana one exactly. */
export function walletHoldings(
    rows: readonly SwapHoldingRow[],
    read: SwapHoldingsView["read"],
    signers: { evm?: string; solana?: string },
): WalletHoldings {
    const units: Record<string, Partial<Record<NetworkId, number>>> = {};
    for (const row of rows) {
        const signer = row.network === "solana" ? signers.solana : signers.evm;
        if (!signer || !KNOWN.has(row.network) || !sameWallet(row.wallet, signer)) continue;
        const amount = Number(row.amount);
        if (!(amount > 0) || !Number.isFinite(amount)) continue;
        const coin = (units[row.symbol] ??= {});
        coin[row.network] = (coin[row.network] ?? 0) + amount;
    }
    const unread = NETWORKS.filter(({ id, kind }) => {
        const signer = kind === "solana" ? signers.solana : signers.evm;
        return !!signer && !read.some((pair) => pair.network === id && sameWallet(pair.wallet, signer));
    }).map(({ id }) => id);
    return { units, unread };
}
