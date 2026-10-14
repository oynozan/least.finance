import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
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

/** The markets Long and Short offer, in the order the picker lists them. */
export const PERP_ASSETS = ["BTC", "ETH", "SOL", "LINK", "DOGE"];

/** Keeps the offered perp markets from Hyperliquid's meta and serves them with their marks and leverage caps. */
export class PerpMarkets {
    readonly #deps: Deps;
    readonly #now: () => number;
    #assets: PerpMeta["assets"] = [];
    #readAt: number | null = null;
    #maxOrderUSD: () => number | null = () => null;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
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
            const listed = new Map(meta.assets.map((entry) => [entry.asset, entry]));
            this.#assets = PERP_ASSETS.flatMap((asset) => listed.get(asset) ?? []);
            this.#readAt = this.#now();
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't sync the Hyperliquid markets, keeping the last list");
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
