import type { TradeOrderRequest } from "@/server/src/trading/types";
import { QUOTE, TOKENS } from "@/lib/trade/catalog";
import { toWei, type OptimisticSpot } from "./state";

const DECIMALS = 8;

/** Coin units rounded down to 8 places, as a plain decimal string without trailing zeros. */
export function coinText(value: number): string {
    const floored = Math.floor(value * 10 ** DECIMALS) / 10 ** DECIMALS;
    return floored.toFixed(DECIMALS).replace(/\.?0+$/, "") || "0";
}

const homeOf = (symbol: string) => TOKENS.find((t) => t.symbol === symbol)?.home ?? "ethereum";

/** What a trade changes at the price shown, to count it before the server answers; null when the request can't be estimated. */
export function estimateTrade(req: TradeOrderRequest): OptimisticSpot | null {
    const price = Number(req.quotedPriceUSD);
    if (!(price > 0)) return null;
    if (req.verb === "buy") {
        const usd = Number(req.amountUSD);
        if (!(usd > 0)) return null;
        return {
            requestId: req.requestId,
            balanceWei: -toWei(req.amountUSD ?? "0"),
            paid: { symbol: QUOTE, units: req.amountUSD ?? "0" },
            got: { symbol: req.symbol, units: coinText(usd / price), network: homeOf(req.symbol) },
        };
    }
    const units = Number(req.units);
    if (!(units > 0)) return null;
    const paid = { symbol: req.symbol, units: req.units ?? "0" };
    if (req.verb === "sell") {
        return {
            requestId: req.requestId,
            balanceWei: toWei((units * price).toFixed(6)),
            paid,
            got: { symbol: QUOTE, units: (units * price).toFixed(6), network: homeOf(QUOTE) },
        };
    }
    const toPrice = Number(req.quotedToPriceUSD);
    if (!req.toSymbol || !(toPrice > 0)) return null;
    return {
        requestId: req.requestId,
        balanceWei: BigInt(0),
        paid,
        got: { symbol: req.toSymbol, units: coinText((units * price) / toPrice), network: homeOf(req.toSymbol) },
    };
}
