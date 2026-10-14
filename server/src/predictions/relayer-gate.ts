import type { Collections } from "../db/mongo.ts";

/** How long a batch can still execute after it was prepared: its signed deadline of 600 s plus a minute. */
export const GATE_SHUT_MS = 11 * 60_000;

export type GateResult<T> = { ran: true; value: T } | { ran: false; reason: "shut" | "unconfirmed" };

type Deps = {
    collections: Collections;
    /** The clock, for tests. */
    now?: () => number;
};

/** Lets one relayer batch be prepared and submitted at a time, and none while an earlier one may still execute. */
export class RelayerGate {
    readonly #collections: Collections;
    readonly #now: () => number;
    #tail: Promise<void> = Promise.resolve();
    #shutUntil = 0;

    constructor(deps: Deps) {
        this.#collections = deps.collections;
        this.#now = deps.now ?? Date.now;
    }

    /** Runs `submit` alone, once the gate is free of a shut and of an unconfirmed earlier batch; a refusal runs nothing. */
    async run<T>(submit: () => Promise<T>, o: { from: "redeemer" | "rebalancer" }): Promise<GateResult<T>> {
        const before = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => (release = resolve));
        await before;
        try {
            if (this.#now() < this.#shutUntil) return { ran: false, reason: "shut" };
            if (await this.#unconfirmed(o.from)) return { ran: false, reason: "unconfirmed" };
            return { ran: true, value: await submit() };
        } finally {
            release();
        }
    }

    /** Refuses every run for 11 minutes, after a call that timed out and may still complete. */
    shut(): void {
        this.#shutUntil = Math.max(this.#shutUntil, this.#now() + GATE_SHUT_MS);
    }

    /** Whether an earlier batch can still execute: the rebalancer's rows say so, and for the rebalancer so do the redemptions. */
    async #unconfirmed(from: "redeemer" | "rebalancer"): Promise<boolean> {
        const { poolRebalances, predictionRedemptions } = this.#collections;
        const young = { $gt: new Date(this.#now() - GATE_SHUT_MS) };
        const live = await poolRebalances.countDocuments(
            {
                $or: [
                    { "polygon.relayerTransactionId": { $ne: null }, "polygon.relayerFinalAt": null },
                    { "polygon.wrapTransactionId": { $ne: null }, "polygon.wrapFinalAt": null },
                    {
                        "polygon.attemptedAt": young,
                        "polygon.relayerTransactionId": null,
                        "polygon.relayerFinalAt": null,
                    },
                    {
                        "polygon.wrapAttemptedAt": young,
                        "polygon.wrapTransactionId": null,
                        "polygon.wrapFinalAt": null,
                    },
                ],
            },
            { limit: 1 },
        );
        if (live > 0) return true;
        if (from === "redeemer") return false;
        return (await predictionRedemptions.countDocuments({ state: "submitted" }, { limit: 1 })) > 0;
    }
}
