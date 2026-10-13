import { useEffect, useSyncExternalStore } from "react";
import type { PriceHistoryView, PriceRange } from "@/server/src/protocol";
import { API_URL } from "@/lib/api";

/** One coin's dollar prices, oldest first: [unix ms, USD]. */
export type PricePoints = readonly (readonly [number, number])[];

export type PriceHistorySnapshot = {
    range: PriceRange;
    /** Each coin's prices by symbol; empty until the server has answered. */
    coins: ReadonlyMap<string, PricePoints>;
};

/** The server reads its week again every 12 minutes, so this never asks for nothing new. */
const REFRESH_MS = 600_000;
/** Until a first answer, ask again soon. */
const RETRY_MS = 15_000;

const isPoint = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    value[1] > 0;

/** Each coin's usable points, skipping whatever a newer or broken server sends that doesn't fit. */
function toCoins(view: unknown): Map<string, PricePoints> | null {
    if (typeof view !== "object" || view === null || !Array.isArray((view as PriceHistoryView).coins)) return null;
    const coins = new Map<string, PricePoints>();
    for (const coin of (view as PriceHistoryView).coins as unknown[]) {
        if (typeof coin !== "object" || coin === null) continue;
        const { symbol, points } = coin as { symbol?: unknown; points?: unknown };
        if (typeof symbol !== "string" || !Array.isArray(points)) continue;
        const usable = points.filter(isPoint);
        if (usable.length >= 2) coins.set(symbol, usable);
    }
    return coins;
}

/**
 * Every swap coin's price history over one range, read from our server (never
 * from DefiLlama) in the background once the page is idle, and kept fresh
 * while it's visible, so a chart is in hand before anyone hovers a coin.
 */
export function createPriceHistoryStore(options: { apiUrl: string; range?: PriceRange; fetch?: typeof fetch }) {
    const range = options.range ?? "7d";
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const listeners = new Set<() => void>();
    let snapshot: PriceHistorySnapshot = { range, coins: new Map() };
    let users = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let askedAt = 0;
    let reading: Promise<void> | null = null;

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    // One read at a time, however many timers and visibility changes ask
    function refresh(): Promise<void> {
        reading ??= read().finally(() => (reading = null));
        return reading;
    }

    async function read() {
        askedAt = Date.now();
        let coins: Map<string, PricePoints> | null = null;
        try {
            const response = await request(`${options.apiUrl}/prices/history?range=${range}`);
            coins = response.ok ? toCoins(await response.json()) : null;
        } catch {
            // Offline or the server is down; the next refresh tries again.
        }
        if (users === 0 || !coins || coins.size === 0) return;
        snapshot = { range, coins };
        listeners.forEach((listener) => listener());
    }

    function schedule() {
        clearTimeout(timer);
        if (users === 0) return;
        timer = setTimeout(
            async () => {
                if (visible()) await refresh();
                schedule();
            },
            snapshot.coins.size > 0 ? REFRESH_MS : RETRY_MS,
        );
    }

    const onVisible = () => {
        if (users > 0 && visible() && Date.now() - askedAt >= REFRESH_MS) void refresh();
    };

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        /** Starts reading on the first user and stops after the last; returns the stop. */
        use() {
            users += 1;
            if (users === 1) {
                // After the page's own first requests, so the charts never hold up the sentence.
                const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 200));
                idle(() => {
                    if (users > 0) void refresh().then(schedule);
                });
                document.addEventListener("visibilitychange", onVisible);
            }
            return () => {
                users -= 1;
                if (users > 0) return;
                clearTimeout(timer);
                document.removeEventListener("visibilitychange", onVisible);
            };
        },
    };
}

export type PriceHistoryStore = ReturnType<typeof createPriceHistoryStore>;

let shared: PriceHistoryStore | null = null;
const store = () => (shared ??= createPriceHistoryStore({ apiUrl: API_URL }));

const EMPTY: PriceHistorySnapshot = { range: "7d", coins: new Map() };

/** The swap coins' week of prices, loading in the background from the first component that asks. */
export function usePriceHistory(): PriceHistorySnapshot {
    useEffect(() => store().use(), []);
    return useSyncExternalStore(
        (listener) => store().subscribe(listener),
        () => store().getSnapshot(),
        () => EMPTY,
    );
}
