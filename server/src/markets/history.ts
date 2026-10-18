import { describeUpstream } from "./upstream.ts";
import type { Logger } from "pino";
import type { MarketHistoryView } from "../protocol.ts";
import type { MarketService } from "./markets.ts";
import type { HistoryQuery, PolymarketData, RawPoint } from "./polymarket-data.ts";

export const HISTORY_FRESH_MS = 180_000;
export const HISTORY_STALE_MS = 1_800_000;
export const HISTORY_MAX_TOKENS = 1_000;
export const MAX_POINTS = 300;

const MINUTE = 60_000;
const DAY = 86_400_000;

type Entry = { points: [number, number][]; stepMs: number; readAt: number };

/** The resolution that gives about 250 points for a market of this age, within what Polymarket keeps. */
export function historyQuery(openedAt: Date | null, now: number): HistoryQuery & { stepMs: number } {
    const result = (interval: HistoryQuery["interval"], fidelity: number) => ({
        interval,
        fidelity,
        stepMs: fidelity * MINUTE,
    });
    if (!openedAt) return result("max", 60);
    const age = Math.max(0, now - openedAt.getTime());
    if (age < DAY) return result("1d", 5);
    if (age < 30 * DAY) return result("max", Math.max(10, Math.ceil(age / MINUTE / 250)));
    if (age < 180 * DAY) return result("max", 720);
    return result("max", 1440);
}

/** Points sorted oldest first as [unix ms, chance], without those before the opening or out of range. */
export function cleanPoints(raw: RawPoint[], openedAt: Date | null): [number, number][] {
    const opened = openedAt?.getTime() ?? -Infinity;
    return raw
        .filter(({ t, p }) => Number.isFinite(t) && Number.isFinite(p) && p >= 0 && p <= 1 && t * 1000 >= opened)
        .sort((a, b) => a.t - b.t)
        .map(({ t, p }): [number, number] => [t * 1000, Math.round(p * 10_000) / 10_000]);
}

/** At most `max` points evenly spread by index, keeping the first and the last. */
export function thin<T>(points: readonly T[], max: number): T[] {
    if (points.length <= max) return [...points];
    const last = points.length - 1;
    return Array.from({ length: max }, (_, i) => points[Math.round((i * last) / (max - 1))]!);
}

type Deps = {
    data: Pick<PolymarketData, "priceHistory">;
    markets: Pick<MarketService, "event" | "openedAt" | "tokensOf">;
    logger: Logger;
    now?: () => number;
};

/** Outcome price history from Polymarket, cached per token and shared between concurrent readers. */
export class MarketHistory {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #entries = new Map<string, Entry>();
    readonly #pending = new Map<string, Promise<void>>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** The asked tokens' lines in the order asked; null when the event isn't offered now or any token isn't one of its own; rejects when Polymarket fails and a token has nothing read within HISTORY_STALE_MS. */
    async view(eventId: string, tokenIds: string[]): Promise<MarketHistoryView | null> {
        if (!(await this.#deps.markets.event(eventId))) return null;
        const held = this.#deps.markets.tokensOf(eventId);
        if (!held || !tokenIds.every((t) => held.has(t))) return null;

        const now = this.#now();
        const wanted = [...new Set(tokenIds)];
        const reads = wanted.filter((t) => {
            const entry = this.#entries.get(t);
            return !entry || now - entry.readAt >= HISTORY_FRESH_MS;
        });
        const toStart = reads.filter((t) => !this.#pending.has(t));
        if (toStart.length) this.#start(eventId, toStart, now);

        const failures = await Promise.allSettled(reads.map((t) => this.#pending.get(t)!));
        const entries = wanted.map((t) => this.#entries.get(t));
        const rejected = failures.find((f) => f.status === "rejected");
        const unusable = entries.some((e) => !e || now - e.readAt >= HISTORY_STALE_MS);
        if (rejected && unusable) throw (rejected as PromiseRejectedResult).reason;

        const byToken = new Map(wanted.map((t, i) => [t, entries[i]!]));
        const used = [...byToken.values()];
        return {
            eventId,
            stepMs: Math.max(...used.map((e) => e.stepMs)),
            outcomes: tokenIds.map((tokenId) => ({ tokenId, points: byToken.get(tokenId)!.points })),
            readAt: new Date(Math.min(...used.map((e) => e.readAt))).toISOString(),
        };
    }

    #start(eventId: string, tokens: string[], now: number) {
        const openedAt = this.#deps.markets.openedAt(eventId);
        const { stepMs, ...query } = historyQuery(openedAt, now);
        const read = this.#deps.data
            .priceHistory(tokens, query)
            .then((histories) => {
                for (const token of tokens) {
                    const points = thin(cleanPoints(histories.get(token) ?? [], openedAt), MAX_POINTS);
                    this.#store(token, { points, stepMs, readAt: now });
                }
            })
            .catch((error: unknown) => {
                // Logged here, once per read; the route that waits on it only maps the failure to a sentence
                this.#deps.logger.warn(
                    { ...describeUpstream(error).fields, err: error, eventId, tokens: tokens.length, ...query },
                    "Polymarket price history read failed",
                );
                throw error;
            })
            .finally(() => {
                for (const token of tokens) this.#pending.delete(token);
            });
        for (const token of tokens) this.#pending.set(token, read);
    }

    #store(token: string, entry: Entry) {
        this.#entries.delete(token);
        this.#entries.set(token, entry);
        if (this.#entries.size > HISTORY_MAX_TOKENS) this.#entries.delete(this.#entries.keys().next().value!);
    }
}
