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

test.describe("perp checks", () => {
    test("collateral 9.99 shows 'Positions start at $10.'", () => {
        const view9 = run("long", ctxOf(view()), [slot("collateralUSD", "9.99")]);
        expect(view9.blocking).toMatchObject({ message: "Positions start at $10." });
    });

    test("$10 at 1x shows 'A position starts at $11. Raise the collateral or the leverage.'", () => {
        const view1 = run("long", ctxOf(view()), [slot("collateralUSD", "10"), slot("leverage", "1")]);
        expect(view1.blocking).toMatchObject({
            message: "A position starts at $11. Raise the collateral or the leverage.",
        });
        const ok = run("long", ctxOf(view()), [slot("collateralUSD", "11"), slot("leverage", "1")]);
        expect(ok.blocking).toBeUndefined();
    });

    test("collateral over the server's order limit shows 'Long and short are limited to $150 right now.'", () => {
        const over = run("long", ctxOf(view()), [slot("collateralUSD", "151")]);
        expect(over.blocking).toMatchObject({
            message: "Long and short are limited to $150 right now.",
            cta: "Over the limit",
        });
        expect(run("long", ctxOf(view()), [slot("collateralUSD", "150")]).blocking).toBeUndefined();
        // A limit with cents reads like the server's
        const cents = ctxOf(view({ maxOrderUSD: "99.5" }));
        expect(run("long", cents, [slot("collateralUSD", "100")]).blocking).toMatchObject({
            message: "Long and short are limited to $99.50 right now.",
        });
    });

    test("the smaller of the order limit and the balance caps the collateral", () => {
        const poor = ctxOf(view(), { holdings: { ...HOLDINGS, USDC: 120 } });
        expect(run("long", poor, [slot("collateralUSD", "130")]).blocking).toMatchObject({ cta: "Not enough USDC" });
        const rich = ctxOf(view({ maxOrderUSD: "100" }), { holdings: { ...HOLDINGS, USDC: 120 } });
        expect(run("long", rich, [slot("collateralUSD", "110")]).blocking).toMatchObject({ cta: "Over the limit" });
        // The slider tops out at the tighter one
        expect(run("long", rich).slots.collateralUSD).toMatchObject({ range: { max: 100, capped: true } });
        expect(run("long", poor).slots.collateralUSD).toMatchObject({ range: { max: 120, capped: true } });
    });

    test("a held BTC position blocks a second BTC Long with 'You already hold a BTC position. Close it first.'", () => {
        const ctx = ctxOf(view(), { openPerps: [{ asset: "BTC" }] });
        expect(run("long", ctx).blocking).toMatchObject({
            message: "You already hold a BTC position. Close it first.",
        });
        expect(run("short", ctx).blocking).toMatchObject({
            message: "You already hold a BTC position. Close it first.",
        });
    });

    test("a different asset is not blocked", () => {
        const ctx = ctxOf(view(), { openPerps: [{ asset: "BTC" }] });
        expect(run("long", ctx, [slot("asset", "ETH")]).blocking).toBeUndefined();
    });
});
