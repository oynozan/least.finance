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

const SOL = "SOL";

/** Estimated network fee for the preview. */
const NETWORK_FEE_USD = 0.03;

const networkMissing = { message: "Pick a network.", cta: "Pick a network" };

/** The first coin other than `exclude` that the wallet can pay with, dollars first */
const payableCoin = (ctx: TradeCtx, exclude: string) =>
    [QUOTE, ...ctx.catalog.tokens.map((t) => t.symbol)].find((symbol) => symbol !== exclude && !unheld(ctx, symbol)) ??
    (exclude === QUOTE ? "ETH" : QUOTE);

/** The coins to swap between: as asked, else another coin the wallet holds, else the received coin against dollars */
function heldPair(ctx: TradeCtx, from: string, to: string) {
    if (!unheld(ctx, from)) return { fromToken: from, toToken: to };
    const other = payableCoin(ctx, to);
    if (unheld(ctx, other) && !unheld(ctx, to)) return { fromToken: to, toToken: to === QUOTE ? "ETH" : QUOTE };
    return { fromToken: other, toToken: to };
}

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
            (v: Values, ctx) => ({
                min: minimum(1),
                // A coin the wallet doesn't hold at all is already blocked by its pill
                max: unheld(ctx, v.fromToken) ? undefined : holdingCapOn(ctx, v.fromToken, v.fromNetwork),
            }),
            (v, ctx) => {
                const to = priceOf(ctx, v.toToken);
                const amount = Number(v.amountUSD) - NETWORK_FEE_USD;
                return to && amount > 0 ? `You get ≈ ${formatUnits(amount / to, v.toToken)}` : undefined;
            },
        ),
    },
    defaults: (ctx: TradeCtx) => {
        const { fromToken, toToken } = heldPair(ctx, "ETH", "SOL");
        const fromNetwork = defaultPayNetwork(ctx, fromToken);
        const toNetwork = defaultReceiveNetwork(ctx, toToken, { token: fromToken, network: fromNetwork });
        return { fromToken, fromNetwork, toToken, toNetwork, amountUSD: "10" };
    },
    template: () => [VERB, "my", { slot: "fromToken" }, "to", { slot: "toToken" }, "for", { slot: "amountUSD" }, "."],
    normalize: (next, cause, _fixed, ctx) => {
        const picked = cause.type === "slot" ? cause.slot : undefined;
        const entered = cause.type === "enter" ? cause.changed : [];
        const chosen: readonly string[] = cause.type === "slot" ? [] : cause.chosen;
        // After a pick every slot stays where it fits; on enter and refit only the person's choices do
        const pinned = (slot: string) => cause.type === "slot" || chosen.includes(slot);
        // A carried coin that is the one being paid is paid for with another coin
        const swapped = entered.includes("toToken") && next.fromToken === next.toToken && !chosen.includes("fromToken");
        const carried = entered.includes("toNetwork");
        const strayed = entered.includes("toToken") !== carried;

        // A coin the wallet doesn't hold is paid for with one it does
        const held =
            cause.type !== "slot" && !swapped
                ? heldPair(ctx, next.fromToken, next.toToken)
                : { fromToken: next.fromToken, toToken: next.toToken };
        const fromToken = swapped ? payableCoin(ctx, next.toToken) : held.fromToken;
        const toToken = held.toToken;
        const keepFrom =
            fromToken === next.fromToken &&
            picked !== "fromToken" &&
            pinned("fromNetwork") &&
            networkFits(ctx, fromToken, next.fromNetwork, "pay");
        const fromNetwork = keepFrom ? next.fromNetwork : defaultPayNetwork(ctx, fromToken);
        const keepTo =
            picked !== "toToken" &&
            pinned("toNetwork") &&
            (!swapped || carried) &&
            toToken === next.toToken &&
            networkFits(ctx, toToken, next.toNetwork, "receive", strayed);
        const toNetwork = keepTo
            ? next.toNetwork
            : defaultReceiveNetwork(ctx, toToken, { token: fromToken, network: fromNetwork });
        const repaired = { ...next, fromToken, fromNetwork, toToken, toNetwork };

        if (fromToken !== toToken || fromNetwork !== toNetwork) return repaired;
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
        // Otherwise the receive coin moves unless the person chose it; the pay coin they chose never does
        if (cause.type !== "slot" && !chosen.includes("toToken")) {
            const other = [SOL, "ETH", QUOTE].find((symbol) => symbol !== fromToken) ?? QUOTE;
            return {
                ...repaired,
                toToken: other,
                toNetwork: defaultReceiveNetwork(ctx, other, { token: fromToken, network: fromNetwork }),
            };
        }
        const payWith = payableCoin(ctx, toToken);
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
