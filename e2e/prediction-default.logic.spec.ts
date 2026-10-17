import { expect, test } from "@playwright/test";
import { initialState, reduce, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import type { Catalog } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { fitKey, refitTrade } from "@/lib/trade/fit";
import { toPredictionMarket } from "@/lib/trade/markets";
import { TRADE } from "@/lib/trade/registry";
import type { MarketView } from "@/server/src/protocol";
import { HOLDINGS, LOADED_CATALOG } from "./trade-fixtures";

const outcome = (tokenId: string, label: string, price: number, minUSD: number) => ({
    tokenId,
    label,
    buyPrice: price,
    sellPrice: price - 0.01,
    minShares: 5,
    chance: price,
    tone: "neutral" as const,
    minUSD,
    image: null,
});
const fed: MarketView = {
    id: "900",
    title: "Fed Decision in October?",
    image: null,
    endDate: "2026-10-29T18:00:00Z",
    volume24hUSD: 5,
    outcomes: [outcome("nochange", "No change", 0.87, 4.35), outcome("cut", "25 bps decrease", 0.13, 1)],
};
const rain: MarketView = {
    id: "901",
    title: "Will it rain?",
    image: null,
    endDate: "2026-10-30T18:00:00Z",
    volume24hUSD: 4,
    outcomes: [outcome("rain-a", "Heavy", 0.6, 1), outcome("rain-b", "Light", 0.4, 1)],
};
const known = new Map([fed, rain].map((m) => [m.id, toPredictionMarket(m, new Date(2026, 9, 12))]));
const catalog = {
    ...LOADED_CATALOG,
    markets: [...known.values()],
    findMarket: (id: string) => known.get(id),
} satisfies Catalog;

const ctxOf = (maxOrderUSD: number | null, holdings: TradeCtx["holdings"] = HOLDINGS): TradeCtx => ({
    catalog,
    holdings,
    maxOrderUSD,
});

/** The trade sentence as the page keeps it: the same refit the hook runs whenever the context's fit key moves. */
function page(first: TradeCtx) {
    let state: SentenceState<TradeTerms> = initialState(TRADE, "predict", first);
    let ctx = first;
    let key = fitKey(first);
    const refits: string[] = [];
    return {
        context(next: TradeCtx) {
            ctx = next;
            if (fitKey(next) === key) return;
            key = fitKey(next);
            const before = state;
            state = refitTrade(state, next);
            if (state !== before) refits.push(key);
        },
        dispatch(action: SentenceAction) {
            state = reduce(TRADE, state, action, ctx);
        },
        get outcome() {
            const view = resolve(TRADE, state, ctx);
            const slot = view.slots.outcomeId;
            return slot.kind === "choice" ? slot.selected?.label : undefined;
        },
        refits,
    };
}

test.describe("the sentence's default outcome as the pool's limit moves", () => {
    test("an untouched default follows the limit when it arrives, and again when it leaves", () => {
        const p = page(ctxOf(null));
        expect(p.outcome).toBe("No change");
        // The limit loads after the page: $2 is under No change's $4.35 minimum
        p.context(ctxOf(2));
        expect(p.outcome).toBe("25 bps decrease");
        // It rises past the minimum, and the usual default comes back
        p.context(ctxOf(10));
        expect(p.outcome).toBe("No change");
    });

    test("holdings changing, or a wallet connecting, moves nothing while the limit stays", () => {
        const p = page(ctxOf(2, null));
        expect(p.outcome).toBe("25 bps decrease");
        p.context(ctxOf(2, HOLDINGS));
        p.context(ctxOf(2, { ...HOLDINGS, ETH: 9 }));
        p.context(ctxOf(2, null));
        expect(p.outcome).toBe("25 bps decrease");
        expect(p.refits).toEqual([]);
        // And a default that fits stays where it is through the same events
        const roomy = page(ctxOf(50, null));
        roomy.context(ctxOf(50, HOLDINGS));
        expect(roomy.outcome).toBe("No change");
    });

    test("a pick the person made stays through every limit", () => {
        const p = page(ctxOf(50));
        p.dispatch({ type: "slot", slot: "outcomeId", value: "nochange" });
        p.context(ctxOf(2));
        // Still the person's, with the issue on it
        expect(p.outcome).toBe("No change");
        p.context(ctxOf(null));
        expect(p.outcome).toBe("No change");
        // A question and outcome they picked on another question stay through the same events
        const q = page(ctxOf(50));
        q.dispatch({ type: "slot", slot: "marketId", value: "901" });
        q.dispatch({ type: "slot", slot: "outcomeId", value: "rain-b" });
        q.context(ctxOf(2));
        q.context(ctxOf(2, { ...HOLDINGS, ETH: 1 }));
        expect(q.outcome).toBe("Light");
    });
});
