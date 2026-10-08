import { schema } from "@/lib/sentence";
import { QUOTE, type Catalog } from "./catalog";

/** What every trade operation can read. */
export type TradeCtx = {
  catalog: Catalog;
  /** Coin units the connected wallet holds; null while no wallet is connected. */
  holdings: Readonly<Record<string, number>> | null;
};

/**
 * Values shared across operations: the amount, and the coin the sentence is
 * about (Swap's destination, Buy/Sell's coin, a perp's market). Switching
 * verbs carries them over, and their pills glide instead of being replaced.
 */
export type TradeTerms = { amountUSD: string; token: string };

export const { operation, registry } = schema<TradeTerms, TradeCtx>();

export const token = (ctx: TradeCtx, symbol: string) =>
  ctx.catalog.tokens.find((t) => t.symbol === symbol);

export const priceOf = (ctx: TradeCtx, symbol: string) => token(ctx, symbol)?.priceUSD ?? 0;

/** Coin units held, or null when no wallet is connected. */
export const held = (ctx: TradeCtx, symbol: string) =>
  ctx.holdings === null ? null : (ctx.holdings[symbol] ?? 0);

/** Dollar value held of a coin, or null when no wallet is connected. */
export const heldUSD = (ctx: TradeCtx, symbol: string) => {
  const units = held(ctx, symbol);
  return units === null ? null : units * priceOf(ctx, symbol);
};

/** Dollars available to spend (the stablecoin balance). */
export const spendableUSD = (ctx: TradeCtx) => heldUSD(ctx, QUOTE);
