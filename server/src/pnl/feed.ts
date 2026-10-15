import { ObjectId, type Document, type FindCursor } from "mongodb";
import type { Logger } from "pino";
import type { Collections, PositionState } from "../db/mongo.ts";
import { depositView } from "../deposits/views.ts";
import { AppError } from "../errors.ts";
import { perpPositionView } from "../perps/views.ts";
import { orderView, positionView } from "../predictions/views.ts";
import type { ActivityFilter, ActivityItem, ActivityPage } from "../protocol.ts";
import { swapOrderView } from "../swaps/views.ts";
import { tradeView } from "../trading/views.ts";
import { withdrawalView } from "../withdrawals/views.ts";

const DEFAULT_LIMIT = 50;
const MAX_DATE_MS = 8.64e15;
const CURSOR = /^(\d{1,16}):(\d):([0-9a-f]{24})$/;
const SETTLED: PositionState[] = ["closed", "won", "lost"];

/** What an item sorts by, newest first, being its time in ms, its source's rank and its document id as hex */
export type FeedKey = { atMs: number; rank: number; id: string };

type Ask = { collections: Collections; accountId: ObjectId; cursor: FeedKey | null; limit: number; now: number };
type Candidate = { key: FeedKey; item: ActivityItem };
type Source = {
    name: string;
    group: Exclude<ActivityFilter, "all">;
    read: (ask: Ask, rank: number) => Promise<Candidate[]>;
};

type Deps = {
    collections: Collections;
    logger: Logger;
    now?: () => number;
};

const badCursor = () => new AppError("bad_request", "Invalid before: a cursor from a previous page");

export const encodeCursor = (key: FeedKey) => `${key.atMs}:${key.rank}:${key.id}`;

export function decodeCursor(cursor: string): FeedKey {
    const match = CURSOR.exec(cursor);
    if (!match) throw badCursor();
    const [, time = "", rank = "", id = ""] = match;
    const key = { atMs: Number(time), rank: Number(rank), id };
    if (key.rank >= SOURCES.length || key.atMs > MAX_DATE_MS) throw badCursor();
    return key;
}

/** A negative result lists a before b, so sorting with it puts the newest key first */
export function compareKeys(a: FeedKey, b: FeedKey): number {
    if (a.atMs !== b.atMs) return b.atMs - a.atMs;
    if (a.rank !== b.rank) return b.rank - a.rank;
    return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

// A date match never takes a null, and with no cursor the field only has to be set
function after(field: string, rank: number, cursor: FeedKey | null): Document {
    if (!cursor) return { [field]: { $ne: null } };
    const at = new Date(cursor.atMs);
    if (rank > cursor.rank) return { [field]: { $lt: at } };
    if (rank < cursor.rank) return { [field]: { $lte: at } };
    return { $or: [{ [field]: { $lt: at } }, { [field]: at, _id: { $lt: new ObjectId(cursor.id) } }] };
}

// A source's next rows after the cursor, newest first, each with the key it sorts by
async function newest<T extends { _id: ObjectId }>(
    ask: Ask,
    rank: number,
    field: string,
    open: (bound: Document) => FindCursor<T>,
    at: (doc: T) => Date,
    item: (doc: T, at: string) => ActivityItem,
): Promise<Candidate[]> {
    const docs = await open(after(field, rank, ask.cursor))
        .sort({ [field]: -1, _id: -1 })
        .limit(ask.limit)
        .toArray();
    return docs.map((doc) => {
        const when = at(doc);
        return { key: { atMs: when.getTime(), rank, id: doc._id.toHexString() }, item: item(doc, when.toISOString()) };
    });
}

// The settled queries only return rows whose settledAt is a date
const settledAt = <T extends { settledAt: Date | null }>(doc: T) => doc.settledAt as Date;

/** The sources in rank order, so a source's rank is its index */
const SOURCES: Source[] = [
    {
        name: "deposits",
        group: "deposits",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "creditedAt",
                (bound) => ask.collections.deposits.find({ accountId: ask.accountId, ...bound }),
                (doc) => doc.creditedAt,
                (doc, at) => ({ kind: "deposit", at, deposit: depositView(doc) }),
            ),
    },
    {
        name: "withdrawals",
        group: "deposits",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "createdAt",
                (bound) =>
                    ask.collections.withdrawals.find({ accountId: ask.accountId, state: { $ne: "failed" }, ...bound }),
                (doc) => doc.createdAt,
                (doc, at) => ({ kind: "withdrawal", at, withdrawal: withdrawalView(doc, ask.now) }),
            ),
    },
    {
        name: "swaps",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "createdAt",
                (bound) =>
                    ask.collections.swapOrders.find({
                        accountId: ask.accountId,
                        "txHashes.0": { $exists: true },
                        ...bound,
                    }),
                (doc) => doc.createdAt,
                (doc, at) => ({ kind: "swap", at, order: swapOrderView(doc) }),
            ),
    },
    {
        name: "predictionOpens",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "openedAt",
                (bound) => ask.collections.positions.find({ accountId: ask.accountId, ...bound }),
                (doc) => doc.openedAt,
                (doc, at) => ({ kind: "prediction", at, part: "open", position: positionView(doc) }),
            ),
    },
    {
        name: "predictionSettles",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "settledAt",
                (bound) =>
                    ask.collections.positions.find({ accountId: ask.accountId, state: { $in: SETTLED }, ...bound }),
                settledAt,
                (doc, at) => ({ kind: "prediction", at, part: "settle", position: positionView(doc) }),
            ),
    },
    {
        name: "sales",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "soldPart.at",
                (bound) => ask.collections.predictionOrders.find({ accountId: ask.accountId, ...bound }),
                (doc) => doc.soldPart?.at as Date,
                (doc, at) => ({ kind: "sale", at, order: orderView(doc) }),
            ),
    },
    {
        name: "perpOpens",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "openedAt",
                (bound) => ask.collections.perpPositions.find({ accountId: ask.accountId, ...bound }),
                (doc) => doc.openedAt,
                (doc, at) => ({ kind: "perp", at, part: "open", position: perpPositionView(doc) }),
            ),
    },
    {
        name: "perpSettles",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "settledAt",
                (bound) => ask.collections.perpPositions.find({ accountId: ask.accountId, ...bound }),
                settledAt,
                (doc, at) => ({ kind: "perp", at, part: "settle", position: perpPositionView(doc) }),
            ),
    },
    {
        name: "trades",
        group: "trades",
        read: (ask, rank) =>
            newest(
                ask,
                rank,
                "createdAt",
                (bound) => ask.collections.trades.find({ accountId: ask.accountId, ...bound }),
                (doc) => doc.createdAt,
                (doc, at) => ({ kind: "trade", at, trade: tradeView(doc) }),
            ),
    },
];

/** An account's whole history as one list, newest first, paged by a cursor over (time, source rank, id) */
export class ActivityFeed {
    readonly #collections: Collections;
    readonly #logger: Logger;
    readonly #now: () => number;

    constructor(deps: Deps) {
        this.#collections = deps.collections;
        this.#logger = deps.logger;
        this.#now = deps.now ?? Date.now;
    }

    /** The next `limit` items after `before`, where each source is asked for one row more than the page can take */
    async page(
        accountId: ObjectId,
        input: { before?: string; limit?: number; filter?: ActivityFilter },
    ): Promise<ActivityPage> {
        const started = performance.now();
        const limit = input.limit ?? DEFAULT_LIMIT;
        const filter = input.filter ?? "all";
        const cursor = input.before === undefined ? null : decodeCursor(input.before);
        const ask: Ask = { collections: this.#collections, accountId, cursor, limit: limit + 1, now: this.#now() };

        const found = await Promise.all(
            SOURCES.map(async (source, rank) => ({
                name: source.name,
                read: filter !== "all" && source.group !== filter ? [] : await source.read(ask, rank),
            })),
        );
        const rows = Object.fromEntries(found.map(({ name, read }) => [name, read.length]));

        const merged = found.flatMap(({ read }) => read).sort((a, b) => compareKeys(a.key, b.key));
        const last = merged[limit - 1];
        const page: ActivityPage = {
            items: merged.slice(0, limit).map((candidate) => candidate.item),
            next: last && merged.length > limit ? encodeCursor(last.key) : null,
        };
        this.#logger.info(
            { accountId: accountId.toHexString(), ms: Math.round(performance.now() - started), rows },
            "pnl.feed",
        );
        return page;
    }
}
