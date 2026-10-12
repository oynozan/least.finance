import { VERB, canonicalDecimal } from "@/lib/sentence";
import { QUOTE } from "../catalog";
import { operation, priceOf, type TradeCtx } from "../context";
import { formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { networkName, type NetworkId } from "../networks";
import {
    buyPayNetwork,
    coinChoice,
    defaultPayNetwork,
    defaultReceiveNetwork,
    holdingCapOn,
    minimum,
    networkChoices,
    networkFits,
    unheld,
    usdAmount,
    usdcCap,
} from "./shared";

type Side = "buy" | "sell";
type Values = { token: string; network: NetworkId; amountUSD: string };
type Fixed = { side: Side };

const FEE_RATE = 0.002;

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
            then: "network",
            missing: { message: "Pick a coin.", cta: "Pick a coin" },
            // Trades are priced in the stablecoin, so it isn't on offer here.
            choices: (v: Values & Fixed, ctx) =>
                ctx.catalog.tokens
                    .filter((t) => t.symbol !== QUOTE)
                    .map((t) =>
                        coinChoice(ctx, t, { disabled: v.side === "sell" ? unheld(ctx, t.symbol) : undefined }),
                    ),
        },
        network: {
            kind: "choice",
            prompt: "On which network?",
            hint: "Network of the coin",
            term: "tokenNetwork",
            missing: { message: "Pick a network.", cta: "Pick a network" },
            choices: (v: Values & Fixed, ctx) => networkChoices(ctx, v.token, v.side === "sell" ? "pay" : "receive"),
        },
        amountUSD: usdAmount(
            (v: Values & Fixed, ctx) => ({
                min: minimum(1),
                max: v.side === "buy" ? usdcCap(ctx) : holdingCapOn(ctx, v.token, v.network),
            }),
            (v, ctx) => {
                const price = priceOf(ctx, v.token);
                if (!price) return undefined;
                const coins = formatUnits(Number(v.amountUSD) / price, v.token);
                return v.side === "buy" ? `You get ≈ ${coins}` : `You sell ≈ ${coins}`;
            },
        ),
    },
    defaults: (ctx: TradeCtx) => ({ token: "SOL", network: defaultReceiveNetwork(ctx, "SOL"), amountUSD: "10" }),
    template: (v) =>
        v.side === "buy"
            ? [VERB, { slot: "amountUSD" }, "of", { slot: "token" }, "."]
            : [VERB, { slot: "amountUSD" }, "of my", { slot: "token" }, "."],
    normalize: (next, cause, fixed, ctx) => {
        const side = fixed.side === "sell" ? "pay" : "receive";
        const entered = cause.type === "enter" ? cause.changed : [];
        const strayed = entered.includes("token") !== entered.includes("network");
        const keep =
            !(cause.type === "slot" && cause.slot === "token") &&
            networkFits(ctx, next.token, next.network, side, strayed);
        if (keep) return next;
        const network = side === "pay" ? defaultPayNetwork(ctx, next.token) : defaultReceiveNetwork(ctx, next.token);
        return { ...next, network };
    },
    toIntent: (v): Extract<TransactionIntent, { type: "spot" }> => ({
        type: "spot",
        side: v.side,
        token: v.token,
        network: v.network,
        amountUSD: canonicalDecimal(v.amountUSD),
    }),
    preview: (v, ctx) => {
        const amount = Number(v.amountUSD) || 0;
        const price = priceOf(ctx, v.token);
        const fee = amount * FEE_RATE;
        const coins = amount && price ? formatUnits(amount / price, v.token) : "—";
        const paidFrom = buyPayNetwork(ctx, v.network, amount);
        const rows =
            v.side === "buy"
                ? [
                      {
                          id: "pay",
                          label: "You pay",
                          value: amount ? `${formatUsd(amount)} ${QUOTE}` : "—",
                          primary: true,
                      },
                      { id: "get", label: "You get", value: amount ? `≈ ${coins}` : "—", primary: true },
                      {
                          id: "from",
                          label: "Paid from",
                          value: paidFrom ? `${QUOTE} on ${networkName(paidFrom)}` : QUOTE,
                      },
                  ]
                : [
                      { id: "pay", label: "You sell", value: amount ? `≈ ${coins}` : "—", primary: true },
                      {
                          id: "get",
                          label: "You get",
                          value: amount ? `≈ ${formatUsd(amount - fee)} ${QUOTE}` : "—",
                          primary: true,
                      },
                      { id: "to", label: "Received on", value: `${QUOTE} on ${networkName(v.network)}` },
                  ];
        return {
            rows: [
                ...rows,
                { id: "price", label: "Price", value: price ? `${formatUsd(price)} per ${v.token}` : "—" },
                { id: "fee", label: "Fee", value: amount ? `≈ ${formatUsd(fee)}` : "—" },
            ],
        };
    },
});
