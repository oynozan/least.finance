import type { StatsPnlView, StatsRange } from "../protocol.ts";
import { usdString } from "./units.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MAX_PNL_POINTS = 200;

/** How wide a block of snapshots is; the last snapshot of each block is the one drawn. */
const BLOCK_MS: Record<StatsRange, number> = { "7D": HOUR, "30D": 4 * HOUR, All: DAY };
const SPAN_MS: Record<StatsRange, number> = { "7D": 7 * DAY, "30D": 30 * DAY, All: Infinity };

/** The snapshots as chart points: 7D hourly, 30D every 4 hours, All daily (UTC), at most 200, and the change across them. */
export function pnlPoints(snapshots: { at: Date; equityUsd: number }[], range: StatsRange, now: number): StatsPnlView {
    const since = now - SPAN_MS[range];
    const block = BLOCK_MS[range];
    const inRange = snapshots.filter((s) => s.at.getTime() >= since).sort((a, b) => a.at.getTime() - b.at.getTime());

    // Sorted oldest first, so a later snapshot in the same block replaces the earlier one.
    const blocks = new Map<number, { at: Date; equityUsd: number }>();
    for (const snapshot of inRange) blocks.set(Math.floor(snapshot.at.getTime() / block), snapshot);
    let kept = [...blocks.values()];

    // Every nth point counting back from the newest, so the latest figure is always drawn.
    if (kept.length > MAX_PNL_POINTS) {
        const n = Math.ceil(kept.length / MAX_PNL_POINTS);
        kept = kept.filter((_, i) => (kept.length - 1 - i) % n === 0);
    }

    const change = kept.length ? kept[kept.length - 1]!.equityUsd - kept[0]!.equityUsd : 0;
    return {
        range,
        points: kept.map((s) => ({ at: s.at.toISOString(), equityUsd: usdString(s.equityUsd) })),
        changeUsd: usdString(change),
    };
}
