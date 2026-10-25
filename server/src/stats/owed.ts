import type { Decimal128 } from "mongodb";
import type { Collections } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import { fromUnitsDecimal } from "../trading/units.ts";
import { usdFromE6, usdFromUnits, usdFromWei } from "./units.ts";

export type OwedLine = {
    id: "cash" | "coins" | "withdrawals" | "coinWithdrawals" | "predictionBuys" | "perpFloatHeld";
    label: string;
    usd: number;
};

type Deps = { collections: Collections; priceOf: (symbol: string) => number | null };

/** Everything we owe people, one line per kind; a coin with no price counts 0 and is named in `unpriced`. */
export async function readOwed({ collections, priceOf }: Deps): Promise<{ lines: OwedLine[]; unpriced: string[] }> {
    const unpriced = new Set<string>();

    // Units add up per symbol in bigint, then each symbol is priced once.
    const coinsUsd = async (rows: AsyncIterable<{ symbol: string; units: Decimal128 }>) => {
        const bySymbol = new Map<string, bigint>();
        for await (const row of rows) {
            bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0n) + fromUnitsDecimal(row.units));
        }
        let total = 0;
        for (const [symbol, units] of bySymbol) {
            const price = priceOf(symbol);
            if (price === null) {
                if (units > 0n) unpriced.add(symbol);
                continue;
            }
            total += usdFromUnits(units) * price;
        }
        return total;
    };
    const weiUsd = async (rows: AsyncIterable<{ amount: Decimal128 }>) => {
        let total = 0n;
        for await (const row of rows) total += fromDecimal(row.amount);
        return usdFromWei(total);
    };

    const cash = await weiUsd(
        (async function* () {
            for await (const row of collections.accounts.find({}, { projection: { _id: 0, balance: 1 } })) {
                yield { amount: row.balance };
            }
        })(),
    );
    const coins = await coinsUsd(collections.holdings.find({}, { projection: { _id: 0, symbol: 1, units: 1 } }));
    const withdrawals = await weiUsd(
        collections.withdrawals.find({ state: "sending" }, { projection: { _id: 0, amount: 1 } }),
    );
    const coinWithdrawals = await coinsUsd(
        collections.coinWithdrawals.find({ state: "sending" }, { projection: { _id: 0, symbol: 1, units: 1 } }),
    );
    const predictionBuys = await weiUsd(
        collections.predictionOrders.find(
            { side: "buy", state: { $in: ["placing", "posted"] } },
            { projection: { _id: 0, amount: 1 } },
        ),
    );
    const float = await collections.perpFloat.findOne({ _id: "hyperliquid" });
    const perpFloatHeld = float ? usdFromE6(fromDecimal(float.heldE6)) : 0;

    return {
        lines: [
            { id: "cash", label: "People's cash", usd: cash },
            { id: "coins", label: "People's coins", usd: coins },
            { id: "withdrawals", label: "Withdrawals sending", usd: withdrawals },
            { id: "coinWithdrawals", label: "Coin withdrawals sending", usd: coinWithdrawals },
            { id: "predictionBuys", label: "Prediction buys waiting", usd: predictionBuys },
            { id: "perpFloatHeld", label: "Perp float held", usd: perpFloatHeld },
        ],
        unpriced: [...unpriced].sort(),
    };
}
