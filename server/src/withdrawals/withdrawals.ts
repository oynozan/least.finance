import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { parseUnits, type Address } from "viem";
import type { ArcClient } from "../chain/arc.ts";
import { NATIVE_DECIMALS } from "../chain/arc.ts";
import type { AccountDoc, Collections, WithdrawalDoc } from "../db/mongo.ts";
import { e6ToWei, formatUsdc, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Config } from "../config.ts";
import { solanaOpen } from "../crosschain/solana-switch.ts";
import type { SolanaRpc } from "../crosschain/solana.ts";
import { IrisError, type Iris } from "../crosschain/iris.ts";
import { AppError } from "../errors.ts";
import { upstreamLine } from "../trading/send-errors.ts";
import type { Bus } from "../events.ts";
import { checkRecipient } from "./solana-recipient.ts";

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
    /** What withdrawals to Solana need; without it they are refused as not open. */
    solana?: {
        rpc: SolanaRpc;
        iris: Iris;
        switches: Pick<Config, "SOLANA_DEPOSITS" | "SOLANA_WITHDRAWALS">;
        /** Wei. */
        min: bigint;
        /** Wei: how far the fee may rise past the reviewed one. */
        tolerance: bigint;
    };
};

type CreateInput = { requestId: string; amount: string; to: string; network?: "arc" | "solana"; reviewedFee?: string };

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
        const free = await this.treasuryFree();
        return { max: balance < free ? balance : free, min: this.#deps.minWithdraw };
    }

    /** What a withdrawal of `amount` to the Solana wallet `to` would cost; nothing is taken. */
    async quoteSolana(
        _account: AccountDoc,
        input: { amount: string; to: string },
    ): Promise<{ fee: bigint; receive: bigint; setup: boolean; setupFee: bigint | null }> {
        const priced = await this.#priceSolana(input);
        // The part of the fee that creates the recipient's USDC account.
        const plain = priced.setup
            ? await this.#deps.solana!.iris.forwardFee({ from: 26, to: 5, setup: false }).catch((error: unknown) => {
                  this.#deps.logger.warn(
                      { event: "withdraw.setup_fee_failed", to: input.to, err: error },
                      "Couldn't split the account setup fee out of a withdrawal quote",
                  );
                  return null;
              })
            : null;
        const setupFee = plain ? (priced.fee > plain.med ? priced.fee - plain.med : 0n) : null;
        return { fee: priced.fee, receive: priced.wei - priced.fee, setup: priced.setup, setupFee };
    }

    create(account: AccountDoc, input: CreateInput): Promise<WithdrawalDoc> {
        return this.withTreasuryLock(() =>
            this.#create(account, input).catch((error: unknown) => {
                if (!(error instanceof AppError) || error.logged) throw error;
                // Refusals are the person's to fix, but "my withdrawal was refused" needs a trace to find
                this.#deps.logger.warn(
                    {
                        event: "withdraw.refused",
                        accountId: account._id.toHexString(),
                        requestId: input.requestId,
                        code: error.code,
                        amount: input.amount,
                        to: input.to,
                        network: input.network ?? "arc",
                        reviewedFee: input.reviewedFee,
                    },
                    `A withdrawal was refused: ${error.message}`,
                );
                throw new AppError(error.code, error.message, { cause: error.cause, logged: true });
            }),
        );
    }

    /** Runs `fn` alone among creates and other lock holders, in the order they asked. */
    withTreasuryLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.#lock.catch(() => undefined).then(fn);
        this.#lock = run;
        return run;
    }

    recent(accountId: ObjectId, limit = 50): Promise<WithdrawalDoc[]> {
        return this.#deps.collections.withdrawals.find({ accountId }).sort({ _id: -1 }).limit(limit).toArray();
    }

    /** The recipient, the fee and the amount checked as a Solana withdrawal needs, before anything is taken. */
    async #priceSolana(input: { amount: string; to: string }) {
        const { solana } = this.#deps;
        if (!solana) {
            this.#deps.logger.warn(
                { event: "withdraw.solana_unconfigured" },
                "Withdrawals to Solana were asked for but the Solana client isn't configured",
            );
            throw new AppError("unavailable", "Withdrawals to Solana aren't open yet.");
        }
        solanaOpen(solana.switches, "withdrawals");
        if (!/^\d+(\.\d{1,6})?$/.test(input.amount)) {
            throw new AppError("bad_request", "Enter an amount with at most 6 decimals.");
        }
        const wei = parseUnits(input.amount, NATIVE_DECIMALS);
        if (wei < solana.min) {
            throw new AppError("bad_request", `The smallest withdrawal to Solana is ${dollars(solana.min)}.`);
        }
        const { usdcAccount, setup } = await checkRecipient(solana.rpc, input.to, this.#deps.logger);
        const { med, high } = await solana.iris.forwardFee({ from: 26, to: 5, setup }).catch((error: unknown) => {
            if (error instanceof IrisError) {
                this.#deps.logger.warn(
                    {
                        event: "withdraw.quote_failed",
                        kind: error.kind,
                        status: error.status,
                        to: input.to,
                        amount: input.amount,
                        err: error,
                    },
                    "Circle's fee service couldn't price a Solana withdrawal",
                );
                const said =
                    error.kind === "rate_limited"
                        ? "Circle's fee service is busy right now. Try again in a minute."
                        : error.kind === "timeout"
                          ? "Circle's fee service didn't answer in 10 seconds."
                          : `Circle's fee service gave an error (${error.status ?? upstreamLine(error, 80)}).`;
                throw new AppError("unavailable", `${said} Nothing was taken.`, { cause: error, logged: true });
            }
            throw error;
        });
        if (wei <= high) {
            throw new AppError(
                "bad_request",
                `The Solana fee is up to ${formatUsdc(high)} USDC, so withdraw more than that. Nothing was taken.`,
            );
        }
        return { wei, usdcAccount, setup, fee: med, maxFee: high };
    }

    async #create(account: AccountDoc, input: CreateInput) {
        const { collections, ledger, bus, logger, minWithdraw } = this.#deps;
        const known = await collections.withdrawals.findOne({ accountId: account._id, requestId: input.requestId });
        if (known) return known;
        if (input.network === "solana") return this.#createSolana(account, input);

        if (!/^\d+(\.\d{1,6})?$/.test(input.amount)) {
            throw new AppError("bad_request", "Enter an amount with at most 6 decimals.");
        }
        const wei = parseUnits(input.amount, NATIVE_DECIMALS);
        if (wei <= 0n) throw new AppError("bad_request", "Enter an amount above zero.");
        if (wei < minWithdraw) {
            throw new AppError("bad_request", `The smallest withdrawal is ${dollars(minWithdraw)}.`);
        }

        const treasury = await this.#treasury();
        if (wei > treasury.free) throw this.#tooMuchForTreasury(account, input, wei, treasury);

        const now = new Date();
        const withdrawal: WithdrawalDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: input.requestId,
            amount: toDecimal(wei),
            to: input.to.toLowerCase(),
            network: "arc",
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
                requestId: input.requestId,
                network: "arc",
                to: withdrawal.to,
                amount: formatUsdc(wei),
            },
            "Withdrawal created",
        );
        bus.emit("withdrawal:updated", { withdrawal, account: updated });
        return withdrawal;
    }

    async #createSolana(account: AccountDoc, input: CreateInput) {
        const { collections, ledger, bus, logger, solana } = this.#deps;
        const priced = await this.#priceSolana(input);
        if (input.reviewedFee !== undefined) {
            const reviewed = parseUnits(input.reviewedFee, NATIVE_DECIMALS);
            if (priced.fee > reviewed + solana!.tolerance) {
                throw new AppError(
                    "quote_changed",
                    `The fee is now ${formatUsdc(priced.fee)} USDC and you'd receive ${formatUsdc(priced.wei - priced.fee)} USDC. Nothing was taken.`,
                );
            }
        }
        const treasury = await this.#treasury();
        if (priced.wei > treasury.free) throw this.#tooMuchForTreasury(account, input, priced.wei, treasury);

        const now = new Date();
        const withdrawal: WithdrawalDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: input.requestId,
            amount: toDecimal(priced.wei),
            to: input.to,
            network: "solana",
            state: "sending",
            nonce: null,
            rawTx: null,
            txHash: null,
            failure: null,
            solana: {
                wallet: input.to,
                usdcAccount: priced.usdcAccount,
                setup: priced.setup,
                fee: toDecimal(priced.fee),
                maxFee: toDecimal(priced.maxFee),
                approveNonce: null,
                approveRawTx: null,
                approveTxHash: null,
                burnNonce: null,
                burnRawTx: null,
                burnTxHash: null,
                forwardTxHash: null,
                irisCheckedAt: null,
            },
            createdAt: now,
            updatedAt: now,
        };
        const updated = await ledger.runInTransaction(async (session) => {
            const debited = await ledger.debitInSession(session, account._id, priced.wei, "withdrawal", withdrawal._id);
            await collections.withdrawals.insertOne(withdrawal, { session });
            return debited;
        });
        logger.info(
            {
                accountId: account._id.toHexString(),
                withdrawalId: withdrawal._id.toHexString(),
                requestId: input.requestId,
                amount: formatUsdc(priced.wei),
                network: "solana",
                to: input.to,
                fee: formatUsdc(priced.fee),
                receive: formatUsdc(priced.wei - priced.fee),
            },
            "Withdrawal created",
        );
        bus.emit("withdrawal:updated", { withdrawal, account: updated });
        return withdrawal;
    }

    /** The refusal when the treasury can't pay: it says so, since the person's own limit isn't what stopped them, and the log shows how short the treasury is. */
    #tooMuchForTreasury(
        account: AccountDoc,
        input: CreateInput,
        wei: bigint,
        treasury: { balance: bigint; owed: bigint; leaving: bigint; free: bigint },
    ) {
        this.#deps.logger.warn(
            {
                event: "withdraw.treasury_short",
                accountId: account._id.toHexString(),
                requestId: input.requestId,
                wanted: formatUsdc(wei),
                free: formatUsdc(treasury.free),
                balance: formatUsdc(treasury.balance),
                owedToPending: formatUsdc(treasury.owed),
                leavingToPool: formatUsdc(treasury.leaving),
                reserve: formatUsdc(TREASURY_GAS_RESERVE),
            },
            "The treasury can't pay a withdrawal right now",
        );
        const available = treasury.free < CENT ? "less than $0.01" : dollars(treasury.free);
        return new AppError(
            "insufficient_funds",
            `We can't pay out $${input.amount} right now: only ${available} is available for withdrawals at the moment. Try a smaller amount or try again in a few minutes. Nothing was taken.`,
            { logged: true },
        );
    }

    /** The treasury's balance less what pending payouts and a pool top-up still to be burned will take, and the gas reserve. */
    async treasuryFree(): Promise<bigint> {
        return (await this.#treasury()).free;
    }

    async #treasury() {
        const { collections, client, treasury } = this.#deps;
        const [balance, sending, toPool] = await Promise.all([
            client.getBalance({ address: treasury }),
            collections.withdrawals.find({ state: "sending" }).toArray(),
            collections.poolRebalances.find({ direction: "arc_to_polygon", state: "sending" }).toArray(),
        ]);
        const owed = sending.reduce((sum, doc) => sum + fromDecimal(doc.amount), 0n);
        const leaving = toPool.reduce((sum, doc) => sum + e6ToWei(fromDecimal(doc.amountE6)), 0n);
        const free = balance - owed - leaving - TREASURY_GAS_RESERVE;
        return { balance, owed, leaving, free: free > 0n ? free : 0n };
    }
}
