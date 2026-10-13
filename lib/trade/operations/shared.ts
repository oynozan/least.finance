import type { Bound, Choice, NumberSpec } from "@/lib/sentence";
import { QUOTE, type Token } from "../catalog";
import { heldOn, heldTotal, priceOf, spendableUSD, token, type TradeCtx } from "../context";
import { formatUnits, formatUsd, formatUsdShort } from "../format";
import { networkName, type NetworkId } from "../networks";

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

const entriesOf = (ctx: TradeCtx, symbol: string) => token(ctx, symbol)?.networks ?? [];

const homeOf = (ctx: TradeCtx, symbol: string): NetworkId => token(ctx, symbol)?.home ?? "ethereum";

/** Units a cap allows on a network, or null while unknown, with a real wallet's gas reserve held back */
function spendableOn(ctx: TradeCtx, symbol: string, network: NetworkId): number | null {
    const units = heldOn(ctx, symbol, network);
    if (units === null) return null;
    const reserve = ctx.wallet ? (entriesOf(ctx, symbol).find((e) => e.network === network)?.reserve ?? 0) : 0;
    return Math.max(units - reserve, 0);
}

/** Caps a sale or swap at what the wallet holds of the coin on that network, with no cap while unknown */
export function holdingCapOn(ctx: TradeCtx, symbol: string, network: NetworkId): Bound | undefined {
    const units = spendableOn(ctx, symbol, network);
    if (units === null) return undefined;
    const value = units * priceOf(ctx, symbol);
    const where = `${symbol} on ${networkName(network)}`;
    return {
        value,
        message:
            value === 0 ? `You don't hold any ${where}.` : `That's more than your ${formatUsd(value)} of ${where}.`,
        cta: `Not enough ${symbol}`,
    };
}

type UsdcRow = { network: NetworkId; usd: number };

/** The wallet's spendable USDC on each network in the coin's order, empty while unknown */
function usdcRows(ctx: TradeCtx): UsdcRow[] {
    return entriesOf(ctx, QUOTE).flatMap(({ network }) => {
        const units = spendableOn(ctx, QUOTE, network);
        return units === null ? [] : [{ network, usd: units * priceOf(ctx, QUOTE) }];
    });
}

const richest = (rows: UsdcRow[]) =>
    rows.reduce<UsdcRow | undefined>((best, row) => (!best || row.usd > best.usd ? row : best), undefined);

/** Caps a purchase at the most USDC the wallet holds on one network, with no cap while unknown */
export function usdcCap(ctx: TradeCtx): Bound | undefined {
    const best = richest(usdcRows(ctx));
    if (!best) return undefined;
    return {
        value: best.usd,
        message:
            best.usd === 0
                ? `You don't hold any ${QUOTE}.`
                : `You have ${formatUsd(best.usd)} ${QUOTE} on ${networkName(best.network)} to spend.`,
        cta: `Not enough ${QUOTE}`,
    };
}

/** The network a purchase pays from, the coin's own if its USDC covers the amount, else where USDC is largest */
export function buyPayNetwork(ctx: TradeCtx, network: NetworkId, amountUSD: number): NetworkId | null {
    const here = spendableOn(ctx, QUOTE, network);
    if (here === null) return null;
    if (here * priceOf(ctx, QUOTE) >= amountUSD) return network;
    const best = richest(usdcRows(ctx));
    return best && best.usd > 0 ? best.network : network;
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

/** A coin as a picker row with what you hold across networks once connected, else its price */
export function coinChoice(ctx: TradeCtx, coin: Token, options: { disabled?: string } = {}): Choice {
    const units = heldTotal(ctx, coin.symbol);
    return {
        value: coin.symbol,
        label: coin.symbol,
        description: coin.name,
        ...(units
            ? { detail: formatUnits(units, coin.symbol), subdetail: formatUsd(units * coin.priceUSD) }
            : { detail: formatUsd(coin.priceUSD) }),
        icon: { set: "coin", id: coin.symbol },
        disabled: options.disabled,
    };
}

/** The coin other than the stablecoin that the wallet holds the most dollars of, if it holds any */
export function largestHolding(ctx: TradeCtx): string | undefined {
    let best: string | undefined;
    let most = 0;
    for (const { symbol } of ctx.catalog.tokens) {
        const value = symbol === QUOTE ? 0 : (heldTotal(ctx, symbol) ?? 0) * priceOf(ctx, symbol);
        if (value > most) {
            best = symbol;
            most = value;
        }
    }
    return best;
}

/** Disables coins the wallet doesn't hold, only once a wallet is connected */
export const unheld = (ctx: TradeCtx, symbol: string) =>
    heldTotal(ctx, symbol) === 0 ? `You don't hold any ${symbol}` : undefined;

/** Why a pay row can't be used: nothing there, or no more than the gas kept back; nothing while unknown */
function payBlock(units: number | null, spendable: number | null) {
    if (units === null || spendable === null) return undefined;
    if (units === 0) return "Nothing here";
    return spendable > 0 ? undefined : "Too little for gas";
}

/** A coin's networks as picker rows, with unusable pay rows and the other side's pair disabled */
export function networkChoices(
    ctx: TradeCtx,
    symbol: string,
    side: "pay" | "receive",
    other?: { token: string; network: string },
): Choice<NetworkId>[] {
    return entriesOf(ctx, symbol).map((entry) => {
        const units = heldOn(ctx, symbol, entry.network);
        const same = other?.token === symbol && other.network === entry.network;
        const empty = side === "pay" ? payBlock(units, spendableOn(ctx, symbol, entry.network)) : undefined;
        return {
            value: entry.network,
            label: networkName(entry.network),
            description: entry.label,
            ...(units
                ? { detail: formatUnits(units, symbol), subdetail: formatUsd(units * priceOf(ctx, symbol)) }
                : {}),
            icon: { set: "coin", id: symbol, badge: { set: "network", id: entry.network } },
            disabled: empty ?? (same ? "Same as the other side" : undefined),
        };
    });
}

/** Whether a coin's network can be kept, which it can't be if absent, unusable on the pay side, or a wrapped form that arrived without its coin */
export function networkFits(ctx: TradeCtx, symbol: string, network: string, side: "pay" | "receive", strayed = false) {
    const row = networkChoices(ctx, symbol, side).find((c) => c.value === network);
    const wrapped = entriesOf(ctx, symbol).find((e) => e.network === network)?.wrapped;
    return !!row && !row.disabled && !(strayed && wrapped);
}

/** The network a paying coin starts on, where the wallet holds the most of what it can spend, else the most, else its home */
export function defaultPayNetwork(ctx: TradeCtx, symbol: string): NetworkId {
    const networks = entriesOf(ctx, symbol).map((entry) => entry.network);
    const units = (network: NetworkId) => heldOn(ctx, symbol, network) ?? 0;
    const richest = (among: NetworkId[]) =>
        among.reduce<NetworkId | undefined>(
            (best, network) => (units(network) > (best ? units(best) : 0) ? network : best),
            undefined,
        );
    const spendable = networks.filter((network) => (spendableOn(ctx, symbol, network) ?? 0) > 0);
    return richest(spendable) ?? richest(networks) ?? homeOf(ctx, symbol);
}

/** The network a received coin starts on, beside the pay side unless the coin is wrapped there */
export function defaultReceiveNetwork(
    ctx: TradeCtx,
    symbol: string,
    pay?: { token: string; network: string },
): NetworkId {
    const home = homeOf(ctx, symbol);
    if (pay?.token === symbol) {
        if (home !== pay.network) return home;
        return entriesOf(ctx, symbol).find((e) => e.network !== pay.network)?.network ?? home;
    }
    const there = entriesOf(ctx, symbol).find((e) => e.network === pay?.network);
    return there && !there.wrapped ? there.network : home;
}
