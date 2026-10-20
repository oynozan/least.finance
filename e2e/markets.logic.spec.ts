import { expect, test } from "@playwright/test";
import { createMarketsStore } from "@/components/trade/markets-store";
import { isMarketView, loadCachedTrending, toPredictionMarket } from "@/lib/trade/markets";
import type { MarketView } from "@/server/src/protocol";

const view = (title: string, endDate: string): MarketView => ({
    id: "77",
    title,
    image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/a.png",
    endDate,
    volume24hUSD: 1000,
    outcomes: [
        {
            tokenId: "t-yes",
            label: "YES",
            buyPrice: 0.42,
            chance: 0.41,
            tone: "gain",
            minUSD: 1.5,
            image: null,
            sellPrice: 0.41,
            minShares: 5,
        },
        {
            tokenId: "t-no",
            label: "NO",
            buyPrice: 0.59,
            chance: 0.59,
            tone: "loss",
            minUSD: 1,
            sellPrice: 0.58,
            minShares: 5,
            image: "https://x/n.png",
        },
    ],
});

test.describe("live markets", () => {
    test("toPredictionMarket maps a view and formats its close date", () => {
        const now = new Date(2026, 9, 12);
        const market = toPredictionMarket(view("Will it rain?", "2026-10-29T12:00:00Z"), now);
        expect(market).toMatchObject({
            id: "77",
            question: "Will it rain?",
            short: "Will it rain?",
            symbol: "",
            closes: "Oct 29",
            image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/a.png",
        });
        expect(market.outcomes[0]).toEqual({
            id: "t-yes",
            label: "YES",
            price: 0.42,
            chance: 0.41,
            tone: "gain",
            minUSD: 1.5,
            image: undefined,
        });
        expect(market.outcomes[1].image).toBe("https://x/n.png");
        expect(toPredictionMarket(view("Q", "2028-11-08T12:00:00Z"), now).closes).toBe("Nov 8, 2028");
    });

    test("short titles cut at a word boundary", () => {
        const now = new Date(2026, 9, 12);
        const short = (title: string) => toPredictionMarket(view(title, "2026-10-29T12:00:00Z"), now).short;
        expect(short("Democratic Presidential Nominee 2028")).toBe("Democratic Presidential…");
        expect(short("Supercalifragilisticexpialidocious")).toBe("Supercalifragilisticexpi…");
    });

    test("a corrupt or old-shaped cache is ignored", () => {
        const store = new Map<string, string>();
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
        };
        try {
            expect(loadCachedTrending()).toBeNull();
            for (const raw of ["{", "[]", '{"markets":{}}']) {
                store.set("markets:trending", raw);
                expect(loadCachedTrending()).toBeNull();
            }
            store.set(
                "markets:trending",
                JSON.stringify({ markets: [], maxOrderUSD: null, readAt: "2026-10-12T00:00:00Z" }),
            );
            expect(loadCachedTrending()).toMatchObject({ readAt: "2026-10-12T00:00:00Z" });
        } finally {
            delete (globalThis as { localStorage?: unknown }).localStorage;
        }
    });

    test("a cache with a malformed market keeps only the good ones", () => {
        const store = new Map<string, string>();
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
        };
        try {
            const good = view("Good", "2030-01-01T00:00:00Z");
            store.set(
                "markets:trending",
                JSON.stringify({ markets: [{ id: "1" }, good], maxOrderUSD: null, readAt: "2026-10-12T00:00:00Z" }),
            );
            expect(loadCachedTrending()?.markets).toEqual([good]);
        } finally {
            delete (globalThis as { localStorage?: unknown }).localStorage;
        }
    });

    test("held questions are read now and then kept fresh, at most 20, and a view without sell prices is still valid", async () => {
        (globalThis as { document?: unknown }).document = {
            visibilityState: "visible",
            addEventListener() {},
            removeEventListener() {},
        };
        const asked: string[] = [];
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        try {
            const store = createMarketsStore({
                apiUrl: "http://api",
                fetch: async (input) => {
                    const url = String(input);
                    asked.push(url);
                    if (url.includes("/markets/trending"))
                        return new Response(JSON.stringify({ markets: [], maxOrderUSD: null, readAt: null }));
                    const id = url.split("/markets/")[1]!;
                    return new Response(JSON.stringify({ ...view("Held", "2030-01-01T00:00:00Z"), id }));
                },
            });
            store.start();
            store.hold(Array.from({ length: 25 }, (_, i) => String(i + 100)));
            await wait(100);
            const held = asked.filter((u) => /\/markets\/\d+$/.test(u));
            expect(held).toHaveLength(20);
            expect([...store.getSnapshot().known.keys()]).toHaveLength(20);
            store.stop();

            const old = { ...view("Old", "2030-01-01T00:00:00Z") };
            old.outcomes = old.outcomes.map(({ tokenId, label, buyPrice, chance, tone, minUSD, image }) => ({
                tokenId,
                label,
                buyPrice,
                chance,
                tone,
                minUSD,
                image,
            })) as MarketView["outcomes"];
            expect(isMarketView(old)).toBe(true);
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    });

    test("a paused pool's state and sentence reach the snapshot, and an open or unknown one leaves none", async () => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        (globalThis as { document?: unknown }).document = {
            visibilityState: "visible",
            addEventListener() {},
            removeEventListener() {},
        };
        const body = {
            markets: [view("Good", "2030-01-01T00:00:00Z")],
            maxOrderUSD: 0,
            readAt: "2026-10-12T00:00:00Z",
        };
        const poolOf = async (extra: object) => {
            const store = createMarketsStore({
                apiUrl: "http://api",
                fetch: async () => new Response(JSON.stringify({ ...body, ...extra })),
            });
            store.start();
            await wait(50);
            store.stop();
            return store.getSnapshot().pool;
        };
        try {
            expect(await poolOf({ poolState: "low", poolMessage: "Too low." })).toEqual({
                state: "low",
                message: "Too low.",
            });
            expect(await poolOf({ poolState: "unread" })).toEqual({ state: "unread", message: null });
            expect(await poolOf({ poolState: "open" })).toBeNull();
            expect(await poolOf({ poolState: "mystery", poolMessage: "x" })).toBeNull();
            expect(await poolOf({})).toBeNull();
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    });

    test("maxOrderUSD survives the trending cache", async () => {
        const kept = new Map<string, string>();
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
        };
        (globalThis as { document?: unknown }).document = {
            visibilityState: "visible",
            addEventListener() {},
            removeEventListener() {},
        };
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const body = {
            markets: [view("Good", "2030-01-01T00:00:00Z")],
            maxOrderUSD: 20,
            readAt: "2026-10-12T00:00:00Z",
        };
        try {
            const first = createMarketsStore({
                apiUrl: "http://api",
                fetch: async () => new Response(JSON.stringify(body)),
            });
            expect(first.getSnapshot().maxOrderUSD).toBeNull();
            first.start();
            await wait(50);
            first.stop();
            expect(first.getSnapshot().maxOrderUSD).toBe(20);
            // A new page load: the cache answers before the network does.
            const second = createMarketsStore({
                apiUrl: "http://api",
                fetch: async () => {
                    throw new Error("offline");
                },
            });
            second.start();
            second.stop();
            // A stale cache never switches the review to live trading
            expect(second.getSnapshot().maxOrderUSD).toBeNull();
            expect(second.getSnapshot().trending).toHaveLength(1);
            // A bad value is no limit at all.
            const third = createMarketsStore({
                apiUrl: "http://api",
                fetch: async () => new Response(JSON.stringify({ ...body, maxOrderUSD: "20" })),
            });
            third.start();
            await wait(50);
            third.stop();
            expect(third.getSnapshot().maxOrderUSD).toBeNull();
        } finally {
            delete (globalThis as { localStorage?: unknown }).localStorage;
            delete (globalThis as { document?: unknown }).document;
        }
    });

    test("loading lasts until the first trending answer, whatever it says", async () => {
        (globalThis as { document?: unknown }).document = {
            visibilityState: "visible",
            addEventListener() {},
            removeEventListener() {},
        };
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const reply =
            (body: unknown, status = 200): typeof fetch =>
            async () =>
                new Response(JSON.stringify(body), { status });
        const answers: [string, typeof fetch][] = [
            [
                "a list",
                reply({
                    markets: [view("Good", "2030-01-01T00:00:00Z")],
                    maxOrderUSD: null,
                    readAt: "2026-10-12T00:00:00Z",
                }),
            ],
            ["a warming server", reply({ markets: [], maxOrderUSD: null, readAt: null })],
            ["an error status", reply({ error: "unavailable" }, 503)],
            [
                "no answer",
                async () => {
                    throw new Error("offline");
                },
            ],
        ];
        try {
            for (const [name, fetch] of answers) {
                const store = createMarketsStore({ apiUrl: "http://api", fetch });
                expect(store.getSnapshot().loading, name).toBe(true);
                store.start();
                await wait(50);
                store.stop();
                expect(store.getSnapshot().loading, name).toBe(false);
            }
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    });

    test("a cached list ends the loading at once", async () => {
        const cached = {
            markets: [view("Cached", "2030-01-01T00:00:00Z")],
            maxOrderUSD: null,
            readAt: "2026-10-12T00:00:00Z",
        };
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: () => JSON.stringify(cached),
            setItem() {},
        };
        (globalThis as { document?: unknown }).document = {
            visibilityState: "visible",
            addEventListener() {},
            removeEventListener() {},
        };
        try {
            // The network never answers, so only the cache can end the wait
            const store = createMarketsStore({ apiUrl: "http://api", fetch: () => new Promise<Response>(() => {}) });
            store.start();
            store.stop();
            expect(store.getSnapshot()).toMatchObject({ loading: false, trending: cached.markets });
        } finally {
            delete (globalThis as { localStorage?: unknown }).localStorage;
            delete (globalThis as { document?: unknown }).document;
        }
    });

    test.describe("malformed answers", () => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const good = view("Good", "2030-01-01T00:00:00Z");
        const bad = { id: "9", title: "Bad" } as unknown as MarketView;
        const answer =
            (body: unknown, status = 200): typeof fetch =>
            async () =>
                new Response(JSON.stringify(body), { status });
        const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

        test("a trending response drops only the malformed market", async () => {
            (globalThis as { document?: unknown }).document = doc;
            try {
                const store = createMarketsStore({
                    apiUrl: "http://api",
                    fetch: answer({ markets: [bad, good], maxOrderUSD: null, readAt: "2026-10-12T00:00:00Z" }),
                });
                store.start();
                await wait(50);
                store.stop();
                expect(store.getSnapshot().trending).toEqual([good]);
                expect([...store.getSnapshot().known.keys()]).toEqual(["77"]);
            } finally {
                delete (globalThis as { document?: unknown }).document;
            }
        });

        test("a search response drops only the malformed market", async () => {
            const store = createMarketsStore({
                apiUrl: "http://api",
                fetch: answer({ query: "fed", markets: [bad, good] }),
            });
            store.search("fed");
            await wait(350);
            expect(store.getSnapshot().results).toEqual([good]);
        });

        test("a malformed event answer counts like a 404", async () => {
            (globalThis as { document?: unknown }).document = doc;
            try {
                const store = createMarketsStore({
                    apiUrl: "http://api",
                    fetch: async (input) =>
                        String(input).includes("/markets/trending")
                            ? new Response(
                                  JSON.stringify({
                                      markets: [good],
                                      maxOrderUSD: null,
                                      readAt: "2026-10-12T00:00:00Z",
                                  }),
                              )
                            : new Response(JSON.stringify({ id: "77", title: "x" })),
                });
                store.start();
                await wait(50);
                expect(store.getSnapshot().trending).toHaveLength(1);
                store.watch("77");
                await wait(10_100);
                store.stop();
                expect(store.getSnapshot().trending).toEqual([]);
                expect(store.getSnapshot().known.has("77")).toBe(false);
            } finally {
                delete (globalThis as { document?: unknown }).document;
            }
        });
    });

    test.describe("search", () => {
        const market = (id: string, title: string): MarketView => ({ ...view(title, "2030-01-01T00:00:00Z"), id });
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

        /** A fetch that records search requests and lets each one be answered by hand. */
        function fakeSearch() {
            const pending = new Map<string, (markets: MarketView[]) => void>();
            const asked: string[] = [];
            const fake: typeof fetch = async (input) => {
                const url = String(input);
                if (!url.includes("/markets/search")) return json({ markets: [], maxOrderUSD: null, readAt: null });
                const q = new URL(url).searchParams.get("q")!;
                asked.push(q);
                const markets = await new Promise<MarketView[]>((resolve) => pending.set(q, resolve));
                return json({ query: q, markets });
            };
            return { fake, pending, asked };
        }

        test("a slow search can't overwrite a newer one", async () => {
            const { fake, pending, asked } = fakeSearch();
            const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
            store.search("fe");
            await wait(300);
            store.search("fed");
            await wait(300);
            expect(asked).toEqual(["fe", "fed"]);
            pending.get("fed")!([market("1", "Fed decision")]);
            await wait(20);
            pending.get("fe")!([market("2", "Female president")]);
            await wait(20);
            const snapshot = store.getSnapshot();
            expect(snapshot.query).toBe("fed");
            expect(snapshot.results?.map((m) => m.id)).toEqual(["1"]);
            expect([...snapshot.known.keys()]).toEqual(["1"]);
        });

        test("a query under 2 characters clears the results without fetching", async () => {
            const { fake, pending, asked } = fakeSearch();
            const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
            store.search(" fed ");
            await wait(300);
            expect(store.getSnapshot().query).toBe("fed");
            pending.get("fed")!([market("1", "Fed decision")]);
            await wait(20);
            expect(store.getSnapshot().results).toHaveLength(1);
            store.search(" f ");
            expect(store.getSnapshot()).toMatchObject({ query: "", results: null });
            await wait(300);
            expect(asked).toEqual(["fed"]);
        });

        test("typing quickly sends one request", async () => {
            const { fake, asked } = fakeSearch();
            const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
            store.search("fe");
            await wait(100);
            store.search("fed");
            await wait(100);
            store.search("fed r");
            await wait(100);
            expect(asked).toEqual([]);
            await wait(300);
            expect(asked).toEqual(["fed r"]);
        });

        test("a stopped store ignores late answers and new searches", async () => {
            const { fake, pending, asked } = fakeSearch();
            const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
            (globalThis as { document?: unknown }).document = doc;
            try {
                const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
                store.start();
                store.search("fed");
                await wait(300);
                expect(asked).toEqual(["fed"]);
                const before = store.getSnapshot();
                let calls = 0;
                store.subscribe(() => calls++);
                store.stop();
                pending.get("fed")!([market("1", "Fed decision")]);
                await wait(20);
                store.search("fede");
                await wait(300);
                expect(store.getSnapshot()).toBe(before);
                expect(calls).toBe(0);
                expect(asked).toEqual(["fed"]);
            } finally {
                delete (globalThis as { document?: unknown }).document;
            }
        });

        test("a pending search cancelled by stop never fetches", async () => {
            const { fake, asked } = fakeSearch();
            const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
            (globalThis as { document?: unknown }).document = doc;
            try {
                const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
                store.start();
                store.search("fed");
                store.stop();
                await wait(300);
                expect(asked).toEqual([]);
            } finally {
                delete (globalThis as { document?: unknown }).document;
            }
        });

        test("a failed search is answered as failed, and an answered one clears it", async () => {
            const replies: (() => Response)[] = [
                () => {
                    throw new Error("offline");
                },
                () =>
                    new Response(
                        JSON.stringify({
                            error: {
                                code: "unavailable",
                                message: "Polymarket is rate limiting us right now. Try again in a minute.",
                            },
                        }),
                        { status: 503 },
                    ),
                () => json({ query: "fed r", markets: [market("1", "Fed decision")] }),
            ];
            const store = createMarketsStore({ apiUrl: "http://api", fetch: async () => replies.shift()!() });
            const reasons = [
                "Couldn't reach the server.",
                "Polymarket is rate limiting us right now. Try again in a minute.",
            ];
            for (const query of ["fed", "fede"]) {
                store.search(query);
                await wait(300);
                // The server's own words reach the snapshot; with no answer it says which kind of silence
                expect(store.getSnapshot(), query).toMatchObject({
                    query,
                    answered: query,
                    results: null,
                    searchFailed: true,
                    searchError: reasons.shift(),
                });
            }
            store.search("fed r");
            await wait(300);
            expect(store.getSnapshot()).toMatchObject({ answered: "fed r", searchFailed: false, searchError: null });
            expect(store.getSnapshot().results?.map((m) => m.id)).toEqual(["1"]);
        });

        test("a trending list that can't be read says why, and a later good answer clears it", async () => {
            (globalThis as { document?: unknown }).document = {
                visibilityState: "visible",
                addEventListener() {},
                removeEventListener() {},
            };
            const replies: (() => Response)[] = [
                () =>
                    json({
                        markets: [],
                        maxOrderUSD: null,
                        readAt: null,
                        unavailableReason: "Polymarket isn't reachable right now. Try again in a minute.",
                    }),
                () =>
                    new Response(
                        JSON.stringify({
                            error: { code: "rate_limited", message: "Too many requests. Try again shortly." },
                        }),
                        { status: 429 },
                    ),
            ];
            const store = createMarketsStore({ apiUrl: "http://api", fetch: async () => replies.shift()!() });
            try {
                store.start();
                await wait(50);
                expect(store.getSnapshot()).toMatchObject({
                    loading: false,
                    trending: [],
                    trendingError: "Polymarket isn't reachable right now. Try again in a minute.",
                });
                await wait(2100);
                expect(store.getSnapshot().trendingError).toBe("Too many requests. Try again shortly.");
            } finally {
                store.stop();
                delete (globalThis as { document?: unknown }).document;
            }
        });

        test("earlier results stay until the newer query is answered", async () => {
            const { fake, pending } = fakeSearch();
            const store = createMarketsStore({ apiUrl: "http://api", fetch: fake });
            store.search("fed");
            await wait(300);
            pending.get("fed")!([market("1", "Fed decision")]);
            await wait(20);
            expect(store.getSnapshot()).toMatchObject({ query: "fed", answered: "fed" });
            store.search("fede");
            expect(store.getSnapshot().results?.map((m) => m.id)).toEqual(["1"]);
            expect(store.getSnapshot()).toMatchObject({ query: "fede", answered: "fed" });
            await wait(300);
            expect(store.getSnapshot().results?.map((m) => m.id)).toEqual(["1"]);
            pending.get("fede")!([market("2", "Federal")]);
            await wait(20);
            expect(store.getSnapshot().results?.map((m) => m.id)).toEqual(["2"]);
            expect(store.getSnapshot().answered).toBe("fede");
        });
    });
});
