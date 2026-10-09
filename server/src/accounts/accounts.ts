import { ObjectId } from "mongodb";
import type { Address } from "viem";
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

/** One account per connected wallet, each with its own deposit address on Arc. */
export class AccountService {
    readonly #deps: Deps;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    find(wallet: string) {
        return this.#deps.collections.accounts.findOne({ wallet: wallet.toLowerCase() });
    }

    findById(id: ObjectId) {
        return this.#deps.collections.accounts.findOne({ _id: id });
    }

    /**
     * The wallet's account, opened on first use. Callers must have checked
     * that `privyUserId` controls the wallet.
     */
    async open(wallet: Address, privyUserId: string): Promise<AccountDoc> {
        const { accounts } = this.#deps.collections;
        const key = wallet.toLowerCase();

        const existing = await accounts.findOne({ wallet: key });
        if (existing) return this.#claim(existing, privyUserId);

        const depositIndex = await this.#nextIndex();
        const now = new Date();
        const account: AccountDoc = {
            _id: new ObjectId(),
            wallet: key,
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
            const winner = await accounts.findOne({ wallet: key });
            if (!winner) throw error;
            this.#deps.registry.add(winner);
            return this.#claim(winner, privyUserId);
        }
    }

    /** A wallet moves with whichever Privy user it's verified for now. */
    async #claim(account: AccountDoc, privyUserId: string): Promise<AccountDoc> {
        if (account.privyUserId === privyUserId) return account;
        const updated = await this.#deps.collections.accounts.findOneAndUpdate(
            { _id: account._id },
            { $set: { privyUserId, updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        return updated ?? account;
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
