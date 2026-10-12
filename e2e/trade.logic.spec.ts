import { expect, test } from "@playwright/test";
import {
    initialState,
    reduce,
    resolve,
    sanitizeDecimal,
    canonicalDecimal,
    schema,
    VERB,
    type SentenceAction,
    type SentenceState,
} from "@/lib/sentence";
import { CATALOG, MOCK_HOLDINGS, type Catalog } from "@/lib/trade/catalog";
import { toPredictionMarket } from "@/lib/trade/markets";
import type { MarketView, QuoteView } from "@/server/src/protocol";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { quoteRows } from "@/lib/trade/prediction-quote";
import { TRADE } from "@/lib/trade/registry";
import { balanceHistory, confirmedActivity, daysSince, depositActivity, mockTrades } from "@/lib/trade/activity";

const connected: TradeCtx = { catalog: CATALOG, holdings: MOCK_HOLDINGS };
const disconnected: TradeCtx = { catalog: CATALOG, holdings: null };

function run(verb: string, actions: SentenceAction[] = [], ctx = connected) {
    let state: SentenceState<TradeTerms> = initialState(TRADE, verb, ctx);
    for (const action of actions) state = reduce(TRADE, state, action, ctx);
    return { state, view: resolve(TRADE, state, ctx) };
}
const slot = (slot: string, value: string): SentenceAction => ({ type: "slot", slot, value });
const verb = (verbId: string): SentenceAction => ({ type: "verb", verbId });

test.describe("sentences", () => {
    test("each verb starts with the sentence from the brief", () => {
        expect(run("swap").view.text).toBe("I want to Swap my ETH to SOL for 10 USD.");
        expect(run("buy").view.text).toBe("I want to Buy 10 USD of SOL.");
        expect(run("sell").view.text).toBe("I want to Sell 10 USD of my SOL.");
        expect(run("long").view.text).toBe("I want to Long BTC at 5x leverage with 100 USD.");
        expect(run("short").view.text).toBe("I want to Short BTC at 5x leverage with 100 USD.");
        expect(run("predict").view.text).toBe("I want to Predict YES on Will BTC reach $150K? with 10 USD.");
    });

    test("a complete sentence produces its normalized intent", () => {
        expect(run("swap").view.intent).toEqual({ type: "swap", fromToken: "ETH", toToken: "SOL", amountUSD: "10" });
        expect(run("sell").view.intent).toEqual({ type: "spot", side: "sell", token: "SOL", amountUSD: "10" });
        expect(run("short").view.intent).toEqual({
            type: "perp",
            side: "short",
            asset: "BTC",
            leverage: 5,
            collateralUSD: "100",
        });
        expect(run("predict").view.intent).toEqual({
            type: "prediction",
            marketId: "btc-150k-2026",
            outcomeId: "yes",
            amountUSD: "10",
        });
    });

    test("keys stay stable so persisting pills and words can glide", () => {
        const swap = run("swap").view.parts;
        const buy = run("swap", [verb("buy")]).view.parts;
        expect(swap.map((p) => p.key)).toEqual([
            "w:i:0",
            "w:want:0",
            "w:to:0",
            "verb",
            "w:my:0",
            "swap:fromToken",
            "w:to:1",
            "term:token",
            "w:for:0",
            "term:amountUSD",
        ]);
        expect(buy.map((p) => p.key)).toEqual([
            "w:i:0",
            "w:want:0",
            "w:to:0",
            "verb",
            "term:amountUSD",
            "w:of:0",
            "term:token",
        ]);
        // The period rides on the last pill, so it can never wrap onto its own line.
        expect(swap.at(-1)).toMatchObject({ key: "term:amountUSD", glue: "." });
    });
});

test.describe("switching verbs", () => {
    test("the amount and the coin carry over", () => {
        const { view } = run("swap", [slot("amountUSD", "25"), slot("toToken", "LINK"), verb("buy")]);
        expect(view.text).toBe("I want to Buy 25 USD of LINK.");
        expect(run("swap", [slot("toToken", "LINK"), verb("long")]).view.text).toBe(
            "I want to Long LINK at 5x leverage with 10 USD.",
        );
    });

    test("a coin the next operation can't use is not carried", () => {
        // AVAX has no perp market: Long keeps its own default market.
        const { view } = run("swap", [slot("toToken", "AVAX"), verb("long")]);
        expect(view.slots.asset.kind === "choice" && view.slots.asset.value).toBe("BTC");
        // USDC can't be bought with USDC: Buy keeps its own coin.
        expect(run("swap", [slot("toToken", "USDC"), verb("buy")]).view.text).toBe("I want to Buy 10 USD of SOL.");
    });

    test("operation-only choices are kept when coming back", () => {
        const { view } = run("long", [slot("leverage", "3"), verb("swap"), verb("long")]);
        expect(view.text).toBe("I want to Long BTC at 3x leverage with 100 USD.");
    });

    test("arriving at Swap with its source coin never swaps a coin into itself", () => {
        const { view } = run("buy", [slot("token", "ETH"), verb("swap")]);
        expect(view.intent).toMatchObject({ type: "swap", toToken: "ETH" });
        expect(view.intent).not.toMatchObject({ fromToken: "ETH" });
    });
});

test.describe("preventing invalid sentences", () => {
    test("picking the other side's coin flips the swap", () => {
        expect(run("swap", [slot("toToken", "ETH")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
        expect(run("swap", [slot("fromToken", "SOL")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
    });

    test("disabled, unknown and verb-fixed values are ignored", () => {
        const start = run("sell").state;
        // The wallet holds no AVAX, so it can't be sold.
        expect(reduce(TRADE, start, slot("token", "AVAX"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("side", "buy"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("nope", "1"), connected)).toBe(start);
        // The stablecoin isn't offered for spot trades at all.
        expect(reduce(TRADE, start, slot("token", "USDC"), connected)).toBe(start);
    });

    test("a market with a lower cap pulls the leverage down", () => {
        const { view } = run("long", [slot("leverage", "50"), slot("asset", "SOL")]);
        expect(view.text).toBe("I want to Long SOL at 20x leverage with 100 USD.");
        expect(view.issues).toEqual([]);
        expect(view.intent).toMatchObject({ leverage: 20 });
    });

    test("leverage can be typed, within the market's cap", () => {
        expect(run("long", [slot("leverage", "7")]).view.text).toBe("I want to Long BTC at 7x leverage with 100 USD.");
        expect(run("long", [slot("leverage", "12.5x")]).view.intent).toMatchObject({ leverage: 12.5 });
        // Over BTC's 50x, or not a number: ignored.
        const start = run("long").state;
        expect(reduce(TRADE, start, slot("leverage", "70"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("leverage", "lots"), connected)).toBe(start);
        // A typed 30x on BTC drops to SOL's 20x cap.
        expect(run("long", [slot("leverage", "30"), slot("asset", "SOL")]).view.text).toBe(
            "I want to Long SOL at 20x leverage with 100 USD.",
        );
    });

    test("a new question keeps your side", () => {
        const { view } = run("predict", [slot("outcomeId", "no"), slot("marketId", "eth-5k-2026")]);
        expect(view.intent).toMatchObject({ marketId: "eth-5k-2026", outcomeId: "no" });
    });
});

test.describe("live prediction markets", () => {
    const outcome = (tokenId: string, label: string, buyPrice: number, chance: number, minUSD = 1) => ({
        tokenId,
        label,
        buyPrice,
        sellPrice: buyPrice - 0.01,
        minShares: 5,
        chance,
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
        outcomes: [outcome("fed-nochange", "No change", 0.9, 0.89), outcome("fed-cut", "25 bps decrease", 0.08, 0.07)],
    };
    const rain: MarketView = {
        id: "901",
        title: "Will it rain?",
        image: null,
        endDate: "2026-10-30T18:00:00Z",
        volume24hUSD: 4,
        outcomes: [
            { ...outcome("rain-yes", "YES", 0.3, 0.3, 4.2), tone: "gain" },
            { ...outcome("rain-no", "NO", 0.71, 0.7), tone: "loss" },
        ],
    };
    const now = new Date(2026, 9, 12);
    const known = new Map([fed, rain].map((m) => [m.id, toPredictionMarket(m, now)]));
    const live = (listed: MarketView[]): TradeCtx => ({
        catalog: {
            ...CATALOG,
            markets: listed.map((m) => known.get(m.id)!),
            findMarket: (id) => known.get(id),
        } satisfies Catalog,
        holdings: MOCK_HOLDINGS,
    });

    test("a question without outcomes doesn't break the list", () => {
        const empty: MarketView = { ...fed, id: "902", outcomes: [] };
        known.set("902", toPredictionMarket(empty, now));
        const ctx = live([rain, empty]);
        expect(() => run("predict", [], ctx).view.text).not.toThrow();
    });

    test("a multi-outcome event reads Predict [top option] on [title]", () => {
        expect(run("predict", [], live([fed, rain])).view.text).toBe(
            "I want to Predict No change on Fed Decision in October? with 10 USD.",
        );
    });

    test("a new question keeps YES, and asks for an outcome when it has none", () => {
        const ctx = live([rain, fed]);
        expect(run("predict", [slot("marketId", "901")], ctx).view.intent).toMatchObject({ outcomeId: "rain-yes" });
        const moved = run("predict", [slot("marketId", "900")], ctx).view;
        expect(moved.intent).toBeNull();
        expect(moved.blocking).toMatchObject({ message: "Pick an outcome for this question.", cta: "Pick an outcome" });
    });

    test("the amount's minimum is the outcome's minUSD", () => {
        const view = run("predict", [slot("amountUSD", "3")], live([rain, fed])).view;
        expect(view.blocking).toMatchObject({ message: "The minimum is $4.20." });
    });

    test("quoteRows reads the quote", () => {
        const quote: QuoteView = {
            eventId: "901",
            tokenId: "rain-yes",
            side: "buy",
            amountUSD: "10",
            shares: "32.258064",
            avgPrice: 0.31,
            worstPrice: 0.33,
            feeUSD: "0.12",
            payoutUSD: "32.258064",
            minUSD: 1,
        };
        const rows = quoteRows(quote, "YES", "NO", 0.3);
        expect(rows.map((r) => r.id)).toEqual(["shares", "win", "lose", "fee", "odds"]);
        expect(rows[0]).toMatchObject({ label: "You buy", value: "32.258064 shares at 31\u00a2", primary: true });
        expect(rows[1]).toMatchObject({
            label: "If YES",
            value: "you get $32.26 (+$22.26)",
            tone: "gain",
            primary: true,
        });
        expect(rows[2]).toMatchObject({ label: "If NO", value: "you lose $10.00", tone: "loss" });
        expect(rows[3]).toMatchObject({ label: "Polymarket's fee", value: "$0.12" });
        expect(rows[4]).toMatchObject({ label: "Market odds", value: "30% chance" });
        expect(quoteRows(quote, "YES")[2]).toMatchObject({ label: "Otherwise" });
    });

    test("the amount is capped by maxOrderUSD with the limit message when live", () => {
        const capped = (maxOrderUSD: number | null): TradeCtx => ({ ...live([rain]), maxOrderUSD });
        const over = run("predict", [slot("amountUSD", "50")], capped(20)).view;
        expect(over.blocking).toMatchObject({
            message: "Predictions are limited to $20 right now.",
            cta: "Over the limit",
        });
        expect(run("predict", [slot("amountUSD", "20")], capped(20)).view.blocking).toBeUndefined();
        // Trading off, or not signed in: the balance alone caps it.
        expect(run("predict", [slot("amountUSD", "50")], capped(null)).view.blocking).toBeUndefined();
        expect(run("predict", [slot("amountUSD", "50")], live([rain])).view.blocking).toBeUndefined();
        // The smaller of the two wins.
        const poor = { ...capped(500), holdings: { ...MOCK_HOLDINGS, USDC: 30 } };
        expect(run("predict", [slot("amountUSD", "50")], poor).view.blocking).toMatchObject({ cta: "Not enough USDC" });
    });

    test("a picked question that isn't listed still resolves", () => {
        const { state } = run("predict", [slot("marketId", "900"), slot("outcomeId", "fed-cut")], live([rain, fed]));
        // The list moves on without it.
        const view = resolve(TRADE, state, live([rain]));
        expect(view.text).toBe("I want to Predict 25 bps decrease on Fed Decision in October? with 10 USD.");
        expect(view.intent).toMatchObject({ marketId: "900", outcomeId: "fed-cut" });
    });
});

test.describe("amounts", () => {
    test("typing is cleaned up, not blocked", () => {
        expect(sanitizeDecimal("1a2.3.4", 2)).toBe("12.34");
        expect(sanitizeDecimal("$1,250.009", 2)).toBe("1250.00");
        expect(sanitizeDecimal("10,5", 2)).toBe("10.5");
        expect(sanitizeDecimal("007", 2)).toBe("7");
        expect(sanitizeDecimal(".", 2)).toBe("0.");
        expect(sanitizeDecimal("10.", 2)).toBe("10.");
        expect(canonicalDecimal("010.")).toBe("10");
        expect(canonicalDecimal(".50")).toBe("0.5");
        expect(run("buy", [slot("amountUSD", "12.50")]).view.intent).toMatchObject({ amountUSD: "12.5" });
    });

    test("an empty amount is incomplete, a small one is an error", () => {
        const empty = run("buy", [slot("amountUSD", "")]).view;
        expect(empty.blocking).toMatchObject({ severity: "incomplete", cta: "Enter an amount" });
        expect(empty.intent).toBeNull();
        expect(run("buy", [slot("amountUSD", "0.5")]).view.blocking).toMatchObject({ code: "min", cta: "Minimum $1" });
        expect(run("long", [slot("collateralUSD", "5")]).view.blocking).toMatchObject({
            message: "Positions start at $10.",
        });
    });

    test("balances cap amounts only once a wallet is connected", () => {
        // 1.25 ETH at $3,210.40 is $4,013.
        const over = [slot("amountUSD", "5000")];
        expect(run("swap", over).view.blocking).toMatchObject({ code: "max", cta: "Not enough ETH" });
        expect(run("swap", over, disconnected).view.blocking).toBeUndefined();
        expect(run("buy", [slot("amountUSD", "3000")]).view.blocking).toMatchObject({ cta: "Not enough USDC" });
        // Disconnected, every coin can be picked.
        expect(run("sell", [slot("token", "AVAX")], disconnected).view.text).toBe("I want to Sell 10 USD of my AVAX.");
    });
});

test.describe("the amount's dropdown", () => {
    const amount = (view: ReturnType<typeof run>["view"], id = "amountUSD") => {
        const slot = view.slots[id];
        if (slot.kind !== "number") throw new Error(`${id} isn't a number slot`);
        return slot;
    };

    test("the slider spans the bounds, or the spec's range where a wallet doesn't cap it", () => {
        expect(amount(run("swap", [], disconnected).view).range).toEqual({ min: 1, max: 10_000, capped: false });
        expect(amount(run("buy", [], disconnected).view).range).toEqual({ min: 1, max: 10_000, capped: false });
        // Connected, the top is what the wallet holds of the coin being paid with.
        const swap = amount(run("swap").view).range!;
        expect(swap.capped).toBe(true);
        expect(swap.max).toBeCloseTo(MOCK_HOLDINGS.ETH * CATALOG.tokens.find((t) => t.symbol === "ETH")!.priceUSD, 6);
        // Positions start at $10, and the bottom says so.
        expect(amount(run("long", [], disconnected).view, "collateralUSD").range).toMatchObject({ min: 10 });
    });

    test("each operation says what the amount comes to", () => {
        expect(amount(run("swap").view).summary).toBe("You get ≈ 0.06773 SOL");
        expect(amount(run("buy").view).summary).toBe("You get ≈ 0.06793 SOL");
        expect(amount(run("sell").view).summary).toBe("You sell ≈ 0.06793 SOL");
        expect(amount(run("long").view, "collateralUSD").summary).toBe("A $500 position");
        expect(amount(run("predict").view).summary).toBe("Pays $26.32 if YES");
        // Nothing to say about an empty amount.
        expect(amount(run("swap", [slot("amountUSD", "")]).view).summary).toBeUndefined();
    });
});

test.describe("balance history", () => {
    const now = new Date(2026, 9, 9, 15, 0);
    const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 9 - daysAgo, hour);

    test("a bar a day, ending today, with deposits apart from PnL", () => {
        const activity = [
            depositActivity({ key: "a", amountUSD: 500, at: at(10) }),
            depositActivity({ key: "b", amountUSD: 100, at: at(2) }),
            ...mockTrades(now).filter((a) => a.kind === "close"),
        ];
        const days = balanceHistory(activity, 7, now);
        expect(days).toHaveLength(7);
        expect(days.at(-1)!.day).toEqual(new Date(2026, 9, 9));
        // Everything before the first day is carried in.
        const before = activity.filter((a) => a.at < days[0].day).reduce((sum, a) => sum + a.change, 0);
        expect(days[0].balance).toBeCloseTo(before + days[0].pnl + days[0].deposited, 6);
        const twoDaysAgo = days.at(-3)!;
        expect(twoDaysAgo.deposited).toBe(100);
        // The balance ends at the sum of every change.
        expect(days.at(-1)!.balance).toBeCloseTo(
            activity.reduce((sum, a) => sum + a.change, 0),
            6,
        );
    });

    test("fees alone don't count as a day's realized PnL", () => {
        const trades = mockTrades(now);
        const days = balanceHistory(trades, 30, now);
        const feeOnly = days.filter((d) => d.pnl !== 0 && d.realized === 0);
        expect(feeOnly.length).toBeGreaterThan(0);
        for (const d of feeOnly) expect(d.pnl).toBeLessThan(0);
        expect(daysSince(trades, now)).toBe(30);
    });

    test("a trade confirmed in Review is listed but moves nothing", () => {
        const confirmed = confirmedActivity(
            { type: "perp", side: "long", asset: "BTC", leverage: 5, collateralUSD: "100" },
            now,
            "c",
        );
        expect(confirmed).toMatchObject({
            title: "Long BTC 5x",
            detail: "A $500 position",
            change: 0,
            simulated: true,
        });
    });
});

test.describe("the schema", () => {
    test("rejects a verb defined twice", () => {
        const { operation, registry } = schema<{ amountUSD: string }, null>();
        const op = (id: string) =>
            operation({
                id,
                verbs: [{ id: "go", label: "Go", hint: "", group: "", fixed: {}, cta: () => "" }],
                slots: {},
                defaults: () => ({}),
                template: () => [VERB],
                toIntent: () => id,
                preview: () => ({ rows: [] }),
            });
        expect(() => registry([op("a"), op("b")], { lead: "I want to" })).toThrow(/defined twice/);
    });
});
