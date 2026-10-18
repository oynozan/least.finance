import { schema } from "@/lib/sentence";
import { QUOTE, type Catalog } from "./catalog";

/** What every trade operation can read. */
export type TradeCtx = {
    catalog: Catalog;
    /** Coin units the connected wallet holds; null while no wallet is connected. */
    holdings: Readonly<Record<string, number>> | null;
    /** The most one prediction may spend; a number only while signed in with trading live. */
    maxOrderUSD?: number | null;
    /** Whether Long and Short can open positions: the server's markets have loaded and its order limit is set. */
    perpTrading?: { maxOrderUSD: number | null; loaded: boolean; error?: string | null };
    /** The account's perp positions that are open or closing, which hold their asset. */
    openPerps?: readonly { asset: string }[];
};

/**
 * Values shared across operations: the amount, and the coin the sentence is
 * about (Swap's destination, Buy/Sell's coin, a perp's market). Switching
 * verbs carries them over, and their pills glide instead of being replaced.
 */
export type TradeTerms = { amountUSD: string; token: string };

export const { operation, registry } = schema<TradeTerms, TradeCtx>();

export const token = (ctx: TradeCtx, symbol: string) => ctx.catalog.tokens.find((t) => t.symbol === symbol);

/** A coin's price in dollars, or null until the swap catalog has read it; USDC is the dollar every amount is in. */
export const priceOf = (ctx: TradeCtx, symbol: string): number | null =>
    symbol === QUOTE ? 1 : (token(ctx, symbol)?.priceUSD ?? null);

/** Coin units held, or null when no wallet is connected. */
export const held = (ctx: TradeCtx, symbol: string) => (ctx.holdings === null ? null : (ctx.holdings[symbol] ?? 0));

/** Dollar value held of a coin, or null when no wallet is connected or the coin has no price yet. */
export const heldUSD = (ctx: TradeCtx, symbol: string) => {
    const units = held(ctx, symbol);
    const price = priceOf(ctx, symbol);
    return units === null || price === null ? null : units * price;
};

/** Dollars available to spend (the stablecoin balance). */
export const spendableUSD = (ctx: TradeCtx) => heldUSD(ctx, QUOTE);
