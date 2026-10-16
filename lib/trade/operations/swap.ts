import { VERB, canonicalDecimal } from "@/lib/sentence";
import { QUOTE } from "../catalog";
import { operation, priceOf, type TradeCtx } from "../context";
import { formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { SPREAD_TITLE, lessSpread } from "../spread";
import { coinChoice, holdingCap, largestHolding, saleMinimum, unheld, usdAmount } from "./shared";

type Values = { fromToken: string; toToken: string; amountUSD: string };

/** The smallest trade the server fills, in dollars. */
const MIN_TRADE_USD = 0.1;

const COINS_TO_TRY = ["SOL", "ETH", "BTC"];

/** A coin other than `exclude` and the stablecoin, which Buy and Sell cover */
const otherCoin = (ctx: TradeCtx, exclude: string) =>
    [...COINS_TO_TRY, ...ctx.catalog.tokens.map((t) => t.symbol)].find((s) => s !== exclude && s !== QUOTE) ?? "ETH";

/** "I want to [Swap] my [ETH] to [SOL] for [10 USD]." */
export const swap = operation({
    id: "swap",
    verbs: [
        {
            id: "swap",
            label: "Swap",
            hint: "Trade one coin for another",
            group: "Trade",
            icon: { set: "verb", id: "swap" },
            fixed: {},
            cta: () => "Review swap",
        },
    ],
    slots: {
        fromToken: {
            kind: "choice",
            prompt: "Swap from which coin?",
            hint: "Coin you pay with",
            missing: { message: "Pick a coin to swap from.", cta: "Pick a coin" },
            choices: (_v: Values, ctx) =>
                ctx.catalog.tokens
                    .filter((t) => t.symbol !== QUOTE)
                    .map((t) => coinChoice(ctx, t, { disabled: unheld(ctx, t.symbol) })),
        },
        toToken: {
            kind: "choice",
            prompt: "Swap to which coin?",
            hint: "Coin you receive",
            term: "token",
            missing: { message: "Pick a coin to swap to.", cta: "Pick a coin" },
            choices: (_v: Values, ctx) =>
                ctx.catalog.tokens.filter((t) => t.symbol !== QUOTE).map((t) => coinChoice(ctx, t)),
        },
        amountUSD: usdAmount(
            (v: Values, ctx) => ({
                min: saleMinimum(ctx, v.fromToken, MIN_TRADE_USD),
                // A coin the account doesn't hold at all is already blocked by its pill
                max: unheld(ctx, v.fromToken) ? undefined : holdingCap(ctx, v.fromToken),
            }),
            (v, ctx) => {
                const to = priceOf(ctx, v.toToken);
                const amount = Number(v.amountUSD);
                return to && amount > 0 ? `You get ≈ ${formatUnits(lessSpread(amount) / to, v.toToken)}` : undefined;
            },
        ),
    },
    defaults: (ctx: TradeCtx) => {
        // ETH unless the account holds none of it
        const fromToken = (unheld(ctx, "ETH") && largestHolding(ctx)) || "ETH";
        return { fromToken, toToken: otherCoin(ctx, fromToken), amountUSD: "10" };
    },
    template: () => [VERB, "my", { slot: "fromToken" }, "to", { slot: "toToken" }, "for", { slot: "amountUSD" }, "."],
    normalize: (next, cause, _fixed, ctx) => {
        // A coin the account doesn't hold is paid for with the one it holds the most of
        const strayed = cause.type !== "slot" && unheld(ctx, next.fromToken);
        const fromToken = (strayed && largestHolding(ctx)) || next.fromToken;
        const toToken = next.toToken === QUOTE ? otherCoin(ctx, fromToken) : next.toToken;
        if (fromToken !== toToken) return { ...next, fromToken, toToken };
        // A coin pick that made both sides identical flips them
        if (cause.type === "slot" && cause.slot === "fromToken" && cause.prev !== QUOTE) {
            return { ...next, fromToken, toToken: cause.prev };
        }
        if (cause.type === "slot" && cause.slot === "toToken" && cause.prev !== QUOTE) {
            return { ...next, fromToken: cause.prev, toToken };
        }
        // Otherwise the receive coin moves unless the person chose it
        const chosen: readonly string[] = cause.type === "slot" ? [] : cause.chosen;
        if (cause.type !== "slot" && !chosen.includes("toToken")) {
            return { ...next, fromToken, toToken: otherCoin(ctx, fromToken) };
        }
        return { ...next, fromToken: otherCoin(ctx, toToken), toToken };
    },
    toIntent: (v): Extract<TransactionIntent, { type: "swap" }> => ({
        type: "swap",
        fromToken: v.fromToken,
        toToken: v.toToken,
        amountUSD: canonicalDecimal(v.amountUSD),
    }),
    preview: (v, ctx) => {
        const amount = Number(v.amountUSD) || 0;
        const from = priceOf(ctx, v.fromToken);
        const to = priceOf(ctx, v.toToken);
        const dash = "—";
        return {
            title: SPREAD_TITLE,
            rows: [
                {
                    id: "pay",
                    label: "You pay",
                    value: amount && from ? formatUnits(amount / from, v.fromToken) : dash,
                    ...(amount && from ? { note: formatUsd(amount) } : {}),
                    primary: true,
                },
                {
                    id: "get",
                    label: "You get ≈",
                    // The coin given up is valued at its bid, and the coin got is bought at its market price
                    value: amount && to ? formatUnits(lessSpread(amount) / to, v.toToken) : dash,
                    primary: true,
                },
                { id: "when", label: "Arrives", value: "Instant" },
            ],
        };
    },
});
