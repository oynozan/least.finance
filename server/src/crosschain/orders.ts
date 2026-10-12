import { ObjectId } from "mongodb";
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import type { AccountDoc, Collections, DepositOrderDoc } from "../db/mongo.ts";
import { formatUsdc, toDecimal } from "../db/money.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { DepositQuoteView } from "../protocol.ts";
import { coinByKey, parseCoinAmount, type Coin } from "./catalog.ts";
import type { BridgeProvider, Quote, SourceTx } from "./providers/types.ts";
import { bestQuote } from "./quotes.ts";

type Deps = { collections: Collections; providers: readonly BridgeProvider[]; bus: Bus };

const TERMINAL = ["delivered", "refunded", "failed", "expired"] as const;
const OPEN_LIMIT = 20;
/** Orders an account may have waiting on its wallet or the source chain at once. */
const UNSETTLED_LIMIT = 5;
/** A bridging order that hasn't changed state in this long is no longer followed or listed. */
export const GIVE_UP_MS = 86_400_000;

/** Deposit orders: a coin on another chain, bridged to the account's address on Arc. */
export class DepositOrders {
    readonly #deps: Deps;
    /** Reports being written and announced, by order id. */
    readonly #announcing = new Map<string, Promise<void>>();

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    /** What the best bridge would pay for this coin, with no order opened. */
    async preview(account: AccountDoc, wallet: Address, coin: string, amount: string): Promise<DepositQuoteView> {
        const { quote, source } = await this.#quote(account, wallet, coin, amount);
        return {
            coin: quote.coin,
            amount: formatUnits(quote.amountIn, source.decimals),
            usdcOut: formatUsdc(quote.usdcOut),
            etaSeconds: quote.etaSeconds,
            provider: quote.provider,
        };
    }

    /** Quotes and opens an order; the wallet then signs `txs` and reports their hashes. */
    async create(
        account: AccountDoc,
        wallet: Address,
        coin: string,
        amount: string,
    ): Promise<{ order: DepositOrderDoc; txs: SourceTx[] }> {
        const unsettled = await this.#deps.collections.depositOrders.countDocuments({
            accountId: account._id,
            state: { $in: ["created", "sent"] },
        });
        if (unsettled >= UNSETTLED_LIMIT) {
            throw new AppError(
                "rate_limited",
                "Too many deposits are still waiting to be sent. Try again in a few minutes.",
            );
        }
        const { quote, source } = await this.#quote(account, wallet, coin, amount);
        const now = new Date();
        const order: DepositOrderDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            coin: source.key,
            amount: formatUnits(quote.amountIn, source.decimals),
            wallet,
            provider: quote.provider,
            ref: quote.ref,
            usdcOut: toDecimal(quote.usdcOut),
            etaSeconds: quote.etaSeconds,
            recipient: quote.recipient.toLowerCase(),
            refundTo: quote.refundTo.toLowerCase(),
            state: "created",
            sourceTxHashes: [],
            fillTxHash: null,
            depositId: null,
            createdAt: now,
            updatedAt: now,
        };
        await this.#deps.collections.depositOrders.insertOne(order);
        this.#deps.bus.emit("order:updated", { order });
        return { order, txs: quote.txs };
    }

    /** Records the hashes the wallet sent; only a created order moves, and a repeat changes nothing. */
    async reportSource(account: AccountDoc, orderId: string, txHashes: Hex[]): Promise<DepositOrderDoc> {
        const { depositOrders } = this.#deps.collections;
        const _id = new ObjectId(orderId);
        // From before the write, so the tracker, which can see the order the moment it is written, announces after.
        let done = () => {};
        this.#announcing.set(
            orderId,
            new Promise<void>((resolve) => {
                done = resolve;
            }),
        );
        try {
            const moved = await depositOrders.findOneAndUpdate(
                { _id, accountId: account._id, state: "created" },
                { $set: { state: "sent", sourceTxHashes: [...new Set(txHashes)], updatedAt: new Date() } },
                { returnDocument: "after" },
            );
            if (moved) {
                this.#deps.bus.emit("order:updated", { order: moved });
                return moved;
            }
            const existing = await depositOrders.findOne({ _id, accountId: account._id });
            if (!existing) throw new AppError("not_found", "No such order.");
            return existing;
        } finally {
            this.#announcing.delete(orderId);
            done();
        }
    }

    /** Resolves once any report of this order has been announced, so a later step is announced after it. */
    announced(orderId: ObjectId): Promise<void> {
        return this.#announcing.get(orderId.toHexString()) ?? Promise.resolve();
    }

    /** The account's orders still in flight, newest first. */
    open(accountId: ObjectId): Promise<DepositOrderDoc[]> {
        return this.#deps.collections.depositOrders
            .find({
                accountId,
                state: { $nin: [...TERMINAL] },
                $or: [
                    { state: { $in: ["created", "sent"] } },
                    { updatedAt: { $gt: new Date(Date.now() - GIVE_UP_MS) } },
                ],
            })
            .sort({ _id: -1 })
            .limit(OPEN_LIMIT)
            .toArray();
    }

    async #quote(
        account: AccountDoc,
        wallet: Address,
        key: string,
        amount: string,
    ): Promise<{ quote: Quote; source: Coin }> {
        const source = coinByKey(key);
        if (source.chain === "arc") {
            throw new AppError("bad_request", "USDC on Arc goes straight to your deposit address.");
        }
        if (source.chain === "solana") throw new AppError("bad_request", "Deposits from Solana aren't open yet.");
        const quote = await bestQuote(this.#deps.providers, {
            coin: source,
            amount: parseCoinAmount(source, amount),
            sender: wallet,
            recipient: getAddress(account.depositAddress),
            refundTo: wallet,
        });
        return { quote, source };
    }
}
