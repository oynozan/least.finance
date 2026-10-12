import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections, PredictionOrderDoc } from "../db/mongo.ts";
import type { PredictionService } from "./predictions.ts";
import type { PoolTrader } from "./trader.ts";

/** A post that never shows up at the exchange this long after it was sent didn't land. */
const MISSING_GIVE_UP_MS = 120_000;
/** A placing order older than this that nothing here is sending never reached the exchange. */
const PLACING_GIVE_UP_MS = 60_000;
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
    #floatAt = -Infinity;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
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
        while (!signal.aborted) {
            try {
                await this.tick();
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Prediction tracking pass failed");
            }
            await this.#refreshFloat();
            await sleep(this.#deps.pollMs, undefined, { signal }).catch(() => undefined);
        }
    }

    async #refreshFloat() {
        const now = this.#now();
        if (now - this.#floatAt < FLOAT_MS) return;
        this.#floatAt = now;
        await this.#deps.service
            .refreshFloat()
            .catch((error: unknown) => this.#deps.logger.warn({ err: error }, "Couldn't read the pool's float"));
    }

    /** One pass over the posted orders that are due; an error on one leaves it as it was. */
    async tick(): Promise<void> {
        const now = this.#now();
        await this.#sweepPlacing(now);
        const trader = this.#deps.trader();
        if (!trader) return;
        const orders = await this.#deps.collections.predictionOrders.find({ state: "posted" }).toArray();
        const ids = new Set(orders.map((order) => order._id.toHexString()));
        for (const id of this.#polled.keys()) if (!ids.has(id)) this.#polled.delete(id);

        for (const order of orders) {
            const id = order._id.toHexString();
            if (this.#deps.service.submitting(order._id)) continue;
            const wait = now - order.createdAt.getTime() > SLOW_AGE_MS ? SLOW_POLL_MS : this.#deps.pollMs;
            if (now - (this.#polled.get(id) ?? -Infinity) < wait) continue;
            this.#polled.set(id, now);
            await this.#step(trader, order).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, order: id }, "Couldn't follow a prediction"),
            );
        }
    }

    /** Refunds placing orders a failed submit left behind; no trader is needed, since they never left. */
    async #sweepPlacing(now: number) {
        const stale = await this.#deps.collections.predictionOrders
            .find({ state: "placing", createdAt: { $lt: new Date(now - PLACING_GIVE_UP_MS) } })
            .toArray();
        for (const order of stale) {
            if (this.#deps.service.submitting(order._id)) continue;
            await this.#deps.service
                .fail(order, "unavailable", "placing")
                .catch((error: unknown) =>
                    this.#deps.logger.warn(
                        { err: error, order: order._id.toHexString() },
                        "Couldn't refund a prediction",
                    ),
                );
        }
    }

    async #step(trader: PoolTrader, order: PredictionOrderDoc) {
        const found = await trader.lookup({
            orderHash: order.orderHash!,
            clobOrderId: order.clobOrderId,
            tokenId: order.tokenId,
        });
        if (found.kind === "filled") await this.#deps.service.settle(order, found.makingE6, found.takingE6);
        else if (found.kind === "cancelled") await this.#deps.service.fail(order, "price_moved", "posted");
        else if (found.kind === "missing" && this.#now() - (order.postedAt?.getTime() ?? 0) > MISSING_GIVE_UP_MS)
            await this.#deps.service.fail(order, "unavailable", "posted");
    }
}
