import type { StatsPnlView } from "@/server/src/protocol";

export type StatsPoint = { at: number; usd: number };

/** The value range a chart draws: the data's own, padded 8% a side, and never zero-height. */
export function fitY(values: number[]): { min: number; max: number } {
    if (values.length === 0) return { min: 0, max: 1 };
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (high === low) {
        // A flat series gets a span, so its line sits mid-chart.
        const half = Math.max(Math.abs(low) * 0.04, 0.5);
        return { min: low - half, max: high + half };
    }
    const pad = (high - low) * 0.08;
    return { min: low - pad, max: high + pad };
}

/** The view's points as times and dollars, oldest first; a figure that isn't a number is dropped. */
export function toPoints(view: StatsPnlView): StatsPoint[] {
    return view.points
        .map((p) => ({ at: Date.parse(p.at), usd: Number(p.equityUsd) }))
        .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.usd))
        .sort((a, b) => a.at - b.at);
}
