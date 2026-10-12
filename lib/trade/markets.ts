import type { MarketView, TrendingView } from "@/server/src/protocol";
import type { PredictionMarket } from "./catalog";

const SHORT_LENGTH = 24;
const CACHE_KEY = "markets:trending";

/** The title cut at a word boundary, for tight spots. */
function shorten(title: string) {
    if (title.length <= SHORT_LENGTH) return title;
    let cut = "";
    for (const word of title.split(" ")) {
        const next = cut ? `${cut} ${word}` : word;
        if (next.length > SHORT_LENGTH) break;
        cut = next;
    }
    return `${cut || title.slice(0, SHORT_LENGTH)}…`;
}

/** "Oct 29", or "Nov 8, 2028" in another year than `now`'s. */
function closing(endDate: string, now: Date) {
    const end = new Date(endDate);
    const sameYear = end.getUTCFullYear() === now.getUTCFullYear();
    return end.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: sameYear ? undefined : "numeric",
        timeZone: "UTC",
    });
}

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

/** Whether a value has the shape of a MarketView, since a cache or a skewed server can hand back anything. */
export function isMarketView(value: unknown): value is MarketView {
    const view = value as MarketView | null;
    if (!view || typeof view.id !== "string" || typeof view.title !== "string") return false;
    if (!Array.isArray(view.outcomes) || view.outcomes.length === 0) return false;
    return view.outcomes.every(
        (o) =>
            !!o &&
            typeof o.tokenId === "string" &&
            typeof o.label === "string" &&
            isNumber(o.buyPrice) &&
            isNumber(o.chance) &&
            isNumber(o.minUSD) &&
            // A cached view from before sell prices has neither
            (o.sellPrice === undefined || isNumber(o.sellPrice)) &&
            (o.minShares === undefined || isNumber(o.minShares)),
    );
}

export const validMarkets = (value: unknown): MarketView[] => (Array.isArray(value) ? value.filter(isMarketView) : []);

export function toPredictionMarket(view: MarketView, now: Date): PredictionMarket {
    return {
        id: view.id,
        question: view.title,
        short: shorten(view.title),
        symbol: "",
        closes: closing(view.endDate, now),
        image: view.image ?? undefined,
        outcomes: view.outcomes.map((o) => ({
            id: o.tokenId,
            label: o.label,
            price: o.buyPrice,
            chance: o.chance,
            tone: o.tone,
            minUSD: o.minUSD,
            image: o.image ?? undefined,
        })),
    };
}

/** The last trending list kept on this device, or null when there is none or storage is unavailable. */
export function loadCachedTrending(): TrendingView | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const view = JSON.parse(raw) as TrendingView;
        if (!Array.isArray(view?.markets) || typeof view.readAt !== "string") return null;
        return { ...view, markets: validMarkets(view.markets) };
    } catch {
        return null;
    }
}

export function saveCachedTrending(view: TrendingView): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(view));
    } catch {
        // Storage is blocked or full; the list works without a cache.
    }
}
