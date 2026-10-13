export type ChancePoints = readonly (readonly [number, number])[];

/** The vertical range never spans less than this, so a quiet line stays flat. */
const MIN_SPAN = 0.2;
/** A change smaller than this many points reads as no change. */
const FLAT_PTS = 0.5;

/** Points with the live chance appended at `now`; one already at or after `now` is replaced. */
export function withLiveEnd(points: ChancePoints, chance: number, now: number): ChancePoints {
    const kept = points.at(-1) && points.at(-1)![0] >= now ? points.slice(0, -1) : points;
    return [...kept, [now, chance]];
}

/** The vertical range: fits the values, never under 0.2, kept inside 0–1. */
export function chanceScale(values: readonly number[]): { floor: number; span: number } {
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = Math.min(1, Math.max(high - low, MIN_SPAN));
    const floor = Math.min(1 - span, Math.max(0, (high + low) / 2 - span / 2));
    return { floor, span };
}

/** The chance at a moment: the last point at or before it, or null before the line starts. */
export function valueAt(points: ChancePoints, time: number): number | null {
    let value: number | null = null;
    for (const [t, chance] of points) {
        if (t > time) break;
        value = chance;
    }
    return value;
}

/** "+12 pts", "−3.5 pts", "0 pts": whole points from 10 up, one decimal under, flat under 0.5. */
export function formatPts(delta: number): { text: string; trend: "gain" | "loss" | "flat" } {
    const pts = Math.abs(delta) * 100;
    if (pts < FLAT_PTS) return { text: "0 pts", trend: "flat" };
    const tenth = Math.round(pts * 10) / 10;
    const body = tenth >= 10 ? String(Math.round(pts)) : tenth.toFixed(1);
    return delta > 0 ? { text: `+${body} pts`, trend: "gain" } : { text: `−${body} pts`, trend: "loss" };
}
