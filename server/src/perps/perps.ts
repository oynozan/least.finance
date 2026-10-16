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
import type { PerpCloseRequest, PerpOrderRequest, PerpQuoteRequest, PerpQuoteView, PerpsView } from "../protocol.ts";
import { formatUsdShort } from "../predictions/views.ts";
import { nextNonce, type AccountState, type Fill, type HyperliquidClient } from "./client.ts";
import { PERP_FEE_E6, PERP_FEE_USD } from "./fee.ts";
import { ACTIVATION_E6, NOTHING_SPENT, PerpFloat } from "./float.ts";
import {
    CLOSE_MIN_SLIPPAGE_BPS,
    OPEN_MIN_SLIPPAGE_BPS,
    dynamicLimit,
    leverageBound,
    liquidationPrice,
    meetsMinimum,
    minOrderE6,
    sizeFor,
} from "./math.ts";
import type { PerpMarkets } from "./markets.ts";
import { perpOrderView, perpPositionView } from "./views.ts";

const DEFAULT_TAKER_RATE = 0.00045;
const FEE_READ_MS = 60_000;
/** Covers the PnL page's 30-day chart; the sidebar trims its closed rows to a week itself. */
const SETTLED_KEEP_MS = 35 * 24 * 3_600_000;
const AMOUNT = /^\d+(\.\d{1,6})?$/;
const IN_FLIGHT: PerpOrderState[] = ["placing", "funding", "posted", "sweeping"];
const CLOSING: PerpOrderState[] = ["placing", "posted", "sweeping"];
const SIZE_EPSILON = 1e-9;
const WEI_PER_E6 = 1_000_000_000_000n;
/** How long Hyperliquid honours a posted order, and how much longer a missing one is given to show up. */
const ORDER_LIFE_MS = 30_000;
const MISSING_GRACE_MS = 5_000;
/** How long an unanswered funding send may still land, so a refused re-send isn't final before it. */
const FUNDING_LAND_MS = 60_000;
/** The least time between two reads that both show a position gone: the fastest poll. */
const GONE_AGAIN_MS = 5_000;
/** A transfer nonce older than this may be past Hyperliquid's acceptance window. */
const NONCE_LIFE_MS = 24 * 3_600_000;

export const PERP_MESSAGES = {
    off: "Long and short aren't available right now.",
    silent: `Hyperliquid isn't answering. ${NOTHING_SPENT}`,
    priceMoved: `The price moved, so your position didn't open. ${NOTHING_SPENT}`,
    rejected: `This position couldn't be opened right now. ${NOTHING_SPENT}`,
    minCollateral: "Positions start at $10.",
    minPosition: "A position starts at $11. Raise the collateral or the leverage.",
    thin: "This market is too thin for a position this size right now. Try a smaller amount.",
    closeFailed: "Couldn't close right now. Your position is still open.",
    tooSmall: "Too small to close right now.",
};

type Outcome =
    { kind: "filled"; sizeCoin: string; avgPx: string; feeE6: string } | { kind: "rejected"; message: string };

type CloseOutcome =
    { kind: "closed"; sizeCoin: string; avgPx: string; feeE6: string } | { kind: "outside"; liquidation: boolean };

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
        | "PERPS_TRADING"
        | "PERPS_FLOAT_USD"
        | "PERPS_OPEN_MAX_SLIPPAGE_BPS"
        | "PERPS_CLOSE_MAX_SLIPPAGE_BPS"
        | "PERPS_MAX_LEVERAGE"
    >;
    /** The clock, for tests. */
    now?: () => number;
};

const clean = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);
const cloidOf = (id: ObjectId) => `0x${id.toHexString().padStart(32, "0")}`;
const reservedOf = (order: PerpOrderDoc) => BigInt(order.steps.reservedE6 as string);
/** The fee stored on an open order when it was placed; an order from before the fee was stored owes none. */
const feeOf = (order: PerpOrderDoc) => BigInt((order.steps.feeE6 as string | undefined) ?? "0");
const minE6 = (a: bigint, b: bigint) => (a < b ? a : b);
const px = (value: number, figures = 7) => String(Number(value.toPrecision(figures)));

/** When Hyperliquid stops accepting a posted order; an order posted before the expiry was stored gets the same span. */
const expiryOf = (order: PerpOrderDoc) =>
    (
        (order.steps.expiresAt as Date | undefined) ??
        new Date(((order.steps.postedAt as Date | undefined) ?? order.createdAt).getTime() + ORDER_LIFE_MS)
    ).getTime();

const retainedOf = (account: PerpAccountDoc | null) => (account?.retainedE6 ? fromDecimal(account.retainedE6) : 0n);

const busy = (asset: string) => new AppError("position_busy", `You already hold a ${asset} position. Close it first.`);

/** Opens positions on Hyperliquid from each person's own account, funded from the master float, and settles each order exactly once; the person's balance holds the money meanwhile. */
export class PerpService {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #float: PerpFloat;
    readonly #master: string;
    #taker: { rate: number; at: number } | null = null;
    /** Orders this process is still sending, so a tracker doesn't judge a post that hasn't answered yet. */
    readonly #submitting = new Set<string>();
    /** The tail of each perp index's queue of holders. */
    readonly #locks = new Map<number, Promise<void>>();
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

    /** Runs `fn` alone among everything that reads an address and then moves its money; a hung call still ends at its timeout. */
    async withIndexLock<T>(index: number, fn: () => Promise<T>): Promise<T> {
        const before = this.#locks.get(index) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((resolve) => (release = resolve));
        const tail = before.then(() => mine);
        this.#locks.set(index, tail);
        await before;
        try {
            return await fn();
        } finally {
            release();
            if (this.#locks.get(index) === tail) this.#locks.delete(index);
        }
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
        const minimum = meetsMinimum(collateralUSD, req.leverage, PERP_FEE_USD);
        if (minimum === "collateral") throw new AppError("below_minimum", PERP_MESSAGES.minCollateral);
        if (minimum === "position") throw new AppError("below_minimum", PERP_MESSAGES.minPosition);
        const bound = leverageBound({
            maxLeverage: market.maxLeverage,
            marginTables: market.marginTables,
            notionalUSD: (collateralUSD - PERP_FEE_USD) * req.leverage,
            configMax: this.#deps.config.PERPS_MAX_LEVERAGE,
        });
        if (req.leverage > bound) throw new AppError("bad_request", `${req.asset} allows up to ${bound}x.`);
        const collateralE6 = parseUnits(req.collateralUSD, 6);
        const feeRate = await this.#takerRate();
        const sizing = sizeFor({
            collateralE6,
            leverage: req.leverage,
            feeRate,
            ourFeeE6: PERP_FEE_E6,
            price: market.markPx,
            szDecimals: market.szDecimals,
        });
        // The position check passed, so only the coin's size step can leave it short of Hyperliquid's order minimum
        if (!sizing || sizing.notionalE6 < minOrderE6(this.#deps.config.PERPS_OPEN_MAX_SLIPPAGE_BPS))
            throw new AppError("below_minimum", stepMessage(req.asset, market));
        return { market, collateralE6, sizing };
    }

    /** What an open of this size would pay on the book as it is now; refused when the visible book can't fill it within the cap, before anything is recorded or funded. */
    async #checkBook(
        req: PerpQuoteRequest,
        sizing: { sizeCoin: string },
        market: { markPx: number; szDecimals: number },
    ) {
        const book = await this.#deps.client.book(req.asset).catch((error: unknown) => {
            this.#deps.logger.warn({ err: error, asset: req.asset }, "Couldn't read a Hyperliquid book");
            throw new AppError("unavailable", PERP_MESSAGES.silent);
        });
        const limit = dynamicLimit({
            ...book,
            mark: market.markPx,
            side: req.side,
            action: "open",
            sizeCoin: sizing.sizeCoin,
            szDecimals: market.szDecimals,
            minBps: OPEN_MIN_SLIPPAGE_BPS,
            maxBps: this.#deps.config.PERPS_OPEN_MAX_SLIPPAGE_BPS,
        });
        if (!limit.fillable || limit.avgPx === null) throw new AppError("unavailable", PERP_MESSAGES.thin);
        return limit.avgPx;
    }

    async quote(req: PerpQuoteRequest): Promise<PerpQuoteView> {
        const { market, sizing } = await this.#prepare(req);
        const entry = await this.#checkBook(req, sizing, market);
        const size = Number(sizing.sizeCoin);
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
        const { market, sizing, collateralE6 } = await this.#prepare(req);
        await this.#checkBook(req, sizing, market);
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
            steps: { reservedE6: hold.toString(), feeE6: PERP_FEE_E6.toString() },
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
            {
                $set: {
                    state: "funding",
                    "steps.fundNonce": nonce,
                    "steps.sentAt": new Date(this.#now()),
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!moved) throw new Error("The order moved on");
        void this.#emit(moved);
        const sent = await this.#deps.client.usdSend(master, address, amount, nonce);
        if (sent.kind === "rejected") {
            rejected();
            throw new Error(`The transfer was refused: ${sent.message}`);
        }
        await perpOrders.updateOne({ _id: order._id, state: "funding" }, { $set: { "steps.funded": true } });
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
        await this.#deps.client.updateLeverage(signer, order.asset, order.leverage);
        // A book that has thinned since the person's review is posted at the widest limit, and fills as much as it can
        const book = await this.#deps.client.book(order.asset).catch((error: unknown) => {
            this.#deps.logger.warn({ err: error, asset: order.asset }, "Couldn't read a Hyperliquid book to open");
            return { bids: [], asks: [] };
        });
        const { limitPx } = dynamicLimit({
            ...book,
            mark: market.markPx,
            side: order.side,
            action: "open",
            sizeCoin: order.sizeCoin,
            szDecimals: market.szDecimals,
            minBps: OPEN_MIN_SLIPPAGE_BPS,
            maxBps: this.#deps.config.PERPS_OPEN_MAX_SLIPPAGE_BPS,
        });
        const postedAt = new Date(this.#now());
        const expiresAt = new Date(postedAt.getTime() + ORDER_LIFE_MS);
        const posted = await perpOrders.findOneAndUpdate(
            { _id: order._id, state: "funding" },
            {
                $set: {
                    state: "posted",
                    limitPx,
                    "steps.postedAt": postedAt,
                    "steps.expiresAt": expiresAt,
                    updatedAt: postedAt,
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
                expiresAfter: expiresAt.getTime(),
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
        if (status.kind === "missing") {
            // A lookup that finds nothing is final only once the order can no longer be accepted
            if (this.#now() < expiryOf(fresh) + MISSING_GRACE_MS) return;
            const found = await this.#filledBy(fresh);
            if (found) return this.#onFill(fresh, found);
        }
        const message =
            status.kind === "rejected"
                ? rejectionMessage(status.message)
                : status.kind === "missing"
                  ? PERP_MESSAGES.silent
                  : PERP_MESSAGES.priceMoved;
        await this.#onNoFill(fresh, message);
    }

    /** What an order's fills add up to, from Hyperliquid's record by cloid; null when none filled. */
    async #filledBy(order: PerpOrderDoc): Promise<{ totalSz: string; avgPx: string } | null> {
        const fills = (
            await this.#deps.client.fills(this.#deps.keyring.perpAddressAt(order.index), order.createdAt.getTime())
        ).filter((f) => f.cloid === order.cloid);
        const size = fills.reduce((sum, f) => sum + Number(f.sizeCoin), 0);
        if (size <= 0) return null;
        const cost = fills.reduce((sum, f) => sum + Number(f.sizeCoin) * Number(f.px), 0);
        return { totalSz: clean(size.toFixed(8)), avgPx: clean((cost / size).toFixed(8)) };
    }

    /** Sweeps the unused collateral and our fee to the master and books the position at what really filled; the person is credited the unused collateral, and a short address pays them first. */
    #onFill(order: PerpOrderDoc, fill: { totalSz: string; avgPx: string }): Promise<void> {
        return this.withIndexLock(order.index, () => this.#sweepFill(order, fill));
    }

    async #sweepFill(order: PerpOrderDoc, fill: { totalSz: string; avgPx: string }): Promise<void> {
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const sizeCoin = clean(fill.totalSz);
        const avgPx = clean(fill.avgPx);
        const feeE6 = await this.#feeOf(order, address, Number(sizeCoin) * Number(avgPx));
        const state = await this.#deps.client.state(address);
        const margin = state?.positions.find((p) => p.asset === order.asset)?.marginUsedE6 ?? 0n;
        const ourFeeE6 = feeOf(order);
        const spare = weiToE6(fromDecimal(order.collateral)) - margin - feeE6 - ourFeeE6;
        const credit = minE6(state?.withdrawableE6 ?? 0n, spare > 0n ? spare : 0n);
        const sweep = minE6(state?.withdrawableE6 ?? 0n, credit + ourFeeE6);
        const moved = await this.#startSweep(
            order,
            ["posted"],
            { kind: "filled", sizeCoin, avgPx, feeE6: feeE6.toString() },
            sweep,
            credit,
            ourFeeE6,
        );
        if (moved) await this.#finishSweep(moved);
    }

    /** Nothing filled: everything on the person's address goes back to the master, and what it received is credited. */
    #onNoFill(order: PerpOrderDoc, message: string): Promise<void> {
        return this.withIndexLock(order.index, () => this.#sweepNoFill(order, message));
    }

    async #sweepNoFill(order: PerpOrderDoc, message: string): Promise<void> {
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

    /** Refunds an order that never posted: the funding transfer is made certain first, then what it moved is swept back and credited; an order whose transfer can't be judged now stays for the tracker. */
    async #unwind(order: PerpOrderDoc, message: string, sent: "no" | "maybe"): Promise<void> {
        await this.withIndexLock(order.index, async () => {
            const { perpOrders, perpAccounts } = this.#deps.collections;
            const fresh = await perpOrders.findOne({ _id: order._id });
            if (!fresh || (fresh.state !== "placing" && fresh.state !== "funding")) return;
            const collateral = weiToE6(fromDecimal(fresh.collateral));
            const outcome = { kind: "rejected", message } as const;
            const from: PerpOrderState[] = ["placing", "funding"];
            const refund = async () => {
                const moved = await this.#startSweep(fresh, from, outcome, 0n, collateral);
                if (moved) await this.#finishSweep(moved);
            };
            if (fresh.state === "placing" || sent === "no") return refund();
            if (fresh.steps.funded !== true) {
                const moved = await this.#fundingMoved(fresh, collateral);
                if (moved === null) return;
                if (!moved) return refund();
                await perpOrders.updateOne({ _id: fresh._id, state: "funding" }, { $set: { "steps.funded": true } });
            }
            const state = await this.#deps.client.state(this.#deps.keyring.perpAddressAt(fresh.index));
            const account = await perpAccounts.findOne({ index: fresh.index });
            const allowance = account?.activatedAt === null ? ACTIVATION_E6 : 0n;
            const have = state?.withdrawableE6 ?? 0n;
            if (have < collateral - allowance) {
                this.#deps.logger.warn({ order: fresh._id.toHexString() }, "A funded order isn't on its address yet");
                return;
            }
            // The funding landed, so the address is activated; the platform absorbs that fee and credits the whole collateral
            const sweep = minE6(have, collateral);
            const moved = await this.#startSweep(fresh, from, outcome, sweep, collateral, 0n, true);
            if (moved) await this.#finishSweep(moved);
        });
    }

    /** Whether the funding transfer reached the person's address: true or false when known, null when the send itself can't be judged now. */
    async #fundingMoved(order: PerpOrderDoc, collateral: bigint): Promise<boolean | null> {
        const master = this.#deps.keyring.perpSignerAt(0);
        const address = this.#deps.keyring.perpAddressAt(order.index);
        try {
            const sent = await this.#deps.client.usdSend(master, address, collateral, order.steps.fundNonce as number);
            if (sent.kind === "ok") return true;
            const sentAt = order.steps.sentAt as Date;
            if (await this.#landed(master.address, address, collateral, sentAt)) return true;
            if (sent.kind === "duplicate") return false;
            return this.#now() - sentAt.getTime() < FUNDING_LAND_MS ? null : false;
        } catch (error) {
            this.#deps.logger.warn(
                { err: error, order: order._id.toHexString() },
                "Couldn't settle a funding transfer",
            );
            return null;
        }
    }

    /** Whether the ledger shows `from` sending `amountE6` to `to` at or after `since`. */
    async #landed(from: string, to: string, amountE6: bigint, since: Date): Promise<boolean> {
        const sent = await this.#deps.client.transfers(from, since.getTime());
        return sent.some(
            (t) =>
                t.from === from.toLowerCase() &&
                t.to === to.toLowerCase() &&
                t.amountE6 === amountE6 &&
                t.time >= since.getTime(),
        );
    }

    /** Stores what the sweep will move and credit, with its nonce, before anything is sent, so a restart repeats it exactly; `activates` also marks the address activated. */
    async #startSweep(
        order: PerpOrderDoc,
        from: PerpOrderState[],
        outcome: Outcome,
        sweepE6: bigint,
        creditE6: bigint,
        ourFeeE6 = 0n,
        activates = false,
    ): Promise<PerpOrderDoc | null> {
        const { perpOrders, perpAccounts } = this.#deps.collections;
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
                        "steps.sweepAt": new Date(this.#now()),
                        "steps.creditE6": creditE6.toString(),
                        "steps.ourFeeE6": ourFeeE6.toString(),
                        updatedAt: new Date(this.#now()),
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            if (activates)
                await perpAccounts.updateOne(
                    { index: order.index, activatedAt: null },
                    { $set: { activatedAt: new Date(this.#now()) } },
                    { session },
                );
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

    /** Sends an order's stored sweep and returns the order once the master has the money; a refused sweep is re-planned and sent once more, and one that can't be judged now returns null. */
    async #pay(order: PerpOrderDoc, replanned = false): Promise<PerpOrderDoc | null> {
        const sweepE6 = BigInt(order.steps.sweepE6 as string);
        if (sweepE6 <= 0n) return order;
        const signer = this.#deps.keyring.perpSignerAt(order.index);
        const nonce = order.steps.sweepNonce as number;
        const since = (order.steps.sweepAt as Date | undefined) ?? order.createdAt;
        try {
            let landed: boolean;
            if (this.#now() - nonce > NONCE_LIFE_MS)
                landed = await this.#landed(signer.address, this.#master, sweepE6, since);
            else {
                const sent = await this.#deps.client.usdSend(signer, this.#master, sweepE6, nonce);
                // A repeat of a send that landed is answered duplicate or plainly refused, so any other answer is checked on the ledger
                landed = sent.kind === "ok" || (await this.#landed(signer.address, this.#master, sweepE6, since));
            }
            if (landed) return order;
            // A re-planned sweep is sent once now; if it is refused too, the tracker plans it again
            if (replanned) return null;
            const next = await this.#replan(order);
            return next ? await this.#pay(next, true) : null;
        } catch (error) {
            this.#deps.logger.error({ err: error, order: order._id.toHexString() }, "A sweep to the master failed");
            return null;
        }
    }

    /** Re-reads the address after a sweep that did not land and stores what it can pay now with a fresh nonce; what was owed to other orders stays. */
    async #replan(order: PerpOrderDoc): Promise<PerpOrderDoc | null> {
        const { perpOrders, perpAccounts } = this.#deps.collections;
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const [state, account, others] = await Promise.all([
            this.#deps.client.state(address),
            perpAccounts.findOne({ index: order.index }),
            perpOrders
                .find({
                    index: order.index,
                    _id: { $ne: order._id },
                    state: { $in: ["funding", "posted", "sweeping"] },
                })
                .toArray(),
        ]);
        const owed = others.reduce((sum, o) => {
            if (o.state === "sweeping") return sum + BigInt(o.steps.sweepE6 as string);
            return o.kind === "open" ? sum + weiToE6(fromDecimal(o.collateral)) : sum;
        }, 0n);
        const free = (state?.withdrawableE6 ?? 0n) - retainedOf(account) - owed;
        const stored = BigInt(order.steps.sweepE6 as string);
        const amount = free > 0n ? minE6(stored, free) : 0n;
        const next = await perpOrders.findOneAndUpdate(
            { _id: order._id, state: "sweeping", "steps.sweepNonce": order.steps.sweepNonce },
            {
                $set: {
                    "steps.sweepE6": amount.toString(),
                    "steps.sweepNonce": amount > 0n ? nextNonce(address) : null,
                    "steps.sweepAt": new Date(this.#now()),
                    // The person is credited first, as in the first plan: our fee rides in the sweep and takes what is left
                    ...(order.kind === "open"
                        ? { "steps.creditE6": minE6(BigInt(order.steps.creditE6 as string), amount).toString() }
                        : {}),
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        this.#deps.logger.error(
            { order: order._id.toHexString(), plannedE6: stored.toString(), nowE6: amount.toString() },
            "A sweep to the master was refused and is re-planned",
        );
        return next;
    }

    /** Sends the stored sweep and, once the master has the money, credits it and settles the order. A repeat does nothing. */
    async #finishSweep(stored: PerpOrderDoc): Promise<void> {
        const { perpOrders, perpPositions, accounts } = this.#deps.collections;
        const order = await this.#pay(stored);
        if (!order) return;
        const outcome = order.steps.outcome as Outcome;
        const creditWei = e6ToWei(BigInt(order.steps.creditE6 as string));

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
                    ourFee: toDecimal(BigInt((moved.steps.ourFeeE6 as string | undefined) ?? "0")),
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

    async #emit(order: PerpOrderDoc, position: PerpPositionDoc | null = null): Promise<void> {
        try {
            const account = await this.#deps.collections.accounts.findOne({ _id: order.accountId });
            if (account) this.#deps.bus.emit("perp:updated", { order, position, account });
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
                if (order.state === "placing" || order.state === "funding") await this.settleStuck(order);
                else if (order.state === "posted") await this.settlePosted(order);
                else await this.retrySweep(order);
            } catch (error) {
                this.#deps.logger.error(
                    { err: error, order: order._id.toHexString() },
                    "Couldn't recover a perp order",
                );
            }
        }
        const closing = await this.#deps.collections.perpOrders
            .find({ kind: "close", state: { $in: CLOSING } })
            .toArray();
        for (const order of closing) {
            await this.settleClose(order).catch((error: unknown) =>
                this.#deps.logger.error(
                    { err: error, order: order._id.toHexString() },
                    "Couldn't recover a perp close",
                ),
            );
        }
    }

    /** Settles an open order that never posted and that nothing in this process is still driving: it is refunded once its funding is certain. */
    async settleStuck(order: PerpOrderDoc): Promise<void> {
        if (order.kind !== "open" || this.submitting(order._id)) return;
        if (order.state === "placing") await this.#unwind(order, PERP_MESSAGES.silent, "no");
        else if (order.state === "funding") await this.#unwind(order, PERP_MESSAGES.silent, "maybe");
    }

    /** Finishes an open order's stored sweep; a repeat, or an order that moved on, does nothing. */
    async retrySweep(order: PerpOrderDoc): Promise<void> {
        await this.withIndexLock(order.index, async () => {
            const fresh = await this.#deps.collections.perpOrders.findOne({ _id: order._id });
            if (fresh?.kind === "open" && fresh.state === "sweeping") await this.#finishSweep(fresh);
        });
    }

    /** The last mark the market sync saw for an asset. */
    markOf(asset: string): number | null {
        return this.#deps.markets.byAsset(asset)?.markPx ?? null;
    }

    /** Closes a whole position with a reduce-only IOC; trading being off doesn't matter, and a repeat is the same close. */
    async close(account: AccountDoc, req: PerpCloseRequest): Promise<{ order: PerpOrderDoc }> {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const known = await perpOrders.findOne({ accountId: account._id, requestId: req.requestId });
        if (known) return { order: known };
        if (this.#stopped) throw new AppError("unavailable", PERP_MESSAGES.closeFailed);
        const position = await perpPositions.findOne({ _id: new ObjectId(req.positionId), accountId: account._id });
        if (!position) throw new AppError("not_found", "That position wasn't found.");
        const live = await this.#closeInFlight(position);
        if (live) return { order: live };
        if (position.state !== "open") throw new AppError("position_busy", "That position is already closed.");
        const market = this.#deps.markets.byAsset(position.asset);
        if (!market) throw new AppError("unavailable", PERP_MESSAGES.closeFailed);

        // A close is never refused for a thin book: it goes out at the widest limit and fills what it can
        const book = await this.#deps.client.book(position.asset).catch((error: unknown) => {
            this.#deps.logger.warn({ err: error, asset: position.asset }, "Couldn't read a Hyperliquid book to close");
            return { bids: [], asks: [] };
        });
        const { limitPx } = dynamicLimit({
            ...book,
            mark: market.markPx,
            side: position.side,
            action: "close",
            sizeCoin: position.sizeCoin,
            szDecimals: market.szDecimals,
            minBps: CLOSE_MIN_SLIPPAGE_BPS,
            maxBps: this.#deps.config.PERPS_CLOSE_MAX_SLIPPAGE_BPS,
        });

        const now = new Date(this.#now());
        const _id = new ObjectId();
        const order: PerpOrderDoc = {
            _id,
            accountId: account._id,
            requestId: req.requestId,
            kind: "close",
            index: position.index,
            asset: position.asset,
            side: position.side,
            leverage: position.leverage,
            collateral: position.collateral,
            notionalE6: toDecimal(BigInt(Math.round(Number(position.sizeCoin) * market.markPx * 1e6))),
            sizeCoin: position.sizeCoin,
            cloid: cloidOf(_id),
            limitPx,
            state: "placing",
            steps: { positionId: position._id.toHexString() },
            fill: null,
            credited: null,
            reason: null,
            createdAt: now,
            updatedAt: now,
        };
        try {
            const moved = await this.#deps.ledger.runInTransaction(async (session) => {
                const closing = await perpPositions.findOneAndUpdate(
                    { _id: position._id, state: "open" },
                    { $set: { state: "closing", closeReason: null, updatedAt: now } },
                    { session, returnDocument: "after" },
                );
                if (!closing) return null;
                await perpOrders.insertOne(order, { session });
                return closing;
            });
            if (!moved) {
                const other = await this.#closeInFlight(position);
                if (other) return { order: other };
                throw new AppError("position_busy", "That position is already closed.");
            }
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            const again = await perpOrders.findOne({ accountId: account._id, requestId: req.requestId });
            if (!again) throw error;
            return { order: again };
        }
        void this.#driveClose(order).catch((error: unknown) =>
            this.#deps.logger.error({ err: error, order: _id.toHexString() }, "Couldn't close a perp position"),
        );
        return { order };
    }

    /** The close of ours that is still moving for a position, if any. */
    #closeInFlight(position: PerpPositionDoc): Promise<PerpOrderDoc | null> {
        return this.#deps.collections.perpOrders.findOne({
            accountId: position.accountId,
            kind: "close",
            "steps.positionId": position._id.toHexString(),
            state: { $in: CLOSING },
        });
    }

    /** Posts the reduce-only order; an answer that doesn't settle it leaves the order posted for the tracker. */
    async #driveClose(order: PerpOrderDoc): Promise<void> {
        const id = order._id.toHexString();
        this.#submitting.add(id);
        try {
            const postedAt = new Date(this.#now());
            const expiresAt = new Date(postedAt.getTime() + ORDER_LIFE_MS);
            const posted = await this.#deps.collections.perpOrders.findOneAndUpdate(
                { _id: order._id, state: "placing" },
                {
                    $set: {
                        state: "posted",
                        "steps.postedAt": postedAt,
                        "steps.expiresAt": expiresAt,
                        updatedAt: postedAt,
                    },
                },
                { returnDocument: "after" },
            );
            if (!posted) return;
            void this.#emitClose(posted);
            const result = await this.#deps.client
                .order(this.#deps.keyring.perpSignerAt(order.index), {
                    asset: order.asset,
                    isBuy: order.side === "short",
                    px: order.limitPx,
                    sz: order.sizeCoin,
                    reduceOnly: true,
                    cloid: order.cloid,
                    expiresAfter: expiresAt.getTime(),
                })
                .catch((error: unknown) => {
                    this.#deps.logger.error({ err: error, order: id }, "The close post failed");
                    return { kind: "unknown" } as const;
                });
            try {
                if (result.kind === "filled" && Number(result.totalSz) > 0) await this.#onCloseFill(posted, result);
                else if (result.kind === "filled") await this.#onCloseRejected(posted, ["posted"], "no fill");
                else if (result.kind === "rejected") await this.#onCloseRejected(posted, ["posted"], result.message);
            } catch (error) {
                this.#deps.logger.error({ err: error, order: id }, "Couldn't settle a posted close");
            }
        } finally {
            this.#submitting.delete(id);
        }
    }

    /** Settles a close from where it stands: an unsent one is undone, a posted one is judged from Hyperliquid's record, a swept one finishes its sweep. */
    async settleClose(order: PerpOrderDoc): Promise<void> {
        const fresh = await this.#deps.collections.perpOrders.findOne({ _id: order._id });
        if (!fresh || fresh.kind !== "close") return;
        if (fresh.state === "sweeping") return this.withIndexLock(fresh.index, () => this.#finishCloseSweep(fresh));
        if (fresh.state === "placing") {
            if (!this.submitting(fresh._id)) await this.#onCloseRejected(fresh, ["placing"], "never sent");
            return;
        }
        if (fresh.state !== "posted") return;
        const address = this.#deps.keyring.perpAddressAt(fresh.index);
        const status = await this.#deps.client.orderStatus(address, fresh.cloid);
        if (status.kind === "open") return;
        if (status.kind === "filled") return this.#onCloseFill(fresh, status);
        if (status.kind === "missing" && this.#now() < expiryOf(fresh) + MISSING_GRACE_MS) return;
        const found = await this.#filledBy(fresh);
        if (found) return this.#onCloseFill(fresh, found);
        await this.#onCloseRejected(fresh, ["posted"], status.kind === "rejected" ? status.message : "no fill");
    }

    /** A close that filled: a partial one shrinks the position, a whole one sweeps the account back to the master first. */
    #onCloseFill(order: PerpOrderDoc, fill: { totalSz: string; avgPx: string }): Promise<void> {
        return this.withIndexLock(order.index, () => this.#settleCloseFill(order, fill));
    }

    async #settleCloseFill(order: PerpOrderDoc, fill: { totalSz: string; avgPx: string }): Promise<void> {
        const { perpPositions } = this.#deps.collections;
        const position = await perpPositions.findOne({ _id: new ObjectId(order.steps.positionId as string) });
        if (!position || position.state !== "closing") return;
        const address = this.#deps.keyring.perpAddressAt(order.index);
        const sizeCoin = clean(fill.totalSz);
        const avgPx = clean(fill.avgPx);
        const feeE6 = await this.#feeOf(order, address, Number(sizeCoin) * Number(avgPx));
        if (Number(sizeCoin) < Number(order.sizeCoin) - SIZE_EPSILON)
            return this.#closePartly(order, position, { sizeCoin, avgPx, feeE6 });
        // The free balance is only this position's while no other order is moving money on the address
        if (await this.#sharesAddress(order.index, order._id)) return;
        const state = await this.#deps.client.state(address);
        const sweep = await this.#sweepable(order.index, state);
        const moved = await this.#startCloseSweep(
            order,
            ["posted"],
            { kind: "closed", sizeCoin, avgPx, feeE6: feeE6.toString() },
            sweep,
        );
        if (moved) await this.#finishCloseSweep(moved);
    }

    async #closePartly(
        order: PerpOrderDoc,
        position: PerpPositionDoc,
        fill: { sizeCoin: string; avgPx: string; feeE6: bigint },
    ): Promise<void> {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const at = new Date(this.#now());
            const moved = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: "posted" },
                {
                    $set: {
                        state: "done",
                        fill: { sizeCoin: fill.sizeCoin, avgPx: fill.avgPx, feeE6: toDecimal(fill.feeE6) },
                        reason: `Closed part of your ${order.asset} position. Press Close again for the rest.`,
                        updatedAt: at,
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const left = clean((Number(order.sizeCoin) - Number(fill.sizeCoin)).toFixed(8));
            const reopened = await perpPositions.findOneAndUpdate(
                { _id: position._id },
                { $set: { state: "open", sizeCoin: left, closeReason: null, updatedAt: at } },
                { session, returnDocument: "after" },
            );
            return { order: moved, position: reopened };
        });
        if (done) void this.#emit(done.order, done.position);
    }

    /** Puts a position back to open after a close that didn't happen; a venue refusal for being too small is kept on the position. */
    async #onCloseRejected(order: PerpOrderDoc, from: PerpOrderState[], message: string): Promise<void> {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const tooSmall = /minimum value|too small/i.test(message);
        const reason = tooSmall ? PERP_MESSAGES.tooSmall : PERP_MESSAGES.closeFailed;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const at = new Date(this.#now());
            const moved = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: { $in: from } },
                { $set: { state: "rejected", reason, updatedAt: at } },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const reopened = await perpPositions.findOneAndUpdate(
                { _id: new ObjectId(order.steps.positionId as string), state: "closing" },
                { $set: { state: "open", closeReason: tooSmall ? reason : null, updatedAt: at } },
                { session, returnDocument: "after" },
            );
            return { order: moved, position: reopened };
        });
        if (!done) return;
        this.#deps.logger[tooSmall ? "error" : "warn"](
            { order: order._id.toHexString(), message },
            tooSmall ? "Hyperliquid refused to close a position as too small" : "A perp close didn't go through",
        );
        void this.#emit(done.order, done.position);
    }

    async #emitClose(order: PerpOrderDoc): Promise<void> {
        try {
            const position = await this.#deps.collections.perpPositions.findOne({
                _id: new ObjectId(order.steps.positionId as string),
            });
            await this.#emit(order, position);
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't announce a perp close");
        }
    }

    /** The free balance minus the fees of ours kept on the address; the rest is the person's. */
    async #sweepable(index: number, state: AccountState | null): Promise<bigint> {
        const account = await this.#deps.collections.perpAccounts.findOne({ index });
        const free = (state?.withdrawableE6 ?? 0n) - retainedOf(account);
        return free > 0n ? free : 0n;
    }

    /** Whether another order is moving money on this order's address, so its free balance isn't only ours to sweep. */
    async #sharesAddress(index: number, id: ObjectId): Promise<boolean> {
        return (
            (await this.#deps.collections.perpOrders.countDocuments(
                {
                    index,
                    _id: { $ne: id },
                    $or: [
                        { kind: "open", state: { $in: IN_FLIGHT } },
                        { kind: "close", state: { $in: ["posted", "sweeping"] }, _id: { $lt: id } },
                    ],
                },
                { limit: 1 },
            )) > 0
        );
    }

    /** Stores what the sweep will move and credit, with its nonce, before anything is sent, so a restart repeats it exactly. */
    async #startCloseSweep(
        order: PerpOrderDoc,
        from: PerpOrderState[],
        outcome: CloseOutcome,
        sweepE6: bigint,
    ): Promise<PerpOrderDoc | null> {
        const nonce = sweepE6 > 0n ? nextNonce(this.#deps.keyring.perpAddressAt(order.index)) : null;
        const moved = await this.#deps.collections.perpOrders.findOneAndUpdate(
            { _id: order._id, state: { $in: from } },
            {
                $set: {
                    state: "sweeping",
                    "steps.outcome": outcome,
                    "steps.sweepE6": sweepE6.toString(),
                    "steps.sweepNonce": nonce,
                    "steps.sweepAt": new Date(this.#now()),
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (moved) void this.#emitClose(moved);
        return moved;
    }

    /** Sends the stored sweep and, once the master has the money, credits it and settles the position. A repeat does nothing. */
    async #finishCloseSweep(stored: PerpOrderDoc): Promise<void> {
        const { perpOrders, perpPositions, accounts } = this.#deps.collections;
        const order = await this.#pay(stored);
        if (!order) return;
        const outcome = order.steps.outcome as CloseOutcome;
        const creditWei = e6ToWei(BigInt(order.steps.sweepE6 as string));
        const positionId = new ObjectId(order.steps.positionId as string);
        const liquidated = outcome.kind === "outside" && outcome.liquidation;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const at = new Date(this.#now());
            const moved = await perpOrders.findOneAndUpdate(
                { _id: order._id, state: "sweeping" },
                {
                    $set: {
                        state: "done",
                        credited: toDecimal(creditWei),
                        updatedAt: at,
                        ...(outcome.kind === "closed"
                            ? {
                                  fill: {
                                      sizeCoin: outcome.sizeCoin,
                                      avgPx: outcome.avgPx,
                                      feeE6: toDecimal(BigInt(outcome.feeE6)),
                                  },
                              }
                            : {
                                  reason: `Your ${order.asset} ${order.side} was ${liquidated ? "liquidated" : "closed"}.`,
                              }),
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const before = await perpPositions.findOne({ _id: positionId }, { session });
            if (!before) throw new Error("The position vanished");
            const position = await perpPositions.findOneAndUpdate(
                { _id: positionId, active: true },
                {
                    $set: {
                        state: liquidated ? "liquidated" : "closed",
                        active: false,
                        proceeds: toDecimal(creditWei),
                        realizedPnl: toDecimal((creditWei - fromDecimal(before.collateral)) / WEI_PER_E6),
                        closeReason: liquidated
                            ? "liquidated"
                            : outcome.kind === "outside"
                              ? "closed_outside"
                              : "closed",
                        settledAt: at,
                        updatedAt: at,
                    },
                },
                { session, returnDocument: "after" },
            );
            const account =
                creditWei > 0n
                    ? await this.#deps.ledger.creditInSession(
                          session,
                          order.accountId,
                          creditWei,
                          "perp_close",
                          order._id,
                      )
                    : await accounts.findOne({ _id: order.accountId }, { session });
            if (!account) throw new Error("The account vanished");
            return { order: moved, position, account };
        });
        if (!done) return;
        this.#deps.logger.info(
            { order: order._id.toHexString(), position: positionId.toHexString() },
            "Perp close settled",
        );
        this.#deps.bus.emit("perp:updated", done);
        void this.#float
            .refresh()
            .catch((error: unknown) => this.#deps.logger.warn({ err: error }, "Couldn't read the Hyperliquid float"));
    }

    /** Settles a position that is gone or smaller on Hyperliquid with no close of ours in flight, from the fills and the account state read for it. */
    settleOutside(position: PerpPositionDoc, fills: Fill[], state: AccountState | null): Promise<void> {
        return this.withIndexLock(position.index, () => this.#settleGone(position, fills, state));
    }

    async #settleGone(position: PerpPositionDoc, fills: Fill[], state: AccountState | null): Promise<void> {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const fresh = await perpPositions.findOne({ _id: position._id });
        if (!fresh || fresh.state !== "open" || !fresh.active) return;
        if (await this.#closeInFlight(fresh)) return;
        const mine = new Map(fills.filter((f) => f.asset === fresh.asset).map((f) => [f.tid, f]));
        const liquidation = [...mine.values()].some((f) => f.liquidation);
        const real = state?.positions.find((p) => p.asset === fresh.asset);
        if (real) {
            if (Number(real.sizeCoin) >= Number(fresh.sizeCoin) - SIZE_EPSILON) return;
            const shrunk = await perpPositions.findOneAndUpdate(
                { _id: fresh._id, state: "open" },
                { $set: { sizeCoin: clean(real.sizeCoin), updatedAt: new Date(this.#now()) } },
                { returnDocument: "after" },
            );
            this.#deps.logger.warn(
                { position: fresh._id.toHexString(), liquidation },
                "A position shrank outside the app",
            );
            const opened = await perpOrders.findOne({
                accountId: fresh.accountId,
                "steps.positionId": fresh._id.toHexString(),
            });
            if (shrunk && opened) void this.#emit(opened, shrunk);
            return;
        }
        const reducing = [...mine.values()].some(
            (f) => f.time >= fresh.openedAt.getTime() && (f.liquidation || /^(close|liquidated)/i.test(f.dir)),
        );
        if (!reducing) {
            // One empty read isn't proof: the ledger follows the fills, so a second read has to agree
            const since = fresh.missingSince?.getTime();
            if (since === undefined) {
                await perpPositions.updateOne(
                    { _id: fresh._id, state: "open" },
                    { $set: { missingSince: new Date(this.#now()) } },
                );
                this.#deps.logger.warn({ position: fresh._id.toHexString() }, "A position is missing on Hyperliquid");
                return;
            }
            if (this.#now() - since < GONE_AGAIN_MS) return;
        }
        const _id = new ObjectId();
        // A later id than any order, so every close still sweeping this address goes first
        if (await this.#sharesAddress(fresh.index, _id)) return;
        // Read again inside the lock: another settle may have swept since the tracker's read
        const current = await this.#deps.client.state(this.#deps.keyring.perpAddressAt(fresh.index));
        if (current?.positions.some((p) => p.asset === fresh.asset)) return;
        const sweep = await this.#sweepable(fresh.index, current);
        const at = new Date(this.#now());
        const order: PerpOrderDoc = {
            _id,
            accountId: fresh.accountId,
            requestId: `outside:${fresh._id.toHexString()}`,
            kind: "close",
            index: fresh.index,
            asset: fresh.asset,
            side: fresh.side,
            leverage: fresh.leverage,
            collateral: fresh.collateral,
            notionalE6: toDecimal(0n),
            sizeCoin: fresh.sizeCoin,
            cloid: cloidOf(_id),
            limitPx: "",
            state: "sweeping",
            steps: {
                positionId: fresh._id.toHexString(),
                outcome: { kind: "outside", liquidation } satisfies CloseOutcome,
                sweepE6: sweep.toString(),
                sweepNonce: sweep > 0n ? nextNonce(this.#deps.keyring.perpAddressAt(fresh.index)) : null,
                sweepAt: at,
            },
            fill: null,
            credited: null,
            reason: null,
            createdAt: at,
            updatedAt: at,
        };
        try {
            const claimed = await this.#deps.ledger.runInTransaction(async (session) => {
                const moved = await perpPositions.findOneAndUpdate(
                    { _id: fresh._id, state: "open" },
                    { $set: { state: "closing", updatedAt: at } },
                    { session },
                );
                if (!moved) return false;
                await perpOrders.insertOne(order, { session });
                return true;
            });
            if (claimed) await this.#finishCloseSweep(order);
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
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

/** What to tell someone whose amount can't make an order Hyperliquid accepts because the coin only trades in coarse steps. */
const stepMessage = (asset: string, market: { szDecimals: number; markPx: number }) => {
    const step = 10 ** -market.szDecimals;
    return `${asset} trades in steps of ${step.toFixed(market.szDecimals)} (about ${formatUsdShort(step * market.markPx)}). Raise the collateral or the leverage.`;
};

const rejectionMessage = (message: string) =>
    /immediately match/i.test(message) ? PERP_MESSAGES.priceMoved : PERP_MESSAGES.rejected;

const partialMessage = (order: PerpOrderDoc, outcome: Extract<Outcome, { kind: "filled" }>) =>
    `Opened ${formatUsdShort(Number(outcome.sizeCoin) * Number(outcome.avgPx))} of your ${formatUsdShort(Number(fromDecimal(order.notionalE6)) / 1e6)}. The rest is back in your balance.`;
