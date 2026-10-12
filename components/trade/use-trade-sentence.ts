"use client";

import { useMemo, useState } from "react";
import { initialState, reduce, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import type { Catalog } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { DEFAULT_VERB, TRADE } from "@/lib/trade/registry";

/** Owns the sentence's state; the composer itself is fully controlled. */
export function useTradeSentence(holdings: TradeCtx["holdings"], catalog: Catalog, maxOrderUSD: number | null = null) {
    const ctx = useMemo<TradeCtx>(() => ({ catalog, holdings, maxOrderUSD }), [catalog, holdings, maxOrderUSD]);
    const [state, setState] = useState<SentenceState<TradeTerms>>(() => initialState(TRADE, DEFAULT_VERB, ctx));
    const view = useMemo(() => resolve(TRADE, state, ctx), [state, ctx]);
    const dispatch = (action: SentenceAction) => setState((current) => reduce(TRADE, current, action, ctx));
    return { state, view, dispatch };
}
