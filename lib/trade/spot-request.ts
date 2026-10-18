import type { TradeOrderRequest } from "@/server/src/trading/types";
import { coinText } from "@/lib/account/spot";
import { QUOTE } from "./catalog";
import type { TransactionIntent } from "./intent";

/** The intents a trade from the balance carries out. */
export type SpotIntent = Extract<TransactionIntent, { type: "swap" | "spot" }>;

export const isSpotIntent = (intent: TransactionIntent | null | undefined): intent is SpotIntent =>
    intent?.type === "swap" || intent?.type === "spot";

/** What the review needs to place a trade: the coins' prices as shown, and the units the account holds of the coin sold. */
export type SpotInputs = {
    price: (symbol: string) => number | null;
    held: (symbol: string) => number;
    /** The holding's exact units, so selling all of it sends what is held and not a rounded figure. */
    heldText: (symbol: string) => string;
};

/** How far under the holding's value an amount may fall and still be all of it, the cent the amount's two places cut off */
const WHOLE_WITHIN_USD = 0.01;

/** Units of the sold coin for a dollar amount, all of the holding when the amount is within a cent of its value, else rounded down */
function unitsFor(symbol: string, amountUSD: number, inputs: SpotInputs, price: number): string {
    const holding = inputs.held(symbol);
    if (holding * price - amountUSD <= WHOLE_WITHIN_USD + 1e-9) return inputs.heldText(symbol);
    return coinText(amountUSD / price);
}

/** The sentence for the price an intent is waiting on, or null when it has them all or its amount is empty. */
export function missingPrice(intent: SpotIntent, inputs: SpotInputs): string | null {
    if (!(Number(intent.amountUSD) > 0)) return null;
    const symbols = intent.type === "swap" ? [intent.fromToken, intent.toToken] : [intent.token];
    const missing = symbols.find((symbol) => symbol !== QUOTE && !inputs.price(symbol));
    return missing ? `The ${missing} price isn't loaded yet.` : null;
}

/** The request for an intent at the prices shown, or null while a price is unknown or the amount is empty. */
export function toTradeRequest(intent: SpotIntent, inputs: SpotInputs, requestId: string): TradeOrderRequest | null {
    const amountUSD = Number(intent.amountUSD);
    if (!(amountUSD > 0)) return null;
    if (intent.type === "spot" && intent.side === "buy") {
        const price = inputs.price(intent.token);
        if (!price) return null;
        return {
            requestId,
            verb: "buy",
            symbol: intent.token,
            amountUSD: intent.amountUSD,
            quotedPriceUSD: String(price),
        };
    }
    const symbol = intent.type === "swap" ? intent.fromToken : intent.token;
    const price = inputs.price(symbol);
    if (!price || symbol === QUOTE) return null;
    const units = unitsFor(symbol, amountUSD, inputs, price);
    if (intent.type === "spot") {
        return { requestId, verb: "sell", symbol, units, quotedPriceUSD: String(price) };
    }
    const toPrice = inputs.price(intent.toToken);
    if (!toPrice) return null;
    return {
        requestId,
        verb: "swap",
        symbol,
        toSymbol: intent.toToken,
        units,
        quotedPriceUSD: String(price),
        quotedToPriceUSD: String(toPrice),
    };
}
