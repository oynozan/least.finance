import type { Collections } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import { fromUnitsDecimal } from "../trading/units.ts";
import { usdFromE6, usdFromUnits } from "./units.ts";

type Fees = { totalUsd: number; spreadUsd: number; perpUsd: number };
const DAY = 86_400_000;

/** Fee gain over 7D, 30D and all time: trade spreads by fill time and our perp fees by open time. */
export async function readFees({
    collections,
    now,
}: {
    collections: Collections;
    now: number;
}): Promise<Record<"7D" | "30D" | "All", Fees>> {
    const starts = { "7D": now - 7 * DAY, "30D": now - 30 * DAY, All: -Infinity };
    const spread = { "7D": 0n, "30D": 0n, All: 0n };
    const perp = { "7D": 0n, "30D": 0n, All: 0n };

    for await (const trade of collections.trades.find(
        { spreadUSD: { $exists: true } },
        { projection: { _id: 0, spreadUSD: 1, createdAt: 1 } },
    )) {
        if (!trade.spreadUSD) continue;
        const value = fromUnitsDecimal(trade.spreadUSD);
        const at = trade.createdAt.getTime();
        for (const range of ["7D", "30D", "All"] as const) if (at >= starts[range]) spread[range] += value;
    }
    for await (const position of collections.perpPositions.find(
        { ourFee: { $exists: true } },
        { projection: { _id: 0, ourFee: 1, openedAt: 1 } },
    )) {
        if (!position.ourFee) continue;
        const value = fromDecimal(position.ourFee);
        const at = position.openedAt.getTime();
        for (const range of ["7D", "30D", "All"] as const) if (at >= starts[range]) perp[range] += value;
    }

    const fees = (range: "7D" | "30D" | "All"): Fees => {
        const spreadUsd = usdFromUnits(spread[range]);
        const perpUsd = usdFromE6(perp[range]);
        return { totalUsd: Math.round((spreadUsd + perpUsd) * 1e9) / 1e9, spreadUsd, perpUsd };
    };
    return { "7D": fees("7D"), "30D": fees("30D"), All: fees("All") };
}
