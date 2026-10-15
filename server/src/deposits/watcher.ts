import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Address } from "viem";
import { ARC_CHAIN_ID, type ArcClient } from "../chain/arc.ts";
import { findTransfersTo } from "../chain/native-transfers.ts";
import type { Collections } from "../db/mongo.ts";
import type { Ledger } from "./ledger.ts";
import type { Backfill, DepositRegistry } from "./registry.ts";

const CURSOR_ID = `deposits:${ARC_CHAIN_ID}`;
const MAX_BACKOFF_MS = 30_000;
/** After this many good passes on a fallback RPC, the scan tries the first one again. */
const RETURN_TO_PRIMARY_AFTER = 300;
// The status is public and a failed pass's message can carry the RPC's address and key, so only this goes out
const SCAN_FAILING = "The deposit scan is failing";

type Deps = {
    /**
     * One client per RPC, in order of preference. A pass reads the head and
     * the logs from the same one: through a fallback, the logs could come from
     * a node behind the one that gave the head, which answers "nothing" for
     * blocks it hasn't seen, and the scan would move past them for good.
     */
    clients: ArcClient[];
    collections: Collections;
    registry: DepositRegistry;
    ledger: Ledger;
    logger: Logger;
    pollMs: number;
    confirmations: number;
    /**
     * Blocks the scan stays behind the head. A load-balanced RPC can answer
     * from a node a block or two behind the one that reported the head; the
     * client's report credits deposits at once, so the scan can afford it.
     */
    lagBlocks: number;
    scanRange: number;
    startBlock?: number;
};

export type WatcherStatus = {
    /** The last block fully scanned, or null before the first pass. */
    scannedThrough: number | null;
    head: number | null;
    /** When a pass last finished without an error. */
    lastSuccessAt: Date | null;
    lastError: string | null;
};

/**
 * Scans Arc for USDC sent to any deposit address and credits it. It's the
 * path that catches every deposit, including ones sent from outside the app
 * or never reported; the client's report only makes the usual case faster.
 */
export class DepositWatcher {
    readonly #deps: Deps;
    #cursor: number | null = null;
    #head: number | null = null;
    #lastSuccessAt: Date | null = null;
    #lastError: string | null = null;
    /** Addresses learned late, still to be scanned for the blocks already passed. */
    #backfills: Backfill[] = [];
    /** The RPC this pass uses: the first one, unless it has been failing. */
    #provider = 0;
    #goodPasses = 0;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    status(): WatcherStatus {
        return {
            scannedThrough: this.#cursor,
            head: this.#head,
            lastSuccessAt: this.#lastSuccessAt,
            lastError: this.#lastError,
        };
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
        let backoff = 0;
        while (!signal.aborted) {
            let wait: number;
            try {
                const caughtUp = await this.tick();
                this.#lastSuccessAt = new Date();
                this.#lastError = null;
                backoff = 0;
                if (this.#provider !== 0 && ++this.#goodPasses >= RETURN_TO_PRIMARY_AFTER) this.#useProvider(0);
                // While behind, keep going; once level with the head, wait for new blocks.
                wait = caughtUp ? this.#deps.pollMs : 0;
            } catch (error) {
                this.#lastError = SCAN_FAILING;
                backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : this.#deps.pollMs);
                wait = backoff;
                this.#deps.logger.warn({ err: error, retryInMs: wait, rpc: this.#provider }, "Deposit scan failed");
                this.#useProvider((this.#provider + 1) % this.#deps.clients.length);
            }
            if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
        }
    }

    #useProvider(index: number) {
        if (index === this.#provider) return;
        this.#provider = index;
        this.#goodPasses = 0;
        this.#deps.logger.info({ rpc: index }, "Deposit scan switched RPC");
    }

    /** One pass: scans the next range of blocks. True once level with the head. */
    async tick(): Promise<boolean> {
        const { registry, scanRange, confirmations, lagBlocks } = this.#deps;
        const client = this.#deps.clients[this.#provider]!;

        // The head is read before the addresses, so any address added after this
        // point was handed out after these blocks, and can't have deposits in them.
        const head = Number(await client.getBlockNumber({ cacheTime: 0 }));
        this.#head = head;
        const target = head - confirmations - lagBlocks;
        // A chain younger than the lag has nothing old enough to scan yet.
        if (target < 0) return true;
        const cursor = this.#cursor ?? (await this.#loadCursor(target));

        this.#backfills.push(...(await registry.refresh(cursor)));
        while (this.#backfills.length > 0) {
            const [{ address, fromBlock }] = this.#backfills as [Backfill];
            await this.#scan(client, [address], fromBlock, cursor);
            this.#backfills.shift();
        }

        if (cursor >= target) return true;
        const from = cursor + 1;
        const to = Math.min(target, from + scanRange - 1);
        await this.#scan(client, registry.addresses(), from, to);
        await this.#saveCursor(to);
        return to >= target;
    }

    async #scan(client: ArcClient, addresses: Address[], fromBlock: number, toBlock: number) {
        const { registry, ledger, scanRange } = this.#deps;
        for (let from = fromBlock; from <= toBlock; from += scanRange) {
            const to = Math.min(toBlock, from + scanRange - 1);
            for (const transfer of await findTransfersTo(client, addresses, from, to)) {
                const accountId = registry.lookup(transfer.to);
                if (accountId) await ledger.credit(transfer, accountId, "scan");
            }
        }
    }

    async #loadCursor(target: number): Promise<number> {
        const { collections, startBlock } = this.#deps;
        const saved = await collections.cursors.findOne({ _id: CURSOR_ID });
        let cursor: number;
        if (saved) {
            cursor = saved.block;
        } else if (startBlock !== undefined) {
            cursor = startBlock - 1;
        } else {
            // Nothing can arrive before the oldest account opened.
            const oldest = await collections.accounts.findOne({}, { sort: { openedAtBlock: 1 } });
            cursor = oldest ? oldest.openedAtBlock - 1 : target;
        }
        this.#cursor = cursor;
        this.#deps.logger.info({ cursor, saved: Boolean(saved) }, "Deposit scan starting");
        return cursor;
    }

    async #saveCursor(block: number) {
        await this.#deps.collections.cursors.updateOne(
            { _id: CURSOR_ID },
            { $max: { block }, $set: { updatedAt: new Date() } },
            { upsert: true },
        );
        this.#cursor = block;
    }
}
