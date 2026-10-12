import { schema } from "@/lib/sentence";
import { QUOTE, type Catalog } from "./catalog";
import type { NetworkId } from "./networks";

/** Coin units the signing wallets hold, by coin and then network */
export type WalletHoldings = Readonly<Record<string, Readonly<Partial<Record<NetworkId, number>>>>>;

/** What every trade operation can read. */
export type TradeCtx = {
    catalog: Catalog;
    /** Coin units the connected wallet holds; null while no wallet is connected. */
    holdings: Readonly<Record<string, number>> | null;
    /** The signing wallets' coins per network; null until they load, and absent in the demo */
    wallet?: WalletHoldings | null;
    /** The most one prediction may spend; a number only while signed in with trading live. */
    maxOrderUSD?: number | null;
};

/**
 * Values shared across operations: the amount, and the coin the sentence is
 * about (Swap's destination, Buy/Sell's coin, a perp's market). Switching
 * verbs carries them over, and their pills glide instead of being replaced.
 */
export type TradeTerms = { amountUSD: string; token: string; tokenNetwork: string };

export const { operation, registry } = schema<TradeTerms, TradeCtx>();

export const token = (ctx: TradeCtx, symbol: string) => ctx.catalog.tokens.find((t) => t.symbol === symbol);

export const priceOf = (ctx: TradeCtx, symbol: string) => token(ctx, symbol)?.priceUSD ?? 0;

/** Coin units held, or null when no wallet is connected. */
export const held = (ctx: TradeCtx, symbol: string) => (ctx.holdings === null ? null : (ctx.holdings[symbol] ?? 0));

/** Dollar value held of a coin, or null when no wallet is connected. */
export const heldUSD = (ctx: TradeCtx, symbol: string) => {
    const units = held(ctx, symbol);
    return units === null ? null : units * priceOf(ctx, symbol);
};

/** Coin units held on one network or null while unknown, with the demo's coins on their home networks */
export function heldOn(ctx: TradeCtx, symbol: string, network: NetworkId): number | null {
    if (ctx.wallet === null) return null;
    if (ctx.wallet) return ctx.wallet[symbol]?.[network] ?? 0;
    if (ctx.holdings === null) return null;
    return token(ctx, symbol)?.home === network ? (ctx.holdings[symbol] ?? 0) : 0;
}

/** Coin units held across every network, or null while nothing is known */
export function heldTotal(ctx: TradeCtx, symbol: string): number | null {
    if (ctx.wallet === null) return null;
    if (ctx.wallet) return Object.values(ctx.wallet[symbol] ?? {}).reduce((sum, units) => sum + units, 0);
    return held(ctx, symbol);
}

/** Dollars available to spend (the stablecoin balance). */
export const spendableUSD = (ctx: TradeCtx) => heldUSD(ctx, QUOTE);
