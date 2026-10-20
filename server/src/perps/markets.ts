import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { outageLog } from "../log-throttle.ts";
import type { Config } from "../config.ts";
import type { PerpMarketsView } from "../protocol.ts";
import type { HyperliquidClient, PerpMeta } from "./client.ts";

type Deps = {
    client: Pick<HyperliquidClient, "meta">;
    config: Pick<Config, "PERPS_TRADING" | "PERPS_MAX_LEVERAGE">;
    logger: Logger;
    /** The clock, for tests. */
    now?: () => number;
};

const SYNC_MS = 5_000;
/** How long the picker's order holds before it follows the 24-hour volumes again. */
const RANK_MS = 10 * 60_000;

/** Keeps every perp market Hyperliquid lists (the default dex, not its builder dexes) and serves them, busiest first, with their marks and leverage caps. */
export class PerpMarkets {
    readonly #deps: Deps;
    readonly #now: () => number;
    #assets: PerpMeta["assets"] = [];
    #rank = new Map<string, number>();
    #rankedAt: number | null = null;
    #readAt: number | null = null;
    /** A sync that keeps failing is logged when it starts, once an hour, and when it clears. */
    readonly #outage: ReturnType<typeof outageLog>;
    #maxOrderUSD: () => number | null = () => null;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#outage = outageLog(deps.logger, this.#now);
    }

    start(): void {
        if (this.#loop) return;
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    stop(): Promise<void> {
        this.#stop?.abort();
        const loop = this.#loop;
        this.#loop = null;
        this.#stop = null;
        return loop ?? Promise.resolve();
    }

    async #run(signal: AbortSignal) {
        while (!signal.aborted) {
            await this.tick(signal);
            await sleep(SYNC_MS, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One sync; a failed read leaves the last good list in place. */
    async tick(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return;
        try {
            const meta = await this.#deps.client.meta();
            if (signal?.aborted) return;
            const listed = meta.assets.filter((entry) => Number.isFinite(entry.markPx) && entry.markPx > 0);
            const at = this.#now();
            if (
                this.#rankedAt === null ||
                at - this.#rankedAt >= RANK_MS ||
                listed.some((a) => !this.#rank.has(a.asset))
            ) {
                const ranked = [...listed].sort((a, b) => b.dayNtlVlm - a.dayNtlVlm || a.asset.localeCompare(b.asset));
                this.#rank = new Map(ranked.map((entry, i) => [entry.asset, i]));
                this.#rankedAt = at;
            }
            this.#assets = listed.sort((a, b) => this.#rank.get(a.asset)! - this.#rank.get(b.asset)!);
            this.#readAt = at;
            this.#outage.ok("sync", "The Hyperliquid markets are being read again");
        } catch (error) {
            this.#outage.failed(
                "sync",
                "warn",
                {
                    event: "perp.markets.sync_failed",
                    lastReadAt: this.#readAt,
                    ageSec: this.#readAt === null ? null : Math.round((this.#now() - this.#readAt) / 1000),
                    err: error,
                },
                "Couldn't sync the Hyperliquid markets, keeping the last list",
            );
        }
    }

    /** When the list was last read, in epoch ms; null before the first read. */
    readAt(): number | null {
        return this.#readAt;
    }

    list(): PerpMeta["assets"] {
        return this.#assets;
    }

    byAsset(asset: string): PerpMeta["assets"][number] | undefined {
        return this.#assets.find((entry) => entry.asset === asset);
    }

    /** The perps service supplies the per-order limit; until it does, and while trading is off, there is none. */
    setMaxOrderUSD(limit: () => number | null): void {
        this.#maxOrderUSD = limit;
    }

    view(): PerpMarketsView {
        const limit = this.#deps.config.PERPS_TRADING === "on" ? this.#maxOrderUSD() : null;
        return {
            markets: this.#assets.map((entry) => ({
                asset: entry.asset,
                markPx: String(entry.markPx),
                maxLeverage: Math.min(entry.maxLeverage, this.#deps.config.PERPS_MAX_LEVERAGE),
                fundingRate: String(entry.funding),
            })),
            maxOrderUSD: limit === null ? null : String(limit),
        };
    }
}
