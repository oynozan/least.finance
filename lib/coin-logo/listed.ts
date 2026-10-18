import { readCapped } from "./body";
import { baseTicker } from "./symbol";

/** Where the list of coins comes from: one fixed, public endpoint, never a URL a visitor can steer. */
const META_URL = "https://api.hyperliquid.xyz/info";

/** The whole read, body included. */
const TIMEOUT_MS = 5_000;
/** The list is under 20 KB today. */
const MAX_BYTES = 512 * 1024;

/** A list that was read is trusted this long. */
const REFRESH_MS = 10 * 60_000;
/** A read that failed is tried again no sooner than this, and the last good list is used meanwhile. */
const RETRY_MS = 60_000;

/** Hyperliquid's live perps, each by its own name and by its base coin's (kPEPE and PEPE); null until a read has worked. */
let names: Set<string> | null = null;
let nextRead = 0;
let reading: Promise<void> | null = null;

async function readNames(): Promise<Set<string>> {
    const res = await fetch(META_URL, {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ type: "meta" }),
    });
    if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`${META_URL} answered ${res.status}`);
    }
    const bytes = await readCapped(res, MAX_BYTES);
    if (!bytes) throw new Error("list is over the size limit");
    const universe = (JSON.parse(bytes.toString("utf8")) as { universe?: unknown } | null)?.universe;
    if (!Array.isArray(universe)) throw new Error("list has no universe");
    const live = new Set<string>();
    for (const perp of universe as ({ name?: unknown; isDelisted?: unknown } | null)[]) {
        if (typeof perp?.name !== "string" || perp.isDelisted === true) continue;
        live.add(perp.name);
        live.add(baseTicker(perp.name));
    }
    // An empty list would turn every coin away for the whole refresh, so it counts as a failed read.
    if (!live.size) throw new Error("list has no live coins");
    return live;
}

/** Reads the list, once however many ask at the same time; a failed read keeps the list there is. */
function refresh(): Promise<void> {
    reading ??= readNames()
        .then(
            (live) => {
                names = live;
                nextRead = Date.now() + REFRESH_MS;
            },
            (error) => {
                nextRead = Date.now() + RETRY_MS;
                console.warn(`coin-logo list: ${error instanceof Error ? error.message : String(error)}`);
            },
        )
        .finally(() => {
            reading = null;
        });
    return reading;
}

export type Listing =
    | "listed"
    | "unlisted"
    /** No read of the list has worked yet, so nothing is known. */
    | "unknown";

/**
 * Whether Hyperliquid lists a perp for a symbol (a validated ticker): the symbol itself or its base coin.
 * The list is read at most every ten minutes, so a made-up ticker costs nothing upstream.
 */
export async function coinListing(symbol: string): Promise<Listing> {
    if (Date.now() >= nextRead) await refresh();
    if (!names) return "unknown";
    return names.has(symbol) || names.has(baseTicker(symbol)) ? "listed" : "unlisted";
}

/** Forgets the list; for tests. */
export function clearListedCoins() {
    names = null;
    nextRead = 0;
}
