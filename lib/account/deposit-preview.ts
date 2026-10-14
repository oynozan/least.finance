import { formatUsd } from "@/components/wallet-data";
import type { CoinBalance } from "@/server/src/protocol";
import type { DepositQuoteView } from "./state";

const LAMPORTS_PER_SOL = 1e9;

/** "2 s", "3 min". */
const etaText = (seconds: number) =>
    seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;

/** The SOL a deposit leaves with Circle as rent: "plus about 0.004 SOL held by Circle for 5 days". */
export const heldSolText = (heldLamports: string) =>
    `plus about ${(Number(heldLamports) / LAMPORTS_PER_SOL).toLocaleString("en-US", { maximumFractionDigits: 3 })} SOL held by Circle for 5 days`;

/** What a quote pays: "≈ $300.00 in about 2 s"; from Solana "You get about 9.97 USDC in about 5 s", with the fee when the amount sent is known in dollars and the SOL Circle holds. */
export function previewText(coin: CoinBalance, amount: string | null, payout: DepositQuoteView) {
    const out = Number(payout.usdcOut);
    const eta = etaText(payout.etaSeconds);
    if (coin.chain !== "solana") return `≈ ${formatUsd(out)} in about ${eta}`;
    const sent =
        coin.symbol === "USDC"
            ? Number(amount)
            : coin.usd !== null && coin.amount !== null && Number(coin.amount) > 0
              ? (Number(amount) * coin.usd) / Number(coin.amount)
              : null;
    const fee = sent === null ? 0 : sent - out;
    const got = `You get about ${out.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC in about ${eta}`;
    const costs = [
        ...(fee >= 0.005 ? [`fee ${formatUsd(fee)}`] : []),
        ...(payout.sol ? [heldSolText(payout.sol.held)] : []),
    ];
    return costs.length > 0 ? `${got} · ${costs.join(", ")}` : got;
}
