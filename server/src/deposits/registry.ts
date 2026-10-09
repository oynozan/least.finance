import type { ObjectId } from "mongodb";
import type { Address } from "viem";
import type { AccountDoc, Collections } from "../db/mongo.ts";

type Entry = { accountId: ObjectId; openedAtBlock: number };

/** An address the scan learned about late, and the blocks it may have missed for it. */
export type Backfill = { address: Address; fromBlock: number };

/** Re-reading every account each pass would be wasteful; recent ones are re-read with this much overlap. */
const OVERLAP_MS = 5 * 60_000;
const FULL_RELOAD_MS = 10 * 60_000;

/**
 * The deposit addresses the chain scan watches. Accounts opened by this
 * process are added before their address is handed out, so the scan can't
 * miss them. Ones opened elsewhere (another instance) turn up on refresh,
 * and come back as backfills for blocks scanned before they were known.
 */
export class DepositRegistry {
    readonly #accounts: Collections["accounts"];
    readonly #byAddress = new Map<string, Entry>();
    #lastRefresh = 0;
    #lastFullReload = 0;

    constructor(accounts: Collections["accounts"]) {
        this.#accounts = accounts;
    }

    add(account: Pick<AccountDoc, "_id" | "depositAddress" | "openedAtBlock">) {
        this.#byAddress.set(account.depositAddress, { accountId: account._id, openedAtBlock: account.openedAtBlock });
    }

    remove(address: string) {
        this.#byAddress.delete(address.toLowerCase());
    }

    lookup(address: string): ObjectId | undefined {
        return this.#byAddress.get(address.toLowerCase())?.accountId;
    }

    addresses(): Address[] {
        return [...this.#byAddress.keys()] as Address[];
    }

    get size() {
        return this.#byAddress.size;
    }

    /** Loads every account. The scan's saved cursor already covers them, so nothing needs backfilling. */
    async load(now = Date.now()) {
        const cursor = this.#accounts.find({}, { projection: { _id: 1, depositAddress: 1, openedAtBlock: 1 } });
        for await (const account of cursor) this.add(account);
        this.#lastRefresh = now;
        this.#lastFullReload = now;
    }

    /** Loads accounts opened since the last refresh, returning the ones that opened at or before `scannedThrough`. */
    async refresh(scannedThrough: number, now = Date.now()): Promise<Backfill[]> {
        const full = now - this.#lastFullReload >= FULL_RELOAD_MS;
        const since = new Date(this.#lastRefresh - OVERLAP_MS);
        const cursor = this.#accounts.find(full ? {} : { createdAt: { $gte: since } }, {
            projection: { _id: 1, depositAddress: 1, openedAtBlock: 1 },
        });

        // Read in full before anything is added: a cursor failing halfway leaves the registry as it was,
        // and the next refresh finds the same accounts again, backfills included.
        const fresh = (await cursor.toArray()).filter((account) => !this.#byAddress.has(account.depositAddress));
        const backfills: Backfill[] = [];
        for (const account of fresh) {
            this.add(account);
            if (account.openedAtBlock <= scannedThrough) {
                backfills.push({ address: account.depositAddress as Address, fromBlock: account.openedAtBlock });
            }
        }
        this.#lastRefresh = now;
        if (full) this.#lastFullReload = now;
        return backfills;
    }
}
