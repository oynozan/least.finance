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

/** Keeps the store's timers of 1 to 15 seconds and its 10-minute one instead of starting them, to run by hand; every other timer runs as usual. */
function heldTimers() {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const held = new Map<object, { run: () => void; ms: number }>();
    globalThis.setTimeout = ((run: () => void, ms?: number, ...args: unknown[]) => {
        if (ms === undefined || ((ms < 1_000 || ms > 15_000) && ms !== 10 * MINUTE))
            return real.setTimeout(run, ms, ...args);
        const handle = {};
        held.set(handle, { run, ms });
        return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: unknown) => {
        if (typeof handle === "object" && handle !== null && held.delete(handle)) return;
        real.clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout;
    return {
        /** The delays of the timers waiting to run. */
        waiting: () => [...held.values()].map((timer) => timer.ms).sort((a, b) => a - b),
        /** Runs and drops the timers set for this delay. */
        fire(ms: number) {
            for (const [handle, timer] of [...held]) {
                if (timer.ms !== ms) continue;
                held.delete(handle);
                timer.run();
            }
        },
        restore: () => void Object.assign(globalThis, real),
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

test.describe("a wanted coin whose read failed", () => {
    /** Runs `check` on a store in use with the swap coins read, its 15 s and 10 min timers held. */
    async function inUse(
        check: (page: {
            store: ReturnType<typeof storeOf>["store"];
            asked: string[];
            advance: (ms: number) => void;
            status: (next: number) => void;
            timers: ReturnType<typeof heldTimers>;
            visible: () => void;
        }) => Promise<void>,
    ) {
        const { store, asked, advance, status } = storeOf();
        const { restore, page } = inPage();
        const timers = heldTimers();
        try {
            const stop = store.use();
            await expect.poll(() => store.getSnapshot().coins.size).toBe(2);
            await check({ store, asked, advance, status, timers, visible: page.visible });
            stop();
        } finally {
            timers.restore();
            restore();
        }
    }

    test("is read again 15 s later while it is still the coin wanted", async () => {
        await inUse(async ({ store, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            expect(store.getSnapshot().coins.has("HYPE")).toBe(false);
            expect(timers.waiting()).toContain(15_000);

            status(200);
            advance(15_000);
            timers.fire(15_000);
            await expect.poll(() => store.getSnapshot().coins.has("HYPE")).toBe(true);
        });
    });

    test("is not read again once another coin is wanted", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            status(200);
            await store.want("kPEPE");
            const before = asked.length;

            advance(15_000);
            timers.fire(15_000);
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(asked).toHaveLength(before);
            expect(store.getSnapshot().coins.has("HYPE")).toBe(false);
        });
    });

    test("is tried again a few times, not for ever", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            for (let retry = 0; retry < 3; retry++) {
                expect(timers.waiting()).toContain(15_000);
                advance(15_000);
                timers.fire(15_000);
                await expect.poll(() => asked.length).toBe(3 + retry);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            expect(timers.waiting()).not.toContain(15_000);
        });
    });

    test("is tried again a few more times when it is wanted again", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            for (let retry = 0; retry < 3; retry++) {
                advance(15_000);
                timers.fire(15_000);
                await expect.poll(() => asked.length).toBe(3 + retry);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(timers.waiting()).not.toContain(15_000);

            advance(15_000);
            await store.want("HYPE");

            expect(timers.waiting()).toContain(15_000);
        });
    });

    test("is not read again by a store nobody uses any more", async () => {
        const { store, asked, advance, status } = storeOf();
        const { restore } = inPage();
        const timers = heldTimers();
        try {
            const stop = store.use();
            await expect.poll(() => store.getSnapshot().coins.size).toBe(2);
            status(500);
            await store.want("HYPE");
            stop();
            const before = asked.length;

            advance(15_000);
            timers.fire(15_000);
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(asked).toHaveLength(before);
        } finally {
            timers.restore();
            restore();
        }
    });

    test("is read again when its pause is over if it is wanted again after another coin that failed too", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            advance(2_000);
            await store.want("kPEPE");
            advance(2_000);
            // The pause for HYPE has 11 s left; kPEPE's retry is no longer wanted
            await store.want("HYPE");
            const before = asked.length;
            expect(timers.waiting()).toContain(11_000);
            expect(timers.waiting()).not.toContain(15_000);

            status(200);
            advance(11_000);
            timers.fire(11_000);
            await expect.poll(() => store.getSnapshot().coins.has("HYPE")).toBe(true);
            expect(asked.slice(before)).toEqual(["/prices/history?range=7d&coins=HYPE"]);
        });
    });

    test("is not read twice when it is wanted again inside its own pause", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            status(500);
            await store.want("HYPE");
            advance(2_000);
            await store.want("HYPE");

            expect(timers.waiting().filter((ms) => ms !== 10 * MINUTE)).toEqual([15_000]);
            status(200);
            advance(13_000);
            timers.fire(15_000);
            await expect.poll(() => store.getSnapshot().coins.has("HYPE")).toBe(true);
            expect(asked.filter((url) => url.endsWith("coins=HYPE"))).toHaveLength(2);
        });
    });

    test("has the same few tries when it is read again after another coin failed in between", async () => {
        await inUse(async ({ store, asked, advance, status, timers }) => {
            const hype = () => asked.filter((url) => url.endsWith("coins=HYPE")).length;
            status(500);
            await store.want("HYPE");
            advance(2_000);
            await store.want("kPEPE");
            await store.want("HYPE");

            // The read held back for the rest of its pause, then two more tries; four reads in all, as if no other coin was wanted
            advance(13_000);
            for (let read = 2; read <= 4; read++) {
                expect(timers.waiting().filter((ms) => ms !== 10 * MINUTE)).toHaveLength(1);
                timers.fire(timers.waiting().find((ms) => ms !== 10 * MINUTE) ?? 0);
                await expect.poll(hype).toBe(read);
                await new Promise((resolve) => setTimeout(resolve, 50));
                advance(15_000);
            }

            expect(timers.waiting()).toEqual([10 * MINUTE]);
        });
    });

    test("is not read again on a switch back to the tab until 15 s have passed", async () => {
        await inUse(async ({ store, asked, advance, visible }) => {
            // The server doesn't know it
            await store.want("NOPE");
            expect(asked).toHaveLength(2);

            advance(15_000 - 1);
            visible();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(asked).toHaveLength(2);

            advance(1);
            visible();
            await expect.poll(() => asked.length).toBe(3);
        });
    });

    test("is not read again by the refresh timer until 15 s have passed", async () => {
        await inUse(async ({ store, asked, advance, timers }) => {
            await store.want("NOPE");
            expect(asked).toHaveLength(2);

            // The swap coins are read again; the coin that just failed is left for now
            timers.fire(10 * MINUTE);
            await expect.poll(() => asked.length).toBe(3);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(asked).toHaveLength(3);

            advance(15_000);
            timers.fire(10 * MINUTE);
            await expect.poll(() => asked.length).toBe(5);
        });
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
