import { formatUnits, parseUnits } from "viem";
import type { BalancesView, CoinBalance } from "@/server/src/protocol";

/** Within this long of the last read, a refresh does nothing. */
export const REFRESH_INTERVAL_MS = 30_000;

const cacheKey = (userId: string) => `balances:${userId}`;

/** An Ethereum address matches whatever its casing; a Solana one (base58 has no "0x" prefix) is case-sensitive. */
export const sameWallet = (a: string, b: string) =>
    a === b || (/^0x/i.test(a) && /^0x/i.test(b) && a.toLowerCase() === b.toLowerCase());

/** The last snapshot kept for this person, or null when there is none or storage is unavailable. */
export function loadCachedBalances(userId: string): BalancesView | null {
    try {
        const raw = localStorage.getItem(cacheKey(userId));
        if (!raw) return null;
        const view = JSON.parse(raw) as BalancesView;
        return typeof view?.readAt === "string" && Array.isArray(view.rows) ? view : null;
    } catch {
        return null;
    }
}

export function saveCachedBalances(userId: string, view: BalancesView): void {
    try {
        localStorage.setItem(cacheKey(userId), JSON.stringify(view));
    } catch {
        // Storage is blocked or full; the list works without a cache.
    }
}

/** Whether a refresh is worth sending: the view is 30 s old, or one of `wallets` has no rows in it yet. */
export function needsRefresh(view: BalancesView | null, wallets: string[], now: number): boolean {
    if (!view) return true;
    const age = now - Date.parse(view.readAt);
    if (!(age < REFRESH_INTERVAL_MS)) return true;
    return wallets.some((wallet) => !view.rows.some((row) => sameWallet(row.wallet, wallet)));
}

const ZERO = BigInt(0);

const lower = (value: string | null, by: bigint, decimals: number) => {
    if (value === null) return null;
    const left = parseUnits(value, decimals) - by;
    return formatUnits(left > ZERO ? left : ZERO, decimals);
};

/** The view with `amount` of `coin` taken out of `wallet`'s row, until the next read corrects it. */
export function dropAfterSend(view: BalancesView, coin: string, wallet: string, amount: string): BalancesView {
    const rows = view.rows.map((row): CoinBalance => {
        if (row.coin !== coin || !sameWallet(row.wallet, wallet)) return row;
        const by = parseUnits(amount, row.decimals);
        return {
            ...row,
            amount: lower(row.amount, by, row.decimals),
            spendable: lower(row.spendable, by, row.decimals),
        };
    });
    return { ...view, rows };
}
