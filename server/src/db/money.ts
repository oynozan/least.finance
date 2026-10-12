import { Decimal128 } from "mongodb";
import { formatUnits } from "viem";
import { NATIVE_DECIMALS } from "../chain/arc.ts";
import type { UsdcAmount } from "../protocol.ts";

/**
 * Amounts are stored in wei, 18 decimals, as whole-number Decimal128s: an
 * Int64 tops out near 9.2 USDC at that scale, and Decimal128 adds integers
 * exactly up to 34 digits, which `$inc` relies on.
 */
export const toDecimal = (wei: bigint) => Decimal128.fromString(wei.toString());

/** The exact integer a Decimal128 holds, whether written as "1500" or "1.5E+3". */
export function fromDecimal(value: Decimal128): bigint {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i.exec(value.toString());
    if (!match) throw new Error(`Not a number: ${value.toString()}`);
    const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
    const shift = Number(exponent) - fraction.length;
    let digits = BigInt(whole + fraction);
    if (shift >= 0) {
        digits *= 10n ** BigInt(shift);
    } else {
        const scale = 10n ** BigInt(-shift);
        if (digits % scale !== 0n) throw new Error(`Not a whole number of wei: ${value.toString()}`);
        digits /= scale;
    }
    return sign === "-" ? -digits : digits;
}

/** Wei as the wire's decimal USDC string. */
export const formatUsdc = (wei: bigint): UsdcAmount => formatUnits(wei, NATIVE_DECIMALS);

/** Polymarket's pUSD and shares have 6 decimals; the ledger has 18. */
export const E6_TO_WEI = 10n ** 12n;

export const e6ToWei = (e6: bigint) => e6 * E6_TO_WEI;

/** Floors, so rounding never favors the person. */
export const weiToE6 = (wei: bigint) => wei / E6_TO_WEI;

/** A decimal with up to 6 places and no trailing zeros. */
export const formatE6 = (e6: bigint) => formatUnits(e6, 6);
