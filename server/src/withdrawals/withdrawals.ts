import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { parseUnits, type Address } from "viem";
import type { ArcClient } from "../chain/arc.ts";
import { NATIVE_DECIMALS } from "../chain/arc.ts";
import type { AccountDoc, Collections, WithdrawalDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";

/** What the treasury keeps back for gas: 0.01 USDC in wei. */
export const TREASURY_GAS_RESERVE = 10n ** 16n;

const CENT = 10n ** 16n;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    client: ArcClient;
    treasury: Address;
    bus: Bus;
    logger: Logger;
    /** Wei. */
    minWithdraw: bigint;
};

/** "$12.50", floored to the cent so the figure is never more than can be paid. */
const dollars = (wei: bigint) => {
    const cents = wei / CENT;
    return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

/** Takes withdrawals off balances, but only when the treasury can pay them. */
export class Withdrawals {
    readonly #deps: Deps;
    #lock: Promise<unknown> = Promise.resolve();

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    async limits(account: AccountDoc): Promise<{ max: bigint; min: bigint }> {
        const balance = fromDecimal(account.balance);
        const free = await this.#treasuryFree();
        return { max: balance < free ? balance : free, min: this.#deps.minWithdraw };
    }

    create(account: AccountDoc, input: { requestId: string; amount: string; to: Address }): Promise<WithdrawalDoc> {
        const run = this.#lock.catch(() => undefined).then(() => this.#create(account, input));
        this.#lock = run;
        return run;
    }

    recent(accountId: ObjectId, limit = 50): Promise<WithdrawalDoc[]> {
        return this.#deps.collections.withdrawals.find({ accountId }).sort({ _id: -1 }).limit(limit).toArray();
    }

    async #create(account: AccountDoc, input: { requestId: string; amount: string; to: Address }) {
        const { collections, ledger, bus, logger, minWithdraw } = this.#deps;
        const known = await collections.withdrawals.findOne({ accountId: account._id, requestId: input.requestId });
        if (known) return known;

        if (!/^\d+(\.\d{1,6})?$/.test(input.amount)) {
            throw new AppError("bad_request", "Enter an amount with at most 6 decimals.");
        }
        const wei = parseUnits(input.amount, NATIVE_DECIMALS);
        if (wei <= 0n) throw new AppError("bad_request", "Enter an amount above zero.");
        if (wei < minWithdraw) {
            throw new AppError("bad_request", `The smallest withdrawal is ${dollars(minWithdraw)}.`);
        }

        const free = await this.#treasuryFree();
        if (wei > free) {
            throw new AppError(
                "insufficient_funds",
                `Withdrawals can pay at most ${dollars(free)} right now. Nothing was taken.`,
            );
        }

        const now = new Date();
        const withdrawal: WithdrawalDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: input.requestId,
            amount: toDecimal(wei),
            to: input.to.toLowerCase(),
            state: "sending",
            nonce: null,
            rawTx: null,
            txHash: null,
            failure: null,
            createdAt: now,
            updatedAt: now,
        };
        const updated = await ledger.runInTransaction(async (session) => {
            const debited = await ledger.debitInSession(session, account._id, wei, "withdrawal", withdrawal._id);
            await collections.withdrawals.insertOne(withdrawal, { session });
            return debited;
        });
        logger.info(
            {
                accountId: account._id.toHexString(),
                withdrawalId: withdrawal._id.toHexString(),
                amount: formatUsdc(wei),
            },
            "Withdrawal created",
        );
        bus.emit("withdrawal:updated", { withdrawal, account: updated });
        return withdrawal;
    }

    /** The treasury's balance less what pending payouts will take and the gas reserve. */
    async #treasuryFree(): Promise<bigint> {
        const { collections, client, treasury } = this.#deps;
        const [balance, sending] = await Promise.all([
            client.getBalance({ address: treasury }),
            collections.withdrawals.find({ state: "sending" }).toArray(),
        ]);
        const owed = sending.reduce((sum, doc) => sum + fromDecimal(doc.amount), 0n);
        const free = balance - owed - TREASURY_GAS_RESERVE;
        return free > 0n ? free : 0n;
    }
}
