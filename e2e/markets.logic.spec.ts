import { expect, test } from "@playwright/test";
import { createMarketsStore } from "@/components/trade/markets-store";
import { loadCachedTrending, toPredictionMarket } from "@/lib/trade/markets";
import type { MarketView } from "@/server/src/protocol";

const view = (title: string, endDate: string): MarketView => ({
    id: "77",
    title,
    image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/a.png",
    endDate,
    volume24hUSD: 1000,
    outcomes: [
        { tokenId: "t-yes", label: "YES", buyPrice: 0.42, chance: 0.41, tone: "gain", minUSD: 1.5, image: null },
        {
            tokenId: "t-no",
            label: "NO",
            buyPrice: 0.59,
            chance: 0.59,
            tone: "loss",
            minUSD: 1,
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
    });
});
