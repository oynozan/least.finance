import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { GET } from "@/app/coin-logo/[symbol]/route";
import { LOGO_SIZE, renderLogo } from "@/lib/coin-logo/render";
import { clearListedCoins } from "@/lib/coin-logo/listed";
import { clearCoinLogos, isStandIn } from "@/lib/coin-logo/source";
import { WORK_SIZE, chooseLook, measure } from "@/lib/coin-logo/shape";
import { baseTicker, coinLogoBase } from "@/lib/coin-logo/symbol";

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
const ROUND = svg(
    `<circle cx="16" cy="16" r="16" fill="#e5322d"/><rect x="12" y="12" width="8" height="8" fill="#fff"/>`,
);
const DARK_MARK = svg(`<path d="M16 4 28 28H4Z" fill="#1d4ed8"/>`);
const LIGHT_MARK = svg(`<path d="M16 4 28 28H4Z" fill="#ffffff"/>`);

/** A WORK_SIZE square RGBA image, each pixel from `paint`. */
function image(paint: (x: number, y: number) => [number, number, number, number]) {
    const rgba = new Uint8Array(WORK_SIZE * WORK_SIZE * 4);
    for (let y = 0; y < WORK_SIZE; y++) {
        for (let x = 0; x < WORK_SIZE; x++) rgba.set(paint(x, y), (y * WORK_SIZE + x) * 4);
    }
    return rgba;
}

const distance = (x: number, y: number) =>
    Math.hypot(x - (WORK_SIZE - 1) / 2, y - (WORK_SIZE - 1) / 2) / (WORK_SIZE / 2);

/** One pixel of a WebP, as [r, g, b, a]. */
async function pixel(webp: Buffer, x: number, y: number) {
    const { data, info } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * 4;
    return [data[at], data[at + 1], data[at + 2], data[at + 3]];
}

test.describe("coin logo symbols", () => {
    test("only a short run of letters and digits can be a coin's ticker", () => {
        for (const ok of ["BTC", "0G", "kPEPE", "a", "ABCDEFGHIJKL"]) expect(coinLogoBase(ok)).not.toBeNull();
        for (const bad of ["", "ABCDEFGHIJKLM", "USDC.e", "../etc", "A B", "BTC/ETH", "BTC\n", "ÉTH", "a%2fb"]) {
            expect(coinLogoBase(bad)).toBeNull();
        }
    });

    test("a k-asset takes its base coin's name, and nothing else loses a letter", () => {
        expect(coinLogoBase("kPEPE")).toBe("PEPE");
        expect(coinLogoBase("kBONK")).toBe("BONK");
        expect(coinLogoBase("PEPE")).toBe("PEPE");
        expect(coinLogoBase("kpepe")).toBe("kpepe");
        expect(coinLogoBase("k")).toBe("k");
        expect(coinLogoBase("K")).toBe("K");
        expect(baseTicker("kLUNC")).toBe("LUNC");
        expect(baseTicker("USDC.e")).toBe("USDC.e");
    });
});

test.describe("coin logo shape", () => {
    test("a full disc is a round coin, drawn as it is", () => {
        const disc = image((x, y) => (distance(x, y) <= 1 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
        expect(chooseLook(measure(disc))).toBe("round");
    });

    test("a coin with cut-outs or a margin is still round; a hollow ring and a small mark are not", () => {
        const cutOut = image((x, y) => (distance(x, y) <= 1 && x % 8 > 1 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
        expect(measure(cutOut).coverage).toBeGreaterThan(0.75);
        expect(chooseLook(measure(cutOut))).toBe("round");
        const padded = image((x, y) => (distance(x, y) <= 0.85 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
        expect(chooseLook(measure(padded))).toBe("round");
        const ring = image((x, y) => (distance(x, y) <= 1 && distance(x, y) >= 0.8 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
        expect(chooseLook(measure(ring))).toBe("light-disc");
        const mark = image((x, y) =>
            Math.abs(x - 128) < 50 && Math.abs(y - 128) < 50 ? [30, 60, 200, 255] : [0, 0, 0, 0],
        );
        expect(chooseLook(measure(mark))).toBe("light-disc");
    });

    test("a mark that would vanish on the light disc goes on a dark one", () => {
        const white = image((x, y) =>
            Math.abs(x - 128) < 50 && Math.abs(y - 128) < 50 ? [255, 255, 255, 255] : [0, 0, 0, 0],
        );
        expect(chooseLook(measure(white))).toBe("dark-disc");
        const cream = image((x, y) =>
            Math.abs(x - 128) < 50 && Math.abs(y - 128) < 50 ? [250, 245, 200, 255] : [0, 0, 0, 0],
        );
        expect(chooseLook(measure(cream))).toBe("dark-disc");
    });

    test("a coin that is black all over would vanish on the dark app, so it goes on the light disc", () => {
        const black = image((x, y) => (distance(x, y) <= 1 ? [8, 8, 8, 255] : [0, 0, 0, 0]));
        expect(chooseLook(measure(black))).toBe("light-disc");
        const withMark = image((x, y) =>
            distance(x, y) <= 1 ? (Math.abs(x - 128) < 30 ? [255, 255, 255, 255] : [8, 8, 8, 255]) : [0, 0, 0, 0],
        );
        expect(chooseLook(measure(withMark))).toBe("round");
    });

    test("an empty image is a mark with nothing to show, not an error", () => {
        const empty = new Uint8Array(WORK_SIZE * WORK_SIZE * 4);
        expect(measure(empty)).toEqual({ coverage: 0, luma: 0, lit: 0 });
        expect(chooseLook(measure(empty))).toBe("light-disc");
    });
});

test.describe("coin logo rendering", () => {
    test("a round logo comes out as a 128 px WebP, untouched in the middle, clear in the corners", async () => {
        const logo = await renderLogo(Buffer.from(ROUND), true);
        expect(logo.look).toBe("round");
        const meta = await sharp(logo.webp).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["webp", LOGO_SIZE, LOGO_SIZE]);
        const [r, g, b, a] = await pixel(logo.webp, 64, 8);
        expect(a).toBe(255);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(90);
        expect(b).toBeLessThan(90);
        expect((await pixel(logo.webp, 1, 1))[3]).toBe(0);
    });

    test("a dark mark sits on the light disc and a light one on the dark disc", async () => {
        const dark = await renderLogo(Buffer.from(DARK_MARK), true);
        expect(dark.look).toBe("light-disc");
        const [lr, lg, lb, la] = await pixel(dark.webp, 64, 8);
        expect([lr, lg, lb].every((c) => Math.abs(c - 245) < 8)).toBe(true);
        expect(la).toBe(255);
        expect((await pixel(dark.webp, 1, 1))[3]).toBe(0);

        const light = await renderLogo(Buffer.from(LIGHT_MARK), true);
        expect(light.look).toBe("dark-disc");
        const [dr, dg, db] = await pixel(light.webp, 64, 8);
        expect([dr, dg, db].every((c) => Math.abs(c - 58) < 8)).toBe(true);
    });

    test("a raster logo is drawn the same way", async () => {
        const png = await sharp(Buffer.from(ROUND)).resize(64, 64).png().toBuffer();
        const logo = await renderLogo(png, false);
        expect(logo.look).toBe("round");
        expect((await sharp(logo.webp).metadata()).width).toBe(LOGO_SIZE);
    });

    test("something that is not an image is refused", async () => {
        await expect(renderLogo(Buffer.from("<html>no</html>"), true)).rejects.toThrow();
    });
});

test.describe("GET /coin-logo/<symbol>", () => {
    test.describe.configure({ mode: "serial" });

    const META_URL = "https://api.hyperliquid.xyz/info";
    const LOGO_URL = "https://app.hyperliquid.xyz/coins/";
    /** The coins the stubbed list has by default: every ticker the tests below ask a logo for. */
    const LISTED = [
        "BTC",
        "kPEPE",
        "SOLX",
        "PEOPLE",
        "DOWN",
        "MOVED",
        "BROKEN",
        "HUGE",
        "GONE",
        "JSONY",
        "PNGY",
        ...Array.from({ length: 210 }, (_, n) => `C${n}`),
    ];

    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    /** Logo downloads, and reads of the list of coins, as the stubbed fetch saw them. */
    let calls: string[] = [];
    let metaCalls: (RequestInit | undefined)[] = [];
    let answer: (url: string) => Response | Promise<Response> = () => new Response("", { status: 404 });
    let metaAnswer: (init?: RequestInit) => Response | Promise<Response> = () => listing(LISTED);
    let skew = 0;

    /** Hyperliquid's answer to the list of perps: these coins live, and those delisted. */
    const listing = (names: string[], delisted: string[] = []) =>
        new Response(
            JSON.stringify({
                universe: [
                    ...names.map((name) => ({ name, szDecimals: 1, maxLeverage: 5 })),
                    ...delisted.map((name) => ({ name, szDecimals: 1, maxLeverage: 5, isDelisted: true })),
                ],
                marginTables: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    /** Moves the clock on. */
    const later = (minutes: number) => {
        skew += minutes * 60_000;
    };

    test.beforeEach(() => {
        calls = [];
        metaCalls = [];
        answer = () => new Response("", { status: 404 });
        metaAnswer = () => listing(LISTED);
        skew = 0;
        clearCoinLogos();
        clearListedCoins();
        delete process.env.COIN_LOGOS_REMOTE;
        Date.now = () => realNow() + skew;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url === META_URL) {
                metaCalls.push(init);
                return metaAnswer(init);
            }
            calls.push(url);
            return answer(url);
        }) as typeof fetch;
    });

    test.afterEach(() => {
        globalThis.fetch = realFetch;
        Date.now = realNow;
        delete process.env.COIN_LOGOS_REMOTE;
    });

    const get = (symbol: string) =>
        GET(new Request(`http://localhost/coin-logo/${symbol}`), { params: Promise.resolve({ symbol }) });
    const image_ = (body: string) => new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } });

    test("is a 404 that is not cached, and asks nobody, when remote logos are off", async () => {
        process.env.COIN_LOGOS_REMOTE = "off";
        answer = () => image_(ROUND);
        const res = await get("PEPE");
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(calls).toEqual([]);
        expect(metaCalls).toEqual([]);
    });

    test("is a cacheable 404, and asks nobody, for a symbol that can't be a ticker", async () => {
        for (const bad of ["a.b", "ABCDEFGHIJKLM", "..%2F", "x y"]) {
            const res = await get(bad);
            expect(res.status).toBe(404);
            expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
        }
        expect(calls).toEqual([]);
        expect(metaCalls).toEqual([]);
    });

    test("serves a drawn WebP with a day's caching, fetched from the one host under the base coin's name", async () => {
        answer = () => image_(ROUND);
        const res = await get("kPEPE");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/webp");
        expect(res.headers.get("cache-control")).toBe("public, max-age=86400, stale-while-revalidate=604800");
        expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format).toBe("webp");
        expect(calls).toEqual(["https://app.hyperliquid.xyz/coins/PEPE.svg"]);
    });

    test("remembers a logo, and shares one download between asks at the same time", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        answer = async () => {
            await gate;
            return image_(ROUND);
        };
        const first = [get("SOLX"), get("SOLX"), get("kSOLX")];
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toHaveLength(1);
        release();
        expect((await Promise.all(first)).map((res) => res.status)).toEqual([200, 200, 200]);
        expect((await get("SOLX")).status).toBe(200);
        expect(calls).toEqual(["https://app.hyperliquid.xyz/coins/SOLX.svg"]);
    });

    test("downloads six at a time, and turns away asks beyond a long queue instead of piling up", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        answer = async () => {
            await gate;
            return new Response("", { status: 404 });
        };
        const asks = Array.from({ length: 210 }, (_, n) => get(`C${n}`));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(calls).toHaveLength(6);
        release();
        const answers = await Promise.all(asks);
        expect(calls).toHaveLength(206);
        expect(answers.filter((res) => res.headers.get("cache-control") === "public, max-age=60")).toHaveLength(4);
        expect(answers.filter((res) => res.headers.get("cache-control") === "public, max-age=3600")).toHaveLength(206);
    });

    test("is a 404 for a coin the source answers with a web page, and remembers that for an hour", async () => {
        answer = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
        const res = await get("PEOPLE");
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
        await get("PEOPLE");
        expect(calls).toHaveLength(1);
    });

    test("is a short-cached 404, never a 500, when the source fails, redirects, or is too big", async () => {
        const cases: [string, () => Response | Promise<Response>][] = [
            ["DOWN", () => new Response("", { status: 503 })],
            ["MOVED", () => new Response("", { status: 302, headers: { location: "https://evil.example/x.svg" } })],
            ["BROKEN", () => image_("<svg")],
            [
                "HUGE",
                () =>
                    new Response("x", {
                        status: 200,
                        headers: { "content-type": "image/svg+xml", "content-length": String(6 * 1024 * 1024) },
                    }),
            ],
            ["GONE", () => Promise.reject(new Error("network down"))],
        ];
        for (const [symbol, respond] of cases) {
            answer = respond;
            const res = await get(symbol);
            expect(res.status, symbol).toBe(404);
            expect(res.headers.get("cache-control"), symbol).toBe("public, max-age=60");
        }
        expect(calls.every((url) => url.startsWith("https://app.hyperliquid.xyz/coins/"))).toBe(true);
    });

    test("is a 404 for a file that is not an image type it accepts", async () => {
        answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        expect((await get("JSONY")).status).toBe(404);
    });

    test("takes a PNG too", async () => {
        const png = await sharp(Buffer.from(ROUND)).resize(64, 64).png().toBuffer();
        answer = () => new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } });
        expect((await get("PNGY")).status).toBe(200);
    });

    test("reads Hyperliquid's list of perps with one fixed request, and fetches a listed coin's logo once", async () => {
        answer = () => image_(ROUND);
        expect((await get("PEPE")).status).toBe(200);
        expect((await get("kPEPE")).status).toBe(200);
        expect((await get("PEPE")).status).toBe(200);
        expect(calls).toEqual([`${LOGO_URL}PEPE.svg`]);
        expect(metaCalls).toHaveLength(1);
        expect(metaCalls[0]?.method).toBe("POST");
        expect(metaCalls[0]?.body).toBe(JSON.stringify({ type: "meta" }));
        expect(metaCalls[0]?.redirect).toBe("manual");
        expect(metaCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    test("never asks for a logo of a ticker Hyperliquid doesn't list, or has delisted", async () => {
        answer = () => image_(ROUND);
        metaAnswer = () => listing(["BTC", "kPEPE"], ["MATIC"]);
        for (const made of ["NOSUCH", "kNOSUCH", "MATIC", "kMATIC", "pepe", "KPEPE"]) {
            const res = await get(made);
            expect(res.status, made).toBe(404);
            expect(res.headers.get("cache-control"), made).toBe("public, max-age=3600");
        }
        expect(calls).toEqual([]);
        expect(metaCalls).toHaveLength(1);
    });

    test("lets a k-asset through when its base coin is the one listed, and the base when the k-asset is", async () => {
        answer = () => image_(ROUND);
        metaAnswer = () => listing(["PEPE", "kBONK"]);
        expect((await get("kPEPE")).status).toBe(200);
        expect((await get("BONK")).status).toBe(200);
        expect((await get("kBONK")).status).toBe(200);
        expect((await get("SHIB")).status).toBe(404);
        expect((await get("kSHIB")).status).toBe(404);
        expect(calls).toEqual([`${LOGO_URL}PEPE.svg`, `${LOGO_URL}BONK.svg`]);
    });

    test("shares one read of the list between asks at the same time", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        metaAnswer = async () => {
            await gate;
            return listing(LISTED);
        };
        answer = () => image_(ROUND);
        const asks = [get("PEPE"), get("SOLX"), get("NOSUCH")];
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(metaCalls).toHaveLength(1);
        expect(calls).toEqual([]);
        release();
        expect((await Promise.all(asks)).map((res) => res.status)).toEqual([200, 200, 404]);
        expect(metaCalls).toHaveLength(1);
    });

    test("reads the list again after ten minutes, and a coin no longer on it loses its logo", async () => {
        answer = () => image_(ROUND);
        metaAnswer = () => listing(["OLDX"]);
        expect((await get("OLDX")).status).toBe(200);
        later(9);
        expect((await get("OLDX")).status).toBe(200);
        expect(metaCalls).toHaveLength(1);
        metaAnswer = () => listing(["NEWX"]);
        later(2);
        expect((await get("NEWX")).status).toBe(200);
        expect(metaCalls).toHaveLength(2);
        const gone = await get("OLDX");
        expect(gone.status).toBe(404);
        expect(gone.headers.get("cache-control")).toBe("public, max-age=3600");
        expect(calls).toEqual([`${LOGO_URL}OLDX.svg`, `${LOGO_URL}NEWX.svg`]);
    });

    const BAD_ANSWERS: [string, (init?: RequestInit) => Response | Promise<Response>][] = [
        ["a server error", () => new Response("", { status: 503 })],
        [
            "a redirect",
            // Followed, it would lead to a good-looking list of somebody else's coins
            (init) =>
                init?.redirect === "manual"
                    ? new Response("", { status: 302, headers: { location: "https://evil.example/info" } })
                    : listing(["EVILX"]),
        ],
        ["a network failure", () => Promise.reject(new Error("network down"))],
        ["something that isn't JSON", () => new Response("<html></html>", { status: 200 })],
        ["JSON with no coins", () => new Response('{"universe":[]}', { status: 200 })],
        ["JSON of another shape", () => new Response('{"coins":["BTC"]}', { status: 200 })],
        ["more than the size limit", () => new Response("x".repeat(600 * 1024), { status: 200 })],
    ];

    test("keeps the last good list when a later read fails, and tries again after a minute", async () => {
        answer = () => image_(ROUND);
        expect((await get("PEPE")).status).toBe(200);
        for (const [what, respond] of BAD_ANSWERS) {
            later(11);
            metaAnswer = respond;
            const before = metaCalls.length;
            expect((await get("SOLX")).status, what).toBe(200);
            expect(metaCalls.length, what).toBe(before + 1);
            // Within the minute nobody asks Hyperliquid again.
            later(0.5);
            expect((await get("PEPE")).status, what).toBe(200);
            expect((await get("NOSUCH")).status, what).toBe(404);
            expect(metaCalls.length, what).toBe(before + 1);
        }
        later(1);
        metaAnswer = () => listing(["OTHERX"]);
        expect((await get("OTHERX")).status).toBe(200);
        expect((await get("SOLX")).status).toBe(404);
    });

    test("denies every coin, with a short-cached 404 and no logo fetch, while the first read of the list fails", async () => {
        answer = () => image_(ROUND);
        for (const [what, respond] of BAD_ANSWERS) {
            clearListedCoins();
            metaAnswer = respond;
            const res = await get("PEPE");
            expect(res.status, what).toBe(404);
            expect(res.headers.get("cache-control"), what).toBe("public, max-age=60");
        }
        expect(calls).toEqual([]);
    });

    test("tries the first read again after a minute, and not before", async () => {
        answer = () => image_(ROUND);
        metaAnswer = () => new Response("", { status: 503 });
        expect((await get("PEPE")).status).toBe(404);
        metaAnswer = () => listing(LISTED);
        later(0.5);
        expect((await get("PEPE")).status).toBe(404);
        expect(metaCalls).toHaveLength(1);
        expect(calls).toEqual([]);
        later(1);
        expect((await get("PEPE")).status).toBe(200);
        expect(metaCalls).toHaveLength(2);
    });

    test("treats a file the source puts in place of a logo as no logo", () => {
        const stand = Buffer.from("a broken image icon");
        const known = new Set([createHash("sha256").update(stand).digest("hex")]);
        expect(isStandIn(stand, known)).toBe(true);
        expect(isStandIn(Buffer.from(ROUND), known)).toBe(false);
    });
});
