import type { Bound, Choice, NumberSpec } from "@/lib/sentence";
import type { Token } from "../catalog";
import { held, heldUSD, spendableUSD, type TradeCtx } from "../context";
import { formatUnits, formatUsd, formatUsdShort } from "../format";

/** Where the amount slider tops out while no wallet caps it. */
const UNCAPPED_MAX_USD = 10_000;

/** A dollar amount bound to the shared `amountUSD` term. */
export function usdAmount<V>(
    bounds: NumberSpec<V, TradeCtx, "amountUSD">["bounds"],
    summary?: NumberSpec<V, TradeCtx, "amountUSD">["summary"],
): NumberSpec<V, TradeCtx, "amountUSD"> {
    return {
        kind: "number",
        prompt: "How much, in dollars?",
        hint: "Amount in USD",
        term: "amountUSD",
        suffix: " USD",
        decimals: 2,
        maxIntegerDigits: 9,
        placeholder: "0",
        missing: { message: "Enter an amount.", cta: "Enter an amount" },
        bounds,
        range: { min: 1, max: UNCAPPED_MAX_USD },
        summary,
    };
}

export const minimum = (value: number): Bound => ({
    value,
    message: `The minimum is ${formatUsdShort(value)}.`,
    cta: `Minimum ${formatUsdShort(value)}`,
});

/** Caps a sale at what the wallet holds; no cap while disconnected. */
export function holdingCap(ctx: TradeCtx, symbol: string): Bound | undefined {
    const value = heldUSD(ctx, symbol);
    if (value === null) return undefined;
    return {
        value,
        message:
            value === 0 ? `You don't hold any ${symbol}.` : `That's more than your ${formatUsd(value)} of ${symbol}.`,
        cta: `Not enough ${symbol}`,
    };
}

/** Caps spending at the stablecoin balance; no cap while disconnected. */
export function spendCap(ctx: TradeCtx): Bound | undefined {
    const value = spendableUSD(ctx);
    if (value === null) return undefined;
    return {
        value,
        message: `You have ${formatUsd(value)} USDC to spend.`,
        cta: "Not enough USDC",
    };
}

/** A coin as a picker row: its price, or what you hold once connected. */
export function coinChoice(ctx: TradeCtx, token: Token, options: { detail?: string; disabled?: string } = {}): Choice {
    const units = held(ctx, token.symbol);
    return {
        value: token.symbol,
        label: token.symbol,
        description: token.name,
        detail: options.detail ?? (units ? formatUnits(units, token.symbol) : formatUsd(token.priceUSD)),
        icon: { set: "coin", id: token.symbol },
        disabled: options.disabled,
    };
}

/** Disables coins the wallet doesn't hold (only once a wallet is connected). */
export const unheld = (ctx: TradeCtx, symbol: string) =>
    held(ctx, symbol) === 0 ? `You don't hold any ${symbol}` : undefined;
