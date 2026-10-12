import { VERB, canonicalDecimal } from "@/lib/sentence";
import { QUOTE } from "../catalog";
import { operation, priceOf, type TradeCtx } from "../context";
import { formatUnits, formatUsd } from "../format";
import type { TransactionIntent } from "../intent";
import { networkName, type NetworkId } from "../networks";
import {
    coinChoice,
    defaultPayNetwork,
    defaultReceiveNetwork,
    holdingCapOn,
    minimum,
    networkChoices,
    networkFits,
    unheld,
    usdAmount,
} from "./shared";

type Values = {
    fromToken: string;
    fromNetwork: NetworkId;
    toToken: string;
    toNetwork: NetworkId;
    amountUSD: string;
};

/** Estimated network fee for the preview. */
const NETWORK_FEE_USD = 0.03;

const networkMissing = { message: "Pick a network.", cta: "Pick a network" };

/** The first coin other than `exclude` that the wallet can pay with, dollars first */
const payableCoin = (ctx: TradeCtx, exclude: string) =>
    [QUOTE, ...ctx.catalog.tokens.map((t) => t.symbol)].find((symbol) => symbol !== exclude && !unheld(ctx, symbol)) ??
    (exclude === QUOTE ? "ETH" : QUOTE);

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
            then: "fromNetwork",
            missing: { message: "Pick a coin to swap from.", cta: "Pick a coin" },
            choices: (_v: Values, ctx) =>
                ctx.catalog.tokens.map((t) => coinChoice(ctx, t, { disabled: unheld(ctx, t.symbol) })),
        },
        fromNetwork: {
            kind: "choice",
            prompt: "On which network?",
            hint: "Network you pay from",
            missing: networkMissing,
            choices: (v: Values, ctx) =>
                networkChoices(ctx, v.fromToken, "pay", { token: v.toToken, network: v.toNetwork }),
        },
        toToken: {
            kind: "choice",
            prompt: "Swap to which coin?",
            hint: "Coin you receive",
            term: "token",
            then: "toNetwork",
            missing: { message: "Pick a coin to swap to.", cta: "Pick a coin" },
            choices: (_v: Values, ctx) => ctx.catalog.tokens.map((t) => coinChoice(ctx, t)),
        },
        toNetwork: {
            kind: "choice",
            prompt: "On which network?",
            hint: "Network you receive on",
            term: "tokenNetwork",
            missing: networkMissing,
            choices: (v: Values, ctx) =>
                networkChoices(ctx, v.toToken, "receive", { token: v.fromToken, network: v.fromNetwork }),
        },
        amountUSD: usdAmount(
            (v: Values, ctx) => ({ min: minimum(1), max: holdingCapOn(ctx, v.fromToken, v.fromNetwork) }),
            (v, ctx) => {
                const to = priceOf(ctx, v.toToken);
                const amount = Number(v.amountUSD) - NETWORK_FEE_USD;
                return to && amount > 0 ? `You get ≈ ${formatUnits(amount / to, v.toToken)}` : undefined;
            },
        ),
    },
    defaults: (ctx: TradeCtx) => {
        const fromNetwork = defaultPayNetwork(ctx, "ETH");
        const toNetwork = defaultReceiveNetwork(ctx, "SOL", { token: "ETH", network: fromNetwork });
        return { fromToken: "ETH", fromNetwork, toToken: "SOL", toNetwork, amountUSD: "10" };
    },
    template: () => [VERB, "my", { slot: "fromToken" }, "to", { slot: "toToken" }, "for", { slot: "amountUSD" }, "."],
    normalize: (next, cause, _fixed, ctx) => {
        const picked = cause.type === "slot" ? cause.slot : undefined;
        // A carried coin that is the one being paid is paid for with another coin
        const swapped = cause.type === "enter" && cause.changed.includes("toToken") && next.fromToken === next.toToken;
        const entered = cause.type === "enter" ? cause.changed : [];
        const carried = entered.includes("toNetwork");
        const strayed = entered.includes("toToken") !== carried;

        const fromToken = swapped ? payableCoin(ctx, next.toToken) : next.fromToken;
        const keepFrom = !swapped && picked !== "fromToken" && networkFits(ctx, fromToken, next.fromNetwork, "pay");
        const fromNetwork = keepFrom ? next.fromNetwork : defaultPayNetwork(ctx, fromToken);
        const keepTo =
            picked !== "toToken" &&
            (!swapped || carried) &&
            networkFits(ctx, next.toToken, next.toNetwork, "receive", strayed);
        const toNetwork = keepTo
            ? next.toNetwork
            : defaultReceiveNetwork(ctx, next.toToken, { token: fromToken, network: fromNetwork });
        const repaired = { ...next, fromToken, fromNetwork, toNetwork };

        if (fromToken !== next.toToken || fromNetwork !== toNetwork) return repaired;
        // A coin pick that made both pairs identical flips them
        if (cause.type === "slot" && cause.slot === "fromToken") {
            return { ...repaired, toToken: cause.prev, toNetwork: next.fromNetwork };
        }
        if (cause.type === "slot" && cause.slot === "toToken") {
            // The old receive network only becomes the pay network where the wallet holds the coin
            const flippedNetwork = networkFits(ctx, cause.prev, next.toNetwork, "pay")
                ? next.toNetwork
                : defaultPayNetwork(ctx, cause.prev);
            return { ...repaired, fromToken: cause.prev, fromNetwork: flippedNetwork };
        }
        const payWith = payableCoin(ctx, next.toToken);
        return { ...repaired, fromToken: payWith, fromNetwork: defaultPayNetwork(ctx, payWith) };
    },
    toIntent: (v): Extract<TransactionIntent, { type: "swap" }> => ({
        type: "swap",
        fromToken: v.fromToken,
        fromNetwork: v.fromNetwork,
        toToken: v.toToken,
        toNetwork: v.toNetwork,
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
                    id: "route",
                    label: "Route",
                    value: `${networkName(v.fromNetwork)} → ${networkName(v.toNetwork)}`,
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
