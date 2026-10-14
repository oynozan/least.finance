import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId, type ClientSession } from "mongodb";
import type { Logger } from "pino";
import { parseUnits } from "viem";
import type { Config } from "../config.ts";
import {
    isDuplicateKey,
    type AccountDoc,
    type Collections,
    type PoolFloatDoc,
    type PositionDoc,
    type PredictionFailure,
    type PredictionOrderDoc,
} from "../db/mongo.ts";
import { e6ToWei, formatE6, formatUsdc, fromDecimal, toDecimal, weiToE6 } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import { AppError, isAppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { MarketService } from "../markets/markets.ts";
import type { PositionsView, PredictionOrderView, QuoteView, SellQuoteView } from "../protocol.ts";
import {
    costOfFill,
    feeE6,
    limitBuyPrice,
    limitSellPrice,
    quoteBuy,
    quoteSell,
    referenceBuyPrice,
    referenceSellPrice,
} from "./pricing.ts";
import type { MarketMeta, PoolTrader, SignedRecord } from "./trader.ts";
import { formatUsdShort, orderView, positionView } from "./views.ts";

/** Covers the PnL page's 30-day chart; the sidebar trims its Won and Lost rows to a week itself */
const SETTLED_KEEP_MS = 35 * 24 * 3_600_000;
const FLOAT_LOW = 0.25;
const FLOAT_HIGH = 2;
const GIVE_UP_TRIES = 3;
const GIVE_UP_RETRY_MS = 200;
/** The SDK signs share sizes to 2 decimals. */
const SHARE_STEP_E6 = 10_000n;
/** A balance read older than this no longer backs new orders. */
const FLOAT_MAX_AGE_MS = 180_000;
/** How long an order waits on a fresh balance read before it is refused. */
const FLOAT_READ_MS = 30_000;
const FLOAT_ID = "polygon";
const AMOUNT = /^\d+(\.\d{1,6})?$/;

export const NOTHING_SPENT = "Nothing was spent.";
const PRICE_MOVED = `The price moved, so your prediction didn't go through. ${NOTHING_SPENT}`;
const TOO_SMALL = "Too small to sell. It pays out when the market resolves.";

export type CloseInput = { requestId: string; positionId: string; quotedPrice: number };

const sellable = (position: PositionDoc): bigint => {
    const shares = fromDecimal(position.shares);
    return shares - (shares % SHARE_STEP_E6);
};
const minSharesE6 = (minOrderSize: number): bigint => BigInt(Math.round(minOrderSize * 1e6));

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
    /** The float document as this process last saw it, for the figure shown to clients. */
    #mirror: { balanceE6: bigint; heldE6: bigint; unreadE6: bigint; at: number } | null = null;
    #floatState: "low" | "high" | "ok" = "ok";
    /** Orders this process is still sending, so the tracker doesn't judge a post that hasn't answered yet. */
    readonly #submitting = new Set<string>();

    /** Set at shutdown; no new order is taken after. */
    #stopped = false;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** Stops taking new orders, so a shutdown doesn't post one it can't follow. */
    stopOrders(): void {
        this.#stopped = true;
    }

    submitting(id: ObjectId): boolean {
        return this.#submitting.has(id.toHexString());
    }

    /** The largest order the pool can cover now, in whole dollars; null while predictions aren't live. */
    maxOrderUSD(): number | null {
        if (this.#deps.config.PREDICTIONS_TRADING !== "on" || !this.#deps.trader() || this.#mirror === null)
            return null;
        const free = this.#mirror.balanceE6 - this.#mirror.heldE6 - this.#mirror.unreadE6;
        return free <= 0n ? 0 : Number(free / 1_000_000n);
    }

    /** Reads the pool's pUSD into the float document, keeping fills that landed during the read. */
    async refreshFloat(): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) return;
        const { poolFloat } = this.#deps.collections;
        const before = await poolFloat.findOne({ _id: FLOAT_ID });
        const unread = before ? fromDecimal(before.unreadFillsE6) : 0n;
        const balance = await trader.balanceE6();
        const now = new Date(this.#now());
        const initialHeld = before ? 0n : (await this.#openHolds()).total;
        const zero = toDecimal(0n);
        const doc = await poolFloat.findOneAndUpdate(
            { _id: FLOAT_ID },
            [
                {
                    $set: {
                        balanceE6: toDecimal(balance),
                        balanceAt: now,
                        updatedAt: now,
                        heldE6: { $ifNull: ["$heldE6", toDecimal(initialHeld)] },
                        unreadFillsE6: {
                            $max: [zero, { $subtract: [{ $ifNull: ["$unreadFillsE6", zero] }, toDecimal(unread)] }],
                        },
                    },
                },
            ],
            { upsert: true, returnDocument: "after" },
        );
        if (doc) this.#remember(doc);
        this.#warnOnFloat(balance);
        await this.#checkHolds();
    }

    /** The sum of what open buys reserved; orders from before the float document reserved their whole amount. */
    async #openHolds(): Promise<{ total: bigint }> {
        const open = await this.#deps.collections.predictionOrders
            .find({ side: "buy", state: { $in: ["placing", "posted"] } })
            .toArray();
        return { total: open.reduce((sum, order) => sum + reservedOf(order), 0n) };
    }

    /** Reports and repairs a held figure that differs from the open buys; it can only differ through a bug. */
    async #checkHolds(): Promise<void> {
        const { poolFloat } = this.#deps.collections;
        const first = await poolFloat.findOne({ _id: FLOAT_ID });
        if (!first) return;
        const { total } = await this.#openHolds();
        const second = await poolFloat.findOne({ _id: FLOAT_ID });
        // A reservation or release in between would make the two reads disagree for no fault
        if (!second || fromDecimal(first.heldE6) !== fromDecimal(second.heldE6)) return;
        const held = fromDecimal(second.heldE6);
        if (held === total) return;
        this.#deps.logger.error(
            { heldE6: held.toString(), expected: total.toString() },
            "The pool's float holds drifted",
        );
        const doc = await poolFloat.findOneAndUpdate(
            { _id: FLOAT_ID, heldE6: second.heldE6 },
            { $set: { heldE6: toDecimal(total), updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (doc) this.#remember(doc);
    }

    #remember(doc: PoolFloatDoc) {
        const at = doc.updatedAt.getTime();
        if (this.#mirror && at < this.#mirror.at) return;
        this.#mirror = {
            balanceE6: fromDecimal(doc.balanceE6),
            heldE6: fromDecimal(doc.heldE6),
            unreadE6: fromDecimal(doc.unreadFillsE6),
            at,
        };
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

    async quoteSell(account: AccountDoc, positionId: string): Promise<SellQuoteView> {
        const trader = this.#trader();
        const position = await this.#openPosition(account, positionId);
        const sharesE6 = sellable(position);
        if (sharesE6 <= 0n) throw new AppError("below_minimum", TOO_SMALL);
        const [book, meta] = await Promise.all([trader.book(position.tokenId), trader.meta(position.tokenId)]);
        const q = quoteSell(book, meta, sharesE6);
        if (!q) throw new AppError("price_moved", PRICE_MOVED);
        return {
            positionId,
            side: "sell",
            shares: formatE6(sharesE6),
            proceedsUSD: formatE6(q.proceedsE6),
            avgPrice: q.avgPrice,
            worstPrice: q.worstPrice,
            feeUSD: formatE6(q.feeE6),
            minShares: book.minOrderSize,
        };
    }

    /** Sells a whole open position; the position is `closing` until the sell settles, so a second sell is refused. */
    async close(account: AccountDoc, input: CloseInput): Promise<PredictionOrderView> {
        const { predictionOrders, positions } = this.#deps.collections;
        const known = await predictionOrders.findOne({ accountId: account._id, requestId: input.requestId });
        if (known) return orderView(known);
        const trader = this.#trader();
        const position = await this.#openPosition(account, input.positionId);
        const sharesE6 = sellable(position);
        const book = await trader.book(position.tokenId);
        if (sharesE6 <= 0n || sharesE6 < minSharesE6(book.minOrderSize)) throw new AppError("below_minimum", TOO_SMALL);

        const check = referenceSellPrice(input.quotedPrice, book.bids[0]?.price ?? null);
        if (!check.ok) throw new AppError("price_moved", PRICE_MOVED);

        const now = new Date(this.#now());
        const order: PredictionOrderDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: input.requestId,
            side: "sell",
            eventId: position.eventId,
            marketId: position.marketId,
            tokenId: position.tokenId,
            conditionId: position.conditionId,
            question: position.question,
            outcome: position.outcome,
            amount: toDecimal(0n),
            shares: toDecimal(sharesE6),
            quotedPrice: check.reference,
            clientPrice: input.quotedPrice,
            limitPrice: 0,
            positionId: position._id,
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
        const held = await this.#record(order, async (session) => {
            // A buy still in flight would land in the closing position after the sell sized itself without it
            const buying = await predictionOrders.countDocuments(
                {
                    accountId: account._id,
                    tokenId: position.tokenId,
                    side: "buy",
                    state: { $in: ["placing", "posted"] },
                },
                { session, limit: 1 },
            );
            if (buying > 0) throw busy();
            const moved = await positions.findOneAndUpdate(
                { _id: position._id, accountId: account._id, state: "open", shares: position.shares },
                { $set: { state: "closing", updatedAt: now } },
                { session },
            );
            if (!moved) throw busy();
        });
        if (!held.fresh) return orderView(held.order);

        void this.#submit(order).catch((error: unknown) =>
            this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "Couldn't submit a sale"),
        );
        return orderView(order);
    }

    /** The person's position, once it is open to sell. */
    async #openPosition(account: AccountDoc, positionId: string): Promise<PositionDoc> {
        const position = ObjectId.isValid(positionId)
            ? await this.#deps.collections.positions.findOne({ _id: new ObjectId(positionId), accountId: account._id })
            : null;
        if (!position) throw new AppError("not_found", "That position wasn't found.");
        if (position.state === "closing") throw busy();
        if (position.state !== "open") throw new AppError("not_found", "That position wasn't found.");
        return position;
    }

    async place(account: AccountDoc, input: PlaceInput): Promise<PredictionOrderView> {
        // A retry is the same order whatever the checks below would say now
        const known = await this.#deps.collections.predictionOrders.findOne({
            accountId: account._id,
            requestId: input.requestId,
        });
        if (known) return orderView(known);
        this.#trader();
        const offered = await this.#deps.markets.outcome(input.eventId, input.tokenId);
        if (!offered) throw marketClosed();
        const check = referenceBuyPrice(input.quotedPrice, offered.outcome.buyPrice);
        if (!check.ok) throw new AppError("price_moved", PRICE_MOVED);
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
            reservedE6: toDecimal(weiToE6(amount)),
            shares: null,
            quotedPrice: check.reference,
            ...(input.quotedPrice !== undefined && { clientPrice: input.quotedPrice }),
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
        let reserved: PoolFloatDoc | null = null;
        const held = await this.#record(order, async (session) => {
            await this.#deps.ledger.debitInSession(session, order.accountId, amount, "prediction_buy", order._id);
            // The shared float document goes last, to hold its lock briefly
            reserved = await this.#reserve(session, weiToE6(amount));
        });
        if (!held.fresh) return orderView(held.order);

        if (reserved) this.#remember(reserved);
        void this.#submit(order).catch((error: unknown) =>
            this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "Couldn't submit a prediction"),
        );
        return orderView(order);
    }

    /** One transaction records the order and takes what it holds; a repeated request is the same order. */
    async #record(
        order: PredictionOrderDoc,
        take: (session: ClientSession) => Promise<unknown>,
    ): Promise<{ order: PredictionOrderDoc; fresh: boolean }> {
        const { predictionOrders } = this.#deps.collections;
        const key = { accountId: order.accountId, requestId: order.requestId };
        try {
            return await this.#deps.ledger.runInTransaction(async (session) => {
                const known = await predictionOrders.findOne(key, { session });
                if (known) return { order: known, fresh: false };
                await predictionOrders.insertOne(order, { session });
                await take(session);
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
        const id = order._id.toHexString();
        this.#submitting.add(id);
        try {
            await this.#send(order);
        } catch (error) {
            this.#deps.logger.error({ err: error, order: id }, "Couldn't submit a prediction");
            await this.#giveUp(order);
        } finally {
            this.#submitting.delete(id);
        }
    }

    /** Refunds an order that never reached the exchange; one that did is left posted, since this only moves a placing one. */
    async #giveUp(order: PredictionOrderDoc): Promise<void> {
        for (let attempt = 1; attempt <= GIVE_UP_TRIES; attempt++) {
            try {
                return await this.fail(order, "unavailable", "placing");
            } catch (error) {
                this.#deps.logger.warn({ err: error, order: order._id.toHexString() }, "Couldn't refund a prediction");
                await sleep(GIVE_UP_RETRY_MS * attempt);
            }
        }
    }

    async #send(order: PredictionOrderDoc): Promise<void> {
        const { predictionOrders } = this.#deps.collections;
        const trader = this.#deps.trader();
        let signed: SignedRecord;
        let meta: MarketMeta;
        let limitPrice: number;
        try {
            if (!trader) throw new Error("The trader isn't ready");
            const [book, m] = await Promise.all([trader.book(order.tokenId), trader.meta(order.tokenId)]);
            meta = m;
            if (order.side === "sell") {
                const sharesE6 = fromDecimal(order.shares!);
                limitPrice = limitSellPrice(order.quotedPrice, meta.tickSize);
                const q = quoteSell(book, meta, sharesE6);
                if (!q || q.worstPrice < limitPrice) return void (await this.fail(order, "price_moved", "placing"));
                signed = await trader.signSell({ tokenId: order.tokenId, sharesE6, minPrice: limitPrice });
            } else {
                limitPrice = limitBuyPrice(order.quotedPrice, meta.tickSize);
                const q = quoteBuy(book, meta, weiToE6(fromDecimal(order.amount)));
                if (!q || q.worstPrice > limitPrice) return void (await this.fail(order, "price_moved", "placing"));
                signed = await trader.signBuy({
                    tokenId: order.tokenId,
                    spendE6: weiToE6(fromDecimal(order.amount)),
                    maxPrice: limitPrice,
                });
            }
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
                    // Marked unknown from the moment it is posted, so a lost answer is held by the tracker, never refunded blind
                    postUnknownAt: now,
                    updatedAt: now,
                },
            },
            { returnDocument: "after" },
        );
        if (!posted) return;

        const result = await trader.post(signed).catch(() => ({ kind: "unknown" }) as const);
        if (result.kind === "unknown") return;
        if (result.kind === "filled") await this.settle(posted, result.makingE6, result.takingE6);
        else if (result.kind === "rejected") await this.fail(posted, result.reason, "posted");
        else if (result.kind === "delayed")
            await predictionOrders.updateOne(
                { _id: order._id, state: "posted" },
                { $set: { clobOrderId: result.orderId, postUnknownAt: null } },
            );
    }

    /** Books a fill: the shares go to the position and whatever the fill didn't use goes back. A repeat does nothing. */
    async settle(order: PredictionOrderDoc, makingE6: bigint, takingE6: bigint): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) throw new Error("The trader isn't ready");
        const meta = await trader.meta(order.tokenId);
        if (order.side === "sell") return this.#settleSell(order, makingE6, takingE6, meta);
        const spent = e6ToWei(costOfFill(makingE6, takingE6, meta));
        const { predictionOrders, accounts } = this.#deps.collections;

        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const now = new Date();
            // The stored order decides who is credited, whatever copy the caller holds
            const moved = await predictionOrders.findOneAndUpdate(
                { _id: order._id, state: "posted" },
                { $set: { state: "filled", filledShares: toDecimal(takingE6), updatedAt: now } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const held = fromDecimal(moved.amount);
            const cost = spent > held ? held : spent;
            const { position, linked } = await this.#bookBuyFill(session, moved, takingE6, cost, now);

            const refund = held - cost;
            const account =
                refund > 0n
                    ? await this.#deps.ledger.creditInSession(
                          session,
                          moved.accountId,
                          refund,
                          "prediction_refund",
                          order._id,
                      )
                    : await accounts.findOne({ _id: moved.accountId }, { session });
            if (!account || !linked) throw new Error("The order or its account vanished");
            const float = await this.#release(session, reservedOf(moved), weiToE6(cost));
            return { order: linked, position, account, float, cost };
        });
        if (!done) return;
        this.#deps.logger.info(
            { order: order._id.toHexString(), shares: formatE6(takingE6), cost: formatUsdc(done.cost) },
            "Prediction filled",
        );
        this.#afterSettle(done);
    }

    /** Adds a buy fill's shares and cost to the person's open position, creating it when there is none, and links the order to it. */
    async #bookBuyFill(
        session: ClientSession,
        moved: PredictionOrderDoc,
        takingE6: bigint,
        cost: bigint,
        now: Date,
    ): Promise<{ position: PositionDoc; linked: PredictionOrderDoc | null }> {
        const { predictionOrders, positions } = this.#deps.collections;
        const position = await positions.findOneAndUpdate(
            { accountId: moved.accountId, tokenId: moved.tokenId, state: { $in: ["open", "closing"] } },
            {
                $inc: { shares: toDecimal(takingE6), cost: toDecimal(cost) },
                $set: { updatedAt: now },
                $setOnInsert: {
                    _id: new ObjectId(),
                    eventId: moved.eventId,
                    marketId: moved.marketId,
                    conditionId: moved.conditionId,
                    question: moved.question,
                    outcome: moved.outcome,
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
            { _id: moved._id },
            { $set: { positionId: position._id, cost: toDecimal(cost) } },
            { session, returnDocument: "after" },
        );
        return { position, linked };
    }

    /** Books a sell fill: the proceeds, net of the fee, go to the balance and the position closes. A repeat does nothing. */
    async #settleSell(order: PredictionOrderDoc, makingE6: bigint, takingE6: bigint, meta: MarketMeta): Promise<void> {
        const proceeds = sellProceeds(makingE6, takingE6, meta);
        const { predictionOrders } = this.#deps.collections;

        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const now = new Date();
            const moved = await predictionOrders.findOneAndUpdate(
                { _id: order._id, state: "posted" },
                { $set: { state: "filled", filledShares: toDecimal(makingE6), updatedAt: now } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const booked = await this.#bookSellFill(session, moved, makingE6, proceeds, "closing", now);
            return { ...booked, float: null };
        });
        if (!done) return;
        this.#deps.logger.info(
            { order: order._id.toHexString(), shares: formatE6(makingE6), proceeds: formatUsdc(proceeds) },
            "Prediction sold",
        );
        this.#afterSettle(done);
    }

    /** Takes a sell fill's shares off the position it closes, which closes when only dust is left, and credits the proceeds. */
    async #bookSellFill(
        session: ClientSession,
        moved: PredictionOrderDoc,
        makingE6: bigint,
        proceeds: bigint,
        from: "closing" | "open",
        now: Date,
    ): Promise<{ order: PredictionOrderDoc; position: PositionDoc; account: AccountDoc }> {
        const { positions, predictionOrders, accounts } = this.#deps.collections;
        const closing = await positions.findOne(
            { _id: moved.positionId!, accountId: moved.accountId, state: from },
            { session },
        );
        if (!closing) throw new Error(`The position wasn't ${from}`);
        // Shares a buy added while the sell was out stay open; only dust under a step is left with the pool
        const left = fromDecimal(closing.shares) - makingE6;
        const keep = left >= SHARE_STEP_E6;
        const position = await positions.findOneAndUpdate(
            { _id: closing._id, state: from },
            {
                $set: keep
                    ? {
                          state: "open",
                          shares: toDecimal(left),
                          cost: toDecimal((fromDecimal(closing.cost) * left) / fromDecimal(closing.shares)),
                          updatedAt: now,
                      }
                    : { state: "closed", proceeds: toDecimal(proceeds), settledAt: now, updatedAt: now },
            },
            { session, returnDocument: "after" },
        );
        if (!position) throw new Error(`The position wasn't ${from}`);
        const order = keep
            ? await predictionOrders.findOneAndUpdate(
                  { _id: moved._id },
                  {
                      $set: {
                          soldPart: {
                              cost: toDecimal(fromDecimal(closing.cost) - fromDecimal(position.cost)),
                              proceeds: toDecimal(proceeds),
                              at: now,
                          },
                      },
                  },
                  { session, returnDocument: "after" },
              )
            : moved;
        if (!order) throw new Error("The order vanished");
        const account =
            proceeds > 0n
                ? await this.#deps.ledger.creditInSession(
                      session,
                      moved.accountId,
                      proceeds,
                      "prediction_sell",
                      moved._id,
                  )
                : await accounts.findOne({ _id: moved.accountId }, { session });
        if (!account) throw new Error("The account vanished");
        return { order, position, account };
    }

    /** Fails an order and gives back everything it held; a failed sell reopens its position, and `watchUntil` marks a refund the tracker keeps checking for a late fill. A repeat, or an order that already moved on, does nothing. */
    async fail(
        order: PredictionOrderDoc,
        reason: PredictionFailure,
        from: "placing" | "posted",
        watchUntil?: Date,
    ): Promise<void> {
        const { predictionOrders, positions, accounts } = this.#deps.collections;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const moved = await predictionOrders.findOneAndUpdate(
                { _id: order._id, state: from },
                { $set: { state: "failed", reason, updatedAt: new Date(), ...(watchUntil && { watchUntil }) } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            if (moved.side === "sell") {
                const position = await positions.findOneAndUpdate(
                    { _id: moved.positionId!, accountId: moved.accountId, state: "closing" },
                    { $set: { state: "open", updatedAt: new Date() } },
                    { session, returnDocument: "after" },
                );
                const account = await accounts.findOne({ _id: moved.accountId }, { session });
                if (!account) throw new Error("The account vanished");
                return { order: moved, position, account, float: null };
            }
            const held = fromDecimal(moved.amount);
            const account = await this.#deps.ledger.creditInSession(
                session,
                moved.accountId,
                held,
                "prediction_refund",
                moved._id,
            );
            const float = await this.#release(session, reservedOf(moved), 0n);
            return { order: moved, position: null, account, float };
        });
        if (!done) return;
        this.#deps.logger.info({ order: order._id.toHexString(), reason }, "Prediction failed and refunded");
        this.#afterSettle(done);
    }

    /** Books a fill that landed after the order was refunded: takes the cost back from the person, or closes the reopened position. If neither can be done the order is orphaned and the pool keeps the shares. Exactly once. */
    async settleLate(order: PredictionOrderDoc, makingE6: bigint, takingE6: bigint): Promise<void> {
        const trader = this.#deps.trader();
        if (!trader) throw new Error("The trader isn't ready");
        const meta = await trader.meta(order.tokenId);
        const { predictionOrders, accounts } = this.#deps.collections;
        const refunded = {
            _id: order._id,
            state: "failed" as const,
            lateFill: { $exists: false },
        };

        let done;
        try {
            done = await this.#deps.ledger.runInTransaction(async (session) => {
                const now = new Date();
                const lateRefId = new ObjectId();
                const moved = await predictionOrders.findOneAndUpdate(
                    { ...refunded, watchUntil: { $gt: new Date(this.#now()) } },
                    {
                        $set: {
                            state: "filled",
                            reason: null,
                            lateFill: "settled",
                            lateRefId,
                            filledShares: toDecimal(order.side === "sell" ? makingE6 : takingE6),
                            updatedAt: now,
                        },
                    },
                    { session, returnDocument: "after" },
                );
                if (!moved) return null;
                if (moved.side === "sell") {
                    const open = await this.#deps.collections.positions.findOne(
                        { _id: moved.positionId!, accountId: moved.accountId, state: "open" },
                        { session },
                    );
                    if (!open || fromDecimal(open.shares) < makingE6) throw new Unbookable();
                    const proceeds = sellProceeds(makingE6, takingE6, meta);
                    const booked = await this.#bookSellFill(session, moved, makingE6, proceeds, "open", now);
                    return { ...booked, float: null };
                }
                const held = fromDecimal(moved.amount);
                const spent = e6ToWei(costOfFill(makingE6, takingE6, meta));
                const cost = spent > held ? held : spent;
                // The refund already gave the held amount back, so the cost is taken again, under its own ledger reference
                const account =
                    cost > 0n
                        ? await this.#deps.ledger.debitInSession(
                              session,
                              moved.accountId,
                              cost,
                              "prediction_buy",
                              lateRefId,
                          )
                        : await accounts.findOne({ _id: moved.accountId }, { session });
                if (!account) throw new Error("The account vanished");
                const { position, linked } = await this.#bookBuyFill(session, moved, takingE6, cost, now);
                if (!linked) throw new Error("The order vanished");
                return { order: linked, position, account, float: null };
            });
        } catch (error) {
            if (!(error instanceof Unbookable) && !(isAppError(error) && error.code === "insufficient_funds"))
                throw error;
            const orphaned = await predictionOrders.updateOne(refunded, {
                $set: { lateFill: "orphaned", updatedAt: new Date() },
            });
            if (orphaned.modifiedCount)
                this.#deps.logger.error(
                    { order: order._id.toHexString(), side: order.side },
                    "A refunded prediction filled late and can't be booked; the pool holds the shares",
                );
            return;
        }
        if (!done) return;
        this.#deps.logger.info({ order: order._id.toHexString() }, "A refunded prediction filled late and was booked");
        this.#afterSettle(done);
    }

    #afterSettle(update: {
        order: PredictionOrderDoc;
        position: PositionDoc | null;
        account: AccountDoc;
        float: PoolFloatDoc | null;
    }) {
        if (update.float) this.#remember(update.float);
        this.#deps.bus.emit("prediction:updated", {
            order: update.order,
            position: update.position,
            account: update.account,
        });
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
        if (this.#deps.config.PREDICTIONS_TRADING !== "on" || !trader || this.#stopped)
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

    /** Refuses an order the float obviously can't cover, before a transaction opens; the reservation is the real guard. */
    async #checkFloat(amountE6: bigint) {
        const { poolFloat } = this.#deps.collections;
        let doc = await poolFloat.findOne({ _id: FLOAT_ID });
        if (!doc || this.#stale(doc)) {
            await this.#readBalance();
            doc = await poolFloat.findOne({ _id: FLOAT_ID });
        }
        if (!doc || this.#stale(doc) || freeOf(doc) < amountE6) throw this.#short(doc);
    }

    /** Reads the balance once, giving up after a while; a failed read leaves the old figure to be judged stale. */
    async #readBalance() {
        const abort = new AbortController();
        const timer = sleep(FLOAT_READ_MS, undefined, { signal: abort.signal }).then(
            () => {
                throw new Error("The balance read timed out");
            },
            () => undefined,
        );
        try {
            await Promise.race([this.refreshFloat(), timer]);
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't read the pool's float");
        } finally {
            abort.abort();
        }
    }

    #stale(doc: PoolFloatDoc): boolean {
        return doc.balanceAt.getTime() < this.#now() - FLOAT_MAX_AGE_MS;
    }

    /** Takes the order's pUSD from the float inside the order's transaction; nothing is taken if it doesn't fit. */
    async #reserve(session: ClientSession, amountE6: bigint): Promise<PoolFloatDoc> {
        const now = this.#now();
        const amount = toDecimal(amountE6);
        const doc = await this.#deps.collections.poolFloat.findOneAndUpdate(
            {
                _id: FLOAT_ID,
                balanceAt: { $gte: new Date(now - FLOAT_MAX_AGE_MS) },
                $expr: {
                    $gte: [{ $subtract: [{ $subtract: ["$balanceE6", "$heldE6"] }, "$unreadFillsE6"] }, amount],
                },
            },
            { $inc: { heldE6: amount }, $set: { updatedAt: new Date(now) } },
            { session, returnDocument: "after" },
        );
        if (doc) return doc;
        throw this.#short(await this.#deps.collections.poolFloat.findOne({ _id: FLOAT_ID }, { session }));
    }

    /** Gives back a reservation and counts what the fill spent until a balance read shows it; an order that held nothing does nothing. */
    async #release(session: ClientSession, reservedE6: bigint, spentE6: bigint): Promise<PoolFloatDoc | null> {
        if (reservedE6 === 0n && spentE6 === 0n) return null;
        return this.#deps.collections.poolFloat.findOneAndUpdate(
            { _id: FLOAT_ID },
            {
                $inc: { heldE6: toDecimal(-reservedE6), unreadFillsE6: toDecimal(spentE6) },
                $set: { updatedAt: new Date(this.#now()) },
            },
            { session, returnDocument: "after" },
        );
    }

    #short(doc: PoolFloatDoc | null): AppError {
        const free = doc && !this.#stale(doc) ? freeOf(doc) : 0n;
        const usd = free <= 0n ? 0 : Number(free / 1_000_000n);
        return new AppError(
            "float_short",
            `Predictions are limited to ${formatUsdShort(usd)} right now. ${NOTHING_SPENT}`,
        );
    }
}

const freeOf = (doc: PoolFloatDoc): bigint =>
    fromDecimal(doc.balanceE6) - fromDecimal(doc.heldE6) - fromDecimal(doc.unreadFillsE6);

/** What a buy reserved; an order from before the float document held its whole amount. */
/** A late fill the person's balance or position can't take. */
class Unbookable extends Error {}

/** The net proceeds of a sell fill in wei; taking is the gross pUSD, and the fee comes off it. */
const sellProceeds = (makingE6: bigint, takingE6: bigint, meta: MarketMeta): bigint => {
    const fee = makingE6 > 0n ? feeE6(makingE6, Number(takingE6) / Number(makingE6), meta) : 0n;
    return e6ToWei(takingE6 > fee ? takingE6 - fee : 0n);
};

const reservedOf = (order: PredictionOrderDoc): bigint =>
    order.reservedE6 ? fromDecimal(order.reservedE6) : weiToE6(fromDecimal(order.amount));

const marketClosed = () => new AppError("market_closed", `This market just closed. ${NOTHING_SPENT}`);

const busy = () => new AppError("position_busy", "This position is already being sold.");
