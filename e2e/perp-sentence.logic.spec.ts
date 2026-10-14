import { expect, test } from "@playwright/test";
import { initialState, reduce, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import { PERP_MARKETS } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { createPerpMarketsStore, perpMarketsOf, perpMaxOrderUSD } from "@/lib/trade/perp-markets-store";
import { TRADE } from "@/lib/trade/registry";
import type { PerpMarketsView } from "@/server/src/protocol";
import { HOLDINGS, LOADED_CATALOG } from "./trade-fixtures";

const view = (over: Partial<PerpMarketsView> = {}): PerpMarketsView => ({
    markets: [
        { asset: "BTC", markPx: "66000", maxLeverage: 10, fundingRate: "0.0000125" },
        { asset: "ETH", markPx: "3200", maxLeverage: 20, fundingRate: "0.00001" },
    ],
    maxOrderUSD: "150",
    ...over,
});

const ctxOf = (served: PerpMarketsView | null, over: Partial<TradeCtx> = {}): TradeCtx => ({
    catalog: { ...LOADED_CATALOG, perps: perpMarketsOf(served) },
    holdings: HOLDINGS,
    perpTrading: { maxOrderUSD: perpMaxOrderUSD(served), loaded: served !== null },
    ...over,
});

function run(verb: string, ctx: TradeCtx, actions: SentenceAction[] = []) {
    let state: SentenceState<TradeTerms> = initialState(TRADE, verb, ctx);
    for (const action of actions) state = reduce(TRADE, state, action, ctx);
    return resolve(TRADE, state, ctx);
}
const slot = (slot: string, value: string): SentenceAction => ({ type: "slot", slot, value });

test.describe("perp markets in the sentence", () => {
    test("the leverage picker follows the server's cap", () => {
        const ctx = ctxOf(view());
        const picker = run("long", ctx).slots.leverage;
        expect(picker.kind === "choice" && picker.choices.map((c) => c.value)).toEqual(["2", "3", "5", "10"]);

        const pulled = run("long", ctx, [slot("asset", "ETH"), slot("leverage", "20"), slot("asset", "BTC")]);
        expect(pulled.slots.leverage).toMatchObject({ value: "10" });
        expect(pulled.text).toBe("I want to Long BTC at 10x leverage with 100 USD.");
    });

    test("Review stays blocked with 'Long and short aren't available right now.' while maxOrderUSD is null", () => {
        const blocked = {
            code: "unavailable",
            severity: "error",
            message: "Long and short aren't available right now.",
            cta: "Not available right now",
        };
        expect(run("short", ctxOf(view({ maxOrderUSD: null }))).blocking).toEqual(blocked);
        expect(run("long", ctxOf(null)).blocking).toEqual(blocked);
        expect(run("long", ctxOf(view())).blocking).toBeUndefined();
        expect(run("long", ctxOf(view()), [slot("collateralUSD", "5")]).blocking).toMatchObject({
            message: "Positions start at $10.",
        });
    });

    test("the fallback list is used before the first load", async () => {
        expect(perpMarketsOf(null)).toBe(PERP_MARKETS);
        expect(perpMarketsOf(view({ markets: [] }))).toBe(PERP_MARKETS);

        const answers: Array<() => Response> = [
            () => new Response(JSON.stringify(view())),
            () => new Response("nope", { status: 503 }),
            () => new Response(JSON.stringify({ markets: "x" })),
        ];
        const store = createPerpMarketsStore({ apiUrl: "http://api", fetch: async () => answers.shift()!() });
        let heard = 0;
        store.subscribe(() => (heard += 1));
        expect(store.get()).toBeNull();

        await store.load();
        expect(store.get()?.markets.map((m) => m.asset)).toEqual(["BTC", "ETH"]);
        expect(perpMarketsOf(store.get()).map((m) => m.maxLeverage)).toEqual([10, 20]);
        expect(perpMaxOrderUSD(store.get())).toBe(150);

        // A failed or malformed answer keeps the last good view.
        await store.load();
        await store.load();
        expect(store.get()?.markets).toHaveLength(2);
        expect(heard).toBe(1);
    });
});
