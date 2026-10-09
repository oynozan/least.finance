import { VERB, canonicalDecimal, type Choice } from "@/lib/sentence";
import type { PredictionMarket } from "../catalog";
import { operation, type TradeCtx } from "../context";
import { formatCents, formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { minimum, spendCap, usdAmount } from "./shared";

type Values = { outcomeId: string; marketId: string; amountUSD: string };

const marketOf = (ctx: TradeCtx, id: string) => ctx.catalog.markets.find((m) => m.id === id);
const chance = (price: number) => `${Math.round(price * 100)}% chance`;
const yesOdds = (market: PredictionMarket) =>
    Math.round((market.outcomes.find((o) => o.id === "yes")?.price ?? 0) * 100);

/** "I want to [Predict] [YES] on [Will BTC reach $150K?] with [10 USD]." */
export const prediction = operation({
    id: "prediction",
    verbs: [
        {
            id: "predict",
            label: "Predict",
            hint: "Bet on a yes-or-no question",
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
            missing: { message: "Pick YES or NO for this question.", cta: "Pick an outcome" },
            choices: (v: Values, ctx) =>
                (marketOf(ctx, v.marketId)?.outcomes ?? []).map((o): Choice => ({
                    value: o.id,
                    label: o.label,
                    detail: `${formatCents(o.price)} · ${chance(o.price)}`,
                    tone: o.tone,
                    icon: { set: "outcome", id: o.id, tone: o.tone },
                })),
        },
        marketId: {
            kind: "choice",
            prompt: "Which question?",
            hint: "Prediction market",
            wide: true,
            missing: { message: "Pick a question.", cta: "Pick a question" },
            choices: (_v: Values, ctx) =>
                ctx.catalog.markets.map((m): Choice => ({
                    value: m.id,
                    label: m.question,
                    short: m.short,
                    detail: `${yesOdds(m)}% YES · ends ${m.closes}`,
                    icon: { set: "coin", id: m.symbol },
                })),
        },
        amountUSD: usdAmount((_v: Values, ctx) => ({ min: minimum(1), max: spendCap(ctx) })),
    },
    defaults: (ctx: TradeCtx): Values => ({
        outcomeId: "yes",
        marketId: ctx.catalog.markets[0]?.id ?? "",
        amountUSD: "10",
    }),
    template: () => [VERB, { slot: "outcomeId" }, "on", { slot: "marketId" }, "with", { slot: "amountUSD" }, "."],
    // A new question keeps your side when it offers the same outcome.
    normalize: (next, cause, _fixed, ctx) => {
        if (cause.type !== "slot" || cause.slot !== "marketId") return next;
        const outcomes = marketOf(ctx, next.marketId)?.outcomes ?? [];
        if (outcomes.some((o) => o.id === next.outcomeId)) return next;
        return { ...next, outcomeId: "" };
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
        const other = market.outcomes.find((o) => o.id !== outcome.id);
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
                { id: "odds", label: "Market odds", value: `${yesOdds(market)}% YES` },
            ],
        };
    },
});
