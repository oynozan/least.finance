import { isMarketView, loadCachedTrending, saveCachedTrending, validMarkets } from "@/lib/trade/markets";
import type { MarketView, TrendingView } from "@/server/src/protocol";

export type MarketsSnapshot = {
    trending: MarketView[];
    /** When the server last read Polymarket's list; null until it has one. */
    readAt: string | null;
    /** The most one prediction may spend while trading is live; null when it isn't. */
    maxOrderUSD: number | null;
    query: string;
    /** Search results for `query`; null while it has none, so the trending list shows. */
    results: MarketView[] | null;
    /** The query `results` answers; it trails `query` while a newer one is pending. */
    answered: string | null;
    /** The search for `answered` got no answer, so `results` stays null. */
    searchFailed: boolean;
    /** Why it got none, in the server's words or ours; null when the search didn't fail or nothing said. */
    searchError: string | null;
    /** Until the first answer for the trending list, or a cached one, there is nothing to show. */
    loading: boolean;
    /** Every question seen, so one picked earlier still resolves after it leaves the list. */
    known: ReadonlyMap<string, MarketView>;
};

const TRENDING_MS = 60_000;
/** Until the server has a list, ask again soon. */
const WARMING_MS = 2_000;
const WATCH_MS = 10_000;
const HELD_MAX = 20;
const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY: MarketsSnapshot = {
    trending: [],
    readAt: null,
    maxOrderUSD: null,
    query: "",
    results: null,
    answered: null,
    searchFailed: false,
    searchError: null,
    loading: true,
    known: new Map(),
};

const limitOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

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
    let held: string[] = [];
    let heldTimer: ReturnType<typeof setInterval> | undefined;
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
        if (stopped || query !== snapshot.query) return;
        const body = result?.body as { markets?: unknown } | null | undefined;
        if (!body || !Array.isArray(body.markets)) {
            set({ results: null, answered: query, searchFailed: true, searchError: result?.error ?? null });
            return;
        }
        const markets = validMarkets(body.markets);
        set({ results: markets, answered: query, searchFailed: false, searchError: null, known: remember(markets) });
    }

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    /** `error` is why there is no body: the server's own message from a refusal, or that the browser is offline. */
    async function getJson(path: string): Promise<{ status: number; body: unknown; error?: string } | null> {
        try {
            const response = await request(`${options.apiUrl}${path}`);
            if (response.ok) return { status: response.status, body: await response.json() };
            const refusal = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
            const said = refusal?.error?.message;
            return { status: response.status, body: null, ...(typeof said === "string" ? { error: said } : {}) };
        } catch {
            return typeof navigator !== "undefined" && navigator.onLine === false
                ? { status: 0, body: null, error: "You're offline." }
                : null;
        }
    }

    async function refreshTrending() {
        const result = await getJson("/markets/trending");
        if (!running) return;
        // Any answer, even a failed or empty one, ends the wait: the picker then says what it has.
        if (!result || !isTrending(result.body)) {
            if (snapshot.loading) set({ loading: false });
            return;
        }
        const view = { ...result.body, markets: validMarkets(result.body.markets) };
        // An empty answer from a server still warming up shouldn't wipe the cached list.
        if (view.markets.length === 0 && view.readAt === null) {
            if (snapshot.loading) set({ loading: false });
            return;
        }
        set({
            loading: false,
            trending: view.markets,
            readAt: view.readAt,
            maxOrderUSD: limitOf(view.maxOrderUSD),
            known: remember(view.markets),
        });
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
        if (result.status === 404 || (result.body && !isMarketView(result.body))) {
            const known = new Map(snapshot.known);
            known.delete(id);
            set({
                known,
                trending: snapshot.trending.filter((m) => m.id !== id),
                results: snapshot.results && snapshot.results.filter((m) => m.id !== id),
            });
        } else if (isMarketView(result.body)) {
            const view = result.body;
            set({
                known: remember([view]),
                trending: snapshot.trending.map((m) => (m.id === view.id ? view : m)),
                results: snapshot.results && snapshot.results.map((m) => (m.id === view.id ? view : m)),
            });
        }
    }

    async function refreshHeld() {
        if (!running || !visible()) return;
        const ids = held;
        const answers = await Promise.all(ids.map((id) => getJson(`/markets/${encodeURIComponent(id)}`)));
        if (!running) return;
        const views = answers.flatMap((answer) => (answer && isMarketView(answer.body) ? [answer.body] : []));
        if (views.length === 0) return;
        const fresh = new Map(views.map((v) => [v.id, v]));
        set({
            known: remember(views),
            trending: snapshot.trending.map((m) => fresh.get(m.id) ?? m),
            results: snapshot.results && snapshot.results.map((m) => fresh.get(m.id) ?? m),
        });
    }

    function syncHeld() {
        clearInterval(heldTimer);
        heldTimer = undefined;
        if (running && held.length > 0) heldTimer = setInterval(refreshHeld, TRENDING_MS);
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
        void refreshHeld();
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
                // The limit is only as old as the answer that gave it, so a cache never turns live trading on
                set({
                    trending: cached.markets,
                    readAt: cached.readAt,
                    loading: false,
                    known: remember(cached.markets),
                });
            }
            void refreshTrending().then(scheduleTrending);
            syncWatch();
            syncHeld();
            if (held.length > 0) void refreshHeld();
            document.addEventListener("visibilitychange", onVisible);
        },
        stop() {
            if (!running) return;
            running = false;
            stopped = true;
            clearTimeout(trendingTimer);
            clearInterval(watchTimer);
            clearInterval(heldTimer);
            clearTimeout(searchTimer);
            document.removeEventListener("visibilitychange", onVisible);
        },
        search(query: string) {
            if (stopped) return;
            const trimmed = query.trim();
            if (trimmed === snapshot.query) return;
            clearTimeout(searchTimer);
            if (trimmed.length < SEARCH_MIN) {
                set({ query: "", results: null, answered: null, searchFailed: false, searchError: null });
                return;
            }
            // The earlier results stay on screen until this query's answer replaces them.
            set({ query: trimmed });
            searchTimer = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS);
        },
        /** Keeps these questions' prices fresh, so open positions show a live value; only the first 20 are read. */
        hold(eventIds: string[]) {
            const next = [...new Set(eventIds)].slice(0, HELD_MAX);
            if (next.length === held.length && next.every((id, i) => id === held[i])) return;
            held = next;
            syncHeld();
            if (running && held.length > 0) void refreshHeld();
        },
        watch(eventId: string | null) {
            if (eventId === watched) return;
            watched = eventId;
            syncWatch();
        },
    };
}

export type MarketsStore = ReturnType<typeof createMarketsStore>;
