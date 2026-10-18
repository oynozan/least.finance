import { setTimeout as sleep } from "node:timers/promises";
import { loopWatch } from "../loop-watch.ts";
import type { Logger } from "pino";
import type { Collections, PredictionRedemptionDoc } from "../db/mongo.ts";
import type { PredictionService } from "./predictions.ts";
import type { RelayerGate } from "./relayer-gate.ts";
import type { PoolTrader, TransactionState } from "./trader.ts";

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
    /** Serialises the redeem batches with the pool rebalancer's, when there is one. */
    gate?: RelayerGate;
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
        const watch = loopWatch(this.#deps.logger, "prediction redemption");
        while (!signal.aborted) {
            let waitMs = this.#deps.intervalMs;
            try {
                await this.tick();
                watch.ok();
            } catch (error) {
                waitMs = watch.failed(error, this.#deps.intervalMs);
            }
            await sleep(waitMs, undefined, { signal }).catch(() => undefined);
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
                this.#deps.logger.warn(
                    {
                        err: error,
                        condition: row.conditionId,
                        marketId: row.marketId,
                        transactionId: row.transactionId,
                    },
                    "Couldn't check a submitted redemption",
                ),
            );
        }
        const due = await predictionRedemptions
            .find({ state: { $in: ["pending", "failed", "stuck"] }, nextAt: { $lte: new Date(this.#now()) } })
            .toArray();
        for (const row of due) {
            await this.#submit(trader, row).catch((error: unknown) =>
                // The step that threw is after the relayer took the call when a transaction id was returned,
                // so the redemption may be in flight without being written down
                this.#deps.logger.error(
                    {
                        err: error,
                        condition: row.conditionId,
                        marketId: row.marketId,
                        round: row.round ?? 1,
                        attempts: row.attempts,
                    },
                    "Couldn't submit or save a redemption; if the relayer took it, it is not written down",
                ),
            );
        }
        await this.#reportStuck();
    }

    async #reportStuck() {
        const stuck = await this.#deps.collections.predictionRedemptions.find({ state: "stuck" }).toArray();
        const now = this.#now();
        if (stuck.length === 0 || now - this.#stuckLoggedAt < STUCK_LOG_MS) return;
        this.#stuckLoggedAt = now;
        this.#deps.logger.error(
            {
                count: stuck.length,
                conditions: stuck.slice(0, 5).map((row) => row.conditionId),
                lastErrors: stuck.slice(0, 5).map((row) => row.lastError),
            },
            "Redemptions are stuck",
        );
    }

    async #submit(trader: PoolTrader, row: PredictionRedemptionDoc) {
        const send = async () => {
            let transactionId: string;
            try {
                ({ transactionId } = await trader.redeem(row.conditionId));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const timedOut = /timed out/.test(message);
                // A call that timed out may still complete, so no other batch is prepared meanwhile
                if (timedOut) this.#deps.gate?.shut();
                return { failure: message, err: error };
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
            return { failure: null, err: undefined };
        };
        const outcome = this.#deps.gate
            ? await this.#deps.gate.run(send, { from: "redeemer" })
            : { ran: true as const, value: await send() };
        // A held gate leaves the row due for the next pass
        if (outcome.ran && outcome.value.failure !== null)
            await this.#fail(row, outcome.value.failure, undefined, outcome.value.err);
    }

    async #check(trader: PoolTrader, row: PredictionRedemptionDoc) {
        const { predictionRedemptions } = this.#deps.collections;
        let state: TransactionState;
        try {
            ({ state } = await trader.transaction(row.transactionId!));
        } catch (error) {
            const counted = await predictionRedemptions.findOneAndUpdate(
                { _id: row._id, state: "submitted" },
                {
                    $inc: { checkErrors: 1 },
                    $set: {
                        lastError: `Couldn't look up transaction ${row.transactionId}: ${error instanceof Error ? error.message : String(error)}`,
                        updatedAt: new Date(this.#now()),
                    },
                },
                { returnDocument: "after" },
            );
            if (counted && (counted.checkErrors ?? 0) >= CHECK_ERRORS_LIMIT) {
                await this.#expire(
                    trader,
                    counted,
                    `transaction lookups failed ${CHECK_ERRORS_LIMIT} times; last: ${counted.lastError}`,
                );
            } else {
                this.#deps.logger.warn(
                    {
                        err: error,
                        condition: row.conditionId,
                        transactionId: row.transactionId,
                        checkErrors: counted?.checkErrors,
                    },
                    "Couldn't look up a redemption's transaction",
                );
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
            // refreshFloat logs its own failure
            .catch(() => undefined);
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

    async #fail(
        row: PredictionRedemptionDoc,
        reason: string,
        expired?: { abandoned: string; retryNow: boolean },
        err?: unknown,
    ) {
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
        const fields = {
            condition: row.conditionId,
            marketId: row.marketId,
            round: row.round ?? 1,
            transactionId: row.transactionId,
            attempts,
            reason,
            ...(err !== undefined && { err }),
        };
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
