import type { PnlSeries } from "@/server/src/protocol";

const stored = new Map<string, PnlSeries>();
/** The highest request number saved for each zone. */
const latest = new Map<string, number>();
const listeners = new Set<() => void>();
let issued = 0;
/** Requests numbered up to here were sent before the last reset. */
let floor = 0;

const emit = () => {
    for (const listener of listeners) listener();
};

/** The last series saved for a zone, or null. */
export const storedSeries = (tz: string): PnlSeries | null => stored.get(tz) ?? null;

/** The number to send a request under, so a later answer can tell whether it is the newest. */
export const nextSeriesRequest = (): number => ++issued;

/** Keeps the answer unless a newer request for the zone was saved already or a reset came after it was sent. */
export function saveSeries(tz: string, request: number, series: PnlSeries): boolean {
    if (request <= floor || request < (latest.get(tz) ?? 0)) return false;
    latest.set(tz, request);
    stored.set(tz, series);
    emit();
    return true;
}

export function subscribeSeries(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Forgets every series, and refuses any answer to a request sent before now. */
export function resetPnlStores(): void {
    stored.clear();
    latest.clear();
    floor = issued;
    emit();
}
