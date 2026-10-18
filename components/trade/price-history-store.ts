import { useEffect, useSyncExternalStore } from "react";
import type { PriceHistoryView, PriceRange } from "@/server/src/protocol";
import { API_URL } from "@/lib/api";
import { reportRefusal, reportUnreachable } from "@/lib/net/report";
import { REQUEST_TIMEOUT_MS, serverSaid, silenceOf } from "@/lib/fetch-failure";

/** One coin's dollar prices, oldest first: [unix ms, USD]. */
export type PricePoints = readonly (readonly [number, number])[];

export type PriceHistorySnapshot = {
    range: PriceRange;
    /** Each coin's prices by symbol; empty until the server has answered. */
    coins: ReadonlyMap<string, PricePoints>;
    /** Why a coin's prices couldn't be read, in plain words, until a read of it works. */
    errors: ReadonlyMap<string, string>;
    /** Why the swap coins' prices couldn't be read, until a read works. */
    swapError: string | null;
};

/** The server reads its week again every 12 minutes, so this never asks for nothing new. */
const REFRESH_MS = 600_000;
/** Until a first answer, ask again soon; a coin whose read failed waits this long too. */
const RETRY_MS = 15_000;
/** How many times in a row the coin wanted is read again by itself after its read failed. */
const MAX_RETRIES = 3;

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
 * Another coin, such as a Long or Short market, is read when it's wanted.
 */
export function createPriceHistoryStore(options: {
    apiUrl: string;
    range?: PriceRange;
    fetch?: typeof fetch;
    now?: () => number;
}) {
    const range = options.range ?? "7d";
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const now = options.now ?? Date.now;
    const listeners = new Set<() => void>();
    let snapshot: PriceHistorySnapshot = { range, coins: new Map(), errors: new Map(), swapError: null };
    const errors = new Map<string, string>();
    let swapError: string | null = null;
    // The swap coins' read, and the coins read when wanted
    let swapCoins: ReadonlyMap<string, PricePoints> = new Map();
    const wantedCoins = new Map<string, PricePoints>();
    const readAt = new Map<string, number>();
    const failedAt = new Map<string, number>();
    const reading = new Set<string>();
    // The coin whose card can be hovered now: the last one wanted
    let current: string | null = null;
    let users = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The one read waiting to be made again, and the coin it is for
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryFor: string | null = null;
    // How many times each coin was read again by itself since it was last wanted
    const retries = new Map<string, number>();
    let askedAt = 0;
    let readingSwapCoins: Promise<void> | null = null;

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    function publish() {
        snapshot = { range, coins: new Map([...wantedCoins, ...swapCoins]), errors: new Map(errors), swapError };
        listeners.forEach((listener) => listener());
    }

    // One read at a time, however many timers and visibility changes ask
    function refresh(): Promise<void> {
        readingSwapCoins ??= read().finally(() => (readingSwapCoins = null));
        return readingSwapCoins;
    }

    async function read() {
        askedAt = now();
        let coins: Map<string, PricePoints> | null = null;
        let reason: string | null = null;
        try {
            const response = await request(`${options.apiUrl}/prices/history?range=${range}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            coins = response.ok ? toCoins(await response.json()) : null;
            if (!response.ok) {
                reason = await serverSaid(response);
                await reportRefusal("Price history", response, reason);
            }
        } catch (error) {
            // Offline or the server is down; the next refresh tries again.
            reason = silenceOf(error);
        }
        if (users === 0) return;
        if (!coins || coins.size === 0) {
            // The coins stay as they were; the card says why they haven't loaded
            swapError = reason ?? "The server sent no prices.";
            publish();
            return;
        }
        swapError = null;
        swapCoins = coins;
        publish();
    }

    /** Reads one coin's series; a coin the server doesn't know or can't read keeps what it had. */
    async function readCoin(symbol: string) {
        if (reading.has(symbol)) return;
        reading.add(symbol);
        const time = now();
        try {
            const response = await request(
                `${options.apiUrl}/prices/history?range=${range}&coins=${encodeURIComponent(symbol)}`,
                { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            );
            const said = response.ok ? null : await serverSaid(response);
            if (said !== null) await reportRefusal("Price history", response, said);
            const points = response.ok ? toCoins(await response.json())?.get(symbol) : undefined;
            if (!points) {
                errors.set(symbol, said ?? "No prices for this coin yet.");
                publish();
                failed(symbol, time);
                return;
            }
            errors.delete(symbol);
            wantedCoins.set(symbol, points);
            readAt.set(symbol, time);
            retries.delete(symbol);
            publish();
        } catch (error) {
            // Offline or the server is down; the pause below tries again.
            reportUnreachable("Price history", error);
            errors.set(symbol, silenceOf(error));
            publish();
            failed(symbol, time);
        } finally {
            reading.delete(symbol);
        }
    }

    /** How much of the pause after the coin's last failed read is left; none once it's over or if it never failed. */
    const pauseLeft = (symbol: string) => RETRY_MS - (now() - (failedAt.get(symbol) ?? -Infinity));
    /** Whether the coin's last read failed less than the pause ago. */
    const failedLately = (symbol: string) => pauseLeft(symbol) > 0;

    /** Reads the coin again after the delay, if it is still the one wanted then; the coin wanted is the only one waited for. */
    function readLater(symbol: string, delay: number) {
        clearTimeout(retryTimer);
        retryFor = symbol;
        retryTimer = setTimeout(() => {
            retryFor = null;
            if (users > 0 && symbol === current && visible()) void readCoin(symbol);
        }, delay);
    }

    /** A failed read is tried again after the pause while the coin is still the one wanted, so its card doesn't wait for the refresh. */
    function failed(symbol: string, time: number) {
        failedAt.set(symbol, time);
        const tried = retries.get(symbol) ?? 0;
        if (symbol !== current || users === 0 || tried >= MAX_RETRIES) return;
        retries.set(symbol, tried + 1);
        readLater(symbol, RETRY_MS);
    }

    function schedule() {
        clearTimeout(timer);
        if (users === 0) return;
        timer = setTimeout(
            async () => {
                if (visible()) {
                    await refresh();
                    if (current && !swapCoins.has(current) && !failedLately(current)) await readCoin(current);
                }
                schedule();
            },
            swapCoins.size > 0 ? REFRESH_MS : RETRY_MS,
        );
    }

    const onVisible = () => {
        if (users === 0 || !visible()) return;
        if (now() - askedAt >= REFRESH_MS) void refresh();
        if (
            current &&
            !swapCoins.has(current) &&
            now() - (readAt.get(current) ?? -Infinity) >= REFRESH_MS &&
            !failedLately(current)
        )
            void readCoin(current);
    };

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        /**
         * Reads a coin's series, such as a perp market's that isn't a swap coin, unless it's in hand: from
         * the swap coins' read (waiting for it if it's out), read in the last 10 minutes, or being read. A coin whose read
         * failed in the last 15 seconds is read when they're over. The last coin wanted is read again with the swap coins
         * while the page is used.
         */
        async want(symbol: string): Promise<void> {
            current = symbol;
            // A swap coin may be in the read that's out
            await readingSwapCoins;
            const time = now();
            if (swapCoins.has(symbol)) return;
            if (time - (readAt.get(symbol) ?? -Infinity) < REFRESH_MS) return;
            if (failedLately(symbol)) {
                // Wanted again inside its pause, perhaps after another coin took the retry: read it when the pause is over
                if (users > 0 && retryFor !== symbol) readLater(symbol, pauseLeft(symbol));
                return;
            }
            retries.delete(symbol);
            await readCoin(symbol);
        },
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
                clearTimeout(retryTimer);
                retryFor = null;
                document.removeEventListener("visibilitychange", onVisible);
            };
        },
    };
}

export type PriceHistoryStore = ReturnType<typeof createPriceHistoryStore>;

let shared: PriceHistoryStore | null = null;

/** The shared store; components call `priceHistoryStore().want(...)` to read a coin ahead. */
export const priceHistoryStore = () => (shared ??= createPriceHistoryStore({ apiUrl: API_URL }));

const EMPTY: PriceHistorySnapshot = { range: "7d", coins: new Map(), errors: new Map(), swapError: null };

/** The swap coins' week of prices, and any coin wanted, loading in the background from the first component that asks. */
export function usePriceHistory(): PriceHistorySnapshot {
    useEffect(() => priceHistoryStore().use(), []);
    return useSyncExternalStore(
        (listener) => priceHistoryStore().subscribe(listener),
        () => priceHistoryStore().getSnapshot(),
        () => EMPTY,
    );
}
