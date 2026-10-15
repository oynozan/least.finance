import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { SwapCatalogView } from "../protocol.ts";
import { COINS, NETWORKS } from "./coins.ts";
import type { Lifi } from "./lifi.ts";

type Deps = {
    lifi: Pick<Lifi, "tokens">;
    logger: Logger;
    syncMs: number;
    /** The clock, for tests. */
    now?: () => number;
};

/** How many syncs a read price may go unrefreshed before it counts as no price. */
const STALE_AFTER_SYNCS = 3;

const CHAIN_IDS = NETWORKS.map((network) => network.chainId);
const NETWORK_OF = new Map(NETWORKS.map((network) => [network.id, network]));
const KIND_OF = new Map(NETWORKS.map((network) => [network.chainId, network.kind]));

// EVM addresses compare without case, Solana's are exact
const keyOf = (chainId: number, address: string) =>
    `${chainId}:${KIND_OF.get(chainId) === "evm" ? address.toLowerCase() : address}`;

/** Keeps the swap coins' live USD prices from LI.FI's token list and serves the coins with them. */
export class SwapCatalog {
    readonly #deps: Deps;
    readonly #now: () => number;
    #prices = new Map<string, number | null>();
    #readAt: number | null = null;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    async #run(signal: AbortSignal) {
        while (!signal.aborted) {
            await this.tick(signal);
            await sleep(this.#deps.syncMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One refresh; a failed or empty read leaves the last prices in place, until they are too old to serve. */
    async tick(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return;
        try {
            const listed = new Map<string, number | null>();
            for (const token of await this.#deps.lifi.tokens(CHAIN_IDS)) {
                listed.set(keyOf(token.chainId, token.address), token.priceUSD);
            }
            if (signal?.aborted) return;

            let found = 0;
            const prices = new Map<string, number | null>();
            for (const coin of COINS) {
                const entries = coin.entries.map((entry) => {
                    const key = keyOf(NETWORK_OF.get(entry.network)!.chainId, entry.address);
                    if (listed.has(key)) found += 1;
                    return { network: entry.network, price: listed.get(key) ?? null };
                });
                const home = entries.find((entry) => entry.network === coin.home)?.price ?? null;
                prices.set(coin.symbol, home ?? entries.find((entry) => entry.price !== null)?.price ?? null);
            }
            // A list without a single table coin is a changed schema, not a market with no prices
            if (found === 0) throw new Error("LI.FI's token list holds none of the swap coins");

            this.#prices = prices;
            this.#readAt = this.#now();
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't read LI.FI's token list");
        }
    }

    view(): SwapCatalogView {
        return {
            coins: COINS.map((coin) => ({
                symbol: coin.symbol,
                name: coin.name,
                priceUSD: this.priceOf(coin.symbol),
                home: coin.home,
                networks: coin.entries.map(({ network, label, wrapped }) => ({
                    network,
                    ...(label !== undefined && { label }),
                    ...(wrapped !== undefined && { wrapped }),
                })),
            })),
            readAt: this.#readAt === null ? null : new Date(this.#readAt).toISOString(),
        };
    }

    /** The coin's last read price, or null when it has none, isn't a swap coin, or the list hasn't been read for three syncs. */
    priceOf(symbol: string): number | null {
        // Every price comes from the same read, so one time covers them all; an old price must not fill a trade
        if (this.#readAt === null || this.#now() - this.#readAt > STALE_AFTER_SYNCS * this.#deps.syncMs) return null;
        return this.#prices.get(symbol) ?? null;
    }
}
