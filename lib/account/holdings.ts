import type { CoinWithdrawalView, HoldingView } from "@/server/src/trading/types";
import { COINS, NETWORKS } from "@/server/src/swaps/coins";

export type HoldingRow = HoldingView & { usd: number | null };

/** The holdings with their dollar value at the live prices, the most valuable first; a coin with no price yet goes last. */
export function holdingRows(holdings: HoldingView[], priceOf: (symbol: string) => number | null): HoldingRow[] {
    return holdings
        .map((h) => {
            const price = priceOf(h.symbol);
            return { ...h, usd: price === null ? null : Number(h.units) * price };
        })
        .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
}

const isSolana = (network: string) => NETWORKS.find((n) => n.id === network)?.kind === "solana";

/** The linked wallet a coin on `network` is sent to by default: the Solana wallet for Solana, else the EVM one. */
export function sendAddress(network: string, wallets: { evm?: string; solana?: string }): string {
    return (isSolana(network) ? wallets.solana : wallets.evm) ?? "";
}

/** Whether `to` looks like an address on `network`; the server checks it again. */
export function validAddress(network: string, to: string): boolean {
    return isSolana(network) ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) : /^0x[0-9a-fA-F]{40}$/.test(to);
}

/** The decimals a held coin can be sent in, as its home network keeps them */
export function sendDecimals(symbol: string): number {
    const coin = COINS.find((c) => c.symbol === symbol);
    return coin?.entries.find((e) => e.network === coin.home)?.decimals ?? 18;
}

/** Why the units can't be sent from a holding, or null when they can. */
export function sendIssue(text: string, held: string): string | null {
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) return "Enter an amount.";
    return Number(text) > Number(held) ? "That's more than you hold." : null;
}

/** The sends still in view: those moving or failed lately, newest first, and the done ones for a short while. */
export function recentSends(sends: CoinWithdrawalView[], now: number, windowMs = 60 * 60_000): CoinWithdrawalView[] {
    return sends.filter((s) => now - new Date(s.at).getTime() < windowMs).slice(0, 5);
}
