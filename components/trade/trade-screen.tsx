"use client";

import { TradeComposer } from "./trade-composer";
import { useTrade } from "./trade-provider";

/** The page's trade sentence, wired to the shared trade state. */
export function TradeScreen() {
    const { view, dispatch, search, refreshHoldings } = useTrade();
    return <TradeComposer view={view} dispatch={dispatch} search={search} onCoinOpen={refreshHoldings} />;
}
