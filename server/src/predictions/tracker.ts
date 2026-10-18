import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections, PredictionOrderDoc } from "../db/mongo.ts";
import { cancelled, isUpstreamFailure, unconfirmed } from "./failures.ts";
import { HourlyLog } from "./rebalance-log.ts";
import type { PredictionService } from "./predictions.ts";
import type { PoolTrader } from "./trader.ts";

/** A post that never shows up at the exchange this long after it was sent didn't land. */
const MISSING_GIVE_UP_MS = 120_000;
/** A placing order older than this that nothing here is sending never reached the exchange. */
const PLACING_GIVE_UP_MS = 60_000;
/** An unknown post is held this long before any refund, longer than any proxy or SDK retry. */
const UNKNOWN_QUARANTINE_MS = 900_000;
/** How long a refunded unknown post is still checked for a fill that lands late. */
const LATE_WATCH_MS = 86_400_000;
/** Orders followed at once in a pass. */
const CONCURRENCY = 4;
const SLOW_AGE_MS = 600_000;
const SLOW_POLL_MS = 60_000;
const FLOAT_MS = 60_000;

type Deps = {
    collections: Collections;
    service: PredictionService;
    trader: () => PoolTrader | null;
    logger: Logger;
    pollMs: number;
    /** The clock, for tests. */
    now?: () => number;
};

/** Follows each posted prediction order the exchange hasn't answered, and settles it when it does. */
export class PredictionTracker {
    readonly #deps: Deps;
    readonly #now: () => number;
    /** When each posted order was last looked up. */
    readonly #polled = new Map<string, number>();
    /** When each refunded order was last checked for a late fill. */
    readonly #watched = new Map<string, number>();
    #floatAt = -Infinity;
    /** A follow that keeps failing repeats every poll, so each order's line is logged once an hour. */
    readonly #hourly: HourlyLog;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#hourly = new HourlyLog(deps.logger, this.#now);
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    async #run(signal: AbortSignal) {
        // The float refresh runs on its own so a slow pass can't starve it
        const float = (async () => {
            while (!signal.aborted) {
                await this.#refreshFloat();
                await sleep(Math.max(this.#deps.pollMs, 1000), undefined, { signal }).catch(() => undefined);
            }
        })();
        while (!signal.aborted) {
            try {
                await this.tick(signal);
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Prediction tracking pass failed");
            }
            await sleep(this.#deps.pollMs, undefined, { signal }).catch(() => undefined);
        }
        await float;
    }

    async #refreshFloat() {
        const now = this.#now();
        if (now - this.#floatAt < FLOAT_MS) return;
        this.#floatAt = now;
        await this.#deps.service
            .refreshFloat()
            // refreshFloat logs its own failure
            .catch(() => undefined);
    }

    /** One pass over the posted orders that are due, then the refunded ones still watched; an error on one leaves it as it was, and an aborted signal skips the orders not yet started. */
    async tick(signal?: AbortSignal): Promise<void> {
        const now = this.#now();
        await this.#sweepPlacing(now);
        const trader = this.#deps.trader();
        if (!trader) return;
        const { predictionOrders } = this.#deps.collections;
        const orders = await predictionOrders.find({ state: "posted" }).toArray();
        const ids = new Set(orders.map((order) => order._id.toHexString()));
        for (const id of this.#polled.keys()) if (!ids.has(id)) this.#polled.delete(id);

        for (const order of orders) {
            const ageMs = now - order.createdAt.getTime();
            if (ageMs > SLOW_AGE_MS)
                this.#hourly.once(
                    `slow:${order._id.toHexString()}`,
                    "error",
                    {
                        ...this.#deps.service.context(order),
                        state: order.state,
                        clobOrderId: order.clobOrderId,
                        orderHash: order.orderHash,
                        ageSec: Math.round(ageMs / 1000),
                        needsReview: Boolean(order.needsReviewAt),
                    },
                    "A posted prediction is still unanswered",
                );
        }
        const due = orders.filter((order) => {
            const id = order._id.toHexString();
            if (this.#deps.service.submitting(order._id)) return false;
            const wait = now - order.createdAt.getTime() > SLOW_AGE_MS ? SLOW_POLL_MS : this.#deps.pollMs;
            if (now - (this.#polled.get(id) ?? -Infinity) < wait) return false;
            this.#polled.set(id, now);
            return true;
        });
        await this.#each(due, signal, (order) => this.#step(trader, order), "Couldn't follow a prediction");

        const refunded = await predictionOrders
            .find({
                state: "failed",
                reason: "unavailable",
                watchUntil: { $gt: new Date(now) },
                lateFill: { $exists: false },
            })
            .toArray();
        const watching = new Set(refunded.map((order) => order._id.toHexString()));
        for (const id of this.#watched.keys()) if (!watching.has(id)) this.#watched.delete(id);
        const checks = refunded.filter((order) => {
            const id = order._id.toHexString();
            if (now - (this.#watched.get(id) ?? -Infinity) < Math.max(this.#deps.pollMs, SLOW_POLL_MS)) return false;
            this.#watched.set(id, now);
            return true;
        });
        await this.#each(checks, signal, (order) => this.#watch(trader, order), "Couldn't check a refunded prediction");
    }

    /** Runs `work` over the orders four at a time, logging a failure on one and skipping the rest once aborted. */
    async #each(
        orders: PredictionOrderDoc[],
        signal: AbortSignal | undefined,
        work: (order: PredictionOrderDoc) => Promise<void>,
        failure: string,
    ) {
        const queue = [...orders];
        const worker = async () => {
            for (let order = queue.shift(); order && !signal?.aborted; order = queue.shift()) {
                await work(order).catch((error: unknown) => {
                    const now = this.#now();
                    // An outage at Polymarket is expected; anything else is a bug that may be holding someone's money
                    const level = isUpstreamFailure(error) ? "warn" : "error";
                    this.#hourly.once(
                        `${failure}:${order._id.toHexString()}`,
                        level,
                        {
                            ...this.#deps.service.context(order),
                            event: "prediction:follow",
                            state: order.state,
                            clobOrderId: order.clobOrderId,
                            orderHash: order.orderHash,
                            ageSec: Math.round((now - order.createdAt.getTime()) / 1000),
                            err: error,
                        },
                        failure,
                    );
                });
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    }

    /** Refunds placing orders a failed submit left behind; no trader is needed, since they never left. */
    async #sweepPlacing(now: number) {
        const stale = await this.#deps.collections.predictionOrders
            .find({ state: "placing", createdAt: { $lt: new Date(now - PLACING_GIVE_UP_MS) } })
            .toArray();
        for (const order of stale) {
            if (this.#deps.service.submitting(order._id)) continue;
            await this.#deps.service
                .fail(
                    order,
                    "unavailable",
                    "placing",
                    undefined,
                    unconfirmed(
                        order,
                        "Refunded a prediction that never finished sending",
                        `it was still placing ${Math.round((now - order.createdAt.getTime()) / 1000)} s after it was made`,
                    ),
                )
                .catch((error: unknown) =>
                    this.#deps.logger.warn(
                        { err: error, order: order._id.toHexString() },
                        "Couldn't refund a prediction",
                    ),
                );
        }
    }

    #fail(order: PredictionOrderDoc, why: ReturnType<typeof cancelled>) {
        return this.#deps.service.fail(order, why.reason, "posted", undefined, why);
    }

    async #step(trader: PoolTrader, order: PredictionOrderDoc) {
        const found = await trader.lookup({
            orderHash: order.orderHash!,
            clobOrderId: order.clobOrderId,
            tokenId: order.tokenId,
        });
        if (found.kind === "filled") await this.#deps.service.settle(order, found.makingE6, found.takingE6);
        else if (found.kind === "cancelled")
            await this.#fail(order, cancelled(order, found.status, { limitPrice: order.limitPrice }));
        else if (found.kind === "missing") {
            if (order.postUnknownAt) await this.#unknown(trader, order, order.postUnknownAt);
            else if (this.#now() - (order.postedAt?.getTime() ?? 0) > MISSING_GIVE_UP_MS)
                await this.#deps.service.fail(
                    order,
                    "unavailable",
                    "posted",
                    undefined,
                    unconfirmed(
                        order,
                        "Refunded a prediction Polymarket has no record of",
                        `Polymarket had no record of the order ${Math.round(MISSING_GIVE_UP_MS / 1000)} s after it was posted`,
                        { ageSec: Math.round((this.#now() - (order.postedAt?.getTime() ?? 0)) / 1000) },
                    ),
                );
        }
    }

    /** Decides an unknown post the exchange has no order for: held for the quarantine, then settled, flagged or refunded by what the trades show. */
    async #unknown(trader: PoolTrader, order: PredictionOrderDoc, unknownAt: Date) {
        const now = this.#now();
        if (now - unknownAt.getTime() < UNKNOWN_QUARANTINE_MS || order.needsReviewAt) return;
        const found = await trader.findFill({
            orderHash: order.orderHash!,
            tokenId: order.tokenId,
            side: order.side,
            since: order.postedAt ?? unknownAt,
        });
        if (found === "unlinked") {
            const flagged = await this.#deps.collections.predictionOrders.updateOne(
                { _id: order._id, state: "posted", needsReviewAt: null },
                {
                    $set: {
                        needsReviewAt: new Date(now),
                        needsReviewReason: `the post got no answer for ${Math.round((now - unknownAt.getTime()) / 60_000)} minutes and the pool has trades that can't be linked to any order`,
                        updatedAt: new Date(now),
                    },
                },
            );
            if (flagged.modifiedCount)
                this.#deps.logger.error(
                    {
                        ...this.#deps.service.context(order),
                        orderHash: order.orderHash,
                        postedAt: order.postedAt,
                        quarantineSec: Math.round((now - unknownAt.getTime()) / 1000),
                    },
                    "A prediction's post got no answer and a trade can't be linked to it; it needs review and was not refunded",
                );
        } else if (found) await this.#deps.service.settle(order, found.makingE6, found.takingE6);
        else
            await this.#deps.service.fail(
                order,
                "unavailable",
                "posted",
                new Date(now + LATE_WATCH_MS),
                unconfirmed(
                    order,
                    "Refunded a prediction whose post got no answer and shows no trade",
                    "the post got no answer and the pool's trades show no fill for it",
                    { quarantineSec: Math.round((now - unknownAt.getTime()) / 1000) },
                ),
            );
    }

    /** Looks for a fill on a refunded unknown post and books it if one landed. */
    async #watch(trader: PoolTrader, order: PredictionOrderDoc) {
        const looked = await trader.lookup({
            orderHash: order.orderHash!,
            clobOrderId: order.clobOrderId,
            tokenId: order.tokenId,
        });
        if (looked.kind === "filled") return this.#deps.service.settleLate(order, looked.makingE6, looked.takingE6);
        const found = await trader.findFill({
            orderHash: order.orderHash!,
            tokenId: order.tokenId,
            side: order.side,
            since: order.postedAt ?? order.createdAt,
        });
        if (found && found !== "unlinked") await this.#deps.service.settleLate(order, found.makingE6, found.takingE6);
    }
}
