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
