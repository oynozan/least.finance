import type { Decimal128, FindCursor, ObjectId } from "mongodb";
import type { Logger } from "pino";
import type {
    Collections,
    DepositDoc,
    PerpPositionDoc,
    PositionDoc,
    PredictionOrderDoc,
    WithdrawalDoc,
} from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { PnlSeries } from "../protocol.ts";
import { BASIS_FIELDS, realizedByTrade, type BasisTrade } from "./basis.ts";
import { buildRanges, type DayTotals } from "./series.ts";
import { zoneOf } from "./zones.ts";

type Deps = {
    collections: Collections;
    logger: Logger;
    now?: () => number;
};

type PositionRow = Pick<PositionDoc, "state" | "cost" | "proceeds" | "payout" | "settledAt" | "updatedAt">;
type PerpRow = Pick<PerpPositionDoc, "collateral" | "proceeds" | "settledAt" | "updatedAt">;

// Async, so a find that throws before it returns a cursor rejects like one that fails later
/** A read slower than this is worth a warning; faster ones are only visible at debug level. */
const SLOW_READ_MS = 1000;

const read = async <T extends object>(open: () => FindCursor<T>): Promise<T[]> => open().toArray();

// A missing proceeds or payout is nothing paid
const wei = (value: Decimal128 | null | undefined) => (value ? fromDecimal(value) : 0n);

function positionPnl(row: PositionRow): bigint {
    const cost = fromDecimal(row.cost);
    if (row.state === "lost") return -cost;
    return wei(row.state === "won" ? row.payout : row.proceeds) - cost;
}

/** An account's balance history by local day, read from the entity collections */
export class PnlService {
    readonly #collections: Collections;
    readonly #logger: Logger;
    readonly #now: () => number;
    readonly #running = new Map<string, Promise<PnlSeries>>();

    constructor(deps: Deps) {
        this.#collections = deps.collections;
        this.#logger = deps.logger;
        this.#now = deps.now ?? Date.now;
    }

    /** The 7D, 30D and All ranges, where overlapping identical requests share one run and nothing is kept after it */
    series(accountId: ObjectId, tz: string, now: number = this.#now()): Promise<PnlSeries> {
        const key = `${accountId.toHexString()}:${tz}`;
        const running = this.#running.get(key);
        if (running) return running;
        const run = this.#run(accountId, tz, now).finally(() => this.#running.delete(key));
        this.#running.set(key, run);
        return run;
    }

    async #run(accountId: ObjectId, tz: string, now: number): Promise<PnlSeries> {
        const started = performance.now();
        const { deposits, withdrawals, positions, predictionOrders, perpPositions, trades } = this.#collections;
        const [depositRows, withdrawalRows, positionRows, saleRows, perpRows, tradeRows] = await Promise.all([
            read(() =>
                deposits
                    .find({ accountId })
                    .project<Pick<DepositDoc, "amount" | "creditedAt">>({ _id: 0, amount: 1, creditedAt: 1 }),
            ),
            read(() =>
                withdrawals
                    .find({ accountId, state: { $ne: "failed" } })
                    .project<Pick<WithdrawalDoc, "amount" | "createdAt">>({ _id: 0, amount: 1, createdAt: 1 }),
            ),
            read(() =>
                positions.find({ accountId, state: { $in: ["closed", "won", "lost"] } }).project<PositionRow>({
                    _id: 0,
                    state: 1,
                    cost: 1,
                    proceeds: 1,
                    payout: 1,
                    settledAt: 1,
                    updatedAt: 1,
                }),
            ),
            read(() =>
                predictionOrders
                    .find({ accountId, soldPart: { $exists: true } })
                    .project<Pick<PredictionOrderDoc, "soldPart">>({ _id: 0, soldPart: 1 }),
            ),
            read(() =>
                perpPositions
                    .find({ accountId, state: { $in: ["closed", "liquidated"] } })
                    .project<PerpRow>({ _id: 0, collateral: 1, proceeds: 1, settledAt: 1, updatedAt: 1 }),
            ),
            read(() => trades.find({ accountId }).project<BasisTrade>(BASIS_FIELDS)),
        ]);

        const zone = zoneOf(tz);
        const days = new Map<string, DayTotals>();
        // Every event gets a key, even one that sums to nothing, because the earliest key starts All
        const add = (at: Date, net: bigint, pnl: bigint) => {
            const date = zone.dateOf(at.getTime());
            const sum = days.get(date);
            days.set(date, { net: (sum?.net ?? 0n) + net, pnl: (sum?.pnl ?? 0n) + pnl });
        };
        for (const row of depositRows) add(row.creditedAt, fromDecimal(row.amount), 0n);
        for (const row of withdrawalRows) add(row.createdAt, -fromDecimal(row.amount), 0n);
        for (const row of positionRows) add(row.settledAt ?? row.updatedAt, 0n, positionPnl(row));
        for (const { soldPart } of saleRows) {
            if (soldPart) add(soldPart.at, 0n, fromDecimal(soldPart.proceeds) - fromDecimal(soldPart.cost));
        }
        for (const row of perpRows)
            add(row.settledAt ?? row.updatedAt, 0n, wei(row.proceeds) - fromDecimal(row.collateral));
        // A buy moves cash into a holding at cost, so only a sell or swap adds to the balance, by its realized PnL
        const realized = realizedByTrade(tradeRows);
        for (const row of tradeRows) add(row.createdAt, 0n, realized.get(row._id.toHexString()) ?? 0n);

        const series: PnlSeries = { tz: zone.tz, ranges: buildRanges(days, zone.dateOf(now)) };
        const ms = Math.round(performance.now() - started);
        this.#logger[ms > SLOW_READ_MS ? "warn" : "debug"](
            {
                accountId: accountId.toHexString(),
                ms,
                rows: {
                    deposits: depositRows.length,
                    withdrawals: withdrawalRows.length,
                    positions: positionRows.length,
                    sales: saleRows.length,
                    perps: perpRows.length,
                },
            },
            "pnl.series",
        );
        return series;
    }
}
