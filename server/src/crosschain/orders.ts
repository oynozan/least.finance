import { ObjectId } from "mongodb";
import { formatUnits, getAddress, isAddress } from "viem";
import type { Config } from "../config.ts";
import type { AccountDoc, Collections, DepositOrderDoc } from "../db/mongo.ts";
import { formatUsdc, toDecimal } from "../db/money.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { DepositQuoteView } from "../protocol.ts";
import { coinByKey, parseCoinAmount, type Coin } from "./catalog.ts";
import type { PriceFeed } from "./prices.ts";
import type { BridgeProvider, Quote, SourceTx } from "./providers/types.ts";
import { bestQuote } from "./quotes.ts";
import type { SolanaRpc } from "./solana.ts";
import { solanaOpen } from "./solana-switch.ts";

type Deps = {
    collections: Collections;
    providers: readonly BridgeProvider[];
    bus: Bus;
    solana: SolanaRpc;
    prices: PriceFeed;
    switches: Pick<Config, "SOLANA_DEPOSITS" | "SOLANA_WITHDRAWALS">;
    /** Solana deposits worth less than this many dollars are refused. */
    minSolanaUsd: number;
    /** Program ids a Solana quote's instructions may call. */
    allowedPrograms: readonly string[];
    logger?: { error: (fields: object, message: string) => void };
};

/** Tried in this order for Solana coins: Relay, then CCTP only when Relay gave nothing usable. */
const SOLANA_TIERS = [["relay"], ["cctp"]] as const;

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
    async preview(account: AccountDoc, wallet: string, coin: string, amount: string): Promise<DepositQuoteView> {
        const { quote, source } = await this.#quote(account, wallet, coin, amount);
        return {
            coin: quote.coin,
            amount: formatUnits(quote.amountIn, source.decimals),
            usdcOut: formatUsdc(quote.usdcOut),
            etaSeconds: quote.etaSeconds,
            provider: quote.provider,
            ...(quote.sol ? { sol: { needed: String(quote.sol.needed), held: String(quote.sol.held) } } : {}),
        };
    }

    /** Quotes and opens an order; the wallet then signs `txs` and reports their hashes. */
    async create(
        account: AccountDoc,
        wallet: string,
        coin: string,
        amount: string,
    ): Promise<{ order: DepositOrderDoc; txs: SourceTx[]; tables: Map<string, string[]> }> {
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
        const names = [...new Set(quote.txs.flatMap((tx) => (tx.kind === "solana" ? tx.lookupTables : [])))];
        const tables = new Map<string, string[]>();
        if (names.length > 0) {
            for (const { address, addresses } of await this.#deps.solana.getAddressLookupTables(names)) {
                tables.set(address, addresses);
            }
        }
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
            refundTo: source.chain === "solana" ? quote.refundTo : quote.refundTo.toLowerCase(),
            state: "created",
            sourceTxHashes: [],
            fillTxHash: null,
            depositId: null,
            createdAt: now,
            updatedAt: now,
        };
        await this.#deps.collections.depositOrders.insertOne(order);
        this.#deps.bus.emit("order:updated", { order });
        return { order, txs: quote.txs, tables };
    }

    /**
     * Records the hashes the wallet sent. A created order moves to sent, and so does an expired one whose wallet prompt was
     * answered late; one the bridge already moved on keeps its state. Once hashes are recorded a repeat changes nothing.
     */
    async reportSource(account: AccountDoc, orderId: string, txHashes: string[]): Promise<DepositOrderDoc> {
        const { depositOrders } = this.#deps.collections;
        const _id = new ObjectId(orderId);
        const order = await depositOrders.findOne({ _id, accountId: account._id });
        if (!order) throw new AppError("not_found", "No such order.");
        const solana = coinByKey(order.coin).chain === "solana";
        if (txHashes.some((hash) => hash.startsWith("0x") === solana)) {
            throw new AppError(
                "bad_request",
                solana ? "That isn't a Solana signature." : "That isn't a transaction hash.",
            );
        }
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
                {
                    _id,
                    accountId: account._id,
                    state: { $in: ["created", "expired", "bridging"] },
                    sourceTxHashes: { $size: 0 },
                },
                [
                    {
                        $set: {
                            state: { $cond: [{ $eq: ["$state", "bridging"] }, "bridging", "sent"] },
                            sourceTxHashes: { $literal: [...new Set(txHashes)] },
                            updatedAt: new Date(),
                        },
                    },
                ],
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
        wallet: string,
        key: string,
        amount: string,
    ): Promise<{ quote: Quote; source: Coin }> {
        const source = coinByKey(key);
        if (source.chain === "arc") {
            throw new AppError("bad_request", "USDC on Arc goes straight to your deposit address.");
        }
        const solana = source.chain === "solana";
        if (solana) solanaOpen(this.#deps.switches, "deposits");
        if (solana === isAddress(wallet, { strict: false })) {
            throw new AppError("bad_request", "That wallet can't send this coin.");
        }
        const units = parseCoinAmount(source, amount);
        if (solana) await this.#checkMinimum(source, units);
        const quote = await bestQuote(
            this.#deps.providers,
            {
                coin: source,
                amount: units,
                sender: wallet,
                recipient: getAddress(account.depositAddress),
                refundTo: wallet,
            },
            solana
                ? {
                      tiers: SOLANA_TIERS,
                      allowedPrograms: this.#deps.allowedPrograms,
                      logger: this.#deps.logger,
                  }
                : { allowedPrograms: [] },
        );
        return { quote, source };
    }

    /** Refuses a Solana deposit worth less than the minimum, and one that can't be priced. */
    async #checkMinimum(coin: Coin, units: bigint) {
        const price =
            coin.mint === null ? (await this.#deps.prices.usd([coin]).catch(() => new Map())).get(coin.key) : 1;
        if (price === undefined) throw new AppError("unavailable", "Couldn't price this right now. Nothing was taken.");
        if (Number(formatUnits(units, coin.decimals)) * price < this.#deps.minSolanaUsd) {
            throw new AppError("bad_request", `The smallest deposit from Solana is $${this.#deps.minSolanaUsd}.`);
        }
    }
}
