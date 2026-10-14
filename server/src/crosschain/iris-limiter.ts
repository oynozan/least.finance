/** Iris's request budget: a count per second, and a pause after it said to slow down. */
export class IrisLimiter {
    readonly #perSecond: number;
    readonly #backoffMs: number;
    /** When Iris was asked, within the last second. */
    #asked: number[] = [];
    #blockedUntil = 0;

    constructor(o: { perSecond?: number; backoffMs?: number } = {}) {
        this.#perSecond = o.perSecond ?? 5;
        this.#backoffMs = o.backoffMs ?? 5 * 60_000;
    }

    /** True and counted when a request may go out at `now`; false while paused or over the second's budget. */
    take(now: number): boolean {
        if (now < this.#blockedUntil) return false;
        this.#asked = this.#asked.filter((at) => now - at < 1_000);
        if (this.#asked.length >= this.#perSecond) return false;
        this.#asked.push(now);
        return true;
    }

    /** Stops every request until the pause after `now` is over. */
    backoff(now: number): void {
        this.#blockedUntil = now + this.#backoffMs;
    }

    blockedUntil(): number {
        return this.#blockedUntil;
    }
}
