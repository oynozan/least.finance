/**
 * Lets a repeating warning through at most once per `everyMs` for each key, and counts what it held back,
 * so a loop that fails every second writes one line a minute instead of sixty.
 */
export function throttle(everyMs: number, now: () => number = Date.now) {
    const last = new Map<string, { at: number; held: number }>();
    return (key: string): { held: number } | null => {
        const entry = last.get(key);
        if (entry && now() - entry.at < everyMs) {
            entry.held += 1;
            return null;
        }
        last.set(key, { at: now(), held: 0 });
        return { held: entry?.held ?? 0 };
    };
}
