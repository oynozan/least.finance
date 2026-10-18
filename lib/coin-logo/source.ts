import { createHash } from "node:crypto";
import { readCapped } from "./body";
import { renderLogo, type RenderedLogo } from "./render";

/** Where the logos come from: one fixed host, never a URL a visitor can steer. */
const ICON_URL = "https://app.hyperliquid.xyz/coins/";

/**
 * SHA-256 of files the source serves in place of a coin's logo: 2Z's is the broken-image icon.
 * Such a coin has no logo, so it gets the placeholder.
 */
const STAND_INS = new Set(["41e67d90ffbc848e546755c84fa4e888edd15035f9f5d0986513fb6195e4695d"]);

/** The whole download, body included: the largest logos are a few MB and a busy link reads them slowly. */
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;

const HIT_MS = 24 * 3_600_000;
/** A coin the source has no logo for. */
const MISS_MS = 3_600_000;
/** A source that failed or sent something unusable is asked again soon. */
const FAILURE_MS = 60_000;
const MAX_ENTRIES = 500;

/** At most this many logos are downloaded and drawn at once, and this many more may wait for their turn. */
const MAX_ACTIVE = 6;
const MAX_WAITING = 200;

export type CoinLogo =
    | { status: "found"; webp: Buffer }
    | { status: "missing" }
    /** The source could not be read or sent something unusable. */
    | { status: "failed" }
    /** Too many logos are already waiting; nothing was asked. */
    | { status: "busy" };

type Entry = { logo: CoinLogo; until: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<CoinLogo>>();
const waiting: (() => void)[] = [];
let active = 0;

export const isStandIn = (bytes: Uint8Array, standIns = STAND_INS) =>
    standIns.has(createHash("sha256").update(bytes).digest("hex"));

/** Whether logos may be fetched from the source at all; COIN_LOGOS_REMOTE=off turns it off. */
export const remoteLogosOn = () => process.env.COIN_LOGOS_REMOTE !== "off";

async function turn<T>(run: () => Promise<T>): Promise<T | null> {
    if (active >= MAX_ACTIVE) {
        if (waiting.length >= MAX_WAITING) return null;
        await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
        active++;
    }
    try {
        return await run();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
    }
}

/** The source's file for a coin: its bytes and whether it is an SVG, or null when the source has none. */
async function download(base: string): Promise<{ bytes: Buffer; vector: boolean } | null> {
    const res = await fetch(`${ICON_URL}${base}.svg`, {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "image/svg+xml,image/png;q=0.8,image/webp;q=0.8" },
    });
    // A coin the source doesn't know answers 200 with a web page, so only an image counts.
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const vector = type === "image/svg+xml";
    if (res.status !== 200 || !(vector || type === "image/png" || type === "image/webp")) {
        await res.body?.cancel();
        // A redirect is never followed, and neither it nor an overloaded source says the coin has no logo.
        if (res.status >= 500 || res.status === 429 || (res.status >= 300 && res.status < 400)) {
            throw new Error(`${ICON_URL}${base}.svg answered ${res.status}`);
        }
        return null;
    }
    const bytes = await readCapped(res, MAX_BYTES);
    if (!bytes?.length) throw new Error("source file is empty or over the size limit");
    return isStandIn(bytes) ? null : { bytes, vector };
}

async function load(base: string): Promise<CoinLogo> {
    try {
        const done = await turn(async (): Promise<CoinLogo> => {
            const file = await download(base);
            if (!file) return { status: "missing" };
            const drawn: RenderedLogo = await renderLogo(file.bytes, file.vector);
            return { status: "found", webp: drawn.webp };
        });
        return done ?? { status: "busy" };
    } catch (error) {
        console.warn(`coin-logo ${base}: ${error instanceof Error ? error.message : String(error)}`);
        return { status: "failed" };
    }
}

function remember(base: string, logo: CoinLogo) {
    if (logo.status === "busy") return;
    const ttl = logo.status === "found" ? HIT_MS : logo.status === "missing" ? MISS_MS : FAILURE_MS;
    cache.delete(base);
    cache.set(base, { logo, until: Date.now() + ttl });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/**
 * The logo for a coin (a validated base ticker), drawn as a WebP. Remembered in memory only: a found
 * logo for a day, a missing one for an hour, a failure for a minute. Asks for the same coin at the
 * same time share one download.
 */
export function coinLogo(base: string): Promise<CoinLogo> {
    const known = cache.get(base);
    if (known && known.until > Date.now()) {
        // Move it to the back, so the entries dropped at the limit are the ones asked for longest ago.
        cache.delete(base);
        cache.set(base, known);
        return Promise.resolve(known.logo);
    }
    const running = inflight.get(base);
    if (running) return running;
    const started = load(base)
        .then((logo) => {
            remember(base, logo);
            return logo;
        })
        .finally(() => inflight.delete(base));
    inflight.set(base, started);
    return started;
}

/** Forgets everything remembered; for tests. */
export function clearCoinLogos() {
    cache.clear();
}
