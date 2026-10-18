import { MongoServerError, ObjectId, type ClientSession, type MongoClient } from "mongodb";
import type { AccountDoc, Collections, LedgerEntryDoc, PositionDoc, SwapOrderDoc } from "./mongo.ts";
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
    await dropStalePersonIndex(accounts);

    let merged = 0;
    const groups = await accounts
        .aggregate<{ _id: string }>([
            { $match: { privyUserId: { $type: "string", $ne: "" } } },
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

/**
 * Wallet swaps are no longer placed or followed, so an order still open (waiting for the wallet or
 * sent and unsettled) would show as on its way forever. This marks each one expired, which is what
 * the old tracker did once it gave up, and returns how many it changed. Run it any time: a second
 * run finds none.
 */
export async function expireOpenSwapOrders({ swapOrders }: Collections): Promise<number> {
    const { modifiedCount } = await swapOrders.updateMany(
        { state: { $in: ["created", "sent"] satisfies SwapOrderDoc["state"][] } },
        { $set: { state: "expired", updatedAt: new Date() } },
    );
    return modifiedCount;
}

/** Moves one account into another in a single transaction, so the ledger stays double-entry. */
async function mergeInto(
    client: MongoClient,
    {
        accounts,
        deposits,
        ledger,
        depositOrders,
        predictionOrders,
        positions,
        swapOrders,
        withdrawals,
        perpAccounts,
        perpOrders,
        perpPositions,
    }: Collections,
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
            if (!survivor) {
                throw new Error(
                    `Account ${into.toHexString()} vanished while merging ${from.toHexString()} into it (person ${gone.privyUserId.slice(0, 18)}…, step: adding the balance)`,
                );
            }

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
            // Deposits and their orders move: the known-deposit path and the order tracker read their account, and the ledger rows stay with the account they sum for.
            await deposits.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await depositOrders.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await predictionOrders.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await swapOrders.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await withdrawals.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            // Perp positions key on their own address index, so they never collide and each stays closable from its address.
            await perpAccounts.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await perpOrders.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await perpPositions.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
            await movePositions(positions, into, from, now, session);
            return true;
        });
    } finally {
        await session.endSession();
    }
}

/** Both accounts can hold the same token, and only one open position per token may exist, so the survivor absorbs the other's. */
async function movePositions(
    positions: Collections["positions"],
    into: AccountDoc["_id"],
    from: AccountDoc["_id"],
    now: Date,
    session: ClientSession,
) {
    const live = { $in: ["open", "closing"] satisfies PositionDoc["state"][] };
    for (const position of await positions.find({ accountId: from, state: live }, { session }).toArray()) {
        const twin = await positions.findOne({ accountId: into, tokenId: position.tokenId, state: live }, { session });
        if (!twin) continue;
        await positions.updateOne(
            { _id: twin._id },
            {
                $set: {
                    shares: toDecimal(fromDecimal(twin.shares) + fromDecimal(position.shares)),
                    cost: toDecimal(fromDecimal(twin.cost) + fromDecimal(position.cost)),
                    updatedAt: now,
                },
            },
            { session },
        );
        await positions.updateOne(
            { _id: position._id },
            { $set: { state: "closed", proceeds: toDecimal(0n), settledAt: now, updatedAt: now } },
            { session },
        );
    }
    await positions.updateMany({ accountId: from }, { $set: { accountId: into } }, { session });
}

/** The planner skips a `$type` partial index for an equality lookup, so an index built that way is rebuilt with `$gt`. */
async function dropStalePersonIndex(accounts: Collections["accounts"]) {
    const indexes = await accounts.indexes().catch((error: unknown) => {
        if (error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND) return [];
        throw error;
    });
    const current = indexes.find((index) => index.name === "privy_user_unique");
    if (current && JSON.stringify(current.partialFilterExpression) !== JSON.stringify({ privyUserId: { $gt: "" } })) {
        await dropIndex(accounts, "privy_user_unique");
    }
}

async function dropIndex(accounts: Collections["accounts"], name: string) {
    await accounts.dropIndex(name).catch((error: unknown) => {
        const code = error instanceof MongoServerError ? error.code : undefined;
        if (code !== NAMESPACE_NOT_FOUND && code !== INDEX_NOT_FOUND) throw error;
    });
}
