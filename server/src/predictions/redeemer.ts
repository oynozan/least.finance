import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections, PredictionRedemptionDoc } from "../db/mongo.ts";
import type { PredictionService } from "./predictions.ts";
import type { PoolTrader } from "./trader.ts";

const RETRY_MS = 600_000;
const ERROR_FROM_ATTEMPT = 6;

type Deps = {
    collections: Collections;
    service: PredictionService;
    trader: () => PoolTrader | null;
    logger: Logger;
    intervalMs: number;
    /** The clock, for tests. */
    now?: () => number;
};

/** Redeems the pool's tokens of each resolved condition through the relayer, retrying until it confirms. */
export class PredictionRedeemer {
    readonly #deps: Deps;
    readonly #now: () => number;
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
                this.#deps.logger.warn({ err: error }, "Prediction redemption pass failed");
            }
            await sleep(this.#deps.intervalMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass: follows the submitted redemptions, then submits the ones that are due. */
    async tick(): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) return;
        const { predictionRedemptions } = this.#deps.collections;
        const submitted = await predictionRedemptions.find({ state: "submitted" }).toArray();
        const due = await predictionRedemptions
            .find({ state: { $in: ["pending", "failed"] }, nextAt: { $lte: new Date(this.#now()) } })
            .toArray();
        for (const row of submitted) {
            await this.#check(trader, row).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, condition: row.conditionId }, "Couldn't check a redemption"),
            );
        }
        for (const row of due) {
            await this.#submit(trader, row).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, condition: row.conditionId }, "Couldn't record a redemption"),
            );
        }
    }

    async #submit(trader: PoolTrader, row: PredictionRedemptionDoc) {
        let transactionId: string;
        try {
            ({ transactionId } = await trader.redeem(row.conditionId));
        } catch (error) {
            await this.#fail(row, error instanceof Error ? error.message : String(error));
            return;
        }
        await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: row.state },
            { $set: { state: "submitted", transactionId, lastError: null, updatedAt: new Date(this.#now()) } },
        );
    }

    async #check(trader: PoolTrader, row: PredictionRedemptionDoc) {
        const state = await trader.transaction(row.transactionId!);
        if (state === "pending") return;
        if (state === "failed") return this.#fail(row, "the relayer failed the transaction");
        const moved = await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: "submitted" },
            { $set: { state: "confirmed", lastError: null, updatedAt: new Date(this.#now()) } },
        );
        if (moved.modifiedCount === 0) return;
        this.#deps.logger.info({ condition: row.conditionId }, "Redemption confirmed");
        // The payout is pool float again
        await this.#deps.service
            .refreshFloat()
            .catch((error: unknown) => this.#deps.logger.warn({ err: error }, "Couldn't read the pool's float"));
    }

    async #fail(row: PredictionRedemptionDoc, reason: string) {
        const attempts = row.attempts + 1;
        const now = this.#now();
        const moved = await this.#deps.collections.predictionRedemptions.updateOne(
            { _id: row._id, state: row.state },
            {
                $set: {
                    state: "failed",
                    attempts,
                    nextAt: new Date(now + RETRY_MS),
                    lastError: reason,
                    updatedAt: new Date(now),
                },
            },
        );
        if (moved.modifiedCount === 0) return;
        const level = attempts >= ERROR_FROM_ATTEMPT ? "error" : "warn";
        this.#deps.logger[level]({ condition: row.conditionId, attempts, reason }, "Redemption failed");
    }
}
