import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { parseUnits } from "viem";
import type { Config } from "../config.ts";
import {
    isDuplicateKey,
    type AccountDoc,
    type Collections,
    type PositionDoc,
    type PredictionFailure,
    type PredictionOrderDoc,
} from "../db/mongo.ts";
import { e6ToWei, formatE6, formatUsdc, fromDecimal, toDecimal, weiToE6 } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { MarketService } from "../markets/markets.ts";
import type { PositionsView, PredictionOrderView, QuoteView } from "../protocol.ts";
import { costOfFill, limitBuyPrice, quoteBuy } from "./pricing.ts";
import type { PoolTrader } from "./trader.ts";
import { formatUsdShort, orderView, positionView } from "./views.ts";

const SETTLED_KEEP_MS = 7 * 24 * 3_600_000;
const FLOAT_LOW = 0.25;
const FLOAT_HIGH = 2;
const AMOUNT = /^\d+(\.\d{1,6})?$/;

export const NOTHING_SPENT = "Nothing was spent.";
const PRICE_MOVED = "The price moved, so your prediction didn't go through.";

type Deps = {
    collections: Collections;
    ledger: Ledger;
    markets: Pick<MarketService, "outcome">;
    trader: () => PoolTrader | null;
    bus: Bus;
    logger: Logger;
    config: Pick<Config, "PREDICTIONS_TRADING" | "POLYMARKET_FLOAT_USD">;
    /** The clock, for tests. */
    now?: () => number;
};

export type PlaceInput = {
    requestId: string;
    eventId: string;
    tokenId: string;
    amountUSD: string;
    quotedPrice?: number;
};

/** Places buys against the pool's Polymarket account and settles each exactly once; the person's balance holds the money meanwhile. */
export class PredictionService {
    readonly #deps: Deps;
    readonly #now: () => number;
    /** The pool's pUSD, from the last read. */
    #balanceE6: bigint | null = null;
    /** Wei held by buys that haven't settled. */
    #heldE6 = 0n;
    #floatState: "low" | "high" | "ok" = "ok";

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** The largest order the pool can cover now, in whole dollars; null while predictions aren't live. */
    maxOrderUSD(): number | null {
        if (this.#deps.config.PREDICTIONS_TRADING !== "on" || !this.#deps.trader() || this.#balanceE6 === null)
            return null;
        const free = this.#balanceE6 - this.#heldE6;
        return free <= 0n ? 0 : Number(free / 1_000_000n);
    }

    async refreshFloat(): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) return;
        const { predictionOrders } = this.#deps.collections;
        const [balance, open] = await Promise.all([
            trader.balanceE6(),
            predictionOrders.find({ side: "buy", state: { $in: ["placing", "posted"] } }).toArray(),
        ]);
        this.#balanceE6 = balance;
        this.#heldE6 = open.reduce((total, order) => total + weiToE6(fromDecimal(order.amount)), 0n);
        this.#warnOnFloat(balance);
    }

    #warnOnFloat(balance: bigint) {
        const target = this.#deps.config.POLYMARKET_FLOAT_USD;
        const usd = Number(balance) / 1e6;
        const state = usd < target * FLOAT_LOW ? "low" : usd > target * FLOAT_HIGH ? "high" : "ok";
        if (state !== "ok" && state !== this.#floatState)
            this.#deps.logger.warn({ balanceUSD: usd, targetUSD: target }, `The pool's Polymarket float is ${state}`);
        this.#floatState = state;
    }

    async quote(input: { eventId: string; tokenId: string; amountUSD: string }): Promise<QuoteView> {
        const trader = this.#trader();
        const offered = await this.#deps.markets.outcome(input.eventId, input.tokenId);
        if (!offered) throw marketClosed();
        const amountWei = this.#amount(input.amountUSD, offered.outcome.minUSD);
        const [book, meta] = await Promise.all([trader.book(input.tokenId), trader.meta(input.tokenId)]);
        const q = quoteBuy(book, meta, weiToE6(amountWei));
        if (!q || q.worstPrice > limitBuyPrice(offered.outcome.buyPrice, meta.tickSize))
            throw new AppError("price_moved", PRICE_MOVED);
        const shares = formatE6(q.sharesE6);
        return {
            eventId: input.eventId,
            tokenId: input.tokenId,
            side: "buy",
            amountUSD: input.amountUSD,
            shares,
            avgPrice: q.avgPrice,
            worstPrice: q.worstPrice,
            feeUSD: formatE6(q.feeE6),
            payoutUSD: shares,
            minUSD: offered.outcome.minUSD,
        };
    }

    async place(account: AccountDoc, input: PlaceInput): Promise<PredictionOrderView> {
        this.#trader();
        const offered = await this.#deps.markets.outcome(input.eventId, input.tokenId);
        if (!offered) throw marketClosed();
        const amount = this.#amount(input.amountUSD, offered.outcome.minUSD);
        await this.#checkFloat(weiToE6(amount));

        const now = new Date(this.#now());
        const order: PredictionOrderDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: input.requestId,
            side: "buy",
            eventId: input.eventId,
            marketId: offered.marketId,
            tokenId: input.tokenId,
            conditionId: "",
            question: offered.question,
            outcome: offered.outcome.label,
            amount: toDecimal(amount),
            shares: null,
            quotedPrice: input.quotedPrice ?? offered.outcome.buyPrice,
            limitPrice: 0,
            positionId: null,
            orderHash: null,
            clobOrderId: null,
            signed: null,
            state: "placing",
            reason: null,
            filledShares: null,
            cost: null,
            postedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        const held = await this.#hold(order, amount);
        if (!held.fresh) return orderView(held.order);

        this.#heldE6 += weiToE6(amount);
        void this.#submit(order).catch((error: unknown) =>
            this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "Couldn't submit a prediction"),
        );
        return orderView(order);
    }

    /** One transaction takes the money and records the order; a repeated request is the same order. */
    async #hold(order: PredictionOrderDoc, amount: bigint): Promise<{ order: PredictionOrderDoc; fresh: boolean }> {
        const { predictionOrders } = this.#deps.collections;
        const key = { accountId: order.accountId, requestId: order.requestId };
        try {
            return await this.#deps.ledger.runInTransaction(async (session) => {
                const known = await predictionOrders.findOne(key, { session });
                if (known) return { order: known, fresh: false };
                await predictionOrders.insertOne(order, { session });
                await this.#deps.ledger.debitInSession(session, order.accountId, amount, "prediction_buy", order._id);
                return { order, fresh: true };
            });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            const known = await predictionOrders.findOne(key);
            if (!known) throw error;
            return { order: known, fresh: false };
        }
    }

    async #submit(order: PredictionOrderDoc): Promise<void> {
        const { predictionOrders } = this.#deps.collections;
        const trader = this.#deps.trader();
        let signed;
        let meta;
        let limitPrice = 0;
        try {
            if (!trader) throw new Error("The trader isn't ready");
            const [book, m] = await Promise.all([trader.book(order.tokenId), trader.meta(order.tokenId)]);
            meta = m;
            limitPrice = limitBuyPrice(order.quotedPrice, meta.tickSize);
            const q = quoteBuy(book, meta, weiToE6(fromDecimal(order.amount)));
            if (!q || q.worstPrice > limitPrice) return void (await this.fail(order, "price_moved", "placing"));
            signed = await trader.signBuy({
                tokenId: order.tokenId,
                spendE6: weiToE6(fromDecimal(order.amount)),
                maxPrice: limitPrice,
            });
        } catch (error) {
            this.#deps.logger.warn({ err: error, order: order._id.toHexString() }, "Couldn't prepare a prediction");
            return void (await this.fail(order, "unavailable", "placing"));
        }

        const now = new Date(this.#now());
        const posted = await predictionOrders.findOneAndUpdate(
            { _id: order._id, state: "placing" },
            {
                $set: {
                    state: "posted",
                    orderHash: signed.orderHash,
                    signed: signed.signed,
                    conditionId: meta.conditionId,
                    limitPrice,
                    postedAt: now,
                    updatedAt: now,
                },
            },
            { returnDocument: "after" },
        );
        if (!posted) return;

        // A throw here leaves the order posted, and the tracker finds out what became of it
        const result = await trader.post(signed);
        if (result.kind === "filled") await this.settle(posted, result.makingE6, result.takingE6);
        else if (result.kind === "rejected") await this.fail(posted, result.reason, "posted");
        else if (result.kind === "delayed")
            await predictionOrders.updateOne(
                { _id: order._id, state: "posted" },
                { $set: { clobOrderId: result.orderId } },
            );
    }

    /** Books a fill: the shares go to the position and whatever the fill didn't use goes back. A repeat does nothing. */
    async settle(order: PredictionOrderDoc, makingE6: bigint, takingE6: bigint): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) throw new Error("The trader isn't ready");
        const meta = await trader.meta(order.tokenId);
        const held = fromDecimal(order.amount);
        const spent = e6ToWei(costOfFill(makingE6, takingE6, meta));
        const cost = spent > held ? held : spent;
        const { predictionOrders, positions, accounts } = this.#deps.collections;

        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const now = new Date();
            const moved = await predictionOrders.findOneAndUpdate(
                { _id: order._id, state: "posted" },
                {
                    $set: {
                        state: "filled",
                        filledShares: toDecimal(takingE6),
                        cost: toDecimal(cost),
                        updatedAt: now,
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;

            const position = await positions.findOneAndUpdate(
                { accountId: order.accountId, tokenId: order.tokenId, state: { $in: ["open", "closing"] } },
                {
                    $inc: { shares: toDecimal(takingE6), cost: toDecimal(cost) },
                    $set: { updatedAt: now },
                    $setOnInsert: {
                        _id: new ObjectId(),
                        eventId: order.eventId,
                        marketId: order.marketId,
                        conditionId: order.conditionId,
                        question: order.question,
                        outcome: order.outcome,
                        state: "open",
                        proceeds: null,
                        payout: null,
                        openedAt: now,
                        settledAt: null,
                    },
                },
                { session, upsert: true, returnDocument: "after" },
            );
            if (!position) throw new Error("The position wasn't written");
            const linked = await predictionOrders.findOneAndUpdate(
                { _id: order._id },
                { $set: { positionId: position._id } },
                { session, returnDocument: "after" },
            );

            const refund = held - cost;
            const account =
                refund > 0n
                    ? await this.#deps.ledger.creditInSession(
                          session,
                          order.accountId,
                          refund,
                          "prediction_refund",
                          order._id,
                      )
                    : await accounts.findOne({ _id: order.accountId }, { session });
            if (!account || !linked) throw new Error("The order or its account vanished");
            return { order: linked, position, account };
        });
        if (!done) return;
        this.#deps.logger.info(
            { order: order._id.toHexString(), shares: formatE6(takingE6), cost: formatUsdc(cost) },
            "Prediction filled",
        );
        this.#afterSettle(held, done);
    }

    /** Fails an order and gives back everything it held. A repeat, or an order that already moved on, does nothing. */
    async fail(order: PredictionOrderDoc, reason: PredictionFailure, from: "placing" | "posted"): Promise<void> {
        const { predictionOrders } = this.#deps.collections;
        const held = fromDecimal(order.amount);
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const moved = await predictionOrders.findOneAndUpdate(
                { _id: order._id, state: from },
                { $set: { state: "failed", reason, updatedAt: new Date() } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const account = await this.#deps.ledger.creditInSession(
                session,
                order.accountId,
                held,
                "prediction_refund",
                order._id,
            );
            return { order: moved, position: null, account };
        });
        if (!done) return;
        this.#deps.logger.info({ order: order._id.toHexString(), reason }, "Prediction failed and refunded");
        this.#afterSettle(held, done);
    }

    #afterSettle(
        held: bigint,
        update: { order: PredictionOrderDoc; position: PositionDoc | null; account: AccountDoc },
    ) {
        this.#heldE6 -= weiToE6(held);
        this.#deps.bus.emit("prediction:updated", update);
        void this.refreshFloat().catch((error: unknown) =>
            this.#deps.logger.warn({ err: error }, "Couldn't read the pool's float"),
        );
    }

    /** Orders left placing by a restart never reached Polymarket, so they are refunded. */
    async recover(): Promise<void> {
        const stale = await this.#deps.collections.predictionOrders.find({ state: "placing" }).toArray();
        for (const order of stale) await this.fail(order, "unavailable", "placing");
    }

    async positions(account: AccountDoc): Promise<PositionsView> {
        const { positions, predictionOrders } = this.#deps.collections;
        const since = new Date(this.#now() - SETTLED_KEEP_MS);
        const [open, orders] = await Promise.all([
            positions
                .find({
                    accountId: account._id,
                    $or: [{ state: { $in: ["open", "closing"] } }, { settledAt: { $gte: since } }],
                })
                .sort({ _id: -1 })
                .toArray(),
            predictionOrders
                .find({ accountId: account._id, state: { $in: ["placing", "posted"] } })
                .sort({ _id: -1 })
                .toArray(),
        ]);
        return { positions: open.map(positionView), orders: orders.map(orderView) };
    }

    #trader(): PoolTrader {
        const trader = this.#deps.trader();
        if (this.#deps.config.PREDICTIONS_TRADING !== "on" || !trader)
            throw new AppError("trading_off", `Predictions aren't live yet. ${NOTHING_SPENT}`);
        return trader;
    }

    /** The amount in wei, once it is a clean decimal over the outcome's minimum. */
    #amount(text: string, minUSD: number): bigint {
        if (!AMOUNT.test(text)) throw new AppError("bad_request", "Invalid amountUSD: an amount such as 10.50");
        const wei = parseUnits(text, 18);
        if (wei < parseUnits(minUSD.toFixed(2), 18))
            throw new AppError("below_minimum", `The minimum for this prediction is ${formatUsdShort(minUSD)}.`);
        return wei;
    }

    async #checkFloat(amountE6: bigint) {
        if (this.#balanceE6 === null) await this.refreshFloat();
        const max = this.maxOrderUSD();
        if (max === null || amountE6 > this.#balanceE6! - this.#heldE6)
            throw new AppError(
                "float_short",
                `Predictions are limited to ${formatUsdShort(max ?? 0)} right now. ${NOTHING_SPENT}`,
            );
    }
}

const marketClosed = () => new AppError("market_closed", `This market just closed. ${NOTHING_SPENT}`);
