"use client";

import { useMemo, useState } from "react";
import { initialState, reduce, refit, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import type { Catalog } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { DEFAULT_VERB, TRADE } from "@/lib/trade/registry";

/** Owns the sentence's state; the composer itself is fully controlled. */
export function useTradeSentence(
    holdings: TradeCtx["holdings"],
    catalog: Catalog,
    maxOrderUSD: number | null = null,
    wallet?: TradeCtx["wallet"],
    perpTrading?: TradeCtx["perpTrading"],
    openPerps?: TradeCtx["openPerps"],
) {
    const ctx = useMemo<TradeCtx>(
        () => ({ catalog, holdings, wallet, maxOrderUSD, perpTrading, openPerps }),
        [catalog, holdings, wallet, maxOrderUSD, perpTrading, openPerps],
    );
    const [state, setState] = useState<SentenceState<TradeTerms>>(() => initialState(TRADE, DEFAULT_VERB, ctx));
    // Coins that load after the sentence, or a new signing wallet's, re-default everything the person didn't choose.
    // The coins the account holds decide what Sell and Swap start on, so a change in which are held refits too.
    const fit = `${
        holdings
            ? Object.keys(holdings)
                  .filter((symbol) => holdings[symbol])
                  .join()
            : ""
    }|${wallet ? 1 : 0}`;
    const [fitted, setFitted] = useState(fit);
    if (fitted !== fit) {
        setFitted(fit);
        setState((current) => refit(TRADE, current, ctx));
    }
    const view = useMemo(() => resolve(TRADE, state, ctx), [state, ctx]);
    const dispatch = (action: SentenceAction) => setState((current) => reduce(TRADE, current, action, ctx));
    return { state, view, dispatch };
}
