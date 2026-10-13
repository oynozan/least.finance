const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
});
const units = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/** "$1,250.50" */
export const formatUsd = (value: number) => usd.format(value);

/** "$1,250", or with cents only when they matter ("$12.50", "$0.30"). */
export const formatUsdShort = (value: number) => (Number.isInteger(value) ? usdWhole.format(value) : usd.format(value));

/** "0.003115 ETH"; tiny amounts read "<0.0001 ETH" instead of rounding to 0. */
export function formatUnits(value: number, symbol: string) {
    if (value > 0 && value < 0.0001) return `<0.0001 ${symbol}`;
    return `${units.format(value)} ${symbol}`;
}

/** 0.38 -> "38¢" */
export const formatCents = (price: number) => `${Math.round(price * 100)}¢`;
