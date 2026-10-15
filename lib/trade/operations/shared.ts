import type { Bound, Choice, NumberSpec } from "@/lib/sentence";
import { QUOTE, type Token } from "../catalog";
import { held, priceOf, spendableUSD, type TradeCtx } from "../context";
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

/** Caps a sale or swap at the account's holding of the coin, with no cap while the holding or the price is unknown */
export function holdingCap(ctx: TradeCtx, symbol: string): Bound | undefined {
    const units = held(ctx, symbol);
    const price = priceOf(ctx, symbol);
    if (units === null || price === null) return undefined;
    const value = units * price;
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

/** "$12.40", or "—" while the price isn't known */
const usdOrDash = (value: number | null) => (value === null ? "—" : formatUsd(value));

/** A coin as a picker row with what you hold across networks once read, none included, else its price */
export function coinChoice(ctx: TradeCtx, coin: Token, options: { disabled?: string } = {}): Choice {
    const units = held(ctx, coin.symbol);
    const price = priceOf(ctx, coin.symbol);
    return {
        value: coin.symbol,
        label: coin.symbol,
        description: coin.name,
        ...(units !== null
            ? { detail: formatUnits(units, coin.symbol), subdetail: usdOrDash(price === null ? null : units * price) }
            : { detail: usdOrDash(price) }),
        icon: { set: "coin", id: coin.symbol },
        disabled: options.disabled,
    };
}

/** The coin other than the stablecoin that the account holds the most dollars of, if it holds any */
export function largestHolding(ctx: TradeCtx): string | undefined {
    let best: string | undefined;
    let most = 0;
    for (const { symbol } of ctx.catalog.tokens) {
        // A coin with no price yet can't be ranked against the others
        const value = symbol === QUOTE ? 0 : (held(ctx, symbol) ?? 0) * (priceOf(ctx, symbol) ?? 0);
        if (value > most) {
            best = symbol;
            most = value;
        }
    }
    return best;
}

/** Disables a coin the account holds none of; nothing while the holdings are unknown */
export function unheld(ctx: TradeCtx, symbol: string) {
    const units = held(ctx, symbol);
    return units === null || units > 0 ? undefined : `You don't hold any ${symbol}`;
}
