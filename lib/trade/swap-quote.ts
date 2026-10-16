import type { PreviewRow } from "@/lib/sentence";
import type { SwapOrderRequest, SwapQuoteView } from "@/server/src/protocol";
import { priceOf, type TradeCtx } from "./context";
import { formatUnits, formatUsd } from "./format";
import { networkName } from "./networks";

const LIFI_FEE = /^li\.?fi\b/i;

/** "about 20 s", "about 18 min" */
export function formatEta(seconds: number) {
    if (seconds < 120) return `about ${Math.max(1, Math.round(seconds))} s`;
    return `about ${Math.round(seconds / 60)} min`;
}

/** Fees as "LI.FI 0.25% ($0.03)" and "Relayer ($0.10)"; "None" when there are none. */
function formatFees(quote: SwapQuoteView) {
    const paid = Number(quote.request.amountUSD);
    const fees = quote.fees.map((fee) => {
        if (!LIFI_FEE.test(fee.name)) return `${fee.name} (${formatUsd(fee.usd)})`;
        const percent = paid > 0 ? `${Number(((fee.usd / paid) * 100).toFixed(2))}%` : "";
        return `${["LI.FI", percent].filter(Boolean).join(" ")} (${formatUsd(fee.usd)})`;
    });
    return fees.length ? fees.join(", ") : "None";
}

/** The review's rows for LI.FI's quote; a dollar value without a price reads "—". */
export function swapQuoteRows(quote: SwapQuoteView, ctx: TradeCtx): PreviewRow[] {
    const { from, to, amountUSD } = quote.request;
    const price = priceOf(ctx, to.token);
    const min = Number(quote.toAmountMin);
    const minUsd = price === null ? "—" : formatUsd(min * price);
    return [
        {
            id: "pay",
            label: "You pay",
            value: `${formatUnits(Number(quote.fromAmount), from.token)} (${formatUsd(Number(amountUSD))}) on ${networkName(from.network)}`,
            primary: true,
        },
        {
            id: "get",
            label: "You get",
            value: `≈ ${formatUnits(Number(quote.toAmount), to.token)} on ${networkName(to.network)}`,
            primary: true,
        },
        { id: "min", label: "At least", value: `${formatUnits(min, to.token)} (${minUsd})` },
        { id: "fees", label: "Fees", value: formatFees(quote) },
        { id: "gas", label: "Network gas", value: `≈ ${formatUsd(quote.gasUSD)}` },
        { id: "time", label: "Time", value: formatEta(quote.etaSeconds) },
        { id: "route", label: "Route", value: quote.tool },
    ];
}

/** The order to open for a reviewed quote: its request, the minimum shown, and the slippage it was built with so the confirm is quoted the same way. */
export function swapOrderOf(quote: SwapQuoteView): SwapOrderRequest {
    return {
        ...quote.request,
        reviewedMin: quote.toAmountMin,
        ...(quote.slippage !== undefined && { slippage: quote.slippage }),
    };
}
