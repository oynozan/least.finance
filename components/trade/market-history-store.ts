import { useSyncExternalStore } from "react";
import type { ChancePoints } from "@/lib/trade/chance-chart";
import { API_URL } from "@/lib/api";

export type MarketHistorySnapshot = {
    /** Each outcome token's chance line by token id; empty until the server has answered. */
    lines: ReadonlyMap<string, ChancePoints>;
};

/** The server's own cache is fresh for this long, so asking sooner learns nothing. */
const FRESH_MS = 180_000;
/** After a failed read, a token isn't asked for again for this long. */
const RETRY_MS = 10_000;

const isPoint = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    value[1] >= 0 &&
    value[1] <= 1;

/** Each token's usable points, skipping whatever a newer or broken server sends that doesn't fit. */
function toLines(view: unknown): Map<string, ChancePoints> | null {
    if (typeof view !== "object" || view === null || !Array.isArray((view as { outcomes?: unknown }).outcomes)) {
        return null;
    }
    const lines = new Map<string, ChancePoints>();
    for (const outcome of (view as { outcomes: unknown[] }).outcomes) {
        if (typeof outcome !== "object" || outcome === null) continue;
        const { tokenId, points } = outcome as { tokenId?: unknown; points?: unknown };
        if (typeof tokenId !== "string" || !Array.isArray(points)) continue;
        lines.set(tokenId, points.filter(isPoint));
    }
    return lines;
}

/** Outcome chance lines read from our server (never from Polymarket) when a card or pill asks ahead of a hover. */
export function createMarketHistoryStore(options: { apiUrl: string; fetch?: typeof fetch; now?: () => number }) {
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const now = options.now ?? Date.now;
    const listeners = new Set<() => void>();
    let snapshot: MarketHistorySnapshot = { lines: new Map() };
    const readAt = new Map<string, number>();
    const reading = new Set<string>();
    const failedAt = new Map<string, number>();

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        /** Reads the tokens it has no line for, or a line older than 3 minutes, in one request; tokens already being read, or whose read failed in the last 10 seconds, aren't asked again. */
        async want(eventId: string, tokenIds: readonly string[]): Promise<void> {
            const time = now();
            const tokens = [...new Set(tokenIds)].filter(
                (token) =>
                    !reading.has(token) &&
                    !(time - (readAt.get(token) ?? -Infinity) < FRESH_MS) &&
                    !(time - (failedAt.get(token) ?? -Infinity) < RETRY_MS),
            );
            if (tokens.length === 0) return;
            tokens.forEach((token) => reading.add(token));
            try {
                const response = await request(
                    `${options.apiUrl}/markets/${eventId}/history?outcomes=${tokens.join(",")}`,
                );
                const read = response.ok ? toLines(await response.json()) : null;
                if (!read || read.size === 0) {
                    tokens.forEach((token) => failedAt.set(token, time));
                    return;
                }
                const lines = new Map(snapshot.lines);
                for (const [token, points] of read) {
                    lines.set(token, points);
                    readAt.set(token, time);
                }
                snapshot = { lines };
                listeners.forEach((listener) => listener());
            } catch {
                // Offline or the server is down; a want after the pause tries again.
                tokens.forEach((token) => failedAt.set(token, time));
            } finally {
                tokens.forEach((token) => reading.delete(token));
            }
        },
    };
}

export type MarketHistoryStore = ReturnType<typeof createMarketHistoryStore>;

let shared: MarketHistoryStore | null = null;

/** The shared store's lines; components call `marketHistoryStore().want(...)` to read ahead. */
export function marketHistoryStore(): MarketHistoryStore {
    return (shared ??= createMarketHistoryStore({ apiUrl: API_URL }));
}

const EMPTY: MarketHistorySnapshot = { lines: new Map() };

export function useMarketHistory(): MarketHistorySnapshot {
    return useSyncExternalStore(
        (listener) => marketHistoryStore().subscribe(listener),
        () => marketHistoryStore().getSnapshot(),
        () => EMPTY,
    );
}
