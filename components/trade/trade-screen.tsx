"use client";

import { useCallback, useEffect } from "react";
import { CoinPriceCard, coinName } from "./coin-price-card";
import { drawable, OutcomeChartCard, QuestionChartCard } from "./market-chart-card";
import { marketHistoryStore, useMarketHistory } from "./market-history-store";
import { priceHistoryStore, usePriceHistory } from "./price-history-store";
import { TradeComposer } from "./trade-composer";
import { useTrade } from "./trade-provider";
import { withLiveEnd, type ChancePoints } from "@/lib/trade/chance-chart";
import { chartedOutcomes, historyTokens } from "@/lib/trade/market-lines";

/** Runs once the page is idle, and returns how to cancel. */
function whenIdle(run: () => void): () => void {
    if (typeof requestIdleCallback === "function") {
        const handle = requestIdleCallback(run);
        return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(run, 200);
    return () => clearTimeout(handle);
}

/** The page's trade sentence, wired to the shared trade state. */
export function TradeScreen() {
    const { view, dispatch, search, catalog } = useTrade();
    // Loads in the background, so a coin's chart is ready before its pill is hovered.
    const history = usePriceHistory();
    // A read that lands while a market's pill is hovered opens its card.
    const { lines: chances } = useMarketHistory();
    const coinPreview = useCallback(
        (symbol: string) => {
            const points = history.coins.get(symbol);
            if (!points) return null;
            const name = coinName(symbol, catalog.tokens.find((token) => token.symbol === symbol)?.name);
            return <CoinPriceCard symbol={symbol} name={name} points={points} />;
        },
        [history, catalog.tokens],
    );
    const findMarket = useCallback(
        (id: string) => catalog.markets.find((market) => market.id === id) ?? catalog.findMarket(id),
        [catalog],
    );

    const verb = view.verb.id;
    const marketSlot = view.slots.marketId;
    const outcomeSlot = view.slots.outcomeId;
    const marketId = verb === "predict" && marketSlot?.kind === "choice" && marketSlot.value ? marketSlot.value : null;
    const outcomeId = marketId && outcomeSlot?.kind === "choice" && outcomeSlot.value ? outcomeSlot.value : null;
    const picked = marketId ? findMarket(marketId) : undefined;
    // Read ahead once the page is idle, so the chart is there before the pill is hovered.
    useEffect(() => {
        if (!marketId || !picked) return;
        return whenIdle(() => void marketHistoryStore().want(marketId, historyTokens(picked, outcomeId)));
        // The market is looked up again each render; only a different pick should read ahead.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [marketId, outcomeId, !!picked]);

    // A Long or Short market isn't a swap coin: read its history once the page is idle,
    // so its card is there before the pill is hovered.
    const assetSlot = view.slots.asset;
    const perpAsset =
        (verb === "long" || verb === "short") && assetSlot?.kind === "choice" && assetSlot.value
            ? assetSlot.value
            : null;
    useEffect(() => {
        if (!perpAsset) return;
        return whenIdle(() => void priceHistoryStore().want(perpAsset));
    }, [perpAsset]);

    const marketPreview = useCallback(
        (id: string, outcome: string | null) => {
            const market = findMarket(id);
            if (!market) return null;
            // Hovering also refreshes a stale line.
            void marketHistoryStore().want(id, historyTokens(market, outcome));
            const live = (outcomeId: string, chance: number): ChancePoints | undefined => {
                const points = chances.get(outcomeId);
                return points && withLiveEnd(points, chance, Date.now());
            };
            if (outcome === null) {
                const lines = new Map<string, ChancePoints>();
                for (const { id: outcomeId, chance } of chartedOutcomes(market).drawn) {
                    const points = live(outcomeId, chance);
                    if (points) lines.set(outcomeId, points);
                }
                return drawable(lines.values()) ? <QuestionChartCard market={market} lines={lines} /> : null;
            }
            const picked = market.outcomes.find((o) => o.id === outcome);
            const points = picked && live(picked.id, picked.chance);
            return picked && points && drawable([points]) ? (
                <OutcomeChartCard market={market} outcome={picked} points={points} />
            ) : null;
        },
        [findMarket, chances],
    );
    return (
        <TradeComposer
            view={view}
            dispatch={dispatch}
            search={search}
            coinPreview={coinPreview}
            marketPreview={marketPreview}
        />
    );
}
