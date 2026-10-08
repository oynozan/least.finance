import { VERB, canonicalDecimal } from "@/lib/sentence";
import { QUOTE } from "../catalog";
import { operation, priceOf } from "../context";
import { formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { coinChoice, holdingCap, minimum, unheld, usdAmount } from "./shared";

type Values = { fromToken: string; toToken: string; amountUSD: string };

/** Estimated network fee for the preview. */
const NETWORK_FEE_USD = 0.03;

/** "I want to [Swap] my [ETH] to [SOL] for [10 USD]." */
export const swap = operation({
  id: "swap",
  verbs: [
    {
      id: "swap",
      label: "Swap",
      hint: "Trade one coin for another",
      group: "Trade",
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
      // The other side's coin stays pickable: choosing it flips the pair.
      choices: (v: Values, ctx) =>
        ctx.catalog.tokens.map((t) =>
          coinChoice(ctx, t, {
            detail: t.symbol === v.toToken ? "Switch sides" : undefined,
            disabled: unheld(ctx, t.symbol),
          }),
        ),
    },
    toToken: {
      kind: "choice",
      prompt: "Swap to which coin?",
      hint: "Coin you receive",
      term: "token",
      missing: { message: "Pick a coin to swap to.", cta: "Pick a coin" },
      choices: (v: Values, ctx) =>
        ctx.catalog.tokens.map((t) =>
          coinChoice(ctx, t, { detail: t.symbol === v.fromToken ? "Switch sides" : undefined }),
        ),
    },
    amountUSD: usdAmount((v: Values, ctx) => ({
      min: minimum(1),
      max: holdingCap(ctx, v.fromToken),
    })),
  },
  defaults: () => ({ fromToken: "ETH", toToken: "SOL", amountUSD: "10" }),
  template: () => [VERB, "my", { slot: "fromToken" }, "to", { slot: "toToken" }, "for", { slot: "amountUSD" }, "."],
  normalize: (next, cause, _fixed, ctx) => {
    if (next.fromToken !== next.toToken) return next;
    // Picking the other side's coin flips the pair.
    if (cause.type === "slot") {
      return cause.slot === "fromToken"
        ? { ...next, toToken: cause.prev }
        : { ...next, fromToken: cause.prev };
    }
    // Arriving with a carried coin equal to the source: pay with dollars
    // instead, or with the first other coin the wallet can pay with.
    const payable = [QUOTE, ...ctx.catalog.tokens.map((t) => t.symbol)].find(
      (symbol) => symbol !== next.toToken && !unheld(ctx, symbol),
    );
    return { ...next, fromToken: payable ?? (next.toToken === QUOTE ? "ETH" : QUOTE) };
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
      rows: [
        {
          id: "pay",
          label: "You pay",
          value: amount && from ? `${formatUnits(amount / from, v.fromToken)} (${formatUsd(amount)})` : dash,
          primary: true,
        },
        {
          id: "get",
          label: "You get",
          value: amount && to ? `≈ ${formatUnits((amount - NETWORK_FEE_USD) / to, v.toToken)}` : dash,
          primary: true,
        },
        {
          id: "rate",
          label: "Rate",
          value: from && to ? `1 ${v.fromToken} = ${formatUnits(from / to, v.toToken)}` : dash,
        },
        { id: "fee", label: "Network fee", value: `≈ ${formatUsd(NETWORK_FEE_USD)}` },
      ],
    };
  },
});
