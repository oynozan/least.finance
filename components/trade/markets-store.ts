import { REQUEST_TIMEOUT_MS, serverSaid, silenceOf } from "@/lib/fetch-failure";
import { isMarketView, loadCachedTrending, saveCachedTrending, validMarkets } from "@/lib/trade/markets";
import type { MarketView, PoolState, TrendingView } from "@/server/src/protocol";

/** A paused pool: the state that tells the outcome rows why, and the server's sentence for the notice. */
export type PoolPause = { state: Exclude<PoolState, "open" | "off">; message: string | null };
const PAUSED_STATES: readonly string[] = ["unread", "low", "settling"];

export type MarketsSnapshot = {
    trending: MarketView[];
    /** When the server last read Polymarket's list; null until it has one. */
    readAt: string | null;
    /** The most one prediction may spend while trading is live; null when it isn't. */
    maxOrderUSD: number | null;
    /** Why the pool can't take orders, as the server says it; null while it is open, off or the server doesn't say. */
    pool: PoolPause | null;
    query: string;
    /** Search results for `query`; null while it has none, so the trending list shows. */
    results: MarketView[] | null;
    /** The query `results` answers; it trails `query` while a newer one is pending. */
    answered: string | null;
    /** The search for `answered` got no answer, so `results` stays null. */
    searchFailed: boolean;
    /** Why that search got no answer, in plain words: offline, no answer in time, or the server's own message. */
    searchError: string | null;
    /** Why there is no trending list to show, in plain words; null while there is one or none has been tried. */
    trendingError: string | null;
    /** Until the first answer for the trending list, or a cached one, there is nothing to show. */
    loading: boolean;
    /** Every question seen, so one picked earlier still resolves after it leaves the list. */
    known: ReadonlyMap<string, MarketView>;
};

const TRENDING_MS = 60_000;
/** Until the server has a list, ask again soon. */
const WARMING_MS = 2_000;
/** After this many empty answers in a row the wait stretches, so a server that can't read Polymarket isn't asked every 2 s. */
const WARMING_TRIES = 5;
const SLOW_WARMING_MS = 10_000;
const WATCH_MS = 10_000;
const HELD_MAX = 20;
const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY: MarketsSnapshot = {
    trending: [],
    readAt: null,
    maxOrderUSD: null,
    pool: null,
    query: "",
    results: null,
    answered: null,
    searchFailed: false,
    searchError: null,
    trendingError: null,
    loading: true,
    known: new Map(),
};

const limitOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

const poolOf = (view: TrendingView): PoolPause | null =>
    typeof view.poolState === "string" && PAUSED_STATES.includes(view.poolState)
        ? {
              state: view.poolState as PoolPause["state"],
              message: typeof view.poolMessage === "string" && view.poolMessage ? view.poolMessage : null,
          }
        : null;

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
    let emptyAnswers = 0;
    const warned = new Set<string>();

    /** Said once per distinct failure in development, so a developer sees what the page was told. */
    const note = (what: string, message: string) => {
        if (process.env.NODE_ENV === "production" || warned.has(`${what}|${message}`)) return;
        warned.add(`${what}|${message}`);
        console.warn(`${what}: ${message}`);
    };

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
        const body = result.body as { markets?: unknown } | null | undefined;
        if (!body || !Array.isArray(body.markets)) {
            const searchError = result.error ?? "The server sent something we couldn't read.";
            note("Market search failed", searchError);
            set({ results: null, answered: query, searchFailed: true, searchError });
            return;
        }
        const markets = validMarkets(body.markets);
        set({ results: markets, answered: query, searchFailed: false, searchError: null, known: remember(markets) });
    }

    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    /** What came back, or why nothing did: `error` is the server's own message when it sent one, else which kind of silence it was. */
    async function getJson(path: string): Promise<{ status: number; body: unknown; error: string | null }> {
        try {
            const response = await request(`${options.apiUrl}${path}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (response.ok) return { status: response.status, body: await response.json(), error: null };
            return { status: response.status, body: null, error: await serverSaid(response) };
        } catch (error) {
            return { status: 0, body: null, error: silenceOf(error) };
        }
    }

    async function refreshTrending() {
        const result = await getJson("/markets/trending");
        if (!running) return;
        // Any answer, even a failed or empty one, ends the wait: the picker then says what it has.
        if (!isTrending(result.body)) {
            const trendingError = result.error ?? "The server sent something we couldn't read.";
            note("Market list failed", trendingError);
            set({ ...(snapshot.loading && { loading: false }), trendingError });
            return;
        }
        const view = { ...result.body, markets: validMarkets(result.body.markets) };
        // An empty answer from a server still warming up shouldn't wipe the cached list.
        if (view.markets.length === 0 && view.readAt === null) {
            emptyAnswers++;
            const reason = (result.body as { unavailableReason?: unknown }).unavailableReason;
            const trendingError = typeof reason === "string" ? reason : null;
            if (trendingError) note("Market list is empty", trendingError);
            set({ ...(snapshot.loading && { loading: false }), trendingError });
            return;
        }
        emptyAnswers = 0;
        set({
            trendingError: null,
            loading: false,
            trending: view.markets,
            readAt: view.readAt,
            maxOrderUSD: limitOf(view.maxOrderUSD),
            pool: poolOf(view),
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
            snapshot.readAt === null ? (emptyAnswers >= WARMING_TRIES ? SLOW_WARMING_MS : WARMING_MS) : TRENDING_MS,
        );
    }

    async function refreshWatched() {
        const id = watched;
        if (!id || !running || !visible()) return;
        const result = await getJson(`/markets/${encodeURIComponent(id)}`);
        if (!running || result.status === 0 || id !== watched) return;
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
        const views = answers.flatMap((answer) => (isMarketView(answer.body) ? [answer.body] : []));
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
