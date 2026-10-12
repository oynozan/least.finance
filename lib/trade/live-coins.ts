import { NETWORKS } from "@/server/src/swaps/coins";
import type { SwapCatalogView } from "@/server/src/protocol";
import type { Token, TokenNetwork } from "./catalog";
import type { NetworkId } from "./networks";

const CACHE_KEY = "swaps:catalog";
const KNOWN = new Set<string>(NETWORKS.map((network) => network.id));

type Loose = Record<string, unknown>;

const isRecord = (value: unknown): value is Loose =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isNetwork = (value: unknown): value is NetworkId => typeof value === "string" && KNOWN.has(value);

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A view's networks for a coin: the ones this client knows, with the gas reserve it keeps itself; the built-in ones when none are usable. */
function networksOf(listed: unknown, builtIn: Token): TokenNetwork[] {
    const seen = new Set<NetworkId>();
    const networks: TokenNetwork[] = [];
    for (const entry of Array.isArray(listed) ? listed : []) {
        if (!isRecord(entry) || !isNetwork(entry.network) || seen.has(entry.network)) continue;
        seen.add(entry.network);
        const reserve = builtIn.networks.find((known) => known.network === entry.network)?.reserve;
        networks.push({
            network: entry.network,
            ...(typeof entry.label === "string" && entry.label !== "" ? { label: entry.label } : {}),
            ...(entry.wrapped === true ? { wrapped: true as const } : {}),
            ...(reserve ? { reserve } : {}),
        });
    }
    return networks.length > 0 ? networks : [...builtIn.networks];
}

function merge(builtIn: Token, coin: Loose): Token {
    const networks = networksOf(coin.networks, builtIn);
    const has = (network: NetworkId) => networks.some((entry) => entry.network === network);
    const home =
        isNetwork(coin.home) && has(coin.home) ? coin.home : has(builtIn.home) ? builtIn.home : networks[0].network;
    return {
        symbol: builtIn.symbol,
        name: typeof coin.name === "string" && coin.name.trim() !== "" ? coin.name : builtIn.name,
        priceUSD: isPrice(coin.priceUSD) ? coin.priceUSD : builtIn.priceUSD,
        home,
        networks,
    };
}

/** The built-in coins with a catalog view's live prices and networks, skipping whatever a newer or broken server sends that doesn't fit. */
export function toTokens(view: unknown, fallback: readonly Token[]): Token[] {
    const listed = isRecord(view) && Array.isArray(view.coins) ? view.coins : [];
    const live = new Map<string, Loose>();
    for (const coin of listed) {
        if (isRecord(coin) && typeof coin.symbol === "string" && !live.has(coin.symbol)) live.set(coin.symbol, coin);
    }
    return fallback.map((token) => {
        const coin = live.get(token.symbol);
        return coin ? merge(token, coin) : token;
    });
}

/** Whether a value has the shape of a catalog view, since a cache or a skewed server can hand back anything. */
export const isCatalogView = (value: unknown): value is SwapCatalogView =>
    isRecord(value) && Array.isArray(value.coins) && (value.readAt === null || typeof value.readAt === "string");

/** The last catalog kept on this device, or null when there is none or storage is unavailable. */
export function loadCachedCatalog(): SwapCatalogView | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const view: unknown = JSON.parse(raw);
        return isCatalogView(view) ? view : null;
    } catch {
        return null;
    }
}

export function saveCachedCatalog(view: SwapCatalogView): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(view));
    } catch {
        // Storage is blocked or full; the prices work without a cache.
    }
}
