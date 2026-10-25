/** One helper per scale, so a part is converted to a JS dollar number once and scales never mix. */
const WEI = 10n ** 18n;
const E6 = 10n ** 6n;

/** Splits at the scale first so the whole part stays exact before the fraction is added. */
function scaled(value: bigint, scale: bigint): number {
    const whole = value / scale;
    const rest = value % scale;
    return Number(whole) + Number(rest) / Number(scale);
}

/** 18-decimal wei of USDC to dollars. */
export const usdFromWei = (wei: bigint) => scaled(wei, WEI);

/** 6-decimal fields (Polymarket, Hyperliquid, `E6` fees) to dollars. */
export const usdFromE6 = (e6: bigint) => scaled(e6, E6);

/** 18-decimal units-decimals (`trades.spreadUSD`, `trades.usd`, `holdings.units`) as a dollar amount. */
export const usdFromUnits = (unitsDecimal: bigint) => scaled(unitsDecimal, WEI);

/** A dollar number as the plain decimal string the API sends: up to six places, no trailing zeros. */
export function usdString(usd: number): string {
    const text = usd.toFixed(6).replace(/\.?0+$/, "");
    return text === "-0" || text === "" ? "0" : text;
}
