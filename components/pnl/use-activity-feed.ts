"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AUTO_RETRY, NO_FEED, feedReducer, matchesFilter, overlay, retryDelay } from "@/lib/pnl/activity-pages";
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
    /** Why the filter's newest page or an older one couldn't be read, in the server's own words or which kind of silence it was; `auto` when it is being asked again by itself. */
    failure: { kind: "first" | "more"; message: string; auto: boolean } | null;
    /** Asks again at once, for a failure that isn't asked again by itself. */
    retry: () => void;
};

type Failure = { filter: ActivityFilter; kind: "first" | "more"; message: string; auto: boolean };

/** What a filter's newest page was answered at, being the bind and the pushes counted since, so a new one of either asks again */
export const answerStamp = (pnl: { bound: number; changed: number }) => `${pnl.bound}:${pnl.changed}`;

/** A failed withdrawal is a row of its own now, so no row is kept off the list */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/** The Activity card's rows under one filter: the server's history pages with the live rows over them, older pages on request */
export function useActivityFeed(filter: ActivityFilter, live: readonly Activity[]): ActivityFeed {
    const { pnl, loadActivityPage } = useAccount();
    const { catalog } = useTrade();
    const nowMs = useNow();
    const [feed, dispatch] = useReducer(feedReducer, NO_FEED);
    const [loadingMore, setLoadingMore] = useState<readonly ActivityFilter[]>([]);
    // Bumped by the retry timer, so the effect asks again
    const [attempt, setAttempt] = useState(0);
    const [failure, setFailure] = useState<Failure | null>(null);
    // How many times in a row each filter's newest page has failed, for the wait before the next ask
    const tries = useRef<Partial<Record<ActivityFilter, number>>>({});

    // The latest loader, without asking again whenever its identity changes
    const load = useRef(loadActivityPage);
    useEffect(() => {
        load.current = loadActivityPage;
    });
    // The stamp each filter's newest page was last answered at
    const answeredAt = useRef<Partial<Record<ActivityFilter, string>>>({});
    // The filters with an older page on its way, so a second click is ignored at once
    const asking = useRef(new Set<ActivityFilter>());

    // Nothing is bound between one account and the next, so what was loaded is not carried over
    if (pnl.bound === 0 && feed !== NO_FEED) dispatch({ type: "reset" });

    // The newest page of the filter once it is bound, and again after every bind and push; a failure is asked again after RETRY_MS
    const { bound, changed } = pnl;
    useEffect(() => {
        if (bound === 0) {
            answeredAt.current = {};
            return;
        }
        const stamp = answerStamp({ bound, changed });
        if (answeredAt.current[filter] === stamp) return;
        let current = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        void load.current({ filter }).then((answer) => {
            if (!current) return;
            if ("code" in answer) {
                console.warn(`The history didn't load (${answer.code}): ${answer.message}`);
                // A busy or away server is asked again, a little later each time; anything else waits for a click
                const auto = AUTO_RETRY.has(answer.code);
                setFailure({ filter, kind: "first", message: answer.message, auto });
                if (auto) {
                    const failed = tries.current[filter] ?? 0;
                    tries.current[filter] = failed + 1;
                    timer = setTimeout(() => setAttempt((n) => n + 1), retryDelay(failed));
                }
                return;
            }
            tries.current[filter] = 0;
            setFailure((last) => (last?.filter === filter && last.kind === "first" ? null : last));
            answeredAt.current[filter] = stamp;
            dispatch({ type: "first", filter, page: answer });
        });
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [filter, bound, changed, attempt]);

    const pages = feed[filter];
    const next = pages.next;

    const loadMore = useCallback(() => {
        if (next === null || asking.current.has(filter)) return;
        asking.current.add(filter);
        setLoadingMore((list) => [...list, filter]);
        setFailure((last) => (last?.filter === filter && last.kind === "more" ? null : last));
        void load.current({ before: next, filter }).then((answer) => {
            asking.current.delete(filter);
            setLoadingMore((list) => list.filter((f) => f !== filter));
            if (!("code" in answer)) {
                dispatch({ type: "older", filter, before: next, page: answer });
                return;
            }
            if (answer.code === "bad_request") {
                // The cursor is out of date: start the history again from its newest page
                answeredAt.current = {};
                dispatch({ type: "reset" });
                setAttempt((n) => n + 1);
                return;
            }
            // A failed page changes nothing, so `more` stays and the button asks again
            setFailure({ filter, kind: "more", message: answer.message, auto: false });
        });
    }, [filter, next]);

    const retry = useCallback(() => {
        tries.current = {};
        setFailure(null);
        setAttempt((n) => n + 1);
    }, []);

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
                hidden: NOTHING_HIDDEN,
            }),
        [pageRows, next, live, filter],
    );

    return {
        rows,
        loaded: pages.loaded,
        more: next !== null,
        loadingMore: loadingMore.includes(filter),
        loadMore,
        failure: failure?.filter === filter ? failure : null,
        retry,
    };
}
