import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { TimeoutError, TransactionReceiptNotFoundError, type Hash, type TransactionReceipt } from "viem";
import type { ArcClient } from "../chain/arc.ts";
import { transfersInReceipt } from "../chain/native-transfers.ts";
import type { AccountDoc, Collections } from "../db/mongo.ts";
import { formatUsdc } from "../db/money.ts";
import { AppError, newRef, shortOf } from "../errors.ts";
import type { DepositPage, DepositReceipt, Hex } from "../protocol.ts";
import type { Ledger } from "./ledger.ts";
import { accountView, depositView } from "./views.ts";

/** The receipt poll starts quick, for the usual case, and slows for a transaction that isn't landing. */
const RECEIPT_POLL_MS = 500;
const RECEIPT_POLL_MAX_MS = 2_000;
/** Each check polls the RPC until the transaction lands, so one account can't run many at once. */
const MAX_CHECKS_PER_ACCOUNT = 3;
export const MAX_PAGE = 100;

const seconds = (ms: number) => {
    const count = Math.max(1, Math.round(ms / 1000));
    return `${count} second${count === 1 ? "" : "s"}`;
};

type Deps = {
    client: ArcClient;
    collections: Collections;
    ledger: Ledger;
    confirmations: number;
    receiptTimeoutMs: number;
    logger: Logger;
};

/** Reads deposit history, and credits deposits the client reports. */
export class DepositService {
    readonly #deps: Deps;
    /** Reports of one transaction share a single check. */
    readonly #inFlight = new Map<string, Promise<DepositReceipt>>();
    readonly #checksPerAccount = new Map<string, number>();

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    /** Newest first; `before` is a deposit id from the previous page. */
    async list(account: AccountDoc, { before, limit = 50 }: { before?: string; limit?: number } = {}) {
        const size = Math.min(Math.max(limit, 1), MAX_PAGE);
        const filter = before
            ? { accountId: account._id, _id: { $lt: ObjectId.createFromHexString(before) } }
            : { accountId: account._id };
        const docs = await this.#deps.collections.deposits
            .find(filter)
            .sort({ _id: -1 })
            .limit(size + 1)
            .toArray();
        const items = docs.slice(0, size).map(depositView);
        const page: DepositPage = { items, next: docs.length > size ? (items.at(-1)?.id ?? null) : null };
        return page;
    }

    /**
     * Credits what a transaction sent to the account's deposit address, as
     * soon as it's on chain. The scan would credit it anyway; this is what
     * lets the client settle an optimistic deposit within a second or two.
     */
    report(account: AccountDoc, txHash: Hash): Promise<DepositReceipt> {
        const accountKey = account._id.toHexString();
        const key = `${accountKey}:${txHash.toLowerCase()}`;
        const running = this.#inFlight.get(key);
        if (running) return running;

        const checks = this.#checksPerAccount.get(accountKey) ?? 0;
        if (checks >= MAX_CHECKS_PER_ACCOUNT) {
            this.#deps.logger.warn(
                {
                    op: "deposit.report",
                    accountId: accountKey,
                    txHash,
                    outcome: "rate_limited",
                    checks,
                    limit: MAX_CHECKS_PER_ACCOUNT,
                },
                "Deposit report refused: too many checks already running",
            );
            return Promise.reject(
                new AppError("rate_limited", `${checks} deposits are already being checked. Try again in a moment.`, {
                    logged: true,
                }),
            );
        }
        this.#checksPerAccount.set(accountKey, checks + 1);
        const check = this.#check(account, txHash.toLowerCase() as Hash).finally(() => {
            this.#inFlight.delete(key);
            const left = (this.#checksPerAccount.get(accountKey) ?? 1) - 1;
            if (left > 0) this.#checksPerAccount.set(accountKey, left);
            else this.#checksPerAccount.delete(accountKey);
        });
        this.#inFlight.set(key, check);
        return check;
    }

    async #check(account: AccountDoc, txHash: Hash): Promise<DepositReceipt> {
        const { logger } = this.#deps;
        const accountId = account._id.toHexString();
        const receipt = await this.#settledReceipt(txHash, accountId);
        if (receipt.status !== "success") {
            logger.warn(
                {
                    op: "deposit.report",
                    accountId,
                    txHash,
                    outcome: "reverted",
                    blockNumber: Number(receipt.blockNumber),
                },
                "Deposit report refused: transaction reverted",
            );
            throw new AppError(
                "tx_reverted",
                `Transaction ${shortOf(txHash)} reverted on Arc (block ${receipt.blockNumber}), so nothing was deposited.`,
                { logged: true },
            );
        }

        const all = transfersInReceipt(receipt);
        const transfers = all.filter(
            (t) => t.to === account.depositAddress || account.formerDepositAddresses?.includes(t.to),
        );
        if (transfers.length === 0) {
            logger.warn(
                {
                    op: "deposit.report",
                    accountId,
                    txHash,
                    outcome: "no_transfer_to_address",
                    blockNumber: Number(receipt.blockNumber),
                    depositAddress: account.depositAddress,
                    transfers: all.map((t) => ({ to: t.to, value: formatUsdc(t.value) })),
                },
                "Deposit report refused: the transaction sent nothing to the deposit address",
            );
            const elsewhere = all[0];
            throw new AppError(
                "no_deposit",
                elsewhere
                    ? `That transaction sent ${formatUsdc(elsewhere.value)} USDC to ${shortOf(elsewhere.to)}, not to your deposit address ${shortOf(account.depositAddress)}.`
                    : "That transaction moved no USDC on Arc (it may be a token on another network).",
                { logged: true },
            );
        }

        const credits = [];
        for (const transfer of transfers) {
            const credit = await this.#deps.ledger.credit(transfer, account._id, "report");
            if (credit) credits.push(credit);
        }
        if (credits.length === 0) {
            // The ledger has already kept and logged each transfer it left uncredited
            const sent = transfers.reduce((sum, t) => sum + t.value, 0n);
            throw new AppError(
                "below_minimum",
                `${formatUsdc(sent)} USDC is under the ${formatUsdc(this.#deps.ledger.minDeposit)} USDC minimum, so it wasn't credited.`,
                { logged: true },
            );
        }
        const current = await this.#deps.collections.accounts.findOne({ _id: account._id });
        if (!current) {
            // Credited, but the account can't be read back: say so, so the person isn't told it failed with no way to match it
            const ref = newRef();
            logger.error(
                { op: "deposit.report", accountId, txHash, ref, outcome: "account_vanished", credited: credits.length },
                "A reported deposit was credited but its account can't be read",
            );
            throw new AppError(
                "internal",
                `Your deposit ${shortOf(txHash)} was credited, but your account couldn't be read back. Reload to see it, and quote ref ${ref} if it's missing.`,
                { logged: true },
            );
        }
        return {
            txHash: txHash as Hex,
            deposits: credits.map((credit) => depositView(credit.deposit)),
            account: accountView(current),
        };
    }

    /** Waits for the transaction to land, plus any confirmations, up to the timeout. */
    async #settledReceipt(txHash: Hash, accountId: string): Promise<TransactionReceipt> {
        const { client, confirmations, receiptTimeoutMs } = this.#deps;
        const deadline = Date.now() + receiptTimeoutMs;
        let receipt: TransactionReceipt | null = null;
        let pause = RECEIPT_POLL_MS;
        while (Date.now() < deadline) {
            try {
                receipt ??= await client.getTransactionReceipt({ hash: txHash }).catch((error: unknown) => {
                    if (error instanceof TransactionReceiptNotFoundError) return null;
                    throw error;
                });
                if (receipt) {
                    if (confirmations === 0) return receipt;
                    const head = await client.getBlockNumber({ cacheTime: 0 });
                    if (head - receipt.blockNumber >= BigInt(confirmations)) return receipt;
                }
            } catch (error) {
                this.#deps.logger.warn(
                    { op: "deposit.report.rpc", accountId, txHash, err: error },
                    "Couldn't read a reported deposit from Arc",
                );
                const timedOut =
                    error instanceof TimeoutError || (error instanceof Error && error.name === "TimeoutError");
                throw new AppError(
                    "unavailable",
                    timedOut
                        ? "Arc's network didn't answer in time. Try again shortly."
                        : "Couldn't reach Arc to check that transaction. Try again shortly.",
                    { cause: error, logged: true },
                );
            }
            await sleep(Math.min(pause, Math.max(deadline - Date.now(), 0)));
            pause = Math.min(pause * 1.5, RECEIPT_POLL_MAX_MS);
        }
        this.#deps.logger.warn(
            { op: "deposit.report", accountId, txHash, outcome: "not_found_within_ms", waitedMs: receiptTimeoutMs },
            "Deposit report refused: the transaction hasn't shown up on Arc",
        );
        throw new AppError(
            "tx_not_found",
            `Transaction ${shortOf(txHash)} hasn't shown up on Arc after ${seconds(receiptTimeoutMs)}. If it lands later, it's credited automatically.`,
            { logged: true },
        );
    }
}
