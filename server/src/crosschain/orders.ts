import { ObjectId } from "mongodb";
import { formatUnits, getAddress, isAddress } from "viem";
import type { Config } from "../config.ts";
import type { AccountDoc, Collections, DepositOrderDoc } from "../db/mongo.ts";
import { formatUsdc, toDecimal } from "../db/money.ts";
import type { Logger } from "pino";
import { AppError, refOf, shortOf } from "../errors.ts";
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
    logger?: Pick<Logger, "error" | "warn" | "info">;
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
            this.#deps.logger?.warn(
                { op: "deposit.order.limit", accountId: account._id.toHexString(), unsettled, limit: UNSETTLED_LIMIT },
                "Refused a deposit order: too many are still waiting to be sent",
            );
            throw new AppError(
                "rate_limited",
                `You already have ${unsettled} deposits waiting for your wallet to send them. Send those first, or wait about 10 minutes for them to expire.`,
                { logged: true },
            );
        }
        const { quote, source } = await this.#quote(account, wallet, coin, amount);
        const names = [...new Set(quote.txs.flatMap((tx) => (tx.kind === "solana" ? tx.lookupTables : [])))];
        const tables = new Map<string, string[]>();
        if (names.length > 0) {
            for (const { address, addresses } of await this.#deps.solana.getAddressLookupTables(names)) {
                tables.set(address, addresses);
            }
            const missing = names.filter((name) => !tables.has(name));
            if (missing.length > 0) {
                this.#deps.logger?.error(
                    {
                        op: "deposit.order.tables",
                        missing,
                        quote: quote.ref,
                        provider: quote.provider,
                        accountId: account._id.toHexString(),
                    },
                    "Refused a Solana deposit: a lookup table in the quote couldn't be loaded",
                );
                throw new AppError(
                    "unavailable",
                    "Relay's Solana route uses an address table we couldn't load. Try again in a minute.",
                    { logged: true },
                );
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
        const accountId = account._id.toHexString();
        const order = await depositOrders.findOne({ _id, accountId: account._id });
        if (!order) {
            this.#deps.logger?.warn(
                { op: "deposit.source.refused", accountId, orderId, reason: "not_found", txHashes },
                "Refused a deposit's transaction report: no such order for this account",
            );
            throw new AppError("not_found", `Order ${refOf(orderId)} isn't one of yours or has been cleared.`, {
                logged: true,
            });
        }
        const solana = coinByKey(order.coin).chain === "solana";
        const wrong = txHashes.find((hash) => hash.startsWith("0x") === solana);
        if (wrong !== undefined) {
            this.#deps.logger?.warn(
                {
                    op: "deposit.source.refused",
                    accountId,
                    orderId,
                    reason: "wrong_hash_kind",
                    coin: order.coin,
                    txHashes,
                },
                "Refused a deposit's transaction report: the hash is the wrong kind for the coin",
            );
            throw new AppError(
                "bad_request",
                `The hash your wallet returned (${shortOf(wrong)}) isn't a ${solana ? "Solana signature" : "transaction hash"}.`,
                { logged: true },
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
            if (!existing) {
                this.#deps.logger?.warn(
                    { op: "deposit.source.refused", accountId, orderId, reason: "not_found", txHashes },
                    "Refused a deposit's transaction report: no such order for this account",
                );
                throw new AppError("not_found", `Order ${refOf(orderId)} isn't one of yours or has been cleared.`, {
                    logged: true,
                });
            }
            // A repeat of what is recorded is harmless; anything else is a report the order could not take
            if (existing.sourceTxHashes.join() !== [...new Set(txHashes)].join()) {
                this.#deps.logger?.warn(
                    {
                        op: "deposit.source.ignored",
                        accountId,
                        orderId,
                        state: existing.state,
                        recorded: existing.sourceTxHashes,
                        reported: txHashes,
                    },
                    "Ignored a deposit's transaction report: the order had moved on or already had hashes",
                );
            }
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
            throw new AppError(
                "bad_request",
                `${source.symbol} on ${source.chainName} needs a${solana ? " Solana" : "n Ethereum-style"} wallet; ${shortOf(wallet)} is a${solana ? "n Ethereum-style" : " Solana"} wallet.`,
            );
        }
        const units = parseCoinAmount(source, amount);
        if (solana) await this.#checkMinimum(account, source, units);
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
                : { allowedPrograms: [], logger: this.#deps.logger },
        );
        return { quote, source };
    }

    /** Refuses a Solana deposit worth less than the minimum, and one that can't be priced. */
    async #checkMinimum(account: AccountDoc, coin: Coin, units: bigint) {
        const accountId = account._id.toHexString();
        let price: number | undefined = 1;
        if (coin.mint === null) {
            try {
                price = (await this.#deps.prices.usd([coin])).get(coin.key);
            } catch (error) {
                this.#deps.logger?.warn(
                    { op: "deposit.price", accountId, coin: coin.key, err: error },
                    "Couldn't price a Solana deposit",
                );
                price = undefined;
            }
        }
        const min = this.#deps.minSolanaUsd;
        if (price === undefined) {
            this.#deps.logger?.warn(
                { op: "deposit.price", accountId, coin: coin.key, minimumUsd: min },
                "Refused a Solana deposit: no price to check the minimum against",
            );
            throw new AppError(
                "unavailable",
                `Couldn't get a price for ${coin.symbol} from LI.FI right now, so the $${min} minimum can't be checked. Try again in a minute. Nothing was taken.`,
                { logged: true },
            );
        }
        const held = formatUnits(units, coin.decimals);
        const usd = Number(held) * price;
        if (usd < min) {
            this.#deps.logger?.info(
                { op: "deposit.minimum", accountId, coin: coin.key, amount: held, usd, minimumUsd: min },
                "Refused a Solana deposit under the minimum",
            );
            throw new AppError(
                "bad_request",
                `The smallest deposit from Solana is $${min}; ${held} ${coin.symbol} is about $${usd.toFixed(2)}.`,
                { logged: true },
            );
        }
    }
}
