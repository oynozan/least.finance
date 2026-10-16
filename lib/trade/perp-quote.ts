import type { PreviewRow } from "@/lib/sentence";
import type { PerpQuoteView } from "@/server/src/protocol";
import { formatPrice, formatUsd, formatUsdShort } from "./format";

const price = (px: string) => formatPrice(Number(px));

/** Hourly funding as a percent, "0.00125%"; positive means longs pay shorts. */
const fundingText = (rate: string) => `${Number((Number(rate) * 100).toPrecision(3))}% per hour`;

/** The review's preview rows from the server's perp quote; the position and the loss limit come from the sentence. */
export function quoteRows(
    quote: PerpQuoteView,
    ctx: { side: "long" | "short"; asset: string; leverage: number; collateralUSD: string },
): PreviewRow[] {
    const collateral = Number(ctx.collateralUSD);
    const ours = Number(quote.ourFeeUSD);
    return [
        {
            id: "size",
            label: "Position",
            value: formatUsdShort(Number(quote.notionalUSD)),
            note: `${quote.sizeCoin} ${ctx.asset}, ${ctx.leverage} × ${formatUsdShort(collateral - ours)}`,
            primary: true,
        },
        { id: "entry", label: "Entry price (about)", value: price(quote.entryPx), primary: true },
        {
            id: "liquidation",
            label: "Liquidation price (about)",
            value: `${price(quote.liquidationPx)}, before funding`,
            tone: "loss",
        },
        {
            id: "fees",
            label: "Fees",
            value: `${formatUsd(Number(quote.takerFeeUSD))} Hyperliquid${ours > 0 ? `, ${formatUsd(ours)} ours` : ""}`,
        },
        { id: "funding", label: "Funding", value: fundingText(quote.fundingPerHour) },
        { id: "risk", label: "Most you can lose", value: formatUsd(collateral) },
    ];
}
