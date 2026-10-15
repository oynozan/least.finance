import { Decimal128 } from "mongodb";

/** Coin units are held as whole numbers of 10^-18 coin, so any coin's decimals fit and sums stay exact. */
export const UNIT_DECIMALS = 18;
const SCALE = 10n ** BigInt(UNIT_DECIMALS);

/** A coin-unit decimal string to scaled integer; null when it isn't a non-negative decimal within 18 places. */
export function parseUnits18(text: string): bigint | null {
    const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
    if (!match) return null;
    const [, whole = "", fraction = ""] = match;
    return BigInt(whole) * SCALE + BigInt(fraction.padEnd(UNIT_DECIMALS, "0"));
}

/** A scaled integer as a plain decimal string without trailing zeros. */
export function formatUnits18(scaled: bigint): string {
    const negative = scaled < 0n;
    const digits = (negative ? -scaled : scaled).toString().padStart(UNIT_DECIMALS + 1, "0");
    const whole = digits.slice(0, -UNIT_DECIMALS);
    const fraction = digits.slice(-UNIT_DECIMALS).replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const toUnitsDecimal = (scaled: bigint) => Decimal128.fromString(formatUnits18(scaled));

/** The scaled integer a Decimal128 holds, whether written as "1.5" or "1.5E+3". */
export function fromUnitsDecimal(value: Decimal128): bigint {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i.exec(value.toString());
    if (!match) throw new Error(`Not a number: ${value.toString()}`);
    const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
    const shift = UNIT_DECIMALS + Number(exponent) - fraction.length;
    let digits = BigInt(whole + fraction);
    if (shift >= 0) digits *= 10n ** BigInt(shift);
    else digits /= 10n ** BigInt(-shift);
    return sign === "-" ? -digits : digits;
}

/** Rounds a scaled integer down to `decimals` places. */
export function floorToDecimals(scaled: bigint, decimals: number): bigint {
    const step = 10n ** BigInt(UNIT_DECIMALS - Math.min(decimals, UNIT_DECIMALS));
    return (scaled / step) * step;
}
