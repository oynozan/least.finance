import type { Book, Level, MarketMeta } from "./trader.ts";

type FeeMeta = Pick<MarketMeta, "feeRate" | "feeExponent">;

const E6 = 1_000_000n;
const SLIPPAGE_E6 = 20_000n;

const scaled = (x: number): bigint => BigInt(Math.round(x * 1e6));
const sharesOf = (l: Level): bigint => scaled(l.size);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function feeE6(sharesE6: bigint, price: number, meta: FeeMeta): bigint {
    if (meta.feeRate <= 0 || sharesE6 <= 0n) return 0n;
    if (meta.feeExponent === 1) {
        const p = scaled(price);
        return ceilDiv(sharesE6 * scaled(meta.feeRate) * p * (E6 - p), E6 * E6 * E6);
    }
    const fee = Number(sharesE6) * meta.feeRate * (price * (1 - price)) ** meta.feeExponent;
    return BigInt(Math.ceil(fee - 1e-6));
}

const costE6 = (sharesE6: bigint, priceE6: bigint): bigint => ceilDiv(sharesE6 * priceE6, E6);

export function quoteBuy(
    book: Book,
    meta: FeeMeta,
    spendE6: bigint,
): { sharesE6: bigint; costE6: bigint; feeE6: bigint; avgPrice: number; worstPrice: number } | null {
    let remaining = spendE6;
    let shares = 0n;
    let cost = 0n;
    let fee = 0n;
    let worst = 0;
    for (const level of book.asks) {
        if (remaining <= 1n) break;
        const priceE6 = scaled(level.price);
        if (priceE6 <= 0n) continue;
        const perShare = level.price + meta.feeRate * (level.price * (1 - level.price)) ** meta.feeExponent;
        let take = BigInt(Math.floor(Number(remaining) / perShare));
        const size = sharesOf(level);
        if (take > size) take = size;
        const all = (n: bigint) => costE6(n, priceE6) + feeE6(n, level.price, meta);
        while (take > 0n && all(take) > remaining) take -= 1n;
        if (take <= 0n) continue;
        const c = costE6(take, priceE6);
        const f = feeE6(take, level.price, meta);
        shares += take;
        cost += c;
        fee += f;
        remaining -= c + f;
        worst = level.price;
    }
    if (shares <= 0n || remaining > 1n) return null;
    return { sharesE6: shares, costE6: cost, feeE6: fee, avgPrice: Number(cost) / Number(shares), worstPrice: worst };
}

export function quoteSell(
    book: Book,
    meta: FeeMeta,
    sharesE6: bigint,
): { proceedsE6: bigint; feeE6: bigint; avgPrice: number; worstPrice: number } | null {
    let remaining = sharesE6;
    let gross = 0n;
    let fee = 0n;
    let worst = 0;
    for (const level of book.bids) {
        if (remaining <= 0n) break;
        const take = remaining < sharesOf(level) ? remaining : sharesOf(level);
        if (take <= 0n) continue;
        gross += (take * scaled(level.price)) / E6;
        fee += feeE6(take, level.price, meta);
        remaining -= take;
        worst = level.price;
    }
    if (remaining > 0n || sharesE6 <= 0n) return null;
    return {
        proceedsE6: gross - fee,
        feeE6: fee,
        avgPrice: Number(gross) / Number(sharesE6),
        worstPrice: worst,
    };
}

export function limitBuyPrice(quotedPrice: number, tickSize: number): number {
    const tick = scaled(tickSize);
    const up = ceilDiv(scaled(quotedPrice) + SLIPPAGE_E6, tick) * tick;
    const max = E6 - tick;
    return Number(up > max ? max : up) / 1e6;
}

export function limitSellPrice(quotedPrice: number, tickSize: number): number {
    const tick = scaled(tickSize);
    const raw = scaled(quotedPrice) - SLIPPAGE_E6;
    const down = raw <= 0n ? 0n : (raw / tick) * tick;
    return Number(down < tick ? tick : down) / 1e6;
}

export function costOfFill(makingE6: bigint, takingE6: bigint, meta: FeeMeta): bigint {
    if (takingE6 <= 0n) return makingE6;
    return makingE6 + feeE6(takingE6, Number(makingE6) / Number(takingE6), meta);
}
