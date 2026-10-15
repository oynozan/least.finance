import type { Logger } from "pino";
import type { Collections } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import { FLOAT_MAX_AGE_MS } from "./pool-plan.ts";
import { HourlyLog, rowFields } from "./rebalance-log.ts";
import type { PoolTrader } from "./trader.ts";

/** A forwarding row older than this is no longer money in flight. */
const IN_FLIGHT_MAX_MS = 3_600_000;

/** What the solvency check counts as the pool's, in E6; `stale` when part of it could not be read fresh. */
export type PoolAssets = { assetsE6: bigint; stale: boolean };

/** The pool's USDC in E6 for the solvency check: free float, idle wallet USDC, moves in flight (amount less the fee cap) and a drain's reservation. */
export function poolAssets(o: {
    collections: Collections;
    trader: () => PoolTrader | null;
    now?: () => number;
    logger: Logger;
}): () => Promise<PoolAssets> {
    const now = o.now ?? Date.now;
    const log = new HourlyLog(o.logger, now);
    return async () => {
        const at = now();
        const [float, rows] = await Promise.all([
            o.collections.poolFloat.findOne({ _id: "polygon" }),
            o.collections.poolRebalances
                .find({
                    kind: "move",
                    $or: [{ state: "forwarding" }, { state: "submitting", direction: "polygon_to_arc" }],
                })
                .toArray(),
        ]);

        let assetsE6 = 0n;
        let stale = false;
        if (float) {
            const free = fromDecimal(float.balanceE6) - fromDecimal(float.heldE6) - fromDecimal(float.unreadFillsE6);
            if (free > 0n) assetsE6 += free;
            stale = at - float.balanceAt.getTime() > FLOAT_MAX_AGE_MS;
        }

        for (const row of rows) {
            if (row.state === "submitting") {
                assetsE6 += fromDecimal(row.reservedE6);
            } else if (at - row.updatedAt.getTime() < IN_FLIGHT_MAX_MS) {
                const arriving = fromDecimal(row.amountE6) - fromDecimal(row.maxFeeE6);
                if (arriving > 0n) assetsE6 += arriving;
            } else {
                log.once(
                    `forwarding:${row._id}`,
                    "error",
                    rowFields(row),
                    "A pool move has been forwarding for over an hour, so it no longer counts as an asset",
                );
            }
        }

        const trader = o.trader();
        if (trader) {
            try {
                assetsE6 += await trader.usdcBalanceE6();
            } catch (error) {
                stale = true;
                o.logger.warn({ err: error }, "Couldn't read the pool wallet's USDC for the solvency check");
            }
        }
        return { assetsE6, stale };
    };
}
