import { VERB, VERB_SLOT, canonicalDecimal, type Bound, type Choice, type Issue } from "@/lib/sentence";
import type { Outcome, PredictionMarket } from "../catalog";
import { operation, type TradeCtx } from "../context";
import { formatCents, formatUnits, formatUsd, formatUsdShort } from "../format";
import type { TransactionIntent } from "../intent";
import { minimum, spendCap, usdAmount } from "./shared";

type Values = { outcomeId: string; marketId: string; amountUSD: string };

const marketOf = (ctx: TradeCtx, id: string) =>
    ctx.catalog.markets.find((m) => m.id === id) ?? ctx.catalog.findMarket(id);
const outcomeOf = (ctx: TradeCtx, v: Values) => marketOf(ctx, v.marketId)?.outcomes.find((o) => o.id === v.outcomeId);
const pct = (fraction: number) => Math.round(fraction * 100);
const isYesNo = (outcome: Outcome) => /^(yes|no)$/i.test(outcome.label);

/** What the pool can cover per order; only set while predictions are live. */
function predictionCap(ctx: TradeCtx): Bound | undefined {
    if (typeof ctx.maxOrderUSD !== "number") return undefined;
    return {
        value: ctx.maxOrderUSD,
        message: `Predictions are limited to ${formatUsdShort(ctx.maxOrderUSD)} right now.`,
        cta: "Over the limit",
    };
}

/** The tighter of the balance and the pool's limit. */
function orderCap(ctx: TradeCtx): Bound | undefined {
    const caps = [spendCap(ctx), predictionCap(ctx)].filter((cap) => cap !== undefined);
    return caps.reduce<Bound | undefined>((a, b) => (a && a.value <= b.value ? a : b), undefined);
}

/** The outcome rated most likely */
const likeliest = (outcomes: readonly Outcome[]) =>
    outcomes.reduce<Outcome | undefined>((a, b) => (a && a.chance >= b.chance ? a : b), undefined);

/** Polymarket's smallest order, so a pool under it can place nothing */
const FLOOR_USD = 1;

const limitOf = (ctx: TradeCtx) => (typeof ctx.maxOrderUSD === "number" ? ctx.maxOrderUSD : undefined);

/** Why the pool's limit rules an outcome out, or nothing while it fits or no limit is set */
function limitReason(ctx: TradeCtx, outcome: Outcome): string | undefined {
    const limit = limitOf(ctx);
    if (limit === undefined) return undefined;
    if (limit < FLOOR_USD) return "Paused right now";
    return outcome.minUSD > limit ? `Over the ${formatUsdShort(limit)} limit` : undefined;
}

const overLimit = (ctx: TradeCtx, outcome: Outcome) => limitReason(ctx, outcome) !== undefined;

type Stuck =
    { kind: "paused" } | { kind: "question"; limit: number } | { kind: "outcome"; limit: number; outcome: Outcome };

/** What keeps the sentence from being placed at any amount because of the pool's limit */
function stuck(ctx: TradeCtx, v: Values): Stuck | undefined {
    const limit = limitOf(ctx);
    if (limit === undefined) return undefined;
    if (limit < FLOOR_USD) return { kind: "paused" };
    const outcomes = marketOf(ctx, v.marketId)?.outcomes ?? [];
    if (outcomes.length > 0 && outcomes.every((o) => o.minUSD > limit)) return { kind: "question", limit };
    const outcome = outcomes.find((o) => o.id === v.outcomeId);
    return outcome && outcome.minUSD > limit ? { kind: "outcome", limit, outcome } : undefined;
}

/** The outcome a question starts on, the likeliest one that fits the limit when the usual one doesn't */
function defaultOutcome(ctx: TradeCtx, market: PredictionMarket | undefined): Outcome | undefined {
    const usual = market?.outcomes.find((o) => o.label === "YES") ?? market?.outcomes[0];
    if (!market || !usual || !overLimit(ctx, usual)) return usual;
    return likeliest(market.outcomes.filter((o) => !overLimit(ctx, o))) ?? usual;
}

const PAUSED = {
    code: "paused",
    severity: "error",
    slot: VERB_SLOT,
    message: "Predictions are paused right now. Pick another trade, or try again later.",
    cta: "Predictions paused",
} as const;

/** "I want to [Predict] [YES] on [Will BTC reach $150K?] with [10 USD]." */
export const prediction = operation({
    id: "prediction",
    verbs: [
        {
            id: "predict",
            label: "Predict",
            hint: "Bet on a question",
            group: "Predictions",
            icon: { set: "verb", id: "predict" },
            fixed: {},
            cta: () => "Review prediction",
        },
    ],
    slots: {
        outcomeId: {
            kind: "choice",
            prompt: "Your prediction",
            hint: "Outcome you bet on",
            needs: "marketId",
            missing: { message: "Pick an outcome for this question.", cta: "Pick an outcome" },
            choices: (v: Values, ctx) =>
                (marketOf(ctx, v.marketId)?.outcomes ?? []).map((o): Choice => {
                    const reason = limitReason(ctx, o);
                    return {
                        value: o.id,
                        label: o.label,
                        detail: reason ?? formatCents(o.price),
                        tone: o.tone,
                        icon: isYesNo(o)
                            ? { set: "outcome", id: o.label.toLowerCase(), tone: o.tone }
                            : o.image
                              ? { set: "image", id: o.image }
                              : undefined,
                        // The picked outcome stays pickable so its pill keeps showing, and the issue says the way out
                        disabled: o.id === v.outcomeId ? undefined : reason,
                    };
                }),
        },
        marketId: {
            kind: "choice",
            hint: "Prediction market",
            wide: true,
            missing: { message: "Pick a question.", cta: "Pick a question" },
            empty: "No markets to show right now.",
            search: { placeholder: "Search markets" },
            // A question picked earlier stays listed after it leaves the trending list.
            choices: (v: Values, ctx) => {
                const picked = marketOf(ctx, v.marketId);
                const listed =
                    picked && !ctx.catalog.markets.includes(picked)
                        ? [...ctx.catalog.markets, picked]
                        : ctx.catalog.markets;
                return listed.map((m): Choice => {
                    const lead = likeliest(m.outcomes);
                    return {
                        value: m.id,
                        label: m.question,
                        short: m.short,
                        detail: lead ? `${pct(lead.chance)}% ${lead.label}, ends ${m.closes}` : `Ends ${m.closes}`,
                        icon: m.image ? { set: "image", id: m.image } : { set: "coin", id: m.symbol },
                    };
                });
            },
        },
        amountUSD: usdAmount(
            (v: Values, ctx) =>
                // What the limit rules out says so at its own slot, so the amount has no minimum or limit to cross
                stuck(ctx, v)
                    ? { max: spendCap(ctx), unbounded: true }
                    : { min: minimum(outcomeOf(ctx, v)?.minUSD ?? 1), max: orderCap(ctx) },
            (v, ctx) => {
                const outcome = outcomeOf(ctx, v);
                if (!outcome || stuck(ctx, v)) return undefined;
                return `Pays ${formatUsd(Number(v.amountUSD) / outcome.price)} if ${outcome.label}`;
            },
        ),
    },
    defaults: (ctx: TradeCtx): Values => {
        const market = ctx.catalog.markets[0];
        return { outcomeId: defaultOutcome(ctx, market)?.id ?? "", marketId: market?.id ?? "", amountUSD: "10" };
    },
    template: () => [VERB, { slot: "outcomeId" }, "on", { slot: "marketId" }, "with", { slot: "amountUSD" }, "."],
    normalize: (next, cause, _fixed, ctx) => {
        if (cause.type === "slot") {
            // A new question keeps your side when it offers an outcome with the same label, fit or not
            if (cause.slot !== "marketId") return next;
            const label = marketOf(ctx, cause.prev)?.outcomes.find((o) => o.id === next.outcomeId)?.label;
            const kept = marketOf(ctx, next.marketId)?.outcomes.find((o) => o.label === label);
            return { ...next, outcomeId: kept?.id ?? "" };
        }
        // A side nobody chose is the question's default for the limit of the moment, so it comes back when the limit does
        if (cause.chosen.includes("outcomeId") || cause.chosen.includes("marketId")) return next;
        const usual = defaultOutcome(ctx, marketOf(ctx, next.marketId));
        return usual && usual.id !== next.outcomeId ? { ...next, outcomeId: usual.id } : next;
    },
    check: (v, ctx): readonly Issue<keyof Values | typeof VERB_SLOT>[] => {
        const problem = stuck(ctx, v);
        if (!problem) return [];
        if (problem.kind === "paused") return [PAUSED];
        const limit = formatUsdShort(problem.limit);
        if (problem.kind === "question") {
            return [
                {
                    code: "question_over_limit",
                    severity: "error",
                    slot: "marketId",
                    message: `Every outcome of this question starts above today's ${limit} limit. Pick another question, or try again later.`,
                    cta: "Pick another question",
                },
            ];
        }
        const { outcome } = problem;
        return [
            {
                code: "outcome_over_limit",
                severity: "error",
                slot: "outcomeId",
                message: `${outcome.label} needs at least ${formatUsdShort(outcome.minUSD)}, and predictions are limited to ${limit} right now. Pick an outcome that starts at ${limit} or less, or try again later.`,
                cta: "Pick another outcome",
            },
        ];
    },
    toIntent: (v): Extract<TransactionIntent, { type: "prediction" }> => ({
        type: "prediction",
        marketId: v.marketId,
        outcomeId: v.outcomeId,
        amountUSD: canonicalDecimal(v.amountUSD),
    }),
    preview: (v, ctx) => {
        const market = marketOf(ctx, v.marketId);
        const outcome = market?.outcomes.find((o) => o.id === v.outcomeId);
        const amount = Number(v.amountUSD) || 0;
        if (!market || !outcome) return { title: market?.question, rows: [] };
        const shares = amount / outcome.price;
        const other = market.outcomes.length === 2 ? market.outcomes.find((o) => o.id !== outcome.id) : undefined;
        return {
            title: `${market.question} Ends ${market.closes}.`,
            rows: [
                {
                    id: "shares",
                    label: "You buy",
                    value: amount
                        ? `${formatUnits(shares, outcome.label)} shares at ${formatCents(outcome.price)}`
                        : "—",
                    primary: true,
                },
                {
                    id: "win",
                    label: `If ${outcome.label}`,
                    value: amount ? `you get ${formatUsd(shares)} (+${formatUsd(shares - amount)})` : "—",
                    tone: "gain",
                    primary: true,
                },
                {
                    id: "lose",
                    label: other ? `If ${other.label}` : "Otherwise",
                    value: amount ? `you lose ${formatUsd(amount)}` : "—",
                    tone: "loss",
                },
                { id: "odds", label: "Market odds", value: `${pct(outcome.chance)}% chance` },
            ],
        };
    },
});
