const SIG_FIGS = 5;
const MAX_DECIMALS = 6;
const RATE_SCALE = 1_000_000_000;
const PRICE_SCALE = 100_000_000;

const stripZeros = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);

/** A price on Hyperliquid's tick rule: 5 significant figures, at most 6 - szDecimals decimals, no trailing zeros. */
export function roundPrice(px: number, szDecimals: number): string {
    const figures = Number(px.toPrecision(SIG_FIGS));
    return stripZeros(figures.toFixed(Math.max(0, MAX_DECIMALS - szDecimals)));
}

/** A size rounded down to the asset's coin step, no trailing zeros. */
export function roundSize(size: number, szDecimals: number): string {
    const scale = 10 ** szDecimals;
    return stripZeros((Math.floor(size * scale + 1e-9) / scale).toFixed(szDecimals));
}

/** The worst fill an IOC order accepts: buying goes above the mark, selling below. */
export function limitPrice(
    mark: number,
    side: "long" | "short",
    action: "open" | "close",
    bps: number,
    szDecimals: number,
): string {
    const buying = (side === "long") === (action === "open");
    return roundPrice(mark * (1 + (buying ? bps : -bps) / 10_000), szDecimals);
}

/** Our fee on a notional, rounded up the way sizeFor charges it. */
export function ourFeeOf(notionalE6: bigint, ourFeeRate: number): bigint {
    return ceilDiv(notionalE6 * BigInt(Math.round(ourFeeRate * RATE_SCALE)), BigInt(RATE_SCALE));
}

export type Sizing = {
    sizeCoin: string;
    notionalE6: bigint;
    marginE6: bigint;
    entryFeeE6: bigint;
    ourFeeE6: bigint;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The largest position whose margin plus both fees fit in the collateral; null when the size rounds to zero. */
export function sizeFor(o: {
    collateralE6: bigint;
    leverage: number;
    feeRate: number;
    ourFeeRate: number;
    price: number;
    szDecimals: number;
}): Sizing | null {
    const { collateralE6, leverage, price, szDecimals } = o;
    const unit = 10n ** BigInt(szDecimals);
    const priceScaled = BigInt(Math.round(price * PRICE_SCALE));
    const feeScaled = BigInt(Math.round(o.feeRate * RATE_SCALE));
    const ourScaled = BigInt(Math.round(o.ourFeeRate * RATE_SCALE));
    const lev = BigInt(leverage);
    const notionalOf = (units: bigint) => (units * priceScaled * 1_000_000n) / (unit * BigInt(PRICE_SCALE));
    const costOf = (notional: bigint) => ({
        marginE6: ceilDiv(notional, lev),
        entryFeeE6: ceilDiv(notional * feeScaled, BigInt(RATE_SCALE)),
        ourFeeE6: ceilDiv(notional * ourScaled, BigInt(RATE_SCALE)),
    });

    const notionalUSD = ((Number(collateralE6) / 1e6) * leverage) / (1 + leverage * (o.feeRate + o.ourFeeRate));
    let units = BigInt(Math.floor((notionalUSD / price) * Number(unit)));
    for (;;) {
        if (units <= 0n) return null;
        const notionalE6 = notionalOf(units);
        const cost = costOf(notionalE6);
        if (cost.marginE6 + cost.entryFeeE6 + cost.ourFeeE6 <= collateralE6) {
            return { sizeCoin: stripZeros((Number(units) / Number(unit)).toFixed(szDecimals)), notionalE6, ...cost };
        }
        units -= 1n;
    }
}

/** The leverage a position may use: the smallest of the asset's cap, the tier at its size and the configured cap. */
export function leverageBound(o: {
    maxLeverage: number;
    marginTables: Array<{ lowerBound: string; maxLeverage: number }>;
    notionalUSD: number;
    configMax: number;
}): number {
    let tier = Infinity;
    let reached = -Infinity;
    for (const row of o.marginTables) {
        const lower = Number(row.lowerBound);
        if (lower <= o.notionalUSD && lower >= reached) {
            reached = lower;
            tier = row.maxLeverage;
        }
    }
    return Math.min(o.maxLeverage, tier, o.configMax);
}

/** About where an isolated position liquidates, before funding; mmr is half the initial margin rate at max leverage. */
export function liquidationPrice(o: {
    side: "long" | "short";
    entry: number;
    sizeCoin: number;
    marginUSD: number;
    notionalUSD: number;
    maxLeverage: number;
}): number {
    const s = o.side === "long" ? 1 : -1;
    const mmr = 1 / (2 * o.maxLeverage);
    return o.entry - (s * (o.marginUSD - mmr * o.notionalUSD)) / o.sizeCoin / (1 - s * mmr);
}

/** Which minimum a position misses: collateral under $10, or collateral x leverage under $11. */
export function meetsMinimum(collateralUSD: number, leverage: number): "collateral" | "position" | null {
    if (collateralUSD < 10) return "collateral";
    if (collateralUSD * leverage < 11) return "position";
    return null;
}
