import type { TradeOrderRequest } from "@/server/src/trading/types";
import { QUOTE, TOKENS } from "@/lib/trade/catalog";
import { askOf, lessSpread } from "@/lib/trade/spread";
import { toWei, type OptimisticSpot } from "./state";

const DECIMALS = 8;

/** Coin units rounded down to 8 places, as a plain decimal string without trailing zeros. */
export function coinText(value: number): string {
    const floored = Math.floor(value * 10 ** DECIMALS) / 10 ** DECIMALS;
    return floored.toFixed(DECIMALS).replace(/\.?0+$/, "") || "0";
}

const VERB_ENDING = {
    buy: "Nothing was spent.",
    sell: "Nothing was sold.",
    swap: "Nothing was swapped.",
    send: "Nothing was sent.",
} as const;

/** What a person is told when a trade or send can't be sent because the account or the connection isn't ready. */
export function unsentCopy(
    why: "loading" | "failed" | "offline" | "unreachable",
    verb: keyof typeof VERB_ENDING,
    failed?: string,
): string {
    if (why === "loading") return "Your account is still loading. Try again in a moment.";
    if (why === "failed") return `Your account didn't load${failed ? `: ${failed}` : ""}. ${VERB_ENDING[verb]}`;
    if (why === "offline") return `You're offline. ${VERB_ENDING[verb]}`;
    return `Can't reach the server right now. ${VERB_ENDING[verb]}`;
}

/** What a person is told when the server never answered a trade or send: it may or may not have gone through. */
export const unconfirmedCopy = (verb: keyof typeof VERB_ENDING, seconds: number) =>
    `The server didn't answer in ${seconds} seconds, so we can't confirm this ${verb}. Check your balance and holdings before trying again.`;

/** Why a trade request can't be counted before it is sent, naming the price or amount that is missing. */
export function whyNoEstimate(req: TradeOrderRequest): string {
    const missing = !(Number(req.quotedPriceUSD) > 0)
        ? `the ${req.symbol} price isn't loaded yet`
        : req.verb === "swap" && !req.toSymbol
          ? "no coin to swap into is picked"
          : req.verb === "swap" && !(Number(req.quotedToPriceUSD) > 0)
            ? `the ${req.toSymbol} price isn't loaded yet`
            : "the amount is empty or isn't a number";
    return `Couldn't work out this ${req.verb}: ${missing}. Try again in a moment.`;
}

const homeOf = (symbol: string) => TOKENS.find((t) => t.symbol === symbol)?.home ?? "ethereum";

/** What a trade changes at the price shown and the spread, to count it before the server answers; null when the request can't be estimated. */
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
            got: { symbol: req.symbol, units: coinText(usd / askOf(price)), network: homeOf(req.symbol) },
        };
    }
    const units = Number(req.units);
    if (!(units > 0)) return null;
    const paid = { symbol: req.symbol, units: req.units ?? "0" };
    if (req.verb === "sell") {
        const proceeds = lessSpread(units * price).toFixed(6);
        return {
            requestId: req.requestId,
            balanceWei: toWei(proceeds),
            paid,
            got: { symbol: QUOTE, units: proceeds, network: homeOf(QUOTE) },
        };
    }
    const toPrice = Number(req.quotedToPriceUSD);
    if (!req.toSymbol || !(toPrice > 0)) return null;
    return {
        requestId: req.requestId,
        balanceWei: BigInt(0),
        paid,
        got: {
            symbol: req.toSymbol,
            units: coinText(lessSpread(units * price) / toPrice),
            network: homeOf(req.toSymbol),
        },
    };
}
