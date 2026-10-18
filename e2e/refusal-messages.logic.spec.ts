import { expect, test } from "@playwright/test";
import { createMarketsStore } from "@/components/trade/markets-store";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe("a search the server refused", () => {
    test("carries the server's own message, and a search that works clears it", async () => {
        const replies: (() => Response)[] = [
            () =>
                new Response(
                    JSON.stringify({
                        error: { code: "rate_limited", message: "Too many requests. Try again in 20 seconds." },
                    }),
                    { status: 429 },
                ),
            () => new Response(JSON.stringify({ query: "fed r", markets: [] }), { status: 200 }),
        ];
        const store = createMarketsStore({ apiUrl: "http://api", fetch: async () => replies.shift()!() });
        store.search("fed");
        await wait(300);
        expect(store.getSnapshot()).toMatchObject({
            searchFailed: true,
            searchError: "Too many requests. Try again in 20 seconds.",
        });
        store.search("fed r");
        await wait(300);
        expect(store.getSnapshot()).toMatchObject({ searchFailed: false, searchError: null });
    });

    test("with no body says what the server answered", async () => {
        const store = createMarketsStore({
            apiUrl: "http://api",
            fetch: async () => new Response("<html>", { status: 502 }),
        });
        store.search("fed");
        await wait(300);
        expect(store.getSnapshot()).toMatchObject({ searchFailed: true, searchError: "The server answered 502." });
    });
});
