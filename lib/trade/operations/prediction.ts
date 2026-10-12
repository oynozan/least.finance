import { VERB, canonicalDecimal, type Bound, type Choice } from "@/lib/sentence";
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

/** The outcome the market rates most likely. */
const top = (market: PredictionMarket) =>
    market.outcomes.reduce<Outcome | undefined>((a, b) => (a && a.chance >= b.chance ? a : b), undefined);

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
                (marketOf(ctx, v.marketId)?.outcomes ?? []).map((o): Choice => ({
                    value: o.id,
                    label: o.label,
                    detail: `${formatCents(o.price)} · ${pct(o.chance)}% chance`,
                    tone: o.tone,
                    icon: isYesNo(o)
                        ? { set: "outcome", id: o.label.toLowerCase(), tone: o.tone }
                        : o.image
                          ? { set: "image", id: o.image }
                          : undefined,
                })),
        },
        marketId: {
            kind: "choice",
            prompt: "Which question?",
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
                    const lead = top(m);
                    return {
                        value: m.id,
                        label: m.question,
                        short: m.short,
                        detail: lead ? `${pct(lead.chance)}% ${lead.label} · ends ${m.closes}` : `Ends ${m.closes}`,
                        icon: m.image ? { set: "image", id: m.image } : { set: "coin", id: m.symbol },
                    };
                });
            },
        },
        amountUSD: usdAmount(
            (v: Values, ctx) => ({
                min: minimum(outcomeOf(ctx, v)?.minUSD ?? 1),
                max: orderCap(ctx),
            }),
            (v, ctx) => {
                const outcome = outcomeOf(ctx, v);
                if (!outcome) return undefined;
                return `Pays ${formatUsd(Number(v.amountUSD) / outcome.price)} if ${outcome.label}`;
            },
        ),
    },
    defaults: (ctx: TradeCtx): Values => {
        const market = ctx.catalog.markets[0];
        const outcome = market?.outcomes.find((o) => o.label === "YES") ?? market?.outcomes[0];
        return { outcomeId: outcome?.id ?? "", marketId: market?.id ?? "", amountUSD: "10" };
    },
    template: () => [VERB, { slot: "outcomeId" }, "on", { slot: "marketId" }, "with", { slot: "amountUSD" }, "."],
    // A new question keeps your side when it offers an outcome with the same label.
    normalize: (next, cause, _fixed, ctx) => {
        if (cause.type !== "slot" || cause.slot !== "marketId") return next;
        const label = marketOf(ctx, cause.prev)?.outcomes.find((o) => o.id === next.outcomeId)?.label;
        const kept = marketOf(ctx, next.marketId)?.outcomes.find((o) => o.label === label);
        return { ...next, outcomeId: kept?.id ?? "" };
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
