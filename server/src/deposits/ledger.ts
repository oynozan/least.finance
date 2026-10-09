import { ObjectId, type MongoClient } from "mongodb";
import type { Logger } from "pino";
import { ARC_CHAIN_ID } from "../chain/arc.ts";
import type { NativeTransfer } from "../chain/native-transfers.ts";
import { isDuplicateKey, type AccountDoc, type Collections, type DepositDoc } from "../db/mongo.ts";
import { formatUsdc, toDecimal } from "../db/money.ts";
import type { Bus } from "../events.ts";

export type Credit = {
    deposit: DepositDoc;
    /** The account once this deposit is in. */
    account: AccountDoc;
    /** False when an earlier pass had already credited this log. */
    fresh: boolean;
};

type Deps = {
    client: MongoClient;
    collections: Collections;
    bus: Bus;
    logger: Logger;
    /** Wei. */
    minDeposit: bigint;
};

/**
 * Credits deposits to account balances. Each Arc log is credited at most
 * once: the deposit, the balance and the ledger entry commit together, and a
 * unique index on (chain, tx, log) turns any repeat into a no-op.
 */
export class Ledger {
    readonly #deps: Deps;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    get minDeposit() {
        return this.#deps.minDeposit;
    }

    /** Null when the transfer is below the minimum, which isn't credited. */
    async credit(transfer: NativeTransfer, accountId: ObjectId, source: DepositDoc["source"]): Promise<Credit | null> {
        if (transfer.value < this.#deps.minDeposit) {
            this.#deps.logger.info(
                { txHash: transfer.txHash, logIndex: transfer.logIndex, amount: formatUsdc(transfer.value) },
                "Deposit below the minimum, not credited",
            );
            return null;
        }

        try {
            const credit = await this.#creditOnce(transfer, accountId, source);
            if (credit.fresh) {
                this.#deps.logger.info(
                    {
                        accountId: accountId.toHexString(),
                        txHash: transfer.txHash,
                        logIndex: transfer.logIndex,
                        amount: formatUsdc(transfer.value),
                        source,
                    },
                    "Deposit credited",
                );
                this.#deps.bus.emit("deposit:credited", { deposit: credit.deposit, account: credit.account });
            }
            return credit;
        } catch (error) {
            // Another pass committed the same log between our read and our write.
            if (isDuplicateKey(error)) return this.#existing(transfer);
            throw error;
        }
    }

    async #creditOnce(transfer: NativeTransfer, accountId: ObjectId, source: DepositDoc["source"]): Promise<Credit> {
        const { client, collections } = this.#deps;
        const key = { chainId: ARC_CHAIN_ID, txHash: transfer.txHash, logIndex: transfer.logIndex };

        return client.withSession((session) =>
            session.withTransaction(async () => {
                const known = await collections.deposits.findOne(key, { session });
                if (known) {
                    const account = await collections.accounts.findOne({ _id: known.accountId }, { session });
                    if (!account) throw new Error(`Deposit ${known._id.toHexString()} has no account`);
                    return { deposit: known, account, fresh: false };
                }

                const now = new Date();
                const amount = toDecimal(transfer.value);
                const deposit: DepositDoc = {
                    _id: new ObjectId(),
                    accountId,
                    ...key,
                    blockNumber: transfer.blockNumber,
                    blockHash: transfer.blockHash,
                    from: transfer.from,
                    to: transfer.to,
                    amount,
                    source,
                    creditedAt: now,
                };
                await collections.deposits.insertOne(deposit, { session });

                const account = await collections.accounts.findOneAndUpdate(
                    { _id: accountId, $or: [{ depositAddress: transfer.to }, { formerDepositAddresses: transfer.to }] },
                    { $inc: { balance: amount, version: 1 }, $set: { updatedAt: now } },
                    { session, returnDocument: "after" },
                );
                if (!account) {
                    throw new Error(`No account ${accountId.toHexString()} with deposit address ${transfer.to}`);
                }

                await collections.ledger.insertOne(
                    {
                        _id: new ObjectId(),
                        accountId,
                        kind: "deposit",
                        amount,
                        balanceAfter: account.balance,
                        refId: deposit._id,
                        createdAt: now,
                    },
                    { session },
                );
                return { deposit, account, fresh: true };
            }),
        );
    }

    async #existing(transfer: NativeTransfer): Promise<Credit> {
        const { collections } = this.#deps;
        const deposit = await collections.deposits.findOne({
            chainId: ARC_CHAIN_ID,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
        });
        if (!deposit) throw new Error(`Deposit ${transfer.txHash}:${transfer.logIndex} vanished`);
        const account = await collections.accounts.findOne({ _id: deposit.accountId });
        if (!account) throw new Error(`Deposit ${deposit._id.toHexString()} has no account`);
        return { deposit, account, fresh: false };
    }
}
