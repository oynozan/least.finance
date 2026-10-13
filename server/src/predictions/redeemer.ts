import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections, PredictionRedemptionDoc } from "../db/mongo.ts";
import type { PredictionService } from "./predictions.ts";
import type { PoolTrader } from "./trader.ts";

const SUBMITTED_TIMEOUT_MS = 30 * 60_000;
const RETRY_MS = 600_000;
const SLOW_RETRY_MS = 3_600_000;
const STUCK_RETRY_MS = 21_600_000;
const ERROR_FROM_ATTEMPT = 6;
const STUCK_FROM_ATTEMPT = 10;
const CHECK_ERRORS_LIMIT = 10;
const STUCK_LOG_MS = 600_000;
const PREVIOUS_KEPT = 10;
/** The Data API's tolerance, in micro-shares, below which the pool is taken to hold none of a token. */
const HELD_TOLERANCE_E6 = 100_000n;

type Deps = {
    collections: Collections;
    service: PredictionService;
    trader: () => PoolTrader | null;
    logger: Logger;
    intervalMs: number;
    /** Asks for the pool's trader to be connected when a redemption is waiting for it. */
    needTrader?: () => void;
    /** The clock, for tests. */
    now?: () => number;
};

/** Redeems the pool's tokens of each resolved condition through the relayer, retrying until it confirms. */
export class PredictionRedeemer {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #pass: Promise<void> | null = null;
    #stuckLoggedAt = 0;

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
                this.#deps.logger.warn({ err: error }, "Prediction redemption pass failed");
            }
            await sleep(this.#deps.intervalMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass: follows the submitted redemptions, then submits the ones that are due; a pass already running is joined. */
    tick(): Promise<void> {
        this.#pass ??= this.#tick().finally(() => (this.#pass = null));
        return this.#pass;
    }

    async #tick(): Promise<void> {
        const trader = this.#deps.trader();
        const { predictionRedemptions } = this.#deps.collections;
        if (!trader) {
            if (await predictionRedemptions.countDocuments({ state: { $ne: "confirmed" } }, { limit: 1 })) {
                this.#deps.needTrader?.();
            }
            return;
        }
        const submitted = await predictionRedemptions.find({ state: "submitted" }).toArray();
        for (const row of submitted) {
            await this.#check(trader, row).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, condition: row.conditionId }, "Couldn't check a redemption"),
            );
        }
        const due = await predictionRedemptions
            .find({ state: { $in: ["pending", "failed", "stuck"] }, nextAt: { $lte: new Date(this.#now()) } })
            .toArray();
        for (const row of due) {
            await this.#submit(trader, row).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, condition: row.conditionId }, "Couldn't record a redemption"),
            );
        }
        await this.#reportStuck();
    }

    async #reportStuck() {
        const count = await this.#deps.collections.predictionRedemptions.countDocuments({ state: "stuck" });
        const now = this.#now();
        if (count === 0 || now - this.#stuckLoggedAt < STUCK_LOG_MS) return;
        this.#stuckLoggedAt = now;
        this.#deps.logger.error({ count }, "Redemptions are stuck");
    }

    async #submit(trader: PoolTrader, row: PredictionRedemptionDoc) {
        let transactionId: string;
        try {
            ({ transactionId } = await trader.redeem(row.conditionId));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.#fail(row, /timed out/.test(message) ? "redeem timed out" : message);
            return;
        }
        const now = new Date(this.#now());
        await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: row.state },
            {
                $set: {
                    state: "submitted",
                    transactionId,
                    submittedAt: now,
                    checkErrors: 0,
                    lastError: null,
                    updatedAt: now,
                },
            },
        );
    }

    async #check(trader: PoolTrader, row: PredictionRedemptionDoc) {
        const { predictionRedemptions } = this.#deps.collections;
        let state: Awaited<ReturnType<PoolTrader["transaction"]>>;
        try {
            state = await trader.transaction(row.transactionId!);
        } catch (error) {
            const counted = await predictionRedemptions.findOneAndUpdate(
                { _id: row._id, state: "submitted" },
                { $inc: { checkErrors: 1 }, $set: { updatedAt: new Date(this.#now()) } },
                { returnDocument: "after" },
            );
            if (counted && (counted.checkErrors ?? 0) >= CHECK_ERRORS_LIMIT) {
                await this.#expire(trader, counted, "transaction lookups keep failing");
            } else {
                this.#deps.logger.warn({ err: error, condition: row.conditionId }, "Couldn't look up a redemption");
            }
            return;
        }
        if (row.checkErrors) {
            await predictionRedemptions.updateOne({ _id: row._id, state: "submitted" }, { $set: { checkErrors: 0 } });
        }
        if (state === "pending") {
            const since = (row.submittedAt ?? row.updatedAt).getTime();
            if (this.#now() - since > SUBMITTED_TIMEOUT_MS) {
                await this.#expire(trader, row, "not confirmed after 30 minutes");
            }
            return;
        }
        if (state === "failed") return this.#fail(row, "the relayer failed the transaction");
        await this.#confirm(row, null);
    }

    async #confirm(row: PredictionRedemptionDoc, reason: string | null) {
        const moved = await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: "submitted" },
            {
                $set: {
                    state: "confirmed",
                    lastError: reason && `confirmed by holdings: ${reason}`,
                    stuckAt: null,
                    confirmedAt: new Date(this.#now()),
                    updatedAt: new Date(this.#now()),
                },
            },
        );
        if (moved.modifiedCount === 0) return;
        this.#deps.logger.info({ condition: row.conditionId, reason }, "Redemption confirmed");
        if (row.stuckAt) this.#deps.logger.info({ condition: row.conditionId }, "Redemption recovered");
        // The payout is pool float again
        await this.#deps.service
            .refreshFloat()
            .catch((error: unknown) => this.#deps.logger.warn({ err: error }, "Couldn't read the pool's float"));
    }

    /** Gives up on the current transaction: confirms the redemption if the pool's tokens are gone, else queues a fresh one. */
    async #expire(trader: PoolTrader, row: PredictionRedemptionDoc, reason: string) {
        const { positions, predictionOrders } = this.#deps.collections;
        const filter = { conditionId: row.conditionId };
        const tokens = new Set([
            ...(await positions.distinct("tokenId", filter)),
            ...(await predictionOrders.distinct("tokenId", filter)),
        ]);
        const held = (await trader.holdings()).some((h) => tokens.has(h.tokenId) && h.sharesE6 > HELD_TOLERANCE_E6);
        if (!held) return this.#confirm(row, reason);
        const first = (row.previousTransactions ?? []).length === 0;
        await this.#fail(row, reason, { abandoned: row.transactionId!, retryNow: first });
    }

    async #fail(row: PredictionRedemptionDoc, reason: string, expired?: { abandoned: string; retryNow: boolean }) {
        const attempts = row.attempts + 1;
        const now = this.#now();
        const stuck = attempts >= STUCK_FROM_ATTEMPT;
        const wait = attempts < ERROR_FROM_ATTEMPT ? RETRY_MS : stuck ? STUCK_RETRY_MS : SLOW_RETRY_MS;
        const previous = expired
            ? [...(row.previousTransactions ?? []), expired.abandoned].slice(-PREVIOUS_KEPT)
            : (row.previousTransactions ?? []);
        const moved = await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: row.state },
            {
                $set: {
                    state: stuck ? "stuck" : "failed",
                    attempts,
                    nextAt: new Date(expired?.retryNow ? now : now + wait),
                    lastError: reason,
                    previousTransactions: previous,
                    stuckAt: stuck ? (row.stuckAt ?? new Date(now)) : (row.stuckAt ?? null),
                    updatedAt: new Date(now),
                },
            },
        );
        if (moved.modifiedCount === 0) return;
        const fields = { condition: row.conditionId, attempts, reason };
        if (stuck) {
            this.#deps.logger.error(
                { ...fields, lastError: reason, previousTransactions: previous },
                "Redemption stuck: needs an operator",
            );
            return;
        }
        const level = attempts >= ERROR_FROM_ATTEMPT ? "error" : "warn";
        this.#deps.logger[level](fields, "Redemption failed");
    }
}
