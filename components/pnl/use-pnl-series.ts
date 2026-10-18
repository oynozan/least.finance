"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, type Account } from "@/components/account-provider";
import type { ApiError } from "@/lib/account/state";
import { localDate } from "@/lib/pnl/labels";
import { nextSeriesRequest, saveSeries, storedSeries, subscribeSeries } from "@/lib/pnl/series-store";
import type { PnlSeries } from "@/server/src/protocol";

/** One event fires several pushes, so the series is asked for once they stop. */
const DEBOUNCE_MS = 400;

const MINUTE = 60_000;

const subscribeNever = () => () => undefined;
const subscribeMinute = (onChange: () => void) => {
    const timer = setInterval(onChange, MINUTE);
    return () => clearInterval(timer);
};
/** The browser's time zone, in the browser only: the server doesn't know the person's. */
const useZone = () =>
    useSyncExternalStore(
        subscribeNever,
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        () => null,
    );

/** The browser's local date, in the browser only: it turns over at midnight, when the last bar is a new day. */
const useToday = () =>
    useSyncExternalStore(
        subscribeMinute,
        () => localDate(new Date()),
        () => null,
    );

/** Asks once and saves the answer. The refusal: it failed with nothing stored. False: it was stored. Null: nothing to tell. */
async function ask(load: Account["loadPnlSeries"], tz: string): Promise<ApiError | false | null> {
    const request = nextSeriesRequest();
    const answer = await load(tz);
    if ("code" in answer) {
        console.warn(`The balance history didn't load (${answer.code}): ${answer.message}`);
        return storedSeries(tz) ? null : answer;
    }
    return saveSeries(tz, request, answer) ? false : null;
}

/** The balance and PnL series in the browser's time zone: the stored answer at once, a fresh one on each bind and push. */
export function usePnlSeries(): {
    series: PnlSeries | null;
    failed: boolean;
    /** Why the first load failed, in the server's words or the client's. */
    error: ApiError | null;
    retry: () => void;
} {
    const { pnl, loadPnlSeries } = useAccount();
    const tz = useZone();
    const today = useToday();
    const series = useSyncExternalStore(
        subscribeSeries,
        () => (tz ? storedSeries(tz) : null),
        () => null,
    );
    const [error, setError] = useState<ApiError | null>(null);
    const [attempt, setAttempt] = useState(0);
    if (pnl.bound === 0 && error) setError(null);

    // The latest loader, without asking again whenever its identity changes.
    const load = useRef(loadPnlSeries);
    useEffect(() => {
        load.current = loadPnlSeries;
    });

    // At once on mount, after every bind and when the date turns over.
    useEffect(() => {
        if (!tz || !today || pnl.bound === 0) return;
        let live = true;
        void ask(load.current, tz).then((result) => {
            if (live && result !== null) setError(result || null);
        });
        return () => {
            live = false;
        };
    }, [tz, today, pnl.bound, attempt]);

    // After the pushes stop; the count the page mounted with was answered by the ask above.
    const seen = useRef(pnl.changed);
    useEffect(() => {
        if (pnl.changed === seen.current) return;
        seen.current = pnl.changed;
        if (!tz || pnl.bound === 0) return;
        let live = true;
        const timer = setTimeout(() => {
            void ask(load.current, tz).then((result) => {
                if (live && result !== null) setError(result || null);
            });
        }, DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [tz, pnl.bound, pnl.changed]);

    const failed = error !== null && series === null;
    return { series, failed, error: failed ? error : null, retry: () => setAttempt((n) => n + 1) };
}
