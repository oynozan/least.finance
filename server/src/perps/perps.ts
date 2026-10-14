import { ObjectId, type ClientSession } from "mongodb";
import type { Logger } from "pino";
import { parseUnits } from "viem";
import type { Keyring } from "../accounts/keyring.ts";
import type { Config } from "../config.ts";
import {
    isDuplicateKey,
    type AccountDoc,
    type Collections,
    type PerpAccountDoc,
    type PerpFloatDoc,
    type PerpOrderDoc,
    type PerpOrderState,
    type PerpPositionDoc,
} from "../db/mongo.ts";
import { e6ToWei, formatE6, fromDecimal, toDecimal, weiToE6 } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { PerpOrderRequest, PerpQuoteRequest, PerpQuoteView, PerpsView } from "../protocol.ts";
import type { Level } from "../predictions/trader.ts";
import { formatUsdShort } from "../predictions/views.ts";
import { nextNonce, type HyperliquidClient } from "./client.ts";
import { ACTIVATION_E6, NOTHING_SPENT, PerpFloat } from "./float.ts";
import { leverageBound, limitPrice, liquidationPrice, meetsMinimum, sizeFor } from "./math.ts";
import type { PerpMarkets } from "./markets.ts";
import { perpOrderView, perpPositionView } from "./views.ts";

const DEFAULT_TAKER_RATE = 0.00045;
const FEE_READ_MS = 60_000;
/** Covers the PnL page's 30-day chart; the sidebar trims its closed rows to a week itself. */
const SETTLED_KEEP_MS = 35 * 24 * 3_600_000;
const AMOUNT = /^\d+(\.\d{1,6})?$/;
const IN_FLIGHT: PerpOrderState[] = ["placing", "funding", "posted", "sweeping"];

export const PERP_MESSAGES = {
    off: "Long and short aren't available right now.",
    silent: `Hyperliquid isn't answering. ${NOTHING_SPENT}`,
    priceMoved: `The price moved, so your position didn't open. ${NOTHING_SPENT}`,
    rejected: `This position couldn't be opened right now. ${NOTHING_SPENT}`,
    minCollateral: "Positions start at $10.",
    minPosition: "A position starts at $11. Raise the collateral or the leverage.",
};

type Outcome =
    { kind: "filled"; sizeCoin: string; avgPx: string; feeE6: string } | { kind: "rejected"; message: string };

type Deps = {
    collections: Collections;
    ledger: Ledger;
    markets: Pick<PerpMarkets, "byAsset">;
    client: HyperliquidClient;
    keyring: Pick<Keyring, "perpSignerAt" | "perpAddressAt">;
    bus: Bus;
    logger: Logger;
    config: Pick<
        Config,
        "PERPS_TRADING" | "PERPS_FLOAT_USD" | "PERPS_SLIPPAGE_BPS" | "PERPS_MAX_LEVERAGE" | "PERPS_FEE_BPS"
    >;
    /** The clock, for tests. */
    now?: () => number;
};

const clean = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);
const cloidOf = (id: ObjectId) => `0x${id.toHexString().padStart(32, "0")}`;
const reservedOf = (order: PerpOrderDoc) => BigInt(order.steps.reservedE6 as string);
const minE6 = (a: bigint, b: bigint) => (a < b ? a : b);
const px = (value: number, figures = 7) => String(Number(value.toPrecision(figures)));

const busy = (asset: string) => new AppError("position_busy", `You already hold a ${asset} position. Close it first.`);

/** The average price a market order of `size` pays walking `levels`, or null when the book is too thin. */
function walk(levels: Level[], size: number): number | null {
    let left = size;
    let cost = 0;
    for (const level of levels) {
        const take = Math.min(left, level.size);
        cost += take * level.price;
        left -= take;
        if (left <= 1e-12) return cost / size;
    }
    return null;
}

/** Opens positions on Hyperliquid from each person's own account, funded from the master float, and settles each order exactly once; the person's balance holds the money meanwhile. */
export class PerpService {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #float: PerpFloat;
    readonly #master: string;
    #taker: { rate: number; at: number } | null = null;
    /** Orders this process is still sending, so a tracker doesn't judge a post that hasn't answered yet. */
    readonly #submitting = new Set<string>();
    #stopped = false;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#master = deps.keyring.perpAddressAt(0);
        this.#float = new PerpFloat({
            collections: deps.collections,
            client: deps.client,
            master: this.#master,
            logger: deps.logger,
            config: deps.config,
            now: this.#now,
        });
    }

    start(): void {
        this.#float.start();
    }

    stop(): Promise<void> {
        return this.#float.stop();
    }

    /** Stops taking new orders, so a shutdown doesn't post one it can't follow. */
    stopOrders(): void {
        this.#stopped = true;
    }

    submitting(id: ObjectId): boolean {
        return this.#submitting.has(id.toHexString());
    }

    /** The largest order the float can cover now, in whole dollars; null while trading is off or the float is unread. */
    maxOrderUSD(): number | null {
        return this.#deps.config.PERPS_TRADING === "on" ? this.#float.maxOrderUSD() : null;
    }

    refreshFloat(): Promise<void> {
        return this.#float.refresh();
    }

    async #takerRate(): Promise<number> {
        if (!this.#taker || this.#now() - this.#taker.at > FEE_READ_MS) {
            try {
                const { takerRate } = await this.#deps.client.userFees(this.#master);
                this.#taker = { rate: takerRate, at: this.#now() };
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Couldn't read the Hyperliquid fee rate");
            }
        }
        return Math.max(this.#taker?.rate ?? DEFAULT_TAKER_RATE, DEFAULT_TAKER_RATE);
    }

    /** Checks an open request against the market, the minimums and the leverage bound, and sizes it. */
    async #prepare(req: PerpQuoteRequest) {
        const market = this.#deps.markets.byAsset(req.asset);
        if (!market) throw new AppError("unavailable", `${req.asset} isn't available right now.`);
        if (!AMOUNT.test(req.collateralUSD))
            throw new AppError("bad_request", "Invalid collateralUSD: an amount such as 10.50");
        const collateralUSD = Number(req.collateralUSD);
        const minimum = meetsMinimum(collateralUSD, req.leverage);
        if (minimum === "collateral") throw new AppError("below_minimum", PERP_MESSAGES.minCollateral);
        if (minimum === "position") throw new AppError("below_minimum", PERP_MESSAGES.minPosition);
        const bound = leverageBound({
            maxLeverage: market.maxLeverage,
            marginTables: market.marginTables,
            notionalUSD: collateralUSD * req.leverage,
            configMax: this.#deps.config.PERPS_MAX_LEVERAGE,
        });
        if (req.leverage > bound) throw new AppError("bad_request", `${req.asset} allows up to ${bound}x.`);
        const collateralE6 = parseUnits(req.collateralUSD, 6);
        const feeRate = await this.#takerRate();
        const sizing = sizeFor({
            collateralE6,
            leverage: req.leverage,
            feeRate,
            ourFeeRate: this.#deps.config.PERPS_FEE_BPS / 10_000,
            price: market.markPx,
            szDecimals: market.szDecimals,
        });
        if (!sizing) throw new AppError("below_minimum", PERP_MESSAGES.minPosition);
        return { market, collateralE6, sizing };
    }

    async quote(req: PerpQuoteRequest): Promise<PerpQuoteView> {
        const { market, sizing } = await this.#prepare(req);
        const book = await this.#deps.client.book(req.asset);
        const size = Number(sizing.sizeCoin);
        const long = req.side === "long";
        const cap = Number(
            limitPrice(market.markPx, req.side, "open", this.#deps.config.PERPS_SLIPPAGE_BPS, market.szDecimals),
        );
        const walked = walk(long ? book.asks : book.bids, size) ?? cap;
        const entry = long ? Math.min(walked, cap) : Math.max(walked, cap);
        const notionalUSD = Number(sizing.notionalE6) / 1e6;
        const liquidation = liquidationPrice({
            side: req.side,
            entry,
            sizeCoin: size,
            marginUSD: Number(sizing.marginE6) / 1e6,
            notionalUSD,
            maxLeverage: leverageBound({
                maxLeverage: market.maxLeverage,
                marginTables: market.marginTables,
                notionalUSD,
                configMax: Infinity,
            }),
        });
        return {
            entryPx: px(entry),
            sizeCoin: sizing.sizeCoin,
            notionalUSD: formatE6(sizing.notionalE6),
            takerFeeUSD: formatE6(sizing.entryFeeE6),
            ourFeeUSD: formatE6(sizing.ourFeeE6),
            liquidationPx: px(liquidation, 6),
            fundingPerHour: String(market.funding),
            marginUSD: formatE6(sizing.marginE6),
        };
    }

    async place(account: AccountDoc, req: PerpOrderRequest): Promise<{ order: PerpOrderDoc; account: AccountDoc }> {
        const { perpOrders, accounts } = this.#deps.collections;
        // A retry is the same order whatever the checks below would say now
        const known = await perpOrders.findOne({ accountId: account._id, requestId: req.requestId });
        if (known) return { order: known, account: (await accounts.findOne({ _id: account._id })) ?? account };
        if (this.#deps.config.PERPS_TRADING !== "on" || this.#stopped)
            throw new AppError("trading_off", PERP_MESSAGES.off);
        const { sizing, collateralE6 } = await this.#prepare(req);
        if (
            await this.#deps.collections.perpPositions.countDocuments(
                { accountId: account._id, asset: req.asset, active: true },
                { limit: 1 },
            )
        )
            throw busy(req.asset);
        const perp = await this.#perpAccount(account._id);
        const hold = collateralE6 + (perp.activatedAt === null ? ACTIVATION_E6 : 0n);
        await this.#float.check(hold);

        const now = new Date(this.#now());
        const _id = new ObjectId();
        const order: PerpOrderDoc = {
            _id,
            accountId: account._id,
            requestId: req.requestId,
            kind: "open",
            index: perp.index,
            asset: req.asset,
            side: req.side,
            leverage: req.leverage,
            collateral: toDecimal(e6ToWei(collateralE6)),
            notionalE6: toDecimal(sizing.notionalE6),
            sizeCoin: sizing.sizeCoin,
            cloid: cloidOf(_id),
            limitPx: "",
            state: "placing",
            steps: { reservedE6: hold.toString() },
            fill: null,
            credited: null,
            reason: null,
            createdAt: now,
            updatedAt: now,
        };
        const held = await this.#record(order, hold);
        if (!held.fresh)
            return { order: held.order, account: (await accounts.findOne({ _id: account._id })) ?? account };
        this.#float.remember(held.float);
        void this.#drive(order).catch((error: unknown) =>
            this.#deps.logger.error({ err: error, order: _id.toHexString() }, "Couldn't open a perp position"),
        );
        return { order, account: held.account };
    }

    /** The person's lowest-index Hyperliquid account, created with the next perp index when they have none. */
    async #perpAccount(accountId: ObjectId): Promise<PerpAccountDoc> {
        const { perpAccounts, counters } = this.#deps.collections;
        const lowest = () => perpAccounts.find({ accountId }).sort({ index: 1 }).limit(1).next();
        const existing = await lowest();
        if (existing) return existing;
        const counter = await counters.findOneAndUpdate(
            { _id: "perpIndex" },
            { $inc: { seq: 1 } },
            { upsert: true, returnDocument: "after" },
        );
        if (!counter) throw new Error("Couldn't allocate a perp index");
        await perpAccounts.insertOne({
            _id: new ObjectId(),
            accountId,
            index: counter.seq,
            address: this.#deps.keyring.perpAddressAt(counter.seq),
            activatedAt: null,
            createdAt: new Date(this.#now()),
        });
        // Two first orders at once each make a row; both go on with the lowest
        return (await lowest())!;
    }

    /** One transaction records the order, takes the balance and holds the float; a repeated request is the same order. */
    async #record(order: PerpOrderDoc, holdE6: bigint) {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const key = { accountId: order.accountId, requestId: order.requestId };
        try {
            return await this.#deps.ledger.runInTransaction(async (session) => {
                const known = await perpOrders.findOne(key, { session });
                if (known) return { order: known, fresh: false as const };
                const [positions, orders] = await Promise.all([
                    perpPositions.countDocuments(
                        { accountId: order.accountId, asset: order.asset, active: true },
                        { session, limit: 1 },
                    ),
                    perpOrders.countDocuments(
                        { accountId: order.accountId, asset: order.asset, kind: "open", state: { $in: IN_FLIGHT } },
                        { session, limit: 1 },
                    ),
                ]);
                if (positions + orders > 0) throw busy(order.asset);
                await perpOrders.insertOne(order, { session });
                const account = await this.#deps.ledger.debitInSession(
                    session,
                    order.accountId,
                    fromDecimal(order.collateral),
                    "perp_open",
                    order._id,
                );
                // The shared float document goes last, to hold its lock briefly
                const float = await this.#float.reserve(session, holdE6);
                return { order, fresh: true as const, account, float };
            });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            const known = await perpOrders.findOne(key);
            if (!known) throw error;
            return { order: known, fresh: false as const };
        }
    }

    /** Funds, prices and posts a held order; a failure before the post unwinds it, one after it leaves the order posted. */
    async #drive(order: PerpOrderDoc): Promise<void> {
        const id = order._id.toHexString();
        this.#submitting.add(id);
        try {
            let sent: "no" | "maybe" = "maybe";
            try {
                await this.#fund(order, () => (sent = "no"));
                await this.#post(order);
            } catch (error) {
                this.#deps.logger.warn({ err: error, order: id }, "Couldn't open a perp position, refunding");
                await this.#unwind(order, PERP_MESSAGES.silent, sent);
            }
        } finally {
            this.#submitting.delete(id);
        }
    }

    /** Moves the collateral from the master to the person's address, topping up an activation that came out of it. */
    async #fund(order: PerpOrderDoc, rejected: () => void): Promise<void> {
        const { perpOrders, perpAccounts } = this.#deps.collections;
        const master = this.#deps.keyring.perpSignerAt(0);
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const amount = weiToE6(fromDecimal(order.collateral));
        const nonce = nextNonce(master.address);
        const moved = await perpOrders.findOneAndUpdate(
            { _id: order._id, state: "placing" },
            { $set: { state: "funding", "steps.fundNonce": nonce, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (!moved) throw new Error("The order moved on");
        void this.#emit(moved);
        const sent = await this.#deps.client.usdSend(master, address, amount, nonce);
        if (sent.kind === "rejected") {
            rejected();
            throw new Error(`The transfer was refused: ${sent.message}`);
        }
        const state = await this.#deps.client.state(address);
        const short = amount - (state?.withdrawableE6 ?? 0n);
        if (short > 0n) {
            if (short > ACTIVATION_E6) throw new Error(`The account is short by ${short} after funding`);
            const topUp = nextNonce(master.address);
            await perpOrders.updateOne(
                { _id: order._id },
                { $set: { "steps.topUpNonce": topUp, "steps.topUpE6": short.toString() } },
            );
            const again = await this.#deps.client.usdSend(master, address, short, topUp);
            if (again.kind === "rejected") throw new Error(`The top-up was refused: ${again.message}`);
        }
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const at = new Date(this.#now());
            const funded = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: "funding" },
                { $set: { "steps.funded": true, updatedAt: at } },
                { session, returnDocument: "after" },
            );
            if (!funded) return null;
            await perpAccounts.updateOne(
                { index: order.index, activatedAt: null },
                { $set: { activatedAt: at } },
                { session },
            );
            return this.#releaseHold(session, funded, reservedOf(funded));
        });
        if (!done) throw new Error("The order moved on");
        this.#float.remember(done.float);
        void this.#float.refresh().catch(() => undefined);
    }

    /** Sets the leverage, saves the price, and posts the order; an answer that doesn't settle it leaves it posted for the tracker. */
    async #post(order: PerpOrderDoc): Promise<void> {
        const { perpOrders } = this.#deps.collections;
        const market = this.#deps.markets.byAsset(order.asset);
        if (!market) throw new Error(`${order.asset} is no longer offered`);
        const signer = this.#deps.keyring.perpSignerAt(order.index);
        const limitPx = limitPrice(
            market.markPx,
            order.side,
            "open",
            this.#deps.config.PERPS_SLIPPAGE_BPS,
            market.szDecimals,
        );
        await this.#deps.client.updateLeverage(signer, order.asset, order.leverage);
        const posted = await perpOrders.findOneAndUpdate(
            { _id: order._id, state: "funding" },
            {
                $set: {
                    state: "posted",
                    limitPx,
                    "steps.postedAt": new Date(this.#now()),
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!posted) return;
        void this.#emit(posted);

        const result = await this.#deps.client
            .order(signer, {
                asset: order.asset,
                isBuy: order.side === "long",
                px: limitPx,
                sz: order.sizeCoin,
                reduceOnly: false,
                cloid: order.cloid,
            })
            .catch((error: unknown) => {
                this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "The order post failed");
                return { kind: "unknown" } as const;
            });
        try {
            if (result.kind === "filled" && Number(result.totalSz) > 0) await this.#onFill(posted, result);
            else if (result.kind === "filled") await this.#onNoFill(posted, PERP_MESSAGES.priceMoved);
            else if (result.kind === "rejected") await this.#onNoFill(posted, rejectionMessage(result.message));
        } catch (error) {
            this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "Couldn't settle a posted order");
        }
    }

    /** Settles a posted order from Hyperliquid's own record of its cloid; a repeat, or an order that moved on, does nothing. */
    async settlePosted(order: PerpOrderDoc): Promise<void> {
        if (order.kind !== "open") return;
        const fresh = await this.#deps.collections.perpOrders.findOne({ _id: order._id });
        if (!fresh || fresh.state !== "posted") return;
        const status = await this.#deps.client.orderStatus(this.#deps.keyring.perpAddressAt(fresh.index), fresh.cloid);
        if (status.kind === "open") return;
        if (status.kind === "filled") return this.#onFill(fresh, status);
        const message =
            status.kind === "rejected"
                ? rejectionMessage(status.message)
                : status.kind === "missing"
                  ? PERP_MESSAGES.silent
                  : PERP_MESSAGES.priceMoved;
        await this.#onNoFill(fresh, message);
    }

    /** Sweeps the unused collateral back to the master and books the position at what really filled. */
    async #onFill(order: PerpOrderDoc, fill: { totalSz: string; avgPx: string }): Promise<void> {
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const sizeCoin = clean(fill.totalSz);
        const avgPx = clean(fill.avgPx);
        const feeE6 = await this.#feeOf(order, address, Number(sizeCoin) * Number(avgPx));
        const state = await this.#deps.client.state(address);
        const margin = state?.positions.find((p) => p.asset === order.asset)?.marginUsedE6 ?? 0n;
        const spare = weiToE6(fromDecimal(order.collateral)) - margin - feeE6;
        const sweep = minE6(state?.withdrawableE6 ?? 0n, spare > 0n ? spare : 0n);
        const moved = await this.#startSweep(
            order,
            ["posted"],
            { kind: "filled", sizeCoin, avgPx, feeE6: feeE6.toString() },
            sweep,
            sweep,
        );
        if (moved) await this.#finishSweep(moved);
    }

    /** Nothing filled: everything on the person's address goes back to the master, and what it received is credited. */
    async #onNoFill(order: PerpOrderDoc, message: string): Promise<void> {
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const state = await this.#deps.client.state(address);
        const sweep = minE6(state?.withdrawableE6 ?? 0n, weiToE6(fromDecimal(order.collateral)));
        const moved = await this.#startSweep(order, ["posted"], { kind: "rejected", message }, sweep, sweep);
        if (moved) await this.#finishSweep(moved);
    }

    /** The taker fee Hyperliquid charged for the order's fills, or the base rate's estimate when it can't be read. */
    async #feeOf(order: PerpOrderDoc, address: string, notionalUSD: number): Promise<bigint> {
        try {
            const fills = await this.#deps.client.fills(address, order.createdAt.getTime());
            const fee = fills.filter((f) => f.cloid === order.cloid).reduce((sum, f) => sum + f.feeE6, 0n);
            if (fee > 0n) return fee;
        } catch (error) {
            this.#deps.logger.warn({ err: error, order: order._id.toHexString() }, "Couldn't read the order's fills");
        }
        return BigInt(Math.ceil(notionalUSD * DEFAULT_TAKER_RATE * 1e6));
    }

    /** Refunds an order that never posted: whatever reached the person's address goes back to the master, then the whole collateral is credited. */
    async #unwind(order: PerpOrderDoc, message: string, sent: "no" | "maybe"): Promise<void> {
        const fresh = await this.#deps.collections.perpOrders.findOne({ _id: order._id });
        if (!fresh || (fresh.state !== "placing" && fresh.state !== "funding")) return;
        let sweep = 0n;
        if (sent === "maybe") {
            const state = await this.#deps.client.state(this.#deps.keyring.perpAddressAt(fresh.index));
            sweep = minE6(state?.withdrawableE6 ?? 0n, weiToE6(fromDecimal(fresh.collateral)));
        }
        const credit = fresh.steps.funded === true ? sweep : weiToE6(fromDecimal(fresh.collateral));
        const moved = await this.#startSweep(
            fresh,
            ["placing", "funding"],
            { kind: "rejected", message },
            sweep,
            credit,
        );
        if (moved) await this.#finishSweep(moved);
    }

    /** Stores what the sweep will move and credit, with its nonce, before anything is sent, so a restart repeats it exactly. */
    async #startSweep(
        order: PerpOrderDoc,
        from: PerpOrderState[],
        outcome: Outcome,
        sweepE6: bigint,
        creditE6: bigint,
    ): Promise<PerpOrderDoc | null> {
        const { perpOrders } = this.#deps.collections;
        const nonce = sweepE6 > 0n ? nextNonce(this.#deps.keyring.perpAddressAt(order.index)) : null;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const moved = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: { $in: from } },
                {
                    $set: {
                        state: "sweeping",
                        "steps.outcome": outcome,
                        "steps.sweepE6": sweepE6.toString(),
                        "steps.sweepNonce": nonce,
                        "steps.creditE6": creditE6.toString(),
                        updatedAt: new Date(this.#now()),
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            return this.#releaseHold(session, moved, 0n);
        });
        if (!done) return null;
        this.#float.remember(done.float);
        void this.#emit(done.order);
        return done.order;
    }

    /** Gives back an order's float hold once; an order that already released it does nothing. */
    async #releaseHold(session: ClientSession, order: PerpOrderDoc, spentE6: bigint) {
        const claimed = await this.#deps.collections.perpOrders.findOneAndUpdate(
            { _id: order._id, "steps.released": { $ne: true } },
            { $set: { "steps.released": true } },
            { session, returnDocument: "after" },
        );
        const float: PerpFloatDoc | null = claimed
            ? await this.#float.release(session, reservedOf(order), spentE6)
            : null;
        return { order: claimed ?? order, float };
    }

    /** Sends the stored sweep and, once the master has the money, credits it and settles the order. A repeat does nothing. */
    async #finishSweep(order: PerpOrderDoc): Promise<void> {
        const { perpOrders, perpPositions, accounts } = this.#deps.collections;
        const outcome = order.steps.outcome as Outcome;
        const sweepE6 = BigInt(order.steps.sweepE6 as string);
        const creditWei = e6ToWei(BigInt(order.steps.creditE6 as string));
        if (sweepE6 > 0n) {
            try {
                const sent = await this.#deps.client.usdSend(
                    this.#deps.keyring.perpSignerAt(order.index),
                    this.#master,
                    sweepE6,
                    order.steps.sweepNonce as number,
                );
                if (sent.kind === "rejected") throw new Error(sent.message);
            } catch (error) {
                this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "A sweep to the master failed");
                return;
            }
        }

        const collateral = fromDecimal(order.collateral);
        const positionId = new ObjectId();
        const partial = outcome.kind === "filled" && Number(outcome.sizeCoin) < Number(order.sizeCoin);
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const at = new Date(this.#now());
            const moved = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: "sweeping" },
                {
                    $set:
                        outcome.kind === "filled"
                            ? {
                                  state: "filled",
                                  fill: {
                                      sizeCoin: outcome.sizeCoin,
                                      avgPx: outcome.avgPx,
                                      feeE6: toDecimal(BigInt(outcome.feeE6)),
                                  },
                                  credited: toDecimal(creditWei),
                                  reason: partial ? partialMessage(order, outcome) : null,
                                  "steps.positionId": positionId.toHexString(),
                                  updatedAt: at,
                              }
                            : {
                                  state: "rejected",
                                  credited: toDecimal(creditWei),
                                  reason: outcome.message,
                                  updatedAt: at,
                              },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            let position: PerpPositionDoc | null = null;
            if (outcome.kind === "filled") {
                position = {
                    _id: positionId,
                    accountId: order.accountId,
                    index: order.index,
                    asset: order.asset,
                    side: order.side,
                    leverage: order.leverage,
                    sizeCoin: outcome.sizeCoin,
                    entryPx: outcome.avgPx,
                    collateral: toDecimal(collateral - creditWei),
                    openedFee: toDecimal(BigInt(outcome.feeE6)),
                    state: "open",
                    active: true,
                    proceeds: null,
                    realizedPnl: null,
                    closeReason: null,
                    openedAt: at,
                    settledAt: null,
                    updatedAt: at,
                };
                await perpPositions.insertOne(position, { session });
            }
            const account =
                creditWei > 0n
                    ? await this.#deps.ledger.creditInSession(
                          session,
                          order.accountId,
                          creditWei,
                          "perp_refund",
                          order._id,
                      )
                    : await accounts.findOne({ _id: order.accountId }, { session });
            if (!account) throw new Error("The account vanished");
            const released = await this.#releaseHold(session, moved, 0n);
            return { order: released.order, position, account, float: released.float };
        });
        if (!done) return;
        this.#float.remember(done.float);
        this.#deps.logger.info({ order: order._id.toHexString(), state: done.order.state }, "Perp order settled");
        this.#deps.bus.emit("perp:updated", { order: done.order, position: done.position, account: done.account });
        void this.#float
            .refresh()
            .catch((error: unknown) => this.#deps.logger.warn({ err: error }, "Couldn't read the Hyperliquid float"));
    }

    async #emit(order: PerpOrderDoc): Promise<void> {
        try {
            const account = await this.#deps.collections.accounts.findOne({ _id: order.accountId });
            if (account) this.#deps.bus.emit("perp:updated", { order, position: null, account });
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't announce a perp order");
        }
    }

    /** Picks up every open order a restart interrupted; one that can't be judged now stays for the next start or the tracker. */
    async recover(): Promise<void> {
        const stuck = await this.#deps.collections.perpOrders
            .find({ kind: "open", state: { $in: IN_FLIGHT } })
            .sort({ _id: 1 })
            .toArray();
        for (const order of stuck) {
            try {
                if (order.state === "placing") await this.#unwind(order, PERP_MESSAGES.silent, "no");
                else if (order.state === "funding") await this.#unwind(order, PERP_MESSAGES.silent, "maybe");
                else if (order.state === "posted") await this.settlePosted(order);
                else await this.#finishSweep(order);
            } catch (error) {
                this.#deps.logger.error(
                    { err: error, order: order._id.toHexString() },
                    "Couldn't recover a perp order",
                );
            }
        }
    }

    async positions(account: AccountDoc): Promise<PerpsView> {
        const { perpPositions, perpOrders } = this.#deps.collections;
        const since = new Date(this.#now() - SETTLED_KEEP_MS);
        const [positions, orders] = await Promise.all([
            perpPositions
                .find({ accountId: account._id, $or: [{ active: true }, { settledAt: { $gte: since } }] })
                .sort({ _id: -1 })
                .toArray(),
            perpOrders
                .find({ accountId: account._id, state: { $in: IN_FLIGHT } })
                .sort({ _id: -1 })
                .toArray(),
        ]);
        return { positions: positions.map(perpPositionView), orders: orders.map(perpOrderView) };
    }
}

const rejectionMessage = (message: string) =>
    /immediately match/i.test(message) ? PERP_MESSAGES.priceMoved : PERP_MESSAGES.rejected;

const partialMessage = (order: PerpOrderDoc, outcome: Extract<Outcome, { kind: "filled" }>) =>
    `Opened ${formatUsdShort(Number(outcome.sizeCoin) * Number(outcome.avgPx))} of your ${formatUsdShort(Number(fromDecimal(order.notionalE6)) / 1e6)}. The rest is back in your balance.`;
