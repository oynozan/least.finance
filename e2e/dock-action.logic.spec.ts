import { expect, test } from "@playwright/test";
import { initialState, reduce, resolve, type SentenceAction, type SentenceState } from "@/lib/sentence";
import { CATALOG, type Catalog } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { dockAction } from "@/lib/trade/dock-action";
import { toPredictionMarket } from "@/lib/trade/markets";
import { TRADE } from "@/lib/trade/registry";
import type { MarketView } from "@/server/src/protocol";
import { HOLDINGS, LOADED_CATALOG } from "./trade-fixtures";

const connected: TradeCtx = {
    catalog: LOADED_CATALOG,
    holdings: HOLDINGS,
    perpTrading: { maxOrderUSD: 1_000, loaded: true },
};

function run(verb: string, actions: SentenceAction[] = [], ctx = connected) {
    let state: SentenceState<TradeTerms> = initialState(TRADE, verb, ctx);
    for (const action of actions) state = reduce(TRADE, state, action, ctx);
    return resolve(TRADE, state, ctx);
}
const slot = (slot: string, value: string): SentenceAction => ({ type: "slot", slot, value });
const action = (verb: string, actions: SentenceAction[] = [], ctx = connected) => dockAction(run(verb, actions, ctx));

const outcome = (tokenId: string, label: string, buyPrice: number, minUSD: number) => ({
    tokenId,
    label,
    buyPrice,
    sellPrice: buyPrice - 0.01,
    minShares: 5,
    chance: buyPrice,
    tone: "neutral" as const,
    minUSD,
    image: null,
});
const view = (id: string, outcomes: MarketView["outcomes"]): MarketView => ({
    id,
    title: `Question ${id}`,
    image: null,
    endDate: "2026-10-29T18:00:00Z",
    volume24hUSD: 5,
    outcomes,
});

test.describe("what the dock's button says and does", () => {
    test("a sentence that can go ahead says Review, and opens the review", () => {
        for (const verb of ["buy", "sell", "swap", "long", "short", "predict"]) {
            expect(action(verb), verb).toEqual({ kind: "review" });
        }
    });

    test("an amount that is empty, too small or more than is held says so, and opens the amount", () => {
        expect(action("buy", [slot("amountUSD", "")])).toEqual({
            kind: "open",
            label: "Enter an amount",
            message: "Enter an amount.",
            slot: "amountUSD",
        });
        expect(action("buy", [slot("amountUSD", "0.05")])).toMatchObject({
            kind: "open",
            label: "Minimum $0.10",
            slot: "amountUSD",
        });
        expect(action("buy", [slot("amountUSD", "3000")])).toEqual({
            kind: "open",
            label: "Not enough USDC",
            message: "You have $2,400.00 USDC to spend.",
            slot: "amountUSD",
        });
        expect(action("sell", [slot("token", "SOL"), slot("amountUSD", "9000")])).toMatchObject({
            kind: "open",
            label: "Not enough SOL",
            slot: "amountUSD",
        });
        expect(action("swap", [slot("amountUSD", "9000")])).toMatchObject({ kind: "open", label: "Not enough ETH" });
        expect(action("long", [slot("collateralUSD", "5")])).toMatchObject({
            kind: "open",
            label: "Minimum $10",
            slot: "collateralUSD",
        });
        expect(action("long", [slot("collateralUSD", "5000")])).toMatchObject({
            kind: "open",
            label: "Over the limit",
            slot: "collateralUSD",
        });
    });

    test("a missing question or outcome says what to pick, and opens that pill", () => {
        const none: TradeCtx = { ...connected, catalog: { ...LOADED_CATALOG, markets: [] } };
        expect(action("predict", [], none)).toEqual({
            kind: "open",
            label: "Pick a question",
            message: "Pick a question.",
            slot: "marketId",
        });
        const fed = view("900", [
            outcome("fed-nochange", "No change", 0.9, 1),
            outcome("fed-cut", "25 bps decrease", 0.08, 1),
        ]);
        const now = new Date(2026, 9, 12);
        const asked: TradeCtx = {
            ...connected,
            catalog: {
                ...LOADED_CATALOG,
                markets: [...LOADED_CATALOG.markets, toPredictionMarket(fed, now)],
            } satisfies Catalog,
        };
        // YES isn't offered on the new question, so there is no outcome yet
        expect(action("predict", [slot("marketId", "900")], asked)).toEqual({
            kind: "open",
            label: "Pick an outcome",
            message: "Pick an outcome for this question.",
            slot: "outcomeId",
        });
    });

    test("a coin that is no longer offered says Pick a coin and opens it", () => {
        const bare: TradeCtx = { ...connected, catalog: { ...CATALOG, tokens: [] } };
        expect(action("buy", [], bare)).toMatchObject({ kind: "open", label: "Pick a coin", slot: "token" });
    });

    test("a problem with no pill of its own is said on a button that can't be pressed", () => {
        const off: TradeCtx = { ...connected, perpTrading: { maxOrderUSD: null, loaded: true } };
        expect(action("long", [], off)).toEqual({
            kind: "blocked",
            label: "Not available right now",
            message: "Long and short aren't available right now.",
        });
        expect(action("long", [slot("collateralUSD", "10"), slot("leverage", "1")])).toMatchObject({
            kind: "blocked",
            label: "Raise collateral or leverage",
        });
        const holding: TradeCtx = { ...connected, openPerps: [{ asset: "BTC" }] };
        expect(action("short", [], holding)).toEqual({
            kind: "blocked",
            label: "Position already open",
            message: "You already hold a BTC position. Close it first.",
        });
    });

    test("a pool limit under the outcome's minimum says to pick another outcome, and opens it", () => {
        const fed = view("900", [
            outcome("fed-nochange", "No change", 0.9, 1),
            outcome("fed-cut", "25 bps decrease", 0.08, 1),
        ]);
        const oct = view("910", [
            outcome("oct-nochange", "No change", 0.87, 4.35),
            outcome("oct-cut", "25 bps decrease", 0.13, 1),
        ]);
        const now = new Date(2026, 9, 12);
        const known = new Map([fed, oct].map((m) => [m.id, toPredictionMarket(m, now)]));
        const limited: TradeCtx = {
            ...connected,
            catalog: { ...LOADED_CATALOG, markets: [...known.values()], findMarket: (id) => known.get(id) },
            maxOrderUSD: 2,
        };
        // No change fits on the first question, and comes along to the second, where it doesn't
        expect(action("predict", [slot("outcomeId", "fed-nochange"), slot("marketId", "910")], limited)).toMatchObject({
            kind: "open",
            label: "Pick another outcome",
            slot: "outcomeId",
        });
        // The amount over the limit is the amount's to say
        expect(
            action(
                "predict",
                [slot("marketId", "910"), slot("outcomeId", "oct-cut"), slot("amountUSD", "50")],
                limited,
            ),
        ).toMatchObject({
            kind: "open",
            label: "Over the limit",
            slot: "amountUSD",
        });
    });

    test("a pool that can place nothing says Predictions paused on a button that can't be pressed", () => {
        const fed = view("900", [
            outcome("fed-nochange", "No change", 0.9, 1),
            outcome("fed-cut", "25 bps decrease", 0.08, 1),
        ]);
        const known = new Map([toPredictionMarket(fed, new Date(2026, 9, 12))].map((m) => [m.id, m]));
        const paused: TradeCtx = {
            ...connected,
            catalog: { ...LOADED_CATALOG, markets: [...known.values()], findMarket: (id) => known.get(id) },
            maxOrderUSD: 0.5,
        };
        // The problem sits on the Predict pill, which the button can't open: it only says so
        expect(action("predict", [], paused)).toEqual({
            kind: "blocked",
            label: "Predictions paused",
            message: "Predictions are paused right now. Try again later.",
        });
        // Other verbs don't mind
        expect(action("buy", [], paused)).toEqual({ kind: "review" });
    });
});
