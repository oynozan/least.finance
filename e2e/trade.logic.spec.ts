import { expect, test } from "@playwright/test";
import {
    initialState,
    reduce,
    refit,
    resolve,
    sanitizeDecimal,
    canonicalDecimal,
    schema,
    VERB,
    type SentenceAction,
    type SentenceState,
} from "@/lib/sentence";
import { CATALOG as UNPRICED, type Catalog } from "@/lib/trade/catalog";
import { toPredictionMarket } from "@/lib/trade/markets";
import type { MarketView, QuoteView } from "@/server/src/protocol";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { quoteRows } from "@/lib/trade/prediction-quote";
import { TRADE } from "@/lib/trade/registry";
import { predictionActivity, withdrawalActivity } from "@/lib/trade/activity";
import type { PositionView } from "@/server/src/protocol";
import { HOLDINGS, LOADED_CATALOG as CATALOG, MARKETS, PRICES } from "./trade-fixtures";

const connected: TradeCtx = { catalog: CATALOG, holdings: HOLDINGS };
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
        expect(run("swap").view.intent).toEqual({
            type: "swap",
            fromToken: "ETH",
            toToken: "SOL",
            amountUSD: "10",
        });
        expect(run("sell").view.intent).toEqual({
            type: "spot",
            side: "sell",
            token: "SOL",
            amountUSD: "10",
        });
        // Perps have no venue: the sentence builds, but nothing to review comes of it.
        const short = run("short").view;
        expect(short.intent).toBeNull();
        expect(short.blocking).toEqual({
            code: "unavailable",
            severity: "error",
            message: "Long and short aren't available right now.",
            cta: "Not available right now",
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
    test("picking the other side's coin flips the swap when both sides would be identical", () => {
        expect(run("swap", [slot("fromToken", "SOL")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
        const both = run("swap", [slot("fromToken", "SOL"), slot("toToken", "SOL")]).view;
        expect(both.intent).toMatchObject({ type: "swap", fromToken: "ETH", toToken: "SOL" });
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
        expect(view.issues.map((issue) => issue.code)).toEqual(["unavailable"]);
        expect(view.slots.leverage).toMatchObject({ value: "20" });
    });

    test("leverage can be typed, within the market's cap", () => {
        expect(run("long", [slot("leverage", "7")]).view.text).toBe("I want to Long BTC at 7x leverage with 100 USD.");
        expect(run("long", [slot("leverage", "12x")]).view.slots.leverage).toMatchObject({ value: "12" });
        // Over BTC's 50x, not a number, or not a whole number (the server takes integers) is ignored
        const start = run("long").state;
        expect(reduce(TRADE, start, slot("leverage", "70"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("leverage", "lots"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("leverage", "12.5x"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("leverage", "7.0"), connected)).toBe(start);
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

test.describe("trading from the account", () => {
    const account = (holdings: Record<string, number>): TradeCtx => ({ catalog: CATALOG, holdings });
    const value = (view: ReturnType<typeof run>["view"], id: string) => (view.slots[id] as { value?: string }).value;

    test("no verb has a network step, and the intents carry none", () => {
        for (const id of ["buy", "sell", "swap"]) {
            const { view } = run(id);
            expect(Object.keys(view.slots)).not.toContain("network");
            expect(JSON.stringify(view.intent)).not.toMatch(/network/i);
            for (const slotView of Object.values(view.slots)) expect(slotView).not.toHaveProperty("then");
        }
        expect(run("buy").view.intent).toEqual({ type: "spot", side: "buy", token: "SOL", amountUSD: "10" });
    });

    test("Buy is capped by the account's USDC", () => {
        const ctx = account({ USDC: 25 });
        expect(run("buy", [slot("amountUSD", "30")], ctx).view.blocking).toMatchObject({ cta: "Not enough USDC" });
        expect(run("buy", [slot("amountUSD", "25")], ctx).view.blocking).toBeUndefined();
        expect(run("buy", [slot("amountUSD", "5")], account({ USDC: 0 })).view.blocking).toMatchObject({
            cta: "Not enough USDC",
        });
    });

    test("Sell and Swap are capped by the holding of that coin", () => {
        // 2 SOL at $147.20 is $294.40.
        const ctx = account({ USDC: 1_000, SOL: 2 });
        expect(run("sell", [slot("token", "SOL"), slot("amountUSD", "300")], ctx).view.blocking).toMatchObject({
            code: "max",
            cta: "Not enough SOL",
        });
        expect(run("sell", [slot("token", "SOL"), slot("amountUSD", "294")], ctx).view.blocking).toBeUndefined();
        const over = run("swap", [slot("fromToken", "SOL"), slot("amountUSD", "300")], ctx).view;
        expect(over.blocking).toMatchObject({ code: "max", cta: "Not enough SOL" });
    });

    test("a trade starts at 10 cents", () => {
        const ctx = account({ USDC: 100 });
        expect(run("buy", [slot("amountUSD", "0.05")], ctx).view.blocking).toMatchObject({ code: "min" });
        expect(run("buy", [slot("amountUSD", "0.1")], ctx).view.blocking).toBeUndefined();
    });

    test("a coin held for under 10 cents can still be sold or swapped whole, down to its value in cents", () => {
        // 0.0006 SOL at $147.20 is $0.08832
        const ctx = account({ USDC: 50, SOL: 0.0006, ETH: 1 });
        const sell = run("sell", [slot("token", "SOL"), slot("amountUSD", "0.08")], ctx).view;
        expect(sell.blocking).toBeUndefined();
        expect(sell.slots.amountUSD).toMatchObject({ range: { min: 0.08 } });
        expect(run("sell", [slot("token", "SOL"), slot("amountUSD", "0.07")], ctx).view.blocking).toMatchObject({
            code: "min",
            message: "The minimum is $0.08.",
        });
        const swap = run("swap", [slot("fromToken", "SOL"), slot("amountUSD", "0.08")], ctx).view;
        expect(swap.blocking).toBeUndefined();
        expect(run("swap", [slot("fromToken", "SOL"), slot("amountUSD", "0.07")], ctx).view.blocking).toMatchObject({
            code: "min",
            message: "The minimum is $0.08.",
        });
        // Under a cent the minimum is still a cent, which is more than is held: no slider, and both limits said
        const dust = account({ USDC: 50, SOL: 0.00005, ETH: 1 });
        const tiny = run("sell", [slot("token", "SOL")], dust).view;
        expect(tiny.slots.amountUSD).toMatchObject({ range: undefined });
        expect(tiny.blocking?.message).toMatch(/^The minimum is \$0\.01\. /);
        // A holding of 10 cents or more, and a purchase, keep the 10 cent minimum
        const whole = account({ USDC: 50, SOL: 1, ETH: 1 });
        expect(run("sell", [slot("token", "SOL"), slot("amountUSD", "0.05")], whole).view.blocking).toMatchObject({
            message: "The minimum is $0.10.",
        });
        expect(run("swap", [slot("fromToken", "SOL"), slot("amountUSD", "0.05")], whole).view.blocking).toMatchObject({
            message: "The minimum is $0.10.",
        });
        expect(run("buy", [slot("amountUSD", "0.05")], ctx).view.blocking).toMatchObject({
            message: "The minimum is $0.10.",
        });
    });

    test("Sell and Swap start on the coin held, and only a held coin is on offer to sell", () => {
        const ctx = account({ USDC: 50, LINK: 60, DOGE: 5_000 });
        // 60 LINK is $1,107 and 5,000 DOGE is $910.
        expect(value(run("sell", [], ctx).view, "token")).toBe("LINK");
        expect(value(run("swap", [], ctx).view, "fromToken")).toBe("LINK");
        const sell = run("sell", [], ctx).view.slots.token;
        const offered = sell.kind === "choice" ? sell.choices : [];
        expect(offered.find((c) => c.value === "ETH")?.disabled).toBe("You don't hold any ETH");
        expect(offered.find((c) => c.value === "DOGE")?.disabled).toBeUndefined();
        expect(offered.map((c) => c.value)).not.toContain("USDC");
    });

    test("Swap never swaps a coin into itself or into dollars", () => {
        const ctx = account({ USDC: 50, SOL: 2, ETH: 1 });
        const same = run("swap", [slot("fromToken", "SOL"), slot("toToken", "SOL")], ctx).view;
        expect(value(same, "fromToken")).not.toBe(value(same, "toToken"));
        const picks = same.slots.toToken;
        expect((picks.kind === "choice" ? picks.choices : []).map((c) => c.value)).not.toContain("USDC");
    });

    test("nothing held blocks Sell on the coin, not on an amount", () => {
        const view = run("sell", [], account({ USDC: 50 })).view;
        expect(view.blocking?.code).not.toBe("min");
        expect(view.blocking).toBeTruthy();
    });

    test("the review says what is paid and got, with the spread and no wait", () => {
        const ctx = account({ USDC: 1_000, SOL: 2 });
        // SOL is $147.20. A buy pays the ask, 0.3% more, so the $147.20 buys 0.997 SOL
        const buy = run("buy", [slot("amountUSD", "147.2")], ctx).view.preview;
        expect(buy.title).toBe("Includes a 0.3% spread. We cover network costs.");
        expect(buy.rows.map((r) => [r.label, r.value])).toEqual([
            ["You pay", "$147.20 USDC"],
            ["You get ≈", "0.997 SOL"],
            ["Arrives", "Instant"],
        ]);
        // A sale sells the coin the amount is worth and is paid the bid, 0.3% less
        const sell = run("sell", [slot("token", "SOL"), slot("amountUSD", "147.2")], ctx).view.preview;
        expect(sell.title).toBe("Includes a 0.3% spread. We cover network costs.");
        expect(sell.rows.map((r) => [r.label, r.value])).toEqual([
            ["You pay", "1 SOL"],
            ["You get ≈", "$146.76 USDC"],
            ["Arrives", "Instant"],
        ]);
        // A swap pays the one spread on the coin given up: $97.30 is $97.0081 against BTC's $97,300
        const swap = run("swap", [slot("fromToken", "SOL"), slot("toToken", "BTC"), slot("amountUSD", "97.3")], ctx);
        expect(swap.view.preview.title).toBe("Includes a 0.3% spread. We cover network costs.");
        expect(swap.view.preview.rows.map((r) => r.label)).toEqual(["You pay", "You get ≈", "Arrives"]);
        expect(swap.view.preview.rows[1]?.value).toBe("0.000997 BTC");
    });

    test("without an account every coin can be picked and nothing is capped", () => {
        const sell = run("sell", [slot("amountUSD", "5000")], disconnected).view;
        expect(sell.blocking).toBeUndefined();
        const swap = run("swap", [slot("fromToken", "AVAX")], disconnected).view;
        expect(value(swap, "fromToken")).toBe("AVAX");
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
    // Five shares at 87¢ cost $4.35 and at 13¢ cost 65¢, which Polymarket's $1 floor lifts to $1
    const oct: MarketView = {
        id: "910",
        title: "Fed Decision in October?",
        image: null,
        endDate: "2026-10-29T18:00:00Z",
        volume24hUSD: 5,
        outcomes: [
            outcome("oct-nochange", "No change", 0.87, 0.87, 4.35),
            outcome("oct-cut", "25 bps decrease", 0.13, 0.13, 1),
        ],
    };
    // Every outcome starts above a $2 limit
    const final: MarketView = {
        id: "911",
        title: "Who wins the final?",
        image: null,
        endDate: "2026-10-30T18:00:00Z",
        volume24hUSD: 5,
        outcomes: [outcome("final-home", "Home", 0.55, 0.55, 2.75), outcome("final-away", "Away", 0.45, 0.45, 2.25)],
    };
    // The first outcome doesn't fit a $2 limit, and the likeliest of the two that do isn't second
    const sector: MarketView = {
        id: "912",
        title: "Which sector leads?",
        image: null,
        endDate: "2026-10-30T18:00:00Z",
        volume24hUSD: 5,
        outcomes: [
            outcome("sector-tech", "Tech", 0.62, 0.62, 3.1),
            outcome("sector-banks", "Banks", 0.12, 0.12, 1),
            outcome("sector-energy", "Energy", 0.25, 0.25, 1.25),
        ],
    };
    const now = new Date(2026, 9, 12);
    const known = new Map([fed, rain, oct, final, sector].map((m) => [m.id, toPredictionMarket(m, now)]));
    const live = (listed: MarketView[]): TradeCtx => ({
        catalog: {
            ...CATALOG,
            markets: listed.map((m) => known.get(m.id)!),
            findMarket: (id) => known.get(id),
        } satisfies Catalog,
        holdings: HOLDINGS,
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
        const poor = { ...capped(500), holdings: { ...HOLDINGS, USDC: 30 } };
        expect(run("predict", [slot("amountUSD", "50")], poor).view.blocking).toMatchObject({ cta: "Not enough USDC" });
    });

    test("a limit that meets the minimum allows that one amount, with nothing to slide", () => {
        const ctx: TradeCtx = { ...live([rain]), maxOrderUSD: 4.2 };
        const exact = run("predict", [slot("outcomeId", "rain-yes"), slot("amountUSD", "4.2")], ctx);
        expect(exact.view.blocking).toBeUndefined();
        const one = exact.view.slots.amountUSD;
        expect(one.kind === "number" && one.range).toBeUndefined();
    });

    test.describe("a pool limit under an outcome's minimum", () => {
        const limited = (listed: MarketView[], maxOrderUSD: number | null = 2): TradeCtx => ({
            ...live(listed),
            maxOrderUSD,
        });
        type View = ReturnType<typeof run>["view"];
        const rows = (view: View) => {
            const picker = view.slots.outcomeId;
            return picker.kind === "choice" ? picker.choices : [];
        };
        const row = (view: View, label: string) => rows(view).find((choice) => choice.label === label);
        const amountIssue = (view: View) => view.slots.amountUSD.issue;

        const OVER = "From $4.35, over today's $2 limit";
        const OUTCOME_ISSUE = {
            code: "outcome_over_limit",
            severity: "error",
            slot: "outcomeId",
            message:
                "No change needs at least $4.35, and predictions are limited to $2 right now. Pick an outcome that starts at $2 or less, or try again later.",
            cta: "Pick another outcome",
        };
        const QUESTION_ISSUE = {
            code: "question_over_limit",
            severity: "error",
            slot: "marketId",
            message:
                "Every outcome of this question starts above today's $2 limit. Pick another question, or try again later.",
            cta: "Pick another question",
        };
        const PAUSED = {
            code: "paused",
            severity: "error",
            message: "Predictions are paused right now. Try again later.",
            cta: "Paused right now",
        };
        /** No change on one Fed question, where it fits, then on the October one, where it doesn't */
        const switched = (ctx: TradeCtx) =>
            run("predict", [slot("outcomeId", "fed-nochange"), slot("marketId", "910")], ctx);

        test("an outcome whose minimum is over the limit is listed but disabled, with why", () => {
            const { view } = run("predict", [], limited([oct]));
            expect(row(view, "No change")).toMatchObject({ disabled: OVER });
            expect(row(view, "25 bps decrease")).toMatchObject({ detail: "13\u00a2" });
            expect(row(view, "25 bps decrease")?.disabled).toBeUndefined();
        });

        test("the person's balance is no reason: only the pool's limit disables an outcome", () => {
            const poor = { ...limited([oct], 100), holdings: { ...HOLDINGS, USDC: 1 } };
            const { view } = run("predict", [], poor);
            expect(rows(view).map((choice) => choice.disabled)).toEqual([undefined, undefined]);
            // No limit at all (signed out, or trading off): nothing is disabled either
            for (const none of [limited([oct], null), live([oct])]) {
                expect(rows(run("predict", [], none).view).map((choice) => choice.disabled)).toEqual([
                    undefined,
                    undefined,
                ]);
            }
        });

        test("a disabled outcome can't be picked", () => {
            const ctx = limited([oct]);
            const { view } = run("predict", [slot("outcomeId", "oct-nochange")], ctx);
            expect(view.slots.outcomeId).toMatchObject({ value: "oct-cut" });
        });

        test("a kept outcome over the limit stays picked and the issue points at it", () => {
            const ctx = limited([fed, oct]);
            for (const typed of ["1", "3", "5", "10"]) {
                const { view } = run(
                    "predict",
                    [slot("outcomeId", "fed-nochange"), slot("marketId", "910"), slot("amountUSD", typed)],
                    ctx,
                );
                // The side isn't switched under the person
                expect(view.text, typed).toBe(
                    `I want to Predict No change on Fed Decision in October? with ${typed} USD.`,
                );
                expect(view.blocking, typed).toEqual(OUTCOME_ISSUE);
                expect(view.slots.outcomeId.issue, typed).toEqual(OUTCOME_ISSUE);
                expect(view.intent, typed).toBeNull();
                // The amount says nothing and only the outcome does
                expect(amountIssue(view), typed).toBeUndefined();
                expect(view.issues.map((issue) => issue.message).join(" "), typed).not.toMatch(/The minimum is/);
            }
        });

        test("the kept outcome still lists as picked, and the rest of the list is one pick away", () => {
            const { view } = switched(limited([fed, oct]));
            const picker = view.slots.outcomeId;
            expect(picker.kind === "choice" && picker.selected).toMatchObject({ label: "No change" });
            // Picked, so not disabled, and its row says why it is the problem
            expect(row(view, "No change")).toMatchObject({ detail: OVER });
            expect(row(view, "No change")?.disabled).toBeUndefined();
            expect(row(view, "25 bps decrease")?.disabled).toBeUndefined();
        });

        test("picking the outcome that fits clears it", () => {
            const ctx = limited([fed, oct]);
            const { state } = switched(ctx);
            const fixed = reduce(
                TRADE,
                reduce(TRADE, state, slot("outcomeId", "oct-cut"), ctx),
                slot("amountUSD", "2"),
                ctx,
            );
            const view = resolve(TRADE, fixed, ctx);
            expect(view.blocking).toBeUndefined();
            expect(view.intent).toEqual({ type: "prediction", marketId: "910", outcomeId: "oct-cut", amountUSD: "2" });
        });

        test("an amount over the limit still says the limit when the outcome fits", () => {
            const ctx = limited([oct]);
            const { view } = run("predict", [slot("amountUSD", "5")], ctx);
            expect(view.text).toMatch(/25 bps decrease/);
            expect(view.blocking).toMatchObject({
                message: "Predictions are limited to $2 right now.",
                cta: "Over the limit",
            });
        });

        test("the limit coming after the pick moves it from the amount to the outcome", () => {
            const picked = run("predict", [slot("outcomeId", "rain-yes"), slot("amountUSD", "3")], live([rain]));
            expect(picked.view.blocking).toMatchObject({ message: "The minimum is $4.20." });
            const view = resolve(TRADE, picked.state, limited([rain]));
            expect(view.blocking).toMatchObject({
                code: "outcome_over_limit",
                slot: "outcomeId",
                message:
                    "YES needs at least $4.20, and predictions are limited to $2 right now. Pick an outcome that starts at $2 or less, or try again later.",
            });
            expect(amountIssue(view)).toBeUndefined();
        });

        test("with every outcome over the limit, the issue points at the question", () => {
            const ctx = limited([final]);
            for (const typed of ["1", "10"]) {
                const { view } = run("predict", [slot("amountUSD", typed)], ctx);
                expect(view.blocking, typed).toEqual(QUESTION_ISSUE);
                expect(view.slots.marketId.issue, typed).toEqual(QUESTION_ISSUE);
                expect(amountIssue(view), typed).toBeUndefined();
            }
            // Arriving from another question with no outcome of the same name, the question is still what is said
            const arrived = run("predict", [slot("marketId", "911")], limited([rain, final]));
            expect(arrived.view.blocking).toEqual(QUESTION_ISSUE);
            expect(row(arrived.view, "Away")).toMatchObject({ disabled: "From $2.25, over today's $2 limit" });
        });

        test("under $1 nothing can be placed, so Predict reads as paused", () => {
            for (const max of [0, 0.5]) {
                for (const typed of ["1", "10"]) {
                    const { view } = run("predict", [slot("amountUSD", typed)], limited([oct], max));
                    expect(view.blocking, `${max} ${typed}`).toEqual(PAUSED);
                    expect(view.intent).toBeNull();
                    expect(amountIssue(view), `${max} ${typed}`).toBeUndefined();
                }
            }
            const { view } = run("predict", [], limited([oct], 0));
            expect(rows(view).map((choice) => choice.disabled ?? choice.detail)).toEqual([
                "Paused right now",
                "Paused right now",
            ]);
            // $1 is Polymarket's floor, so an outcome that starts there fits
            const floor = run("predict", [slot("amountUSD", "1")], limited([oct], 1)).view;
            expect(floor.blocking).toBeUndefined();
            expect(floor.intent).toMatchObject({ outcomeId: "oct-cut", amountUSD: "1" });
            // Trading off or signed out is not "paused"
            expect(run("predict", [], limited([oct], null)).view.blocking).toBeUndefined();
        });

        test("the default outcome is the likeliest one that fits the limit", () => {
            // The usual default is YES, or the first outcome
            expect(run("predict", [], live([oct])).view.text).toMatch(/Predict No change on/);
            expect(run("predict", [], limited([oct], 5)).view.text).toMatch(/Predict No change on/);
            expect(run("predict", [], limited([oct])).view.text).toMatch(/Predict 25 bps decrease on/);
            expect(run("predict", [], limited([rain], 5)).view.text).toMatch(/Predict YES on/);
            expect(run("predict", [], limited([rain])).view.text).toMatch(/Predict NO on/);
            // Of several that fit, the likeliest
            expect(run("predict", [], limited([sector])).view.text).toMatch(/Predict Energy on/);
            // Where none fit, the usual one, with the question's issue
            const none = run("predict", [], limited([final])).view;
            expect(none.text).toMatch(/Predict Home on/);
            expect(none.blocking).toEqual(QUESTION_ISSUE);
        });

        test("a limit arriving after the default moves it, unless the person chose a side or a question", () => {
            const before = live([oct]);
            const after = limited([oct]);
            const start = initialState(TRADE, "predict", before);
            expect(resolve(TRADE, start, before).text).toMatch(/Predict No change on/);
            expect(resolve(TRADE, refit(TRADE, start, after), after).text).toMatch(/Predict 25 bps decrease on/);
            // Their own side stays, and the issue says so
            const sided = reduce(TRADE, start, slot("outcomeId", "oct-nochange"), before);
            expect(resolve(TRADE, refit(TRADE, sided, after), after).blocking).toMatchObject({ slot: "outcomeId" });
            // So does the side that came along with a question they picked
            const asked = reduce(TRADE, start, slot("marketId", "910"), before);
            expect(resolve(TRADE, refit(TRADE, asked, after), after).blocking).toMatchObject({ slot: "outcomeId" });
        });
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
        expect(run("buy", [slot("amountUSD", "0.05")]).view.blocking).toMatchObject({
            code: "min",
            cta: "Minimum $0.10",
        });
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

test.describe("before the swap catalog prices the coins", () => {
    // The app's own catalog: no coin has a price until /swaps/catalog answers.
    const unpriced: TradeCtx = { catalog: { ...UNPRICED, markets: MARKETS }, holdings: HOLDINGS };
    const choice = (view: ReturnType<typeof run>["view"], id: string, value: string) => {
        const slot = view.slots[id];
        if (slot.kind !== "choice") throw new Error(`${id} isn't a choice slot`);
        return slot.choices.find((c) => c.value === value);
    };

    test("no coin has a made-up price", () => {
        expect(UNPRICED.tokens.every((token) => token.priceUSD === null)).toBe(true);
        expect(UNPRICED.markets).toEqual([]);
    });

    test("prices show as a dash, never as $0", () => {
        const swap = run("swap", [], unpriced).view;
        // Held: the units, with no dollar value yet; not held: zero units, with no dollar value yet.
        expect(choice(swap, "fromToken", "ETH")).toMatchObject({ detail: "1.25 ETH", subdetail: "—" });
        expect(choice(swap, "toToken", "AVAX")).toMatchObject({ detail: "0 AVAX", subdetail: "—" });
        expect(choice(run("buy", [], unpriced).view, "token", "AVAX")).toMatchObject({
            detail: "0 AVAX",
            subdetail: "—",
        });
        expect(choice(run("long", [], unpriced).view, "asset", "BTC")).toMatchObject({ detail: "—, up to 50x" });
        const sell = run("sell", [], unpriced).view;
        expect(sell.preview.rows.find((r) => r.id === "pay")?.value).toBe("—");
        expect(JSON.stringify(sell.preview)).not.toMatch(/\$0\.00/);
    });

    test("a coin with no price caps nothing and estimates nothing, while dollars stay capped", () => {
        const over = run("swap", [slot("amountUSD", "5000")], unpriced).view;
        expect(over.blocking).toBeUndefined();
        expect(over.intent).toMatchObject({ fromToken: "ETH", amountUSD: "5000" });
        const amount = over.slots.amountUSD;
        expect(amount.kind === "number" && amount.summary).toBeFalsy();
        // USDC is the dollar every amount is in, so it needs no price.
        expect(run("buy", [slot("amountUSD", "3000")], unpriced).view.blocking).toMatchObject({
            cta: "Not enough USDC",
        });
    });
});

test.describe("the amount's dropdown", () => {
    const amount = (view: ReturnType<typeof run>["view"], id = "amountUSD") => {
        const slot = view.slots[id];
        if (slot.kind !== "number") throw new Error(`${id} isn't a number slot`);
        return slot;
    };

    test("the slider spans the bounds, or the spec's range where a wallet doesn't cap it", () => {
        expect(amount(run("swap", [], disconnected).view).range).toEqual({ min: 0.1, max: 10_000, capped: false });
        expect(amount(run("buy", [], disconnected).view).range).toEqual({ min: 0.1, max: 10_000, capped: false });
        // Connected, the top is what the wallet holds of the coin being paid with.
        const swap = amount(run("swap").view).range!;
        expect(swap.capped).toBe(true);
        expect(swap.max).toBeCloseTo(HOLDINGS.ETH * PRICES.ETH, 6);
        // Positions start at $10, and the bottom says so.
        expect(amount(run("long", [], disconnected).view, "collateralUSD").range).toMatchObject({ min: 10 });
    });

    test("each operation says what the amount comes to", () => {
        // $10 of SOL at $147.20 is 0.06793 SOL at the market price; a buy and a swap get 0.3% fewer, a sale sells all of it
        expect(amount(run("swap").view).summary).toBe("You get ≈ 0.06773 SOL");
        expect(amount(run("buy").view).summary).toBe("You get ≈ 0.06773 SOL");
        expect(amount(run("sell").view).summary).toBe("You sell ≈ 0.06793 SOL");
        expect(amount(run("long").view, "collateralUSD").summary).toBe("A $495 position");
        expect(amount(run("predict").view).summary).toBe("Pays $26.32 if YES");
        // Nothing to say about an empty amount.
        expect(amount(run("swap", [slot("amountUSD", "")]).view).summary).toBeUndefined();
    });
});

test.describe("activity rows", () => {
    const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 9 - daysAgo, hour);

    test("a withdrawal row takes its amount off the balance", () => {
        const to = "0x1234567890abcdef1234567890abcdef12345678";
        const withdrawal = withdrawalActivity({ id: "w1", amountUSD: 50, at: at(1), pending: false, to });
        expect(withdrawal).toMatchObject({
            id: "withdrawal:w1",
            kind: "withdrawal",
            title: "Withdrawal",
            detail: "USDC to 0x1234…5678",
            amountUSD: 50,
            change: -50,
        });
    });

    const position = (over: Partial<PositionView>): PositionView => ({
        id: "p1",
        eventId: "e1",
        marketId: "m1",
        tokenId: "t1",
        question: "Will it rain?",
        outcome: "Yes",
        shares: "20",
        costUSD: "10",
        state: "open",
        proceedsUSD: null,
        payoutUSD: null,
        openedAt: at(3).toISOString(),
        settledAt: null,
        updatedAt: at(3).toISOString(),
        ...over,
    });

    test("a won position is a close row with its realized gain", () => {
        const rows = predictionActivity(position({ state: "won", payoutUSD: "20", settledAt: at(1).toISOString() }));
        expect(rows.map((r) => r.id)).toEqual(["prediction:p1:open", "prediction:p1:settle"]);
        expect(rows[0]).toMatchObject({ kind: "predict", title: "Yes on Will it rain?", amountUSD: 10, change: 0 });
        expect(rows[1]).toMatchObject({
            kind: "close",
            title: "Won Yes on Will it rain?",
            change: 10,
            symbols: ["USDC"],
        });
    });

    test("a lost position is a realized loss", () => {
        const rows = predictionActivity(position({ state: "lost", settledAt: at(1).toISOString() }));
        expect(rows[1]).toMatchObject({ kind: "close", title: "Lost Yes on Will it rain?", change: -10 });
    });

    test("a sold position realizes proceeds less cost", () => {
        const rows = predictionActivity(
            position({ state: "closed", proceedsUSD: "12.5", settledAt: at(1).toISOString() }),
        );
        expect(rows[1]).toMatchObject({ kind: "close", title: "Sold Yes on Will it rain?", change: 2.5 });
    });

    test("a buy changes nothing until it settles", () => {
        for (const state of ["open", "closing"] as const) {
            const rows = predictionActivity(position({ state }));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: "prediction:p1:open", change: 0 });
        }
        expect(predictionActivity(position({}), true)[0]!.pending).toBe(true);
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
