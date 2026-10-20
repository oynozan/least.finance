import type { Logger } from "pino";

const MAX_DELAY_MS = 30_000;
/** After the first failure, one line in this many. */
const LOG_EVERY = 10;

/**
 * Keeps a polling loop's failures from filling the log: the first failure is logged, then one in ten, the
 * wait before the next pass grows (up to 30 seconds), and the pass that works again says how long it was down.
 */
export function loopWatch(logger: Logger, loop: string) {
    let failures = 0;
    return {
        /** Records a failed pass; returns how long to wait before the next one, given the usual wait. */
        failed(error: unknown, usualMs: number, fields: Record<string, unknown> = {}): number {
            failures += 1;
            const waitMs = Math.min(MAX_DELAY_MS, Math.max(usualMs, usualMs * 2 ** Math.min(failures - 1, 5)));
            if (failures === 1 || failures % LOG_EVERY === 0) {
                logger.warn(
                    { err: error, event: "loop.failed", loop, consecutive: failures, retryInMs: waitMs, ...fields },
                    `The ${loop} pass failed (${failures} in a row)`,
                );
            }
            return waitMs;
        },
        /** Records a pass that worked. */
        ok(): void {
            if (failures === 0) return;
            logger.warn(
                { event: "loop.recovered", loop, failures },
                `The ${loop} pass works again after ${failures} failures`,
            );
            failures = 0;
        },
    };
}
