import { VERB, canonicalDecimal } from "@/lib/sentence";
import { QUOTE } from "../catalog";
import { operation, priceOf } from "../context";
import { formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { coinChoice, holdingCap, largestHolding, minimum, saleMinimum, spendCap, unheld, usdAmount } from "./shared";

type Side = "buy" | "sell";
type Values = { token: string; amountUSD: string };
type Fixed = { side: Side };

/** The smallest trade the server fills, in dollars. */
const MIN_TRADE_USD = 0.1;

/**
 * "I want to [Buy] [10 USD] of [SOL]."
 * "I want to [Sell] [10 USD] of my [SOL]."
 */
export const spot = operation({
    id: "spot",
    verbs: [
        {
            id: "buy",
            label: "Buy",
            hint: "Get a coin with dollars",
            group: "Trade",
            icon: { set: "verb", id: "buy" },
            fixed: { side: "buy" } as Fixed,
            cta: () => "Review purchase",
        },
        {
            id: "sell",
            label: "Sell",
            hint: "Turn a coin into dollars",
            group: "Trade",
            icon: { set: "verb", id: "sell" },
            fixed: { side: "sell" } as Fixed,
            cta: () => "Review sale",
        },
    ],
    slots: {
        token: {
            kind: "choice",
            prompt: "Which coin?",
            hint: "Coin you trade",
            term: "token",
            missing: { message: "Pick a coin.", cta: "Pick a coin" },
            // Trades are priced in the stablecoin, so it isn't on offer here.
            choices: (v: Values & Fixed, ctx) =>
                ctx.catalog.tokens
                    .filter((t) => t.symbol !== QUOTE)
                    .map((t) =>
                        coinChoice(ctx, t, { disabled: v.side === "sell" ? unheld(ctx, t.symbol) : undefined }),
                    ),
        },
        amountUSD: usdAmount(
            (v: Values & Fixed, ctx) => ({
                min: v.side === "buy" ? minimum(MIN_TRADE_USD) : saleMinimum(ctx, v.token, MIN_TRADE_USD),
                // A coin the account can't sell is already blocked by its pill
                max: v.side === "buy" ? spendCap(ctx) : unheld(ctx, v.token) ? undefined : holdingCap(ctx, v.token),
            }),
            (v, ctx) => {
                const price = priceOf(ctx, v.token);
                if (!price) return undefined;
                const coins = formatUnits(Number(v.amountUSD) / price, v.token);
                return v.side === "buy" ? `You get ≈ ${coins}` : `You sell ≈ ${coins}`;
            },
        ),
    },
    defaults: () => ({ token: "SOL", amountUSD: "10" }),
    template: (v) =>
        v.side === "buy"
            ? [VERB, { slot: "amountUSD" }, "of", { slot: "token" }, "."]
            : [VERB, { slot: "amountUSD" }, "of my", { slot: "token" }, "."],
    // A coin the account doesn't hold is sold as the one it holds the most of
    normalize: (next, cause, fixed, ctx) => {
        if (fixed.side !== "sell" || cause.type === "slot" || !unheld(ctx, next.token)) return next;
        const token = largestHolding(ctx);
        return token ? { ...next, token } : next;
    },
    toIntent: (v): Extract<TransactionIntent, { type: "spot" }> => ({
        type: "spot",
        side: v.side,
        token: v.token,
        amountUSD: canonicalDecimal(v.amountUSD),
    }),
    preview: (v, ctx) => {
        const amount = Number(v.amountUSD) || 0;
        const price = priceOf(ctx, v.token);
        // Nothing to estimate before the coin has a price
        const coins = amount && price ? formatUnits(amount / price, v.token) : "—";
        const dollars = amount ? `${formatUsd(amount)} ${QUOTE}` : "—";
        return {
            title: "No fees, we cover network costs.",
            rows: [
                v.side === "buy"
                    ? { id: "pay", label: "You pay", value: dollars, primary: true }
                    : { id: "pay", label: "You pay", value: coins, primary: true },
                v.side === "buy"
                    ? { id: "get", label: "You get ≈", value: coins, primary: true }
                    : { id: "get", label: "You get ≈", value: dollars, primary: true },
                { id: "when", label: "Arrives", value: "Instant" },
            ],
        };
    },
});
