import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Collections } from "../db/mongo.ts";
import { fromDecimal } from "../db/money.ts";
import type { PoolTrader } from "./trader.ts";

/** The Data API leaves out holdings under 0.1 share, so smaller differences can't be told from dust. */
const TOLERANCE_E6 = 100_000n;

type Deps = {
    collections: Collections;
    trader: () => PoolTrader | null;
    logger: Logger;
    intervalMs: number;
};

/** Compares what the pool holds on Polymarket with what open positions say it should; it only reports, and never touches anyone's money. */
export class PredictionReconciler {
    readonly #deps: Deps;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
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
        if (!trader) return;
        const { positions, predictionOrders, predictionRedemptions } = this.#deps.collections;
        const [holdings, owed, unsettled, unredeemed] = await Promise.all([
            trader.holdings(),
            positions.find({ state: { $in: ["open", "closing"] } }).toArray(),
            predictionOrders.find({ state: { $in: ["placing", "posted"] } }).toArray(),
            predictionRedemptions.find({ state: { $ne: "confirmed" } }).toArray(),
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
        const pool = new Map(holdings.map((row) => [row.tokenId, row.sharesE6]));
        for (const tokenId of new Set([...ledger.keys(), ...pool.keys()])) {
            if (skipped.has(tokenId)) continue;
            const ledgerE6 = ledger.get(tokenId) ?? 0n;
            const poolE6 = pool.get(tokenId) ?? 0n;
            const gap = ledgerE6 > poolE6 ? ledgerE6 - poolE6 : poolE6 - ledgerE6;
            if (gap <= TOLERANCE_E6) continue;
            this.#deps.logger.error({ tokenId, ledgerE6, poolE6 }, "The pool's holdings don't match the positions");
        }
    }
}
