/** Our fee on a Long or Short position. This file has no imports because the app loads it at runtime, and shows the same number as the server charges. */

/** Our fee on each Long or Short position: one dollar, taken from its collateral when it opens; nothing when it doesn't open. */
export const PERP_FEE_USD = 1;
export const PERP_FEE_E6 = BigInt(PERP_FEE_USD * 1_000_000);
