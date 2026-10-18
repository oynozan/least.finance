type LimiterLog = {
    warn: (fields: object, message: string) => void;
    info: (fields: object, message: string) => void;
};

/** Iris's request budget: a count per second, and a pause after it said to slow down. */
export class IrisLimiter {
    readonly #perSecond: number;
    readonly #backoffMs: number;
    readonly #logger: LimiterLog | undefined;
    /** True while a pause that was logged as started hasn't been logged as over. */
    #announced = false;
    /** When Iris was asked, within the last second. */
    #asked: number[] = [];
    #blockedUntil = 0;

    constructor(o: { perSecond?: number; backoffMs?: number; logger?: LimiterLog } = {}) {
        this.#logger = o.logger;
        this.#perSecond = o.perSecond ?? 5;
        this.#backoffMs = o.backoffMs ?? 5 * 60_000;
    }

    /** True and counted when a request may go out at `now`; false while paused or over the second's budget. */
    take(now: number): boolean {
        if (now < this.#blockedUntil) return false;
        if (this.#announced) {
            this.#announced = false;
            this.#logger?.info({ op: "iris.rate_limited" }, "Circle's Iris is being asked again after its pause");
        }
        this.#asked = this.#asked.filter((at) => now - at < 1_000);
        if (this.#asked.length >= this.#perSecond) return false;
        this.#asked.push(now);
        return true;
    }

    /** Stops every request until the pause after `now` is over. */
    backoff(now: number): void {
        this.#blockedUntil = now + this.#backoffMs;
        if (!this.#announced) {
            this.#announced = true;
            this.#logger?.warn(
                {
                    op: "iris.rate_limited",
                    backoffMs: this.#backoffMs,
                    pausedUntil: new Date(this.#blockedUntil).toISOString(),
                },
                "Circle's Iris said to slow down, so every CCTP status check and payout wait is paused",
            );
        }
    }

    blockedUntil(): number {
        return this.#blockedUntil;
    }
}
