const TICKER = /^[A-Za-z0-9]{1,12}$/;

/** The ticker a coin's logo and placeholder go by: a k-asset (kPEPE is 1,000 PEPE) takes its base coin's. */
export const baseTicker = (symbol: string) => symbol.replace(/^k(?=[A-Z])/, "");

/** The Hyperliquid name to look a logo up under, or null when the symbol can't be a coin's ticker. */
export function coinLogoBase(symbol: string): string | null {
    return TICKER.test(symbol) ? baseTicker(symbol) : null;
}
