import { expect, test } from "@playwright/test";
import { coinName, priceFormat } from "@/components/trade/coin-price-card";
import { createPriceHistoryStore } from "@/components/trade/price-history-store";
import { formatPrice } from "@/lib/trade/format";

const API = "http://api.test";
const HOUR = 3_600_000;
const MINUTE = 60_000;
const START = Date.parse("2026-10-13T00:00:00Z");

/** A week of hourly prices climbing from `from`. */
const week = (from: number) => Array.from({ length: 168 }, (_, i) => [START + i * HOUR, from + i / 100]);

/** The server's answers by coin; a coin it doesn't know is left out of the answer, as it does. */
function serverOf(known: Record<string, number[][]>) {
    const asked: string[] = [];
    let status = 200;
    const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        asked.push(`${url.pathname}${url.search}`);
        if (status !== 200) return new Response("down", { status });
        const names = url.searchParams.get("coins")?.split(",") ?? ["ETH", "BTC"];
        const coins = names.flatMap((symbol) => (known[symbol] ? [{ symbol, points: known[symbol] }] : []));
        return new Response(JSON.stringify({ range: "7d", stepMs: HOUR, coins, readAt: "2026-10-13T00:00:00Z" }));
    };
    return {
        asked,
        fetch,
        status: (next: number) => void (status = next),
    };
}

const KNOWN = { ETH: week(3000), BTC: week(66000), kPEPE: week(0.004), HYPE: week(24) };

function storeOf(known: Record<string, number[][]> = KNOWN) {
    const server = serverOf(known);
    let now = START;
    const store = createPriceHistoryStore({ apiUrl: API, fetch: server.fetch, now: () => now });
    return { store, ...server, advance: (ms: number) => void (now += ms) };
}

/** The page's globals the store's `use` reaches for; the idle callback runs at once and the visibility handler is kept. */
function inPage() {
    const saved = { window: globalThis.window, document: globalThis.document };
    const page: { visible: () => void } = { visible: () => undefined };
    Object.assign(globalThis, {
        window: { requestIdleCallback: (run: () => void) => void run() },
        document: {
            visibilityState: "visible",
            addEventListener: (_type: string, handler: () => void) => void (page.visible = handler),
            removeEventListener: () => undefined,
        },
    });
    return {
        page,
        restore: () => void Object.assign(globalThis, saved),
    };
}

test.describe("want", () => {
    test("reads that coin's week once and puts it in the snapshot", async () => {
        const { store, asked } = storeOf();
        let changes = 0;
        store.subscribe(() => (changes += 1));

        await store.want("kPEPE");

        expect(asked).toEqual([`/prices/history?range=7d&coins=kPEPE`]);
        expect(store.getSnapshot().coins.get("kPEPE")).toHaveLength(168);
        expect(store.getSnapshot().range).toBe("7d");
        expect(changes).toBe(1);
    });

    test("asks for the coin by name, spelled for a URL", async () => {
        const { store, asked } = storeOf({ "0G": week(1) });

        await store.want("0G");

        expect(asked).toEqual(["/prices/history?range=7d&coins=0G"]);
        expect(store.getSnapshot().coins.has("0G")).toBe(true);
    });

    test("reads it again only after the refresh interval, and not while a read is out", async () => {
        const { store, asked, advance } = storeOf();

        await Promise.all([store.want("HYPE"), store.want("HYPE")]);
        expect(asked).toHaveLength(1);

        advance(10 * MINUTE - 1);
        await store.want("HYPE");
        expect(asked).toHaveLength(1);

        advance(1);
        await store.want("HYPE");
        expect(asked).toHaveLength(2);
    });

    test("keeps every coin wanted so far", async () => {
        const { store } = storeOf();

        await store.want("kPEPE");
        await store.want("HYPE");

        expect([...store.getSnapshot().coins.keys()].sort()).toEqual(["HYPE", "kPEPE"]);
    });

    test("a coin the server doesn't know adds nothing, and isn't asked for again for 15 s", async () => {
        const { store, asked, advance } = storeOf();

        await store.want("NOPE");
        expect(store.getSnapshot().coins.size).toBe(0);
        advance(15_000 - 1);
        await store.want("NOPE");
        expect(asked).toHaveLength(1);

        advance(1);
        await store.want("NOPE");
        expect(asked).toHaveLength(2);
    });

    test("a failed read is tried again after 15 s and keeps what was read", async () => {
        const { store, asked, advance, status } = storeOf();
        await store.want("kPEPE");
        const first = store.getSnapshot().coins.get("kPEPE");

        advance(10 * MINUTE);
        status(500);
        await store.want("kPEPE");
        expect(store.getSnapshot().coins.get("kPEPE")).toBe(first);
        advance(15_000 - 1);
        await store.want("kPEPE");
        expect(asked).toHaveLength(2);

        status(200);
        advance(1);
        await store.want("kPEPE");
        expect(asked).toHaveLength(3);
        expect(store.getSnapshot().coins.get("kPEPE")).not.toBe(first);
    });
});

test.describe("with the swap coins' own read", () => {
    test("a coin that read already has isn't asked for again", async () => {
        const { store, asked } = storeOf();
        const { restore } = inPage();
        try {
            const stop = store.use();
            await expect.poll(() => store.getSnapshot().coins.size).toBe(2);
            expect(asked).toEqual(["/prices/history?range=7d"]);

            await store.want("ETH");
            expect(asked).toEqual(["/prices/history?range=7d"]);
            stop();
        } finally {
            restore();
        }
    });

    test("a swap coin wanted while their read is out waits for it instead of asking too", async () => {
        const { store, asked } = storeOf();
        const { restore } = inPage();
        try {
            const stop = store.use();
            await store.want("BTC");

            expect(asked).toEqual(["/prices/history?range=7d"]);
            expect(store.getSnapshot().coins.has("BTC")).toBe(true);
            stop();
        } finally {
            restore();
        }
    });

    test("the swap coins' read doesn't take a wanted coin away", async () => {
        const { store } = storeOf();
        const { restore } = inPage();
        try {
            await store.want("kPEPE");
            const stop = store.use();
            await expect.poll(() => store.getSnapshot().coins.size).toBe(3);

            expect([...store.getSnapshot().coins.keys()].sort()).toEqual(["BTC", "ETH", "kPEPE"]);
            stop();
        } finally {
            restore();
        }
    });

    test("the last coin wanted is read again with the swap coins once the interval has passed", async () => {
        const { store, asked, advance } = storeOf();
        const { restore, page } = inPage();
        try {
            const stop = store.use();
            await expect.poll(() => asked.length).toBe(1);
            await store.want("kPEPE");
            await store.want("HYPE");
            expect(asked).toHaveLength(3);

            // Back to the tab after the interval
            advance(10 * MINUTE);
            page.visible();
            await expect.poll(() => asked.length).toBe(5);
            expect(asked.slice(3).sort()).toEqual(["/prices/history?range=7d", "/prices/history?range=7d&coins=HYPE"]);
            stop();
        } finally {
            restore();
        }
    });
});

test.describe("coinName", () => {
    test("is the spot token's name when there is one", () => {
        expect(coinName("ETH", "Ethereum")).toBe("Ethereum");
    });

    test("is '1,000' of the coin for a k-asset", () => {
        expect(coinName("kPEPE")).toBe("1,000 PEPE");
        expect(coinName("kBONK")).toBe("1,000 BONK");
    });

    test("is the ticker for any other coin", () => {
        expect(coinName("HYPE")).toBe("HYPE");
        expect(coinName("S")).toBe("S");
        expect(coinName("0G")).toBe("0G");
        expect(coinName("kinetic")).toBe("kinetic");
    });
});

test.describe("priceFormat", () => {
    const shown = (usd: number) => new Intl.NumberFormat("en-US", priceFormat(usd)).format(usd);

    test("is cents from a dollar up", () => {
        expect(shown(96_120.45)).toBe("$96,120.45");
        expect(shown(1)).toBe("$1.00");
    });

    test("is the picker's price under a dollar, in significant digits", () => {
        for (const usd of [0.5, 0.1823, 0.0041234, 0.000155, 0.00000231]) expect(shown(usd)).toBe(formatPrice(usd));
        expect(shown(0.5)).toBe("$0.50");
        expect(shown(0.0041234)).toBe("$0.004123");
        expect(shown(0.000155)).toBe("$0.000155");
    });
});
