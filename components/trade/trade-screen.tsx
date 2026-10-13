"use client";

import { useCallback } from "react";
import { CoinPriceCard } from "./coin-price-card";
import { usePriceHistory } from "./price-history-store";
import { TradeComposer } from "./trade-composer";
import { useTrade } from "./trade-provider";

/** The page's trade sentence, wired to the shared trade state. */
export function TradeScreen() {
    const { view, dispatch, search, refreshHoldings, catalog } = useTrade();
    // Loads in the background, so a coin's chart is ready before its pill is hovered.
    const history = usePriceHistory();
    const coinPreview = useCallback(
        (symbol: string) => {
            const points = history.coins.get(symbol);
            if (!points) return null;
            const name = catalog.tokens.find((token) => token.symbol === symbol)?.name ?? symbol;
            return <CoinPriceCard symbol={symbol} name={name} points={points} />;
        },
        [history, catalog.tokens],
    );
    return (
        <TradeComposer
            view={view}
            dispatch={dispatch}
            search={search}
            onCoinOpen={refreshHoldings}
            coinPreview={coinPreview}
        />
    );
}
