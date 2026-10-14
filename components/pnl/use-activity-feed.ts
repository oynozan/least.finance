"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { NO_FEED, RETRY_MS, feedReducer, matchesFilter, overlay } from "@/lib/pnl/activity-pages";
import { activityFromItem, type Activity } from "@/lib/trade/activity";
import type { ActivityFilter } from "@/server/src/protocol";
import { useAccount } from "@/components/account-provider";
import { useTrade } from "@/components/trade/trade-provider";
import { priceIn, useNow } from "./use-activity";

export type ActivityFeed = {
    rows: Activity[];
    /** The filter's first page has answered. */
    loaded: boolean;
    /** Older pages exist. */
    more: boolean;
    loadingMore: boolean;
    loadMore: () => void;
};

/** The Activity card's rows under one filter: the server's history pages with the live rows over them, older pages on request */
export function useActivityFeed(filter: ActivityFilter, live: readonly Activity[]): ActivityFeed {
    const { pnl, loadActivityPage, withdrawals } = useAccount();
    const { catalog } = useTrade();
    const nowMs = useNow();
    const [feed, dispatch] = useReducer(feedReducer, NO_FEED);
    const [loadingMore, setLoadingMore] = useState<readonly ActivityFilter[]>([]);
    // Bumped by the retry timer, so the effect asks again
    const [attempt, setAttempt] = useState(0);

    // The latest loader, without asking again whenever its identity changes
    const load = useRef(loadActivityPage);
    useEffect(() => {
        load.current = loadActivityPage;
    });
    // The bind each filter's newest page was last answered at
    const answeredAt = useRef<Partial<Record<ActivityFilter, number>>>({});
    // The filters with an older page on its way, so a second click is ignored at once
    const asking = useRef(new Set<ActivityFilter>());

    // Nothing is bound between one account and the next, so what was loaded is not carried over
    if (pnl.bound === 0 && feed !== NO_FEED) dispatch({ type: "reset" });

    // The newest page of the filter once it is bound, and again after every bind; a failure is asked again after RETRY_MS
    useEffect(() => {
        if (pnl.bound === 0) {
            answeredAt.current = {};
            return;
        }
        if (answeredAt.current[filter] === pnl.bound) return;
        const bound = pnl.bound;
        let current = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        void load.current({ filter }).then((answer) => {
            if (!current) return;
            if ("code" in answer) {
                timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
                return;
            }
            answeredAt.current[filter] = bound;
            dispatch({ type: "first", filter, page: answer });
        });
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [filter, pnl.bound, attempt]);

    const pages = feed[filter];
    const next = pages.next;

    const loadMore = useCallback(() => {
        if (next === null || asking.current.has(filter)) return;
        asking.current.add(filter);
        setLoadingMore((list) => [...list, filter]);
        void load.current({ before: next, filter }).then((answer) => {
            asking.current.delete(filter);
            setLoadingMore((list) => list.filter((f) => f !== filter));
            // A failed page changes nothing, so `more` stays and the button asks again
            if (!("code" in answer)) dispatch({ type: "older", filter, before: next, page: answer });
        });
    }, [filter, next]);

    const hidden = useMemo(
        () => new Set(withdrawals.filter((w) => w.state === "failed").map((w) => `withdrawal:${w.requestId}`)),
        [withdrawals],
    );
    const pageRows = useMemo(() => {
        if (nowMs === null) return [];
        const ctx = { now: new Date(nowMs), priceOf: priceIn(catalog) };
        return pages.items.flatMap((item) => activityFromItem(item, ctx) ?? []);
    }, [pages.items, nowMs, catalog]);
    const rows = useMemo(
        () =>
            overlay({
                pages: pageRows,
                more: next !== null,
                live: live.filter((a) => matchesFilter(filter, a)),
                hidden,
            }),
        [pageRows, next, live, filter, hidden],
    );

    return { rows, loaded: pages.loaded, more: next !== null, loadingMore: loadingMore.includes(filter), loadMore };
}
