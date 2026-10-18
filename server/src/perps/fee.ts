/** Our fee on a Long or Short position. This file has no imports because the app loads it at runtime, and shows the same number as the server charges. */

/** Our fee on each Long or Short position: one dollar, taken from its collateral when it opens; nothing when it doesn't open. */
export const PERP_FEE_USD = 1;
export const PERP_FEE_E6 = BigInt(PERP_FEE_USD * 1_000_000);

/** What a position must start at: its collateral, and its size once our fee is out of the collateral and the leverage is on. The server refuses under these and the sentence tells the person the same numbers. */
export const PERP_MIN_COLLATERAL_USD = 10;
export const PERP_MIN_POSITION_USD = 11;

export const PERP_MIN_COLLATERAL_MESSAGE = `Positions start at $${PERP_MIN_COLLATERAL_USD}.`;
export const PERP_MIN_POSITION_MESSAGE = `A position starts at $${PERP_MIN_POSITION_USD}. Raise the collateral or the leverage.`;
