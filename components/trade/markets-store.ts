import { loadCachedTrending, saveCachedTrending } from "@/lib/trade/markets";
import type { MarketView, TrendingView } from "@/server/src/protocol";

export type MarketsSnapshot = {
    trending: MarketView[];
    /** When the server last read Polymarket's list; null until it has one. */
    readAt: string | null;
    query: string;
    /** Search results for `query`; null while it has none, so the trending list shows. */
    results: MarketView[] | null;
    /** The query `results` answers; it trails `query` while a newer one is pending. */
    answered: string | null;
    /** Every question seen, so one picked earlier still resolves after it leaves the list. */
    known: ReadonlyMap<string, MarketView>;
};

const TRENDING_MS = 60_000;
/** Until the server has a list, ask again soon. */
const WARMING_MS = 2_000;
const WATCH_MS = 10_000;
const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY: MarketsSnapshot = { trending: [], readAt: null, query: "", results: null, answered: null, known: new Map() };

const isTrending = (value: unknown): value is TrendingView => !!value && Array.isArray((value as TrendingView).markets);

/** Polymarket's questions as the server serves them, kept fresh while the page is open. */
export function createMarketsStore(options: { apiUrl: string; fetch?: typeof fetch; now?: () => number }) {
    const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const listeners = new Set<() => void>();
    let snapshot = EMPTY;
    let running = false;
    // Apart from `running` so a store that was never started still searches.
    let stopped = false;
    let watched: string | null = null;
    let trendingTimer: ReturnType<typeof setTimeout> | undefined;
    let watchTimer: ReturnType<typeof setInterval> | undefined;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    const set = (next: Partial<MarketsSnapshot>) => {
        snapshot = { ...snapshot, ...next };
        listeners.forEach((listener) => listener());
    };

    const remember = (views: MarketView[]) => {
        const known = new Map(snapshot.known);
        for (const view of views) known.set(view.id, view);
        return known;
    };

    async function runSearch(query: string) {
        const result = await getJson(`/markets/search?q=${encodeURIComponent(query)}`);
        // The sent string is the token: an answer for an older query is dropped.
        if (stopped || !result || query !== snapshot.query) return;
        const body = result.body as { markets?: unknown } | null;
        if (!body || !Array.isArray(body.markets)) return;
        const markets = body.markets as MarketView[];
        set({ results: markets, answered: query, known: remember(markets) });
    }

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    async function getJson(path: string): Promise<{ status: number; body: unknown } | null> {
        try {
            const response = await request(`${options.apiUrl}${path}`);
            return { status: response.status, body: response.ok ? await response.json() : null };
        } catch {
            return null;
        }
    }

    async function refreshTrending() {
        const result = await getJson("/markets/trending");
        if (!running || !result || !isTrending(result.body)) return;
        const view = result.body;
        // An empty answer from a server still warming up shouldn't wipe the cached list.
        if (view.markets.length === 0 && view.readAt === null) return;
        set({ trending: view.markets, readAt: view.readAt, known: remember(view.markets) });
        if (view.readAt !== null) saveCachedTrending(view);
    }

    function scheduleTrending() {
        clearTimeout(trendingTimer);
        if (!running) return;
        trendingTimer = setTimeout(
            async () => {
                if (visible()) await refreshTrending();
                scheduleTrending();
            },
            snapshot.readAt === null ? WARMING_MS : TRENDING_MS,
        );
    }

    async function refreshWatched() {
        const id = watched;
        if (!id || !running || !visible()) return;
        const result = await getJson(`/markets/${encodeURIComponent(id)}`);
        if (!running || !result || id !== watched) return;
        if (result.status === 404) {
            const known = new Map(snapshot.known);
            known.delete(id);
            set({
                known,
                trending: snapshot.trending.filter((m) => m.id !== id),
                results: snapshot.results && snapshot.results.filter((m) => m.id !== id),
            });
        } else if (result.body) {
            const view = result.body as MarketView;
            set({
                known: remember([view]),
                trending: snapshot.trending.map((m) => (m.id === view.id ? view : m)),
                results: snapshot.results && snapshot.results.map((m) => (m.id === view.id ? view : m)),
            });
        }
    }

    function syncWatch() {
        clearInterval(watchTimer);
        watchTimer = undefined;
        if (running && watched) watchTimer = setInterval(refreshWatched, WATCH_MS);
    }

    const onVisible = () => {
        if (!visible() || !running) return;
        void refreshTrending();
        void refreshWatched();
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
            stopped = false;
            const cached = loadCachedTrending();
            if (cached && snapshot.trending.length === 0) {
                set({ trending: cached.markets, readAt: cached.readAt, known: remember(cached.markets) });
            }
            void refreshTrending().then(scheduleTrending);
            syncWatch();
            document.addEventListener("visibilitychange", onVisible);
        },
        stop() {
            if (!running) return;
            running = false;
            stopped = true;
            clearTimeout(trendingTimer);
            clearInterval(watchTimer);
            clearTimeout(searchTimer);
            document.removeEventListener("visibilitychange", onVisible);
        },
        search(query: string) {
            if (stopped) return;
            const trimmed = query.trim();
            if (trimmed === snapshot.query) return;
            clearTimeout(searchTimer);
            if (trimmed.length < SEARCH_MIN) {
                set({ query: "", results: null, answered: null });
                return;
            }
            // The earlier results stay on screen until this query's answer replaces them.
            set({ query: trimmed });
            searchTimer = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS);
        },
        watch(eventId: string | null) {
            if (eventId === watched) return;
            watched = eventId;
            syncWatch();
        },
    };
}

export type MarketsStore = ReturnType<typeof createMarketsStore>;
