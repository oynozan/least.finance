import type { Book } from "../src/predictions/trader.ts";

// Mirrors the close path's minimum, so a position the check opens can always be sold
export const buyClearsMinimum = (book: Book, sharesE6: bigint): boolean =>
    sharesE6 >= BigInt(Math.round(book.minOrderSize * 1e6));
