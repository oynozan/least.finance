import type { Logger } from "pino";
import type { PoolRebalanceDoc } from "../db/mongo.ts";
import { formatE6, fromDecimal } from "../db/money.ts";

/** The error lines the owner greps for, since there is no alerting. */
export const POOL_ERRORS = {
    stuck: "Pool rebalance stuck: needs an operator",
    halted: "Pool rebalancing halted after repeated failures",
    treasuryLow: "Treasury too low to top up the pool",
    burnDelayed: "Pool rebalance burn delayed",
    wrapFailing: "A pool rebalance wrap keeps failing",
    noBurn: "Pool rebalance confirmed without a burn",
    walletMismatch: "Pool wallet mismatch",
} as const;

const HOUR_MS = 3_600_000;

/** The fields every pool rebalancer line carries: the row, its direction and its amount in dollars. */
export const rowFields = (row: PoolRebalanceDoc) => ({
    rebalance: row._id.toString(),
    direction: row.direction,
    kind: row.kind,
    amountUSD: formatE6(fromDecimal(row.amountE6)),
});

/** Logs a line once an hour per key, so a condition that persists doesn't fill the log. */
export class HourlyLog {
    readonly #logger: Logger;
    readonly #now: () => number;
    readonly #last = new Map<string, number>();

    constructor(logger: Logger, now: () => number) {
        this.#logger = logger;
        this.#now = now;
    }

    once(key: string, level: "info" | "warn" | "error", fields: object, message: string): void {
        const at = this.#now();
        const last = this.#last.get(key);
        if (last !== undefined && at - last < HOUR_MS) return;
        for (const [other, seen] of this.#last) if (at - seen >= HOUR_MS) this.#last.delete(other);
        this.#last.set(key, at);
        this.#logger[level](fields, message);
    }
}
