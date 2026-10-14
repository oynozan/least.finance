import type { Book } from "../src/predictions/trader.ts";

// Mirrors the close path's minimum, so a position the check opens can always be sold
export const buyClearsMinimum = (book: Book, sharesE6: bigint): boolean =>
    sharesE6 >= BigInt(Math.round(book.minOrderSize * 1e6));

const TESTNET_HOST = "api.hyperliquid-testnet.xyz";

/** Throws unless the Hyperliquid URL is the testnet, so a check that moves money can't reach mainnet. */
export function requireTestnet(url: string | undefined): string {
    let host = "";
    try {
        host = new URL(url ?? "").hostname;
    } catch {
        // An unset or unreadable URL is refused below
    }
    if (host !== TESTNET_HOST) {
        throw new Error(`HYPERLIQUID_API_URL must be the testnet (https://${TESTNET_HOST}); got ${url ?? "nothing"}.`);
    }
    return url!;
}
