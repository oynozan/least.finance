import { ObjectId } from "mongodb";
import { isDuplicateKey, type AccountDoc, type Collections } from "../db/mongo.ts";
import { toDecimal } from "../db/money.ts";
import type { DepositRegistry } from "../deposits/registry.ts";
import type { Keyring } from "./keyring.ts";

const DEPOSIT_INDEX = "depositIndex";

type Deps = {
    collections: Collections;
    keyring: Keyring;
    registry: DepositRegistry;
    /** The chain head, recorded as the block an account opened at. */
    headBlock: () => Promise<number>;
};

/** One account per person, each with its own deposit address on Arc. */
export class AccountService {
    readonly #deps: Deps;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    /** The oldest account when a person has several, the one a merge keeps. */
    find(privyUserId: string) {
        return this.#deps.collections.accounts.findOne({ privyUserId }, { sort: { createdAt: 1, depositIndex: 1 } });
    }

    findById(id: ObjectId) {
        return this.#deps.collections.accounts.findOne({ _id: id });
    }

    /** The person's account, opened on first use. */
    async open(privyUserId: string): Promise<AccountDoc> {
        const { accounts } = this.#deps.collections;

        const existing = await this.find(privyUserId);
        if (existing) return existing;

        const depositIndex = await this.#nextIndex();
        const now = new Date();
        const account: AccountDoc = {
            _id: new ObjectId(),
            privyUserId,
            depositIndex,
            depositAddress: this.#deps.keyring.addressAt(depositIndex),
            balance: toDecimal(0n),
            version: 0,
            openedAtBlock: await this.#deps.headBlock(),
            createdAt: now,
            updatedAt: now,
        };
        // Watched before anyone can learn the address, so no deposit to it slips past the scan.
        this.#deps.registry.add(account);
        try {
            await accounts.insertOne(account);
            return account;
        } catch (error) {
            this.#deps.registry.remove(account.depositAddress);
            // Another request opened it first; its index is simply skipped.
            if (!isDuplicateKey(error)) throw error;
            const winner = await this.find(privyUserId);
            if (!winner) throw error;
            this.#deps.registry.add(winner);
            return winner;
        }
    }

    async #nextIndex(): Promise<number> {
        const counter = await this.#deps.collections.counters.findOneAndUpdate(
            { _id: DEPOSIT_INDEX },
            { $inc: { seq: 1 } },
            { upsert: true, returnDocument: "after" },
        );
        if (!counter) throw new Error("Couldn't allocate a deposit index");
        return counter.seq;
    }
}
