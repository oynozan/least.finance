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
        return Array.isArray(view?.markets) && typeof view.readAt === "string" ? view : null;
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
