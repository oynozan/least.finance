import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import type { Address } from "viem";
import { ARC_CHAIN_ID, type ArcClient } from "../chain/arc.ts";
import { findTransfersTo } from "../chain/native-transfers.ts";
import { hostOf } from "../errors.ts";
import type { Collections } from "../db/mongo.ts";
import { formatUsdc } from "../db/money.ts";
import type { Ledger } from "./ledger.ts";
import type { Backfill, DepositRegistry } from "./registry.ts";

const CURSOR_ID = `deposits:${ARC_CHAIN_ID}`;
const MAX_BACKOFF_MS = 30_000;
/** After this many good passes on a fallback RPC, the scan tries the first one again. */
const RETURN_TO_PRIMARY_AFTER = 300;
// The status is public and a failed pass's message can carry the RPC's address and key, so only this goes out
const SCAN_FAILING = "The deposit scan is failing";
const PHASE_TEXT: Record<Phase, string> = {
    head: "reading the chain head",
    cursor: "loading its cursor",
    registry: "loading deposit addresses",
    logs: "reading logs",
    credit: "crediting a transfer",
    save: "saving its cursor",
};

type Deps = {
    /**
     * One client per RPC, in order of preference. A pass reads the head and
     * the logs from the same one: through a fallback, the logs could come from
     * a node behind the one that gave the head, which answers "nothing" for
     * blocks it hasn't seen, and the scan would move past them for good.
     */
    clients: ArcClient[];
    /** The RPCs' URLs, in the same order, for the log: only their hosts are ever written. */
    urls?: string[];
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
    /** Which part of the scan is failing, so /ready says where to look. */
    lastErrorKind: "rpc" | "database" | "credit" | null;
};

/** After this many failed passes in a row the log line is an error. */
const ESCALATE_AFTER = 10;
type Phase = "head" | "cursor" | "registry" | "logs" | "credit" | "save";
const KIND: Record<Phase, NonNullable<WatcherStatus["lastErrorKind"]>> = {
    head: "rpc",
    cursor: "database",
    registry: "database",
    logs: "rpc",
    credit: "credit",
    save: "database",
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
    #lastErrorKind: WatcherStatus["lastErrorKind"] = null;
    /** What the pass was doing, for the line that says it failed. */
    #phase: Phase = "head";
    /** The block range being scanned. */
    #range: { from: number; to: number } | null = null;
    /** The transfer being credited, when a credit is what failed. */
    #crediting: { txHash: string; logIndex: number } | null = null;
    #failures = 0;
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
            lastErrorKind: this.#lastErrorKind,
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
                this.#lastErrorKind = null;
                this.#failures = 0;
                backoff = 0;
                if (this.#provider !== 0 && ++this.#goodPasses >= RETURN_TO_PRIMARY_AFTER) {
                    this.#useProvider(0, "return_to_primary");
                }
                // While behind, keep going; once level with the head, wait for new blocks.
                wait = caughtUp ? this.#deps.pollMs : 0;
            } catch (error) {
                this.#lastError = SCAN_FAILING;
                this.#lastErrorKind = KIND[this.#phase];
                this.#failures += 1;
                backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : this.#deps.pollMs);
                wait = backoff;
                this.#deps.logger[this.#failures >= ESCALATE_AFTER ? "error" : "warn"](
                    {
                        op: "deposit.scan",
                        phase: this.#phase,
                        cursor: this.#cursor,
                        head: this.#head,
                        range: this.#range,
                        addresses: this.#deps.registry.size,
                        crediting: this.#crediting,
                        rpc: this.#provider,
                        rpcHost: this.#host(this.#provider),
                        consecutiveFailures: this.#failures,
                        retryInMs: wait,
                        err: error,
                    },
                    `Deposit scan failed ${PHASE_TEXT[this.#phase]}`,
                );
                this.#useProvider((this.#provider + 1) % this.#deps.clients.length, "failed");
            }
            if (wait > 0) await sleep(wait, undefined, { signal }).catch(() => undefined);
        }
    }

    #host(index: number) {
        const url = this.#deps.urls?.[index];
        return url === undefined ? null : hostOf(url);
    }

    #useProvider(index: number, reason: "failed" | "return_to_primary") {
        if (index === this.#provider) return;
        const from = this.#provider;
        this.#provider = index;
        this.#goodPasses = 0;
        this.#deps.logger.info(
            { rpc: index, from: this.#host(from), to: this.#host(index), reason },
            "Deposit scan switched RPC",
        );
    }

    /** One pass: scans the next range of blocks. True once level with the head. */
    async tick(): Promise<boolean> {
        const { registry, scanRange, confirmations, lagBlocks } = this.#deps;
        const client = this.#deps.clients[this.#provider]!;

        // The head is read before the addresses, so any address added after this
        // point was handed out after these blocks, and can't have deposits in them.
        this.#phase = "head";
        this.#range = null;
        this.#crediting = null;
        const head = Number(await client.getBlockNumber({ cacheTime: 0 }));
        this.#head = head;
        const target = head - confirmations - lagBlocks;
        // A chain younger than the lag has nothing old enough to scan yet.
        if (target < 0) return true;
        this.#phase = "cursor";
        const cursor = this.#cursor ?? (await this.#loadCursor(target));

        this.#phase = "registry";
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
        this.#phase = "save";
        await this.#saveCursor(to);
        return to >= target;
    }

    async #scan(client: ArcClient, addresses: Address[], fromBlock: number, toBlock: number) {
        const { registry, ledger, scanRange } = this.#deps;
        for (let from = fromBlock; from <= toBlock; from += scanRange) {
            const to = Math.min(toBlock, from + scanRange - 1);
            this.#phase = "logs";
            this.#range = { from, to };
            for (const transfer of await findTransfersTo(client, addresses, from, to, this.#deps.logger)) {
                const accountId = registry.lookup(transfer.to);
                if (!accountId) {
                    this.#deps.logger.warn(
                        {
                            op: "deposit.scan",
                            txHash: transfer.txHash,
                            logIndex: transfer.logIndex,
                            to: transfer.to,
                            amount: formatUsdc(transfer.value),
                        },
                        "Scan saw a transfer to an address with no account",
                    );
                    continue;
                }
                this.#phase = "credit";
                this.#crediting = { txHash: transfer.txHash, logIndex: transfer.logIndex };
                try {
                    await ledger.credit(transfer, accountId, "scan");
                } catch (error) {
                    this.#deps.logger.error(
                        {
                            op: "deposit.credit",
                            accountId: accountId.toHexString(),
                            txHash: transfer.txHash,
                            logIndex: transfer.logIndex,
                            to: transfer.to,
                            amount: formatUsdc(transfer.value),
                            source: "scan",
                            err: error,
                        },
                        "Couldn't credit a deposit the scan found",
                    );
                    throw error;
                }
                this.#phase = "logs";
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
