import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import type { Logger } from "pino";
import { ARC_CHAIN_ID } from "../chain/arc.ts";
import { AppError } from "../errors.ts";
import type { NativeTransfer } from "../chain/native-transfers.ts";
import {
    isDuplicateKey,
    type AccountDoc,
    type Collections,
    type DepositDoc,
    type LedgerEntryDoc,
} from "../db/mongo.ts";
import { E6_TO_WEI, formatE6, formatUsdc, toDecimal, fromDecimal } from "../db/money.ts";
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
            await this.#skip(transfer, accountId, source);
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

    /** Keeps a transfer under the minimum, with why, and says so once: it sits at the person's address and nothing else would tell anyone. */
    async #skip(transfer: NativeTransfer, accountId: ObjectId, source: DepositDoc["source"]) {
        const { collections, logger, minDeposit } = this.#deps;
        const amount = formatUsdc(transfer.value);
        const message = `Not credited: ${amount} USDC is under the ${formatUsdc(minDeposit)} USDC minimum (sent to your address in block ${transfer.blockNumber}; contact support to recover it).`;
        const key = { chainId: ARC_CHAIN_ID, txHash: transfer.txHash, logIndex: transfer.logIndex };
        try {
            const kept = await collections.skippedDeposits.updateOne(
                key,
                {
                    $setOnInsert: {
                        _id: new ObjectId(),
                        accountId,
                        blockNumber: transfer.blockNumber,
                        from: transfer.from,
                        to: transfer.to,
                        amount: toDecimal(transfer.value),
                        minimum: toDecimal(minDeposit),
                        reason: "below_minimum" as const,
                        message,
                        source,
                        seenAt: new Date(),
                    },
                },
                { upsert: true },
            );
            if (kept.upsertedCount === 0) return;
        } catch (error) {
            logger.error({ err: error, ...key }, "Couldn't keep a deposit that was left uncredited");
        }
        logger.warn(
            {
                op: "deposit.below_minimum",
                accountId: accountId.toHexString(),
                ...key,
                blockNumber: transfer.blockNumber,
                from: transfer.from,
                to: transfer.to,
                amount,
                minimum: formatUsdc(minDeposit),
                source,
            },
            "Deposit below the minimum, not credited",
        );
    }

    /** Takes wei off the balance inside the caller's transaction, which owns the order's state move and the bus event. */
    async debitInSession(
        session: ClientSession,
        accountId: ObjectId,
        wei: bigint,
        kind: "prediction_buy" | "withdrawal" | "perp_open" | "trade_buy",
        refId: ObjectId,
    ): Promise<AccountDoc> {
        if (wei <= 0n) throw new Error(`A debit must be over zero, not ${wei}`);
        const now = new Date();
        const account = await this.#deps.collections.accounts.findOneAndUpdate(
            { _id: accountId, balance: { $gte: toDecimal(wei) } },
            { $inc: { balance: toDecimal(-wei), version: 1 }, $set: { updatedAt: now } },
            { session, returnDocument: "after" },
        );
        if (!account) {
            const held = await this.#deps.collections.accounts.findOne({ _id: accountId }, { session });
            const balance = held ? fromDecimal(held.balance) : 0n;
            this.#deps.logger.warn(
                {
                    op: "ledger.debit.refused",
                    accountId: accountId.toHexString(),
                    kind,
                    refId: refId.toHexString(),
                    amount: formatUsdc(wei),
                    balance: formatUsdc(balance),
                },
                "Refused a debit: the balance is short",
            );
            // The balance is floored and the need rounded up, so the sentence never understates the gap
            const need = formatE6((wei + E6_TO_WEI - 1n) / E6_TO_WEI);
            throw new AppError(
                "insufficient_funds",
                `You have $${formatE6(balance / E6_TO_WEI)} but this needs $${need}. Nothing was spent.`,
                { logged: true },
            );
        }
        await this.#entry(session, account, -wei, kind, refId, now);
        return account;
    }

    /** Puts wei back on the balance inside the caller's transaction; a repeat of (kind, refId) hits ref_unique. */
    async creditInSession(
        session: ClientSession,
        accountId: ObjectId,
        wei: bigint,
        kind:
            | "prediction_refund"
            | "prediction_sell"
            | "prediction_payout"
            | "withdrawal_refund"
            | "perp_refund"
            | "perp_close"
            | "trade_sell",
        refId: ObjectId,
    ): Promise<AccountDoc> {
        if (wei <= 0n) throw new Error(`A credit must be over zero, not ${wei}`);
        const now = new Date();
        const account = await this.#deps.collections.accounts.findOneAndUpdate(
            { _id: accountId },
            { $inc: { balance: toDecimal(wei), version: 1 }, $set: { updatedAt: now } },
            { session, returnDocument: "after" },
        );
        if (!account) throw new Error(`No account ${accountId.toHexString()} to credit`);
        await this.#entry(session, account, wei, kind, refId, now);
        return account;
    }

    runInTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
        return this.#deps.client.withSession((session) => session.withTransaction(() => work(session)));
    }

    async #entry(
        session: ClientSession,
        account: AccountDoc,
        signed: bigint,
        kind: LedgerEntryDoc["kind"],
        refId: ObjectId,
        createdAt: Date,
    ) {
        await this.#deps.collections.ledger.insertOne(
            {
                _id: new ObjectId(),
                accountId: account._id,
                kind,
                amount: toDecimal(signed),
                balanceAfter: account.balance,
                refId,
                createdAt,
            },
            { session },
        );
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
