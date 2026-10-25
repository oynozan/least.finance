import type { Logger } from "pino";
import type { Collections } from "../db/mongo.ts";
import type { StatsFees, StatsPnlView, StatsPositionsPage, StatsRange, StatsView, StatsWallet } from "../protocol.ts";
import { WALLETS, type HeldReaders, type HeldWallet } from "./held.ts";
import type { readFees } from "./fees.ts";
import type { readOwed } from "./owed.ts";
import { pnlPoints } from "./pnl.ts";
import { positionsPage } from "./positions.ts";
import { usdString } from "./units.ts";

export const STATS_REFRESH_MS = 60_000;
export const DEPOSITS_REFRESH_MS = 600_000;
export const STATS_READ_TIMEOUT_MS = 20_000;
export const DEPOSITS_READ_TIMEOUT_MS = 60_000;
/** Up to this many accounts, the deposit addresses are read on every refresh; above it, every `DEPOSITS_REFRESH_MS`. */
export const DEPOSITS_EVERY_REFRESH_MAX_ACCOUNTS = 300;
const HOUR = 3_600_000;
const RANGES: StatsRange[] = ["7D", "30D", "All"];

type Deps = {
    collections: Collections;
    readers: HeldReaders;
    readOwed: () => ReturnType<typeof readOwed>;
    readFees: (now: number) => ReturnType<typeof readFees>;
    /** The best bid for an outcome token; null when it can't be read. */
    outcomeBid?: (eventId: string, tokenId: string) => Promise<number | null>;
    priceOf?: (symbol: string) => number | null;
    logger: Logger;
    now?: () => number;
    /** How long one wallet read may take; a test shortens it. */
    readTimeoutMs?: number;
    /** The pause between two refreshes of the timer; a test shortens it. */
    refreshMs?: number;
};

type Kept = { wallet: HeldWallet; readAt: number | null; failed: boolean };
type Owed = Awaited<ReturnType<typeof readOwed>>;
type Fees = Awaited<ReturnType<typeof readFees>>;

/** Our money's live figures, kept from the last good read, and the hourly record of them. */
export class StatsService {
    readonly #deps: Deps;
    readonly #now: () => number;
    #kept = new Map<string, Kept>();
    #depositsReadAt: number | null = null;
    /** After a failed deposits read, no new one starts before this. */
    #depositsRetryAt = 0;
    /** Reads that are still running, so a slow one is waited on, not doubled. */
    #inflight = new Map<keyof HeldReaders, Promise<HeldWallet>>();
    #owedStale = false;
    #feesStale = false;
    #owed: Owed | null = null;
    #fees: Fees | null = null;
    #view: StatsView | null = null;
    #snapshotHour: number | null = null;
    #timer: NodeJS.Timeout | null = null;
    #running: Promise<void> | null = null;
    #stopped = true;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start(): void {
        if (!this.#stopped) return;
        this.#stopped = false;
        const tick = () => {
            this.#timer = null;
            void this.refresh().finally(() => {
                if (!this.#stopped) this.#timer = setTimeout(tick, this.#deps.refreshMs ?? STATS_REFRESH_MS);
            });
        };
        tick();
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        await this.#running?.catch(() => undefined);
    }

    /** Reads everything once; a refresh already running is joined, not doubled. */
    refresh(): Promise<void> {
        this.#running ??= this.#refresh()
            .catch((error: unknown) => this.#deps.logger.error({ err: error }, "Couldn't refresh the stats"))
            .finally(() => {
                this.#running = null;
            });
        return this.#running;
    }

    view(): StatsView | null {
        return this.#view;
    }

    async pnl(range: StatsRange): Promise<StatsPnlView> {
        const now = this.#now();
        const span = { "7D": 7, "30D": 30, All: null }[range];
        const rows = await this.#deps.collections.statsSnapshots
            .find(span === null ? {} : { at: { $gte: new Date(now - span * 86_400_000) } }, {
                projection: { _id: 0, at: 1, equityUsd: 1 },
            })
            .sort({ at: 1 })
            .toArray();
        return pnlPoints(rows, range, now);
    }

    positions(ask: Parameters<typeof positionsPage>[1]): Promise<StatsPositionsPage> {
        return positionsPage(
            {
                collections: this.#deps.collections,
                outcomeBid: this.#deps.outcomeBid ?? (async () => null),
                priceOf: this.#deps.priceOf ?? (() => null),
            },
            ask,
        );
    }

    async #refresh(): Promise<void> {
        const now = this.#now();
        const { readers } = this.#deps;
        const depositsDue = await this.#depositsDue(now);

        const ids = (Object.keys(readers) as (keyof HeldReaders)[]).filter((id) => id !== "deposits" || depositsDue);
        const [wallets, owed, fees] = await Promise.all([
            Promise.all(
                ids.map((id) =>
                    withDeadline(
                        this.#read(id),
                        id === "deposits"
                            ? (this.#deps.readTimeoutMs ?? DEPOSITS_READ_TIMEOUT_MS)
                            : (this.#deps.readTimeoutMs ?? STATS_READ_TIMEOUT_MS),
                    ).catch((error: unknown) => failedRead(id, error)),
                ),
            ),
            Promise.resolve()
                .then(() => this.#deps.readOwed())
                .catch((error: unknown) => this.#readFailed("owed", error)),
            Promise.resolve()
                .then(() => this.#deps.readFees(now))
                .catch((error: unknown) => this.#readFailed("fees", error)),
        ]);
        if (owed) this.#owed = owed;
        if (fees) this.#fees = fees;
        this.#owedStale = !owed;
        this.#feesStale = !fees;
        // Nothing to show without what we owe, and this is the first read.
        if (!this.#owed || !this.#fees) return;

        for (const wallet of wallets) {
            const before = this.#kept.get(wallet.id);
            // A wallet that isn't set up is a fact, not a failed read.
            const failed = wallet.error !== null && wallet.error !== "Not set up";
            if (failed && before) {
                this.#kept.set(wallet.id, {
                    wallet: { ...before.wallet, error: wallet.error },
                    readAt: before.readAt,
                    failed: true,
                });
            } else {
                this.#kept.set(wallet.id, { wallet, readAt: failed ? null : now, failed });
            }
            if (failed) this.#deps.logger.warn({ wallet: wallet.id, reason: wallet.error }, "Couldn't read a wallet");
        }
        if (depositsDue) {
            if (this.#kept.get("deposits")?.failed) this.#depositsRetryAt = now + DEPOSITS_REFRESH_MS;
            else if (this.#kept.get("deposits")) this.#depositsReadAt = now;
        }

        const view = this.#build(now);
        this.#view = view;
        await this.#snapshot(now, view);
    }

    /** Few accounts: every refresh, so a deposit and its sweep never show apart. Many: every 10 minutes. */
    async #depositsDue(now: number): Promise<boolean> {
        if (now < this.#depositsRetryAt) return false;
        if (this.#depositsReadAt === null) return true;
        const accounts = await this.#deps.collections.accounts
            .countDocuments({ depositAddress: { $exists: true } }, { limit: DEPOSITS_EVERY_REFRESH_MAX_ACCOUNTS + 1 })
            .catch(() => Infinity);
        if (accounts <= DEPOSITS_EVERY_REFRESH_MAX_ACCOUNTS) return true;
        return now - this.#depositsReadAt >= DEPOSITS_REFRESH_MS;
    }

    /** Starts a wallet's read unless an earlier one is still running, which is reused. */
    #read(id: keyof HeldReaders): Promise<HeldWallet> {
        let work = this.#inflight.get(id);
        if (!work) {
            work = Promise.resolve().then(() => this.#deps.readers[id]());
            this.#inflight.set(id, work);
            const done = () => {
                if (this.#inflight.get(id) === work) this.#inflight.delete(id);
            };
            work.then(done, done);
        }
        return work;
    }

    #readFailed(what: string, error: unknown): null {
        this.#deps.logger.error({ err: error }, `Couldn't read the ${what} for the stats`);
        return null;
    }

    #build(now: number): StatsView {
        const owed = this.#owed!;
        const kept = [...this.#kept.values()];
        const heldUsd = kept.reduce((sum, k) => sum + k.wallet.usd, 0);
        const owedUsd = owed.lines.reduce((sum, line) => sum + line.usd, 0);
        const wallets: StatsWallet[] = kept.map(({ wallet, readAt }) => ({
            id: wallet.id,
            label: wallet.label,
            network: wallet.network,
            address: wallet.address,
            usd: usdString(wallet.usd),
            parts: wallet.parts.map((p) => ({
                symbol: p.symbol,
                amount: p.amount,
                usd: p.usd === null ? null : usdString(p.usd),
            })),
            error: wallet.error,
            readAt: readAt === null ? null : new Date(readAt).toISOString(),
        }));
        const fee = (f: Fees[StatsRange]): StatsFees => ({
            totalUsd: usdString(f.totalUsd),
            spreadUsd: usdString(f.spreadUsd),
            perpUsd: usdString(f.perpUsd),
        });
        return {
            at: new Date(now).toISOString(),
            heldUsd: usdString(heldUsd),
            owedUsd: usdString(owedUsd),
            equityUsd: usdString(heldUsd - owedUsd),
            // A failed read (wallet, owed or fees) or a coin with no price makes the totals a best guess.
            estimated:
                kept.some((k) => k.failed || k.wallet.parts.some((p) => p.usd === null)) ||
                owed.unpriced.length > 0 ||
                this.#owedStale ||
                this.#feesStale,
            wallets,
            owed: owed.lines.map((line) => ({ id: line.id, label: line.label, usd: usdString(line.usd) })),
            fees: Object.fromEntries(RANGES.map((range) => [range, fee(this.#fees![range])])) as Record<
                StatsRange,
                StatsFees
            >,
        };
    }

    /** Writes this hour's record; an estimated one is replaced by the first complete read of the hour, and only a complete one ends the hour's writing. */
    async #snapshot(now: number, view: StatsView): Promise<void> {
        const hour = Math.floor(now / HOUR) * HOUR;
        if (this.#snapshotHour === hour) return;
        const owed = this.#owed!;
        const values = {
            heldUsd: Number(view.heldUsd),
            owedUsd: Number(view.owedUsd),
            equityUsd: Number(view.equityUsd),
            estimated: view.estimated,
            parts: Object.fromEntries([...this.#kept].map(([id, k]) => [id, k.wallet.usd])),
            owed: Object.fromEntries(owed.lines.map((line) => [line.id, line.usd])),
        };
        const { statsSnapshots } = this.#deps.collections;
        const at = new Date(hour);
        await statsSnapshots.updateOne({ at }, { $setOnInsert: values }, { upsert: true });
        if (view.estimated) return;
        await statsSnapshots.updateOne({ at, estimated: true }, { $set: values });
        this.#snapshotHour = hour;
    }
}

function failedRead(id: HeldWallet["id"], error: unknown): HeldWallet {
    return {
        id,
        ...WALLETS[id],
        address: null,
        usd: 0,
        parts: [],
        error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "Read failed",
    };
}

/** The read, or a rejection once `ms` have passed. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
