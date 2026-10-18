import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections } from "../db/mongo.ts";
import { formatE6, fromDecimal } from "../db/money.ts";
import { HourlyLog } from "./rebalance-log.ts";
import type { PoolTrader } from "./trader.ts";

/** The Data API leaves out holdings under 0.1 share, so smaller differences can't be told from dust. */
const TOLERANCE_E6 = 100_000n;

type Deps = {
    collections: Collections;
    trader: () => PoolTrader | null;
    logger: Logger;
    intervalMs: number;
    /** Asks for the pool's trader to be connected when positions are waiting on it. */
    needTrader?: () => void;
    /** The clock, for tests. */
    now?: () => number;
};

/** A condition's redemption is queued again at most this many rounds when the pool still holds its tokens. */
const MAX_ROUNDS = 5;

/** A sell is signed to 2 decimals, so a closed position leaves what is under a step with the pool. */
const SHARE_STEP_E6 = 10_000n;

/** Compares what the pool holds on Polymarket with what open positions say it should; it only reports, and never touches anyone's money. */
export class PredictionReconciler {
    readonly #deps: Deps;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    /** A mismatch stays until someone fixes it, so each token's line is logged once an hour. */
    readonly #hourly: HourlyLog;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#hourly = new HourlyLog(deps.logger, deps.now ?? Date.now);
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
            await sleep(this.#deps.intervalMs, undefined, { signal }).catch(() => undefined);
            if (signal.aborted) break;
            try {
                await this.tick();
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Prediction reconciliation failed");
            }
        }
    }

    async tick(): Promise<void> {
        const trader = this.#deps.trader();
        const { positions, predictionOrders, predictionRedemptions } = this.#deps.collections;
        if (!trader) {
            if (await positions.countDocuments({ state: { $in: ["open", "closing"] } }, { limit: 1 })) {
                this.#deps.needTrader?.();
            }
            return;
        }
        const [holdings, owed, sold, unsettled, unredeemed, redeemed] = await Promise.all([
            trader.holdings(),
            positions.find({ state: { $in: ["open", "closing"] } }).toArray(),
            positions.find({ state: "closed" }).toArray(),
            predictionOrders.find({ state: { $in: ["placing", "posted"] } }).toArray(),
            predictionRedemptions.find({ state: { $ne: "confirmed" } }).toArray(),
            predictionRedemptions.find({ state: "confirmed" }).toArray(),
        ]);
        const skipped = new Set(unsettled.map((order) => order.tokenId));
        if (unredeemed.length > 0) {
            const tokens = await positions
                .find({ conditionId: { $in: unredeemed.map((row) => row.conditionId) } })
                .toArray();
            for (const position of tokens) skipped.add(position.tokenId);
        }

        const ledger = new Map<string, bigint>();
        for (const position of owed) {
            ledger.set(position.tokenId, (ledger.get(position.tokenId) ?? 0n) + fromDecimal(position.shares));
        }
        // The dust of sold positions stays with the pool until its condition is redeemed
        const redeemedConditions = new Set(redeemed.map((row) => row.conditionId));
        for (const position of sold) {
            if (redeemedConditions.has(position.conditionId)) continue;
            ledger.set(
                position.tokenId,
                (ledger.get(position.tokenId) ?? 0n) + (fromDecimal(position.shares) % SHARE_STEP_E6),
            );
        }
        const pool = new Map(holdings.map((row) => [row.tokenId, row.sharesE6]));
        for (const tokenId of new Set([...ledger.keys(), ...pool.keys()])) {
            if (skipped.has(tokenId)) continue;
            const ledgerE6 = ledger.get(tokenId) ?? 0n;
            const poolE6 = pool.get(tokenId) ?? 0n;
            const gap = ledgerE6 > poolE6 ? ledgerE6 - poolE6 : poolE6 - ledgerE6;
            if (gap <= TOLERANCE_E6) continue;
            if (poolE6 > ledgerE6 && (await this.#requeueLeftover(tokenId, redeemedConditions))) continue;
            const involved = [...owed, ...sold].filter((position) => position.tokenId === tokenId);
            this.#hourly.once(
                `mismatch:${tokenId}`,
                "error",
                {
                    tokenId,
                    question: involved[0]?.question ?? null,
                    ledgerShares: formatE6(ledgerE6),
                    poolShares: formatE6(poolE6),
                    gapShares: formatE6(gap),
                    direction: poolE6 < ledgerE6 ? "pool short" : "pool long",
                    positions: involved.slice(0, 5).map((position) => position._id.toHexString()),
                },
                "The pool's holdings don't match the positions",
            );
        }
        // Stuck redemptions are reported by the redeemer, with their conditions and last errors
    }

    /** Queues the confirmed redemption of a token's condition again because the pool still holds the token; false when no confirmed redemption explains it. */
    async #requeueLeftover(tokenId: string, confirmed: Set<string>): Promise<boolean> {
        const { positions, predictionOrders, predictionRedemptions } = this.#deps.collections;
        const owner = (await positions.findOne({ tokenId })) ?? (await predictionOrders.findOne({ tokenId }));
        if (!owner?.conditionId || !confirmed.has(owner.conditionId)) return false;
        const now = new Date((this.#deps.now ?? Date.now)());
        const queued = await predictionRedemptions.updateOne(
            {
                conditionId: owner.conditionId,
                state: "confirmed",
                $expr: {
                    $and: [
                        { $lt: [{ $ifNull: ["$round", 1] }, MAX_ROUNDS] },
                        { $lt: [{ $ifNull: ["$confirmedAt", "$updatedAt"] }, now] },
                    ],
                },
            },
            [
                {
                    $set: {
                        state: "pending",
                        transactionId: null,
                        attempts: 0,
                        nextAt: now,
                        lastError: "re-queued: the pool still holds the condition's tokens",
                        updatedAt: now,
                        round: { $add: [{ $ifNull: ["$round", 1] }, 1] },
                    },
                },
            ],
        );
        if (queued.modifiedCount > 0) {
            this.#deps.needTrader?.();
            return true;
        }
        const row = await predictionRedemptions.findOne({ conditionId: owner.conditionId });
        if (row?.state === "confirmed" && (row.round ?? 1) >= MAX_ROUNDS) {
            this.#deps.logger.error(
                { tokenId, condition: owner.conditionId },
                "Redemption leaves winning tokens behind",
            );
            return true;
        }
        return false;
    }
}
