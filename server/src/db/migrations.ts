import { MongoServerError, ObjectId, type MongoClient } from "mongodb";
import type { AccountDoc, Collections, LedgerEntryDoc } from "./mongo.ts";
import { fromDecimal, toDecimal } from "./money.ts";

export type MigrationReport = { rekeyed: number; merged: number };

const NAMESPACE_NOT_FOUND = 26;
const INDEX_NOT_FOUND = 27;

/**
 * Accounts used to be keyed by wallet, and a person with several wallets had several. This
 * folds each person's accounts into the oldest and drops the wallet key. Run it with no
 * other instance on the old code, and again any time: a finished migration changes nothing.
 */
export async function mergeAccountsByPerson(client: MongoClient, collections: Collections): Promise<MigrationReport> {
    const { accounts } = collections;
    // The old wallet index treats a missing wallet as null, so it has to go before the field does.
    await dropIndex(accounts, "wallet_unique");
    await dropIndex(accounts, "privy_user");

    let merged = 0;
    const groups = await accounts
        .aggregate<{ _id: string }>([
            { $group: { _id: "$privyUserId", count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
        ])
        .toArray();
    for (const { _id: privyUserId } of groups) {
        const [survivor, ...rest] = await accounts
            .find({ privyUserId }, { projection: { _id: 1 } })
            .sort({ createdAt: 1, depositIndex: 1 })
            .toArray();
        for (const other of rest) {
            if (await mergeInto(client, collections, survivor!._id, other._id)) merged++;
        }
    }

    const { modifiedCount } = await accounts.updateMany({ wallet: { $exists: true } }, { $unset: { wallet: "" } });
    return { rekeyed: modifiedCount, merged };
}

/** Moves one account into another in a single transaction, so the ledger stays double-entry. */
async function mergeInto(
    client: MongoClient,
    { accounts, deposits, ledger }: Collections,
    into: AccountDoc["_id"],
    from: AccountDoc["_id"],
) {
    const session = client.startSession();
    try {
        return await session.withTransaction(async () => {
            // Read inside the transaction, so a credit that landed first isn't lost.
            const gone = await accounts.findOneAndDelete({ _id: from }, { session });
            if (!gone) return false;

            const now = new Date();
            const survivor = await accounts.findOneAndUpdate(
                { _id: into },
                {
                    $inc: { balance: gone.balance, version: 1 },
                    $addToSet: {
                        formerDepositAddresses: {
                            $each: [gone.depositAddress, ...(gone.formerDepositAddresses ?? [])],
                        },
                    },
                    $set: { updatedAt: now },
                },
                { session, returnDocument: "after" },
            );
            if (!survivor) throw new Error(`Account ${into.toHexString()} vanished during a merge`);

            const balance = fromDecimal(gone.balance);
            const entries: Omit<LedgerEntryDoc, "_id" | "createdAt">[] = [
                {
                    accountId: from,
                    kind: "merge_out",
                    amount: toDecimal(-balance),
                    balanceAfter: toDecimal(0n),
                    refId: from,
                },
                {
                    accountId: into,
                    kind: "merge_in",
                    amount: gone.balance,
                    balanceAfter: survivor.balance,
                    refId: from,
                },
            ];
            await ledger.insertMany(
                entries.map((entry) => ({ _id: new ObjectId(), createdAt: now, ...entry })),
                { session },
            );
            // Only deposits move: the known-deposit path reads their account, and the ledger rows stay with the account they sum for.
            await deposits.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            return true;
        });
    } finally {
        await session.endSession();
    }
}

async function dropIndex(accounts: Collections["accounts"], name: string) {
    await accounts.dropIndex(name).catch((error: unknown) => {
        const code = error instanceof MongoServerError ? error.code : undefined;
        if (code !== NAMESPACE_NOT_FOUND && code !== INDEX_NOT_FOUND) throw error;
    });
}
