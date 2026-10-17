import { refit, type SentenceState } from "@/lib/sentence";
import type { TradeCtx, TradeTerms } from "./context";
import { TRADE } from "./registry";

/**
 * What the sentence's untouched parts depend on, so it refits when it changes and at no other time:
 * which coins are held (what Sell and Swap start on) and the prediction pool's limit (what Predict starts on).
 */
export function fitKey({ holdings, maxOrderUSD }: Pick<TradeCtx, "holdings" | "maxOrderUSD">): string {
    const held = holdings ? Object.keys(holdings).filter((symbol) => holdings[symbol]) : [];
    return `${held.join()}|${typeof maxOrderUSD === "number" ? maxOrderUSD : ""}`;
}

/** The sentence with whatever the person didn't choose refitted to the context. */
export const refitTrade = (state: SentenceState<TradeTerms>, ctx: TradeCtx) => refit(TRADE, state, ctx);
