/** The spread on account trades. This file has no imports because the app loads it at runtime, and prices a trade with the same number as the server. */

/**
 * The share of the market price a trade gives up to us, in basis points: 30 is 0.3%.
 * A buy fills at the market price plus it, a sell at the market price less it, and a swap pays it once, on the coin it gives up.
 */
export const TRADE_SPREAD_BPS = 30;
