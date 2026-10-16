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

const priceFormats = new Map<number, Intl.NumberFormat>();

/** A coin's price: "$66,000", "$0.1823", "$0.000155"; cents from $1, four significant digits under it. */
export function formatPrice(value: number) {
    if (!(value > 0 && value < 1)) return formatUsdShort(value);
    const places = Math.min(20, 3 - Math.floor(Math.log10(value)));
    let format = priceFormats.get(places);
    if (!format) {
        format = new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2,
            maximumFractionDigits: places,
        });
        priceFormats.set(places, format);
    }
    return format.format(value);
}

/** "0.003115 ETH", "0.00006095 ETH"; below the 8 places coins are kept to, "<0.00000001 ETH". */
export function formatUnits(value: number, symbol: string) {
    if (value > 0 && value < 1e-8) return `<0.00000001 ${symbol}`;
    return `${units.format(value)} ${symbol}`;
}

/** 0.38 -> "38¢" */
export const formatCents = (price: number) => `${Math.round(price * 100)}¢`;
