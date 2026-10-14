import { schema } from "@/lib/sentence";
import { QUOTE, type Catalog } from "./catalog";
import type { NetworkId } from "./networks";

/** Coin units the signing wallets hold, by coin and then network */
export type CoinUnits = Readonly<Record<string, Readonly<Partial<Record<NetworkId, number>>>>>;

/** What the signing wallets hold, and the networks of theirs that were never read, where nothing is known */
export type WalletHoldings = { units: CoinUnits; unread: readonly NetworkId[] };

/** What every trade operation can read. */
export type TradeCtx = {
    catalog: Catalog;
    /** Coin units the connected wallet holds; null while no wallet is connected. */
    holdings: Readonly<Record<string, number>> | null;
    /** The signing wallets' coins and unread networks; null until they load or while signed out */
    wallet?: WalletHoldings | null;
    /** The most one prediction may spend; a number only while signed in with trading live. */
    maxOrderUSD?: number | null;
    /** Whether Long and Short can open positions: the server's markets have loaded and its order limit is set. */
    perpTrading?: { maxOrderUSD: number | null; loaded: boolean };
};

/**
 * Values shared across operations: the amount, and the coin the sentence is
 * about (Swap's destination, Buy/Sell's coin, a perp's market). Switching
 * verbs carries them over, and their pills glide instead of being replaced.
 */
export type TradeTerms = { amountUSD: string; token: string; tokenNetwork: string };

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

/** Coin units held on one network or null while unknown; with no wallet read, `holdings` count on each coin's home network */
export function heldOn(ctx: TradeCtx, symbol: string, network: NetworkId): number | null {
    if (ctx.wallet === null) return null;
    if (ctx.wallet) return ctx.wallet.unread.includes(network) ? null : (ctx.wallet.units[symbol]?.[network] ?? 0);
    if (ctx.holdings === null) return null;
    return token(ctx, symbol)?.home === network ? (ctx.holdings[symbol] ?? 0) : 0;
}

/** Coin units held across every network, or null while nothing is known or any of the coin's networks is unread */
export function heldTotal(ctx: TradeCtx, symbol: string): number | null {
    if (ctx.wallet === null) return null;
    if (ctx.wallet) {
        const { units, unread } = ctx.wallet;
        if (token(ctx, symbol)?.networks.some(({ network }) => unread.includes(network))) return null;
        return Object.values(units[symbol] ?? {}).reduce((sum, amount) => sum + amount, 0);
    }
    return held(ctx, symbol);
}

/** Dollars available to spend (the stablecoin balance). */
export const spendableUSD = (ctx: TradeCtx) => heldUSD(ctx, QUOTE);
