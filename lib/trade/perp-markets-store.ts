import { API_URL } from "@/lib/api";
import type { PerpMarketsView } from "@/server/src/protocol";
import { PERP_MARKETS, type PerpMarket } from "./catalog";
import { reportRefusal, reportUnreachable } from "@/lib/net/report";

const REFRESH_MS = 10_000;

const isMarketsView = (value: unknown): value is PerpMarketsView => {
    const view = value as PerpMarketsView | null;
    return (
        !!view &&
        Array.isArray(view.markets) &&
        view.markets.every(
            (m) =>
                !!m &&
                typeof m.asset === "string" &&
                typeof m.markPx === "string" &&
                typeof m.fundingRate === "string" &&
                typeof m.maxLeverage === "number" &&
                Number.isFinite(m.maxLeverage) &&
                m.maxLeverage >= 1,
        ) &&
        (view.maxOrderUSD === null || typeof view.maxOrderUSD === "string")
    );
};

/** The markets the sentence offers: the server's list once it has one, the built-in fallback until then. */
export function perpMarketsOf(view: PerpMarketsView | null): PerpMarket[] {
    if (!view || view.markets.length === 0) return PERP_MARKETS;
    return view.markets.map((m) => ({ asset: m.asset, maxLeverage: m.maxLeverage, markPx: Number(m.markPx) }));
}

/** The most one order may take, in dollars; null while trading is off or nothing has loaded. */
export function perpMaxOrderUSD(view: PerpMarketsView | null): number | null {
    const limit = view?.maxOrderUSD == null ? NaN : Number(view.maxOrderUSD);
    return Number.isFinite(limit) && limit >= 0 ? limit : null;
}

/** The server's perp markets and order limit; a failed read keeps the last good view. */
export function createPerpMarketsStore(options: { apiUrl: string; fetch?: typeof fetch }) {
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const listeners = new Set<() => void>();
    let view: PerpMarketsView | null = null;
    let error: string | null = null;

    /** Remembers why the last read failed, and says so once in the console; a read that works clears it. */
    const failed = (why: string | null) => {
        if (why === error) return;
        error = why;
        if (why) console.warn(`Couldn't load the Long and Short markets: ${why}`);
        listeners.forEach((listener) => listener());
    };

    return {
        async load(): Promise<void> {
            try {
                const response = await request(`${options.apiUrl}/perps/markets`);
                if (!response.ok) {
                    await reportRefusal("Perp markets", response);
                    return failed(`HTTP ${response.status}`);
                }
                const body: unknown = await response.json();
                if (!isMarketsView(body)) return failed("unexpected response");
                view = body;
                error = null;
                listeners.forEach((listener) => listener());
            } catch (caught) {
                // Offline or the server is down; the last good view stays and the next refresh tries again.
                reportUnreachable("Perp markets", caught);
                failed("offline");
            }
        },
        get: () => view,
        /** Why the last read failed ("HTTP 429", "offline", "unexpected response"), or null. */
        error: () => error,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}

const shared = createPerpMarketsStore({ apiUrl: API_URL });

export const loadPerpMarkets = shared.load;
export const getPerpMarkets = shared.get;
export const getPerpMarketsError = shared.error;
export const subscribePerpMarkets = shared.subscribe;

/** Reads the markets now and every few seconds while the page is visible; returns the stop function. */
export function watchPerpMarkets(): () => void {
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    void loadPerpMarkets();
    const timer = setInterval(() => {
        if (visible()) void loadPerpMarkets();
    }, REFRESH_MS);
    return () => clearInterval(timer);
}
