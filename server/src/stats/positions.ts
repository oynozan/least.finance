import { Decimal128, type ObjectId } from "mongodb";
import type { Collections, PerpPositionState, PositionState } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { StatsPositionRow, StatsPositionsPage } from "../protocol.ts";
import { formatUnits18, fromUnitsDecimal } from "../trading/units.ts";
import { usdFromE6, usdFromUnits, usdFromWei, usdString } from "./units.ts";

export const STATS_PAGE_SIZE = 20;
export const STATS_MAX_PAGE = 500;

type Deps = {
    collections: Collections;
    /** The best bid (0 to 1) for an outcome token; null on any failure. */
    outcomeBid: (eventId: string, tokenId: string) => Promise<number | null>;
    priceOf: (symbol: string) => number | null;
};
type Ask = {
    page: number;
    state: "all" | "open" | "closed";
    kind: "all" | "predictions" | "perps" | "coins";
};

type Entry = { openedAt: Date; id: ObjectId; row: () => Promise<StatsPositionRow> };

const PREDICTION_OPEN: PositionState[] = ["open", "closing"];
const PREDICTION_CLOSED: PositionState[] = ["closed", "won", "lost"];
const PERP_CLOSED: PerpPositionState[] = ["closed", "liquidated"];
const SORT = { openedAt: -1, _id: -1 } as const;

/** The last 6 hex of an account id; never anything that names a person. */
const accountCode = (id: ObjectId) => id.toHexString().slice(-6);
const money = (usd: number | null) => (usd === null ? null : usdString(usd));
const e6Text = (e6: bigint) => formatUnits18(e6 * 10n ** 12n);

/** One page of every position, newest first: the top `page × 20` of each filtered source, merged and sliced. */
export async function positionsPage(deps: Deps, ask: Ask): Promise<StatsPositionsPage> {
    const { collections } = deps;
    const want = (kind: Ask["kind"]) => ask.kind === "all" || ask.kind === kind;
    const take = ask.page * STATS_PAGE_SIZE;
    const entries: Entry[] = [];
    let total = 0;

    if (want("predictions")) {
        const filter =
            ask.state === "all" ? {} : { state: { $in: ask.state === "open" ? PREDICTION_OPEN : PREDICTION_CLOSED } };
        total += await collections.positions.countDocuments(filter);
        for (const doc of await collections.positions.find(filter).sort(SORT).limit(take).toArray()) {
            entries.push({
                openedAt: doc.openedAt,
                id: doc._id,
                row: async () => {
                    const cost = usdFromWei(fromDecimal(doc.cost));
                    const isOpen = PREDICTION_OPEN.includes(doc.state);
                    const shares = fromDecimal(doc.shares);
                    let value: number | null = null;
                    if (isOpen) {
                        const bid = await deps.outcomeBid(doc.eventId, doc.tokenId).catch(() => null);
                        value = bid === null ? null : usdFromE6(shares) * bid;
                    } else if (doc.state === "won") {
                        value = doc.payout ? usdFromWei(fromDecimal(doc.payout)) : null;
                    } else if (doc.state === "lost") {
                        value = 0;
                    } else {
                        value = doc.proceeds ? usdFromWei(fromDecimal(doc.proceeds)) : null;
                    }
                    return {
                        id: doc._id.toHexString(),
                        kind: "prediction",
                        account: accountCode(doc.accountId),
                        title: doc.outcome,
                        detail: doc.question,
                        size: `${e6Text(shares)} shares`,
                        valueUsd: money(value),
                        pnlUsd: money(value === null ? null : value - cost),
                        state: doc.state,
                        openedAt: doc.openedAt.toISOString(),
                        closedAt: doc.settledAt?.toISOString() ?? null,
                    };
                },
            });
        }
    }

    if (want("perps")) {
        const filter =
            ask.state === "all" ? {} : ask.state === "open" ? { active: true } : { state: { $in: PERP_CLOSED } };
        total += await collections.perpPositions.countDocuments(filter);
        for (const doc of await collections.perpPositions.find(filter).sort(SORT).limit(take).toArray()) {
            entries.push({
                openedAt: doc.openedAt,
                id: doc._id,
                row: async () => {
                    const collateral = fromDecimal(doc.collateral);
                    let value: number | null = null;
                    let pnl: number | null = null;
                    if (doc.active) {
                        if (doc.snapshot) {
                            pnl = usdFromE6(fromDecimal(doc.snapshot.unrealizedPnlE6));
                            value = usdFromWei(collateral) + pnl;
                        }
                    } else if (doc.proceeds) {
                        const proceeds = fromDecimal(doc.proceeds);
                        value = usdFromWei(proceeds);
                        pnl = usdFromWei(proceeds - collateral);
                    }
                    return {
                        id: doc._id.toHexString(),
                        kind: "perp",
                        account: accountCode(doc.accountId),
                        title: `${doc.asset} ${doc.side} ${doc.leverage}x`,
                        detail: "",
                        size: `${doc.sizeCoin} ${doc.asset}`,
                        valueUsd: money(value),
                        pnlUsd: money(pnl),
                        state: doc.state,
                        openedAt: doc.openedAt.toISOString(),
                        closedAt: doc.settledAt?.toISOString() ?? null,
                    };
                },
            });
        }
    }

    // Coins are always open, so a closed filter has none.
    if (want("coins") && ask.state !== "closed") {
        const filter = { units: { $gt: Decimal128.fromString("0") } };
        total += await collections.holdings.countDocuments(filter);
        for (const doc of await collections.holdings
            .find(filter)
            .sort({ updatedAt: -1, _id: -1 })
            .limit(take)
            .toArray()) {
            entries.push({
                openedAt: doc.updatedAt,
                id: doc._id,
                row: async () => {
                    const units = fromUnitsDecimal(doc.units);
                    const price = deps.priceOf(doc.symbol);
                    return {
                        id: doc._id.toHexString(),
                        kind: "coin",
                        account: accountCode(doc.accountId),
                        title: doc.symbol,
                        detail: "",
                        size: `${formatUnits18(units)} ${doc.symbol}`,
                        valueUsd: money(price === null ? null : usdFromUnits(units) * price),
                        pnlUsd: null,
                        state: "open",
                        openedAt: doc.updatedAt.toISOString(),
                        closedAt: null,
                    };
                },
            });
        }
    }

    entries.sort(
        (a, b) => b.openedAt.getTime() - a.openedAt.getTime() || (a.id.toHexString() < b.id.toHexString() ? 1 : -1),
    );
    const slice = entries.slice(take - STATS_PAGE_SIZE, take);
    return {
        items: await Promise.all(slice.map((entry) => entry.row())),
        page: ask.page,
        pages: Math.max(1, Math.ceil(total / STATS_PAGE_SIZE)),
        total,
    };
}
