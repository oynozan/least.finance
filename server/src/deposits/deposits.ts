import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import { TransactionReceiptNotFoundError, type Hash, type TransactionReceipt } from "viem";
import type { ArcClient } from "../chain/arc.ts";
import { transfersInReceipt } from "../chain/native-transfers.ts";
import type { AccountDoc, Collections } from "../db/mongo.ts";
import { formatUsdc } from "../db/money.ts";
import { AppError } from "../errors.ts";
import type { DepositPage, DepositReceipt, Hex } from "../protocol.ts";
import type { Ledger } from "./ledger.ts";
import { accountView, depositView } from "./views.ts";

/** The receipt poll starts quick, for the usual case, and slows for a transaction that isn't landing. */
const RECEIPT_POLL_MS = 500;
const RECEIPT_POLL_MAX_MS = 2_000;
/** Each check polls the RPC until the transaction lands, so one account can't run many at once. */
const MAX_CHECKS_PER_ACCOUNT = 3;
export const MAX_PAGE = 100;

type Deps = {
    client: ArcClient;
    collections: Collections;
    ledger: Ledger;
    confirmations: number;
    receiptTimeoutMs: number;
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
            return Promise.reject(
                new AppError("rate_limited", "A few deposits are already being checked. Try again in a moment."),
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
        const receipt = await this.#settledReceipt(txHash);
        if (receipt.status !== "success") {
            throw new AppError("tx_reverted", "That transaction failed on Arc, so nothing was deposited.");
        }

        const transfers = transfersInReceipt(receipt).filter(
            (t) => t.to === account.depositAddress || account.formerDepositAddresses?.includes(t.to),
        );
        if (transfers.length === 0) {
            throw new AppError("no_deposit", "That transaction didn't send any USDC to your deposit address.");
        }

        const credits = [];
        for (const transfer of transfers) {
            const credit = await this.#deps.ledger.credit(transfer, account._id, "report");
            if (credit) credits.push(credit);
        }
        if (credits.length === 0) {
            throw new AppError(
                "below_minimum",
                `Deposits under ${formatUsdc(this.#deps.ledger.minDeposit)} USDC aren't credited.`,
            );
        }
        const current = await this.#deps.collections.accounts.findOne({ _id: account._id });
        if (!current) throw new Error(`Account ${account._id.toHexString()} vanished`);
        return {
            txHash: txHash as Hex,
            deposits: credits.map((credit) => depositView(credit.deposit)),
            account: accountView(current),
        };
    }

    /** Waits for the transaction to land, plus any confirmations, up to the timeout. */
    async #settledReceipt(txHash: Hash): Promise<TransactionReceipt> {
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
                throw new AppError("unavailable", "Couldn't reach Arc to check that transaction. Try again shortly.", {
                    cause: error,
                });
            }
            await sleep(Math.min(pause, Math.max(deadline - Date.now(), 0)));
            pause = Math.min(pause * 1.5, RECEIPT_POLL_MAX_MS);
        }
        throw new AppError(
            "tx_not_found",
            "That transaction hasn't shown up on Arc. If it lands later, it's credited automatically.",
        );
    }
}
