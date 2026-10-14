import { byNewest, type Activity } from "@/lib/trade/activity";
import type { ActivityFilter, ActivityItem, ActivityPage } from "@/server/src/protocol";

/** The history pages loaded for one filter, newest first, with the cursor for the next older page */
export type PagesState = { items: ActivityItem[]; next: string | null; loaded: boolean };

export const NO_PAGES: PagesState = { items: [], next: null, loaded: false };

/** What names an item across pages, being its kind and document id and, for a position, its part */
export function itemKey(item: ActivityItem): string {
    switch (item.kind) {
        case "deposit":
            return `deposit:${item.deposit.id}`;
        case "withdrawal":
            return `withdrawal:${item.withdrawal.id}`;
        case "swap":
            return `swap:${item.order.id}`;
        case "sale":
            return `sale:${item.order.id}`;
        case "prediction":
            return `prediction:${item.position.id}:${item.part}`;
        case "perp":
            return `perp:${item.position.id}:${item.part}`;
    }
}

const atMs = (item: ActivityItem) => Date.parse(item.at);

/** The newest page unioned into what is loaded, the new copy of a row winning, with the older cursor kept */
export function firstPage(state: PagesState, page: ActivityPage): PagesState {
    if (!state.loaded) return { items: page.items, next: page.next, loaded: true };
    const fresh = new Set(page.items.map(itemKey));
    const kept = state.items.filter((item) => !fresh.has(itemKey(item)));
    const items = [...page.items, ...kept].sort((a, b) => atMs(b) - atMs(a));
    return { items, next: state.next, loaded: true };
}

/** The page after the cursor `before` appended once, an answer to any other cursor changing nothing */
export function olderPage(state: PagesState, before: string, page: ActivityPage): PagesState {
    if (state.next !== before) return state;
    const have = new Set(state.items.map(itemKey));
    const added = page.items.filter((item) => !have.has(itemKey(item)));
    return { items: [...state.items, ...added], next: page.next, loaded: true };
}

/** The pages of each filter, so an answer lands on the filter it was asked for */
export type FeedState = Record<ActivityFilter, PagesState>;

export const NO_FEED: FeedState = { all: NO_PAGES, trades: NO_PAGES, deposits: NO_PAGES };

export type FeedAction =
    | { type: "first"; filter: ActivityFilter; page: ActivityPage }
    | { type: "older"; filter: ActivityFilter; before: string; page: ActivityPage };

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
    const current = state[action.filter];
    const next =
        action.type === "first" ? firstPage(current, action.page) : olderPage(current, action.before, action.page);
    return next === current ? state : { ...state, [action.filter]: next };
}

/** Whether a row is listed under a filter: deposits and withdrawals, or everything else */
export function matchesFilter(filter: ActivityFilter, a: Activity): boolean {
    if (filter === "all") return true;
    const cash = a.kind === "deposit" || a.kind === "withdrawal";
    return filter === "deposits" ? cash : !cash;
}

/** The pages under the live rows, newest first, a live row winning a clash and a hidden id never showing */
export function overlay(o: {
    pages: readonly Activity[];
    more: boolean;
    live: readonly Activity[];
    hidden: ReadonlySet<string>;
}): Activity[] {
    // While older pages exist, a live row older than the oldest page row is left to the pages unless it is pending
    const oldest = o.pages.reduce((min, a) => Math.min(min, a.at.getTime()), Infinity);
    const floor = o.more && o.pages.length > 0 ? oldest : -Infinity;
    const byId = new Map<string, Activity>();
    for (const a of o.pages) byId.set(a.id, a);
    for (const a of o.live) {
        if (!a.pending && a.at.getTime() < floor) continue;
        byId.set(a.id, a);
    }
    return [...byId.values()].filter((a) => !o.hidden.has(a.id)).sort(byNewest);
}
