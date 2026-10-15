import type { TradeDoc } from "../trading/docs.ts";
import { fromUnitsDecimal } from "../trading/units.ts";

export type BasisTrade = Pick<
    TradeDoc,
    "_id" | "verb" | "paidSymbol" | "paidUnits" | "gotSymbol" | "gotUnits" | "usd" | "createdAt"
>;

/** The fields of a trade the average cost is built from */
export const BASIS_FIELDS = {
    _id: 1,
    verb: 1,
    paidSymbol: 1,
    paidUnits: 1,
    gotSymbol: 1,
    gotUnits: 1,
    usd: 1,
    createdAt: 1,
};

/** What an account holds of one coin, with the dollars (in wei) it paid for it */
type Lot = { units: bigint; cost: bigint };

const inTimeOrder = (a: BasisTrade, b: BasisTrade) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a._id.toHexString() < b._id.toHexString() ? -1 : 1);

/** The realized PnL in wei of each sell and swap, by trade id, from an average cost per coin built over the trades in time order */
export function realizedByTrade(trades: readonly BasisTrade[]): Map<string, bigint> {
    const lots = new Map<string, Lot>();
    const realized = new Map<string, bigint>();
    const lotOf = (symbol: string): Lot => {
        const lot = lots.get(symbol) ?? { units: 0n, cost: 0n };
        lots.set(symbol, lot);
        return lot;
    };

    // The cost of selling `units` of a coin at the lot's average, taken off the lot
    const release = (symbol: string, units: bigint): bigint => {
        const lot = lotOf(symbol);
        const taken = units < lot.units ? units : lot.units;
        const cost = lot.units === 0n ? 0n : (lot.cost * taken) / lot.units;
        lot.units -= taken;
        lot.cost -= cost;
        return cost;
    };

    for (const trade of [...trades].sort(inTimeOrder)) {
        const paid = fromUnitsDecimal(trade.paidUnits);
        const got = fromUnitsDecimal(trade.gotUnits);
        if (trade.verb === "buy") {
            const lot = lotOf(trade.gotSymbol);
            lot.units += got;
            lot.cost += paid;
        } else if (trade.verb === "sell") {
            realized.set(trade._id.toHexString(), got - release(trade.paidSymbol, paid));
        } else {
            const usd = fromUnitsDecimal(trade.usd);
            realized.set(trade._id.toHexString(), usd - release(trade.paidSymbol, paid));
            const lot = lotOf(trade.gotSymbol);
            lot.units += got;
            lot.cost += usd;
        }
    }
    return realized;
}
