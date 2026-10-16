import type { Level } from "../predictions/trader.ts";

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

/** A price rounded up or down to Hyperliquid's tick rule, where roundPrice goes to the nearest tick. */
export function roundPriceTo(px: number, szDecimals: number, direction: "up" | "down"): string {
    let exponent = Math.floor(Math.log10(px));
    if (10 ** (exponent + 1) <= px) exponent += 1;
    else if (10 ** exponent > px) exponent -= 1;
    const step = 10 ** Math.max(exponent - (SIG_FIGS - 1), -(MAX_DECIMALS - szDecimals));
    // 12 figures drop the float noise of a price that sits on a tick, and keep any real fraction of one
    const ticks = Number((px / step).toPrecision(12));
    return roundPrice((direction === "up" ? Math.ceil(ticks) : Math.floor(ticks)) * step, szDecimals);
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

/** How far the book's mid may sit from the mark before the limit stops following it. */
const ANCHOR_BAND_BPS = 150;
export const OPEN_MIN_SLIPPAGE_BPS = 50;
export const CLOSE_MIN_SLIPPAGE_BPS = 100;
const OPEN_CUSHION_BPS = 25;
const CLOSE_CUSHION_BPS = 50;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** What a market order of `size` takes from `levels`, best first: the average price and the worst level it touches; null when the levels are too thin. */
export function walkBook(levels: Level[], size: number): { avg: number; worst: number } | null {
    let left = size;
    let cost = 0;
    for (const level of levels) {
        const take = Math.min(left, level.size);
        cost += take * level.price;
        left -= take;
        if (left <= 1e-12) return { avg: cost / size, worst: level.price };
    }
    return null;
}

/**
 * The worst price an IOC order accepts, from the book it will meet: the mid (held within 1.5% of the mark) moved by what this size
 * costs to walk plus a cushion for the book changing before it lands, never under `minBps` or over `maxBps`, and rounded away from the
 * anchor. A close cushions more, since a close that doesn't fill leaves the person stuck. `fillable` is whether the visible levels fill
 * the whole size within `maxBps`; `avgPx` is what walking them pays, null when they can't fill it.
 */
export function dynamicLimit(o: {
    bids: Level[];
    asks: Level[];
    mark: number;
    side: "long" | "short";
    action: "open" | "close";
    sizeCoin: number | string;
    szDecimals: number;
    minBps: number;
    maxBps: number;
    /** Replaces the least cushion, 25 bps on an open and 50 on a close. */
    cushionBps?: number;
}): { limitPx: string; distanceBps: number; avgPx: number | null; fillable: boolean } {
    const buying = (o.side === "long") === (o.action === "open");
    const bid = o.bids[0];
    const ask = o.asks[0];
    const mid = bid && ask ? (bid.price + ask.price) / 2 : o.mark;
    const anchor = clamp(mid, o.mark * (1 - ANCHOR_BAND_BPS / 10_000), o.mark * (1 + ANCHOR_BAND_BPS / 10_000));
    const spreadBps = bid && ask ? Math.max(0, ((ask.price - bid.price) / mid) * 10_000) : 0;
    const walked = walkBook(buying ? o.asks : o.bids, Number(o.sizeCoin));
    const impactBps = walked
        ? Math.max(0, ((buying ? walked.worst - anchor : anchor - walked.worst) / anchor) * 10_000)
        : 0;
    const opening = o.action === "open";
    const cushionBps = Math.max(
        o.cushionBps ?? (opening ? OPEN_CUSHION_BPS : CLOSE_CUSHION_BPS),
        spreadBps * (opening ? 1 : 2),
    );
    const distanceBps = walked ? clamp(impactBps + cushionBps, o.minBps, o.maxBps) : o.maxBps;
    const limit = anchor * (1 + (buying ? distanceBps : -distanceBps) / 10_000);
    return {
        limitPx: roundPriceTo(limit, o.szDecimals, buying ? "up" : "down"),
        distanceBps,
        avgPx: walked?.avg ?? null,
        fillable: walked !== null && impactBps <= o.maxBps,
    };
}

export type Sizing = {
    sizeCoin: string;
    notionalE6: bigint;
    marginE6: bigint;
    entryFeeE6: bigint;
    ourFeeE6: bigint;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The largest position whose margin plus both fees fit in the collateral, our flat fee coming off the collateral first; null when nothing is left to size or the size rounds to zero. */
export function sizeFor(o: {
    collateralE6: bigint;
    leverage: number;
    feeRate: number;
    ourFeeE6: bigint;
    price: number;
    szDecimals: number;
}): Sizing | null {
    const { collateralE6, leverage, price, szDecimals } = o;
    const unit = 10n ** BigInt(szDecimals);
    const priceScaled = BigInt(Math.round(price * PRICE_SCALE));
    const feeScaled = BigInt(Math.round(o.feeRate * RATE_SCALE));
    const lev = BigInt(leverage);
    const notionalOf = (units: bigint) => (units * priceScaled * 1_000_000n) / (unit * BigInt(PRICE_SCALE));
    const costOf = (notional: bigint) => ({
        marginE6: ceilDiv(notional, lev),
        entryFeeE6: ceilDiv(notional * feeScaled, BigInt(RATE_SCALE)),
        ourFeeE6: o.ourFeeE6,
    });

    const investE6 = collateralE6 - o.ourFeeE6;
    if (investE6 <= 0n) return null;
    const notionalUSD = ((Number(investE6) / 1e6) * leverage) / (1 + leverage * o.feeRate);
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

/** The least notional an open may be sized to: Hyperliquid refuses an order worth under $10 at its limit price, so a short at the worst slippage still has to clear it, with 0.1% to spare for price rounding. */
export function minOrderE6(slippageBps: number): bigint {
    return ceilDiv(10_000_000n * 10_000n * 1_001n, BigInt(10_000 - slippageBps) * 1_000n);
}

/** The least an opening order may be worth: Hyperliquid's $10 with a cent to spare for price rounding. */
const MIN_ORDER_VALUE_E6 = 10_010_000n;
const VALUE_DECIMALS = 10;

/** A plain decimal as an integer of its first ten decimals; a number goes through toFixed, a string is read as written. */
function scaled(value: string | number): bigint {
    const [whole = "0", fraction = ""] = (typeof value === "number" ? value.toFixed(VALUE_DECIMALS) : value).split(".");
    return BigInt(whole + fraction.padEnd(VALUE_DECIMALS, "0").slice(0, VALUE_DECIMALS));
}

/** What an order of `sizeCoin` is worth at `px`, in millionths of a dollar rounded down, from the decimals themselves. */
export function orderValueE6(sizeCoin: string | number, px: string | number): bigint {
    return (scaled(sizeCoin) * scaled(px)) / 10n ** BigInt(2 * VALUE_DECIMALS - 6);
}

/** Whether an order of `sizeCoin` at `px` is worth Hyperliquid's $10 minimum, with a cent to spare. */
export function worthMinimum(sizeCoin: string | number, px: string | number): boolean {
    return orderValueE6(sizeCoin, px) >= MIN_ORDER_VALUE_E6;
}

/** A limit raised to the first tick at which `sizeCoin` is worth the minimum; as given when it already is. */
export function raiseLimitToMinimum(limitPx: string, sizeCoin: string, szDecimals: number): string {
    if (worthMinimum(sizeCoin, limitPx)) return limitPx;
    return roundPriceTo(Number(MIN_ORDER_VALUE_E6) / 1e6 / Number(sizeCoin), szDecimals, "up");
}

/** Which minimum a position misses: collateral under $10, or what is left of it after our fee, times the leverage, under $11. */
export function meetsMinimum(
    collateralUSD: number,
    leverage: number,
    feeUSD: number,
): "collateral" | "position" | null {
    if (collateralUSD < 10) return "collateral";
    if ((collateralUSD - feeUSD) * leverage < 11) return "position";
    return null;
}
