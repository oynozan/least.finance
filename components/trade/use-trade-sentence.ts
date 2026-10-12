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
) {
    const ctx = useMemo<TradeCtx>(
        () => ({ catalog, holdings, wallet, maxOrderUSD }),
        [catalog, holdings, wallet, maxOrderUSD],
    );
    const [state, setState] = useState<SentenceState<TradeTerms>>(() => initialState(TRADE, DEFAULT_VERB, ctx));
    // Coins that load after the sentence, or a new signing wallet's, move a network that is now empty.
    const [fitted, setFitted] = useState(wallet);
    if (fitted !== wallet) {
        setFitted(wallet);
        setState((current) => refit(TRADE, current, ctx));
    }
    const view = useMemo(() => resolve(TRADE, state, ctx), [state, ctx]);
    const dispatch = (action: SentenceAction) => setState((current) => reduce(TRADE, current, action, ctx));
    return { state, view, dispatch };
}
