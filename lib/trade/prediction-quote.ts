import type { PreviewRow } from "@/lib/sentence";
import type { QuoteView } from "@/server/src/protocol";
import { formatCents, formatUsd } from "./format";

/** The review's preview rows from the server's quote; `chance` adds the market odds row. */
export function quoteRows(quote: QuoteView, outcomeLabel: string, binaryOther?: string, chance?: number): PreviewRow[] {
    const amount = Number(quote.amountUSD);
    const payout = Number(quote.payoutUSD);
    const rows: PreviewRow[] = [
        {
            id: "shares",
            label: "You buy",
            value: `${quote.shares} shares at ${formatCents(quote.avgPrice)}`,
            primary: true,
        },
        {
            id: "win",
            label: `If ${outcomeLabel}`,
            value: `you get ${formatUsd(payout)} (+${formatUsd(payout - amount)})`,
            tone: "gain",
            primary: true,
        },
        {
            id: "lose",
            label: binaryOther ? `If ${binaryOther}` : "Otherwise",
            value: `you lose ${formatUsd(amount)}`,
            tone: "loss",
        },
        { id: "fee", label: "Polymarket's fee", value: formatUsd(Number(quote.feeUSD)) },
    ];
    if (chance !== undefined) {
        rows.push({ id: "odds", label: "Market odds", value: `${Math.round(chance * 100)}% chance` });
    }
    return rows;
}
