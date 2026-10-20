/**
 * Lets a repeating warning through at most once per `everyMs` for each key, and counts what it held back,
 * so a loop that fails every second writes one line a minute instead of sixty.
 * Past `maxKeys` the keys whose interval has passed are dropped, so many sources can't grow the map without bound.
 */
export function throttle(everyMs: number, now: () => number = Date.now, maxKeys = 10_000) {
    const last = new Map<string, { at: number; held: number }>();
    return (key: string): { held: number } | null => {
        const entry = last.get(key);
        if (entry && now() - entry.at < everyMs) {
            entry.held += 1;
            return null;
        }
        if (last.size >= maxKeys) {
            for (const [old, { at }] of last) if (now() - at >= everyMs) last.delete(old);
        }
        last.set(key, { at: now(), held: 0 });
        return { held: entry?.held ?? 0 };
    };
}

const HOUR_MS = 3_600_000;

/**
 * Logs a condition that persists when it starts and when it clears, and again at most once an hour while it lasts
 * (counting what it held back), so a source that stays down writes a handful of lines instead of one per pass or request.
 */
export function outageLog(
    logger: { warn: (fields: object, message: string) => void; error: (fields: object, message: string) => void },
    now: () => number = Date.now,
    repeatMs = HOUR_MS,
) {
    const down = new Map<string, { since: number; loggedAt: number; held: number }>();
    return {
        /** Records a failure under `key`; returns whether it was logged. */
        failed(key: string, level: "warn" | "error", fields: object, message: string): boolean {
            const at = now();
            const known = down.get(key);
            if (known && at - known.loggedAt < repeatMs) {
                known.held += 1;
                return false;
            }
            const entry = known ?? { since: at, loggedAt: at, held: 0 };
            const extra = known
                ? { stillFailing: true, heldBack: known.held, failingSec: Math.round((at - known.since) / 1000) }
                : {};
            entry.loggedAt = at;
            entry.held = 0;
            down.set(key, entry);
            logger[level]({ ...fields, ...extra }, message);
            return true;
        },
        /** Records that `key` works; logs `message` once if it had been failing. */
        ok(key: string, message: string, fields: object = {}): void {
            const known = down.get(key);
            if (!known) return;
            down.delete(key);
            logger.warn({ ...fields, failingSec: Math.round((now() - known.since) / 1000) }, message);
        },
        /** Forgets `key` without a line, for a failure whose recovery another key already reports. */
        clear: (key: string) => void down.delete(key),
        /** Whether `key` is failing now. */
        isDown: (key: string) => down.has(key),
    };
}
