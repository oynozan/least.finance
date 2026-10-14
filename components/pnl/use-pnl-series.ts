"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, type Account } from "@/components/account-provider";
import { nextSeriesRequest, saveSeries, storedSeries, subscribeSeries } from "@/lib/pnl/series-store";
import type { PnlSeries } from "@/server/src/protocol";

/** One event fires several pushes, so the series is asked for once they stop. */
const DEBOUNCE_MS = 400;

const subscribeNever = () => () => undefined;
/** The browser's time zone, in the browser only: the server doesn't know the person's. */
const useZone = () =>
    useSyncExternalStore(
        subscribeNever,
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        () => null,
    );

/** Asks once and saves the answer. True: it failed with nothing stored. False: it was stored. Null: nothing to tell. */
async function ask(load: Account["loadPnlSeries"], tz: string): Promise<boolean | null> {
    const request = nextSeriesRequest();
    const answer = await load(tz);
    if ("code" in answer) return storedSeries(tz) ? null : true;
    return saveSeries(tz, request, answer) ? false : null;
}

/** The balance and PnL series in the browser's time zone: the stored answer at once, a fresh one on each bind and push. */
export function usePnlSeries(): { series: PnlSeries | null; failed: boolean } {
    const { pnl, loadPnlSeries } = useAccount();
    const tz = useZone();
    const series = useSyncExternalStore(
        subscribeSeries,
        () => (tz ? storedSeries(tz) : null),
        () => null,
    );
    const [failed, setFailed] = useState(false);
    if (pnl.bound === 0 && failed) setFailed(false);

    // The latest loader, without asking again whenever its identity changes.
    const load = useRef(loadPnlSeries);
    useEffect(() => {
        load.current = loadPnlSeries;
    });

    // At once on mount and after every bind.
    useEffect(() => {
        if (!tz || pnl.bound === 0) return;
        let live = true;
        void ask(load.current, tz).then((result) => {
            if (live && result !== null) setFailed(result);
        });
        return () => {
            live = false;
        };
    }, [tz, pnl.bound]);

    // After the pushes stop; the count the page mounted with was answered by the ask above.
    const seen = useRef(pnl.changed);
    useEffect(() => {
        if (pnl.changed === seen.current) return;
        seen.current = pnl.changed;
        if (!tz || pnl.bound === 0) return;
        let live = true;
        const timer = setTimeout(() => {
            void ask(load.current, tz).then((result) => {
                if (live && result !== null) setFailed(result);
            });
        }, DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [tz, pnl.bound, pnl.changed]);

    return { series, failed: failed && series === null };
}
