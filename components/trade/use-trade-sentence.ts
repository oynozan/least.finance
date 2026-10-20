"use client";

import { useMemo, useState } from "react";
import { initialState, reduce, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import type { Catalog } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { fitKey, refitTrade } from "@/lib/trade/fit";
import { DEFAULT_VERB, TRADE } from "@/lib/trade/registry";

/** Owns the sentence's state; the composer itself is fully controlled. */
export function useTradeSentence(
    holdings: TradeCtx["holdings"],
    catalog: Catalog,
    maxOrderUSD: number | null = null,
    perpTrading?: TradeCtx["perpTrading"],
    openPerps?: TradeCtx["openPerps"],
    pool?: TradeCtx["pool"],
) {
    const ctx = useMemo<TradeCtx>(
        () => ({ catalog, holdings, maxOrderUSD, pool, perpTrading, openPerps }),
        [catalog, holdings, maxOrderUSD, pool, perpTrading, openPerps],
    );
    const [state, setState] = useState<SentenceState<TradeTerms>>(() => initialState(TRADE, DEFAULT_VERB, ctx));
    // Coins that load after the sentence re-default everything the person didn't choose.
    // The coins the account holds decide what Sell and Swap start on and the pool's limit what Predict starts on, so a change in either refits too.
    const fit = fitKey(ctx);
    const [fitted, setFitted] = useState(fit);
    if (fitted !== fit) {
        setFitted(fit);
        setState((current) => refitTrade(current, ctx));
    }
    const view = useMemo(() => resolve(TRADE, state, ctx), [state, ctx]);
    const dispatch = (action: SentenceAction) => setState((current) => reduce(TRADE, current, action, ctx));
    return { state, view, dispatch };
}
