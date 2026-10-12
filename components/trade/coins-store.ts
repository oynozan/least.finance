import { isCatalogView, loadCachedCatalog, saveCachedCatalog } from "@/lib/trade/live-coins";
import type { SwapCatalogView } from "@/server/src/protocol";

export type CoinsSnapshot = {
    /** The server's swap coins with their live prices; null until a cached or fetched one is in. */
    view: SwapCatalogView | null;
};

const REFRESH_MS = 300_000;
/** Until the server has read its prices, ask again soon. */
const WARMING_MS = 10_000;

/** The server's swap coins and their prices, kept in the browser and fresh while the page is visible. */
export function createCoinsStore(options: { apiUrl: string; fetch?: typeof fetch; refreshMs?: number }) {
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const refreshMs = options.refreshMs ?? REFRESH_MS;
    const listeners = new Set<() => void>();
    let snapshot: CoinsSnapshot = { view: null };
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let askedAt = 0;

    const set = (view: SwapCatalogView) => {
        snapshot = { view };
        listeners.forEach((listener) => listener());
    };

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    async function refresh() {
        askedAt = Date.now();
        let body: unknown;
        try {
            const response = await request(`${options.apiUrl}/swaps/catalog`);
            body = response.ok ? await response.json() : null;
        } catch {
            return;
        }
        if (!running || !isCatalogView(body)) return;
        // A server that hasn't read its prices yet doesn't replace the ones in hand.
        if (body.readAt === null && snapshot.view) return;
        set(body);
        if (body.readAt !== null) saveCachedCatalog(body);
    }

    function schedule() {
        clearTimeout(timer);
        if (!running) return;
        timer = setTimeout(
            async () => {
                if (visible()) await refresh();
                schedule();
            },
            snapshot.view?.readAt ? refreshMs : WARMING_MS,
        );
    }

    const onVisible = () => {
        if (running && visible() && Date.now() - askedAt >= refreshMs) void refresh();
    };

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        start() {
            if (running) return;
            running = true;
            const cached = loadCachedCatalog();
            if (cached && !snapshot.view) set(cached);
            void refresh().then(schedule);
            document.addEventListener("visibilitychange", onVisible);
        },
        stop() {
            if (!running) return;
            running = false;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        },
    };
}

export type CoinsStore = ReturnType<typeof createCoinsStore>;
