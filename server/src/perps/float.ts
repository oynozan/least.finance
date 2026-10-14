import { setTimeout as sleep } from "node:timers/promises";
import type { ClientSession } from "mongodb";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Collections, PerpFloatDoc } from "../db/mongo.ts";
import { fromDecimal, toDecimal } from "../db/money.ts";
import { AppError } from "../errors.ts";
import { formatUsdShort } from "../predictions/views.ts";
import type { HyperliquidClient } from "./client.ts";

const FLOAT_ID = "hyperliquid";
const FLOAT_LOW = 0.25;
const FLOAT_HIGH = 2;
const READ_EVERY_MS = 60_000;
/** A balance read older than this no longer backs new orders. */
const MAX_AGE_MS = 180_000;
/** How long an order waits on a fresh balance read before it is refused. */
const READ_WAIT_MS = 30_000;
const ONE_USDC_E6 = 1_000_000n;

/** The activation and the slack an order leaves in the float besides its collateral. */
export const ACTIVATION_E6 = ONE_USDC_E6;
export const SLACK_E6 = ONE_USDC_E6;

export const NOTHING_SPENT = "Nothing was spent.";

type Deps = {
    collections: Collections;
    client: Pick<HyperliquidClient, "state">;
    /** The master float account's address. */
    master: string;
    logger: Logger;
    config: Pick<Config, "PERPS_TRADING" | "PERPS_FLOAT_USD">;
    now: () => number;
};

const freeOf = (doc: PerpFloatDoc): bigint =>
    fromDecimal(doc.balanceE6) - fromDecimal(doc.heldE6) - fromDecimal(doc.unreadFillsE6);

/** The master Hyperliquid account's free dollars: what the last read saw, less what open orders hold and what fills spent since. */
export class PerpFloat {
    readonly #deps: Deps;
    #mirror: PerpFloatDoc | null = null;
    #level: "low" | "high" | "ok" = "ok";
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    start(): void {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            while (!signal.aborted) {
                if (this.#deps.config.PERPS_TRADING === "on") await this.refresh().catch(() => undefined);
                await sleep(READ_EVERY_MS, undefined, { signal }).catch(() => undefined);
            }
        })();
    }

    stop(): Promise<void> {
        this.#stop?.abort();
        const loop = this.#loop;
        this.#loop = null;
        this.#stop = null;
        return loop ?? Promise.resolve();
    }

    /** The largest order the float can cover now, in whole dollars after the activation and the slack; null while it hasn't been read. */
    maxOrderUSD(): number | null {
        if (!this.#mirror) return null;
        return this.#wholeUSD(freeOf(this.#mirror) - ACTIVATION_E6 - SLACK_E6);
    }

    #wholeUSD(e6: bigint): number {
        return e6 <= 0n ? 0 : Number(e6 / 1_000_000n);
    }

    /** Reads the master's withdrawable into the float document, keeping fills that landed during the read. */
    async refresh(): Promise<void> {
        const { perpFloat } = this.#deps.collections;
        const before = await perpFloat.findOne({ _id: FLOAT_ID });
        const unread = before ? fromDecimal(before.unreadFillsE6) : 0n;
        const state = await this.#deps.client.state(this.#deps.master);
        const balance = state?.withdrawableE6 ?? 0n;
        const at = new Date(this.#deps.now());
        const zero = toDecimal(0n);
        const doc = await perpFloat.findOneAndUpdate(
            { _id: FLOAT_ID },
            [
                {
                    $set: {
                        balanceE6: toDecimal(balance),
                        balanceAt: at,
                        updatedAt: at,
                        heldE6: { $ifNull: ["$heldE6", zero] },
                        unreadFillsE6: {
                            $max: [zero, { $subtract: [{ $ifNull: ["$unreadFillsE6", zero] }, toDecimal(unread)] }],
                        },
                    },
                },
            ],
            { upsert: true, returnDocument: "after" },
        );
        if (doc) this.#remember(doc);
        this.#warn(balance);
    }

    /** Refuses an order the float obviously can't cover, before any money moves; the reservation is the real guard. */
    async check(amountE6: bigint): Promise<void> {
        const { perpFloat } = this.#deps.collections;
        let doc = await perpFloat.findOne({ _id: FLOAT_ID });
        if (!doc || this.#stale(doc)) {
            await this.#readOnce();
            doc = await perpFloat.findOne({ _id: FLOAT_ID });
        }
        if (!doc || this.#stale(doc) || freeOf(doc) < amountE6 + SLACK_E6) throw this.short(doc);
    }

    async #readOnce(): Promise<void> {
        const abort = new AbortController();
        const timer = sleep(READ_WAIT_MS, undefined, { signal: abort.signal }).then(
            () => {
                throw new Error("The balance read timed out");
            },
            () => undefined,
        );
        try {
            await Promise.race([this.refresh(), timer]);
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't read the Hyperliquid float");
        } finally {
            abort.abort();
        }
    }

    #stale(doc: PerpFloatDoc): boolean {
        return doc.balanceAt.getTime() < this.#deps.now() - MAX_AGE_MS;
    }

    /** Takes the order's dollars from the float inside the order's transaction, leaving the slack free; nothing is taken if it doesn't fit. */
    async reserve(session: ClientSession, amountE6: bigint): Promise<PerpFloatDoc> {
        const now = this.#deps.now();
        const amount = toDecimal(amountE6);
        const doc = await this.#deps.collections.perpFloat.findOneAndUpdate(
            {
                _id: FLOAT_ID,
                balanceAt: { $gte: new Date(now - MAX_AGE_MS) },
                $expr: {
                    $gte: [
                        { $subtract: [{ $subtract: ["$balanceE6", "$heldE6"] }, "$unreadFillsE6"] },
                        toDecimal(amountE6 + SLACK_E6),
                    ],
                },
            },
            { $inc: { heldE6: amount }, $set: { updatedAt: new Date(now) } },
            { session, returnDocument: "after" },
        );
        if (doc) return doc;
        throw this.short(await this.#deps.collections.perpFloat.findOne({ _id: FLOAT_ID }, { session }));
    }

    /** Gives back a reservation and counts what the order moved out until a balance read shows it. */
    async release(session: ClientSession, reservedE6: bigint, spentE6: bigint): Promise<PerpFloatDoc | null> {
        if (reservedE6 === 0n && spentE6 === 0n) return null;
        return this.#deps.collections.perpFloat.findOneAndUpdate(
            { _id: FLOAT_ID },
            {
                $inc: { heldE6: toDecimal(-reservedE6), unreadFillsE6: toDecimal(spentE6) },
                $set: { updatedAt: new Date(this.#deps.now()) },
            },
            { session, returnDocument: "after" },
        );
    }

    remember(doc: PerpFloatDoc | null): void {
        if (doc) this.#remember(doc);
    }

    #remember(doc: PerpFloatDoc) {
        if (this.#mirror && doc.updatedAt.getTime() < this.#mirror.updatedAt.getTime()) return;
        this.#mirror = doc;
    }

    short(doc: PerpFloatDoc | null): AppError {
        const free = doc && !this.#stale(doc) ? this.#wholeUSD(freeOf(doc) - ACTIVATION_E6 - SLACK_E6) : 0;
        return new AppError(
            "float_short",
            `Long and short are limited to ${formatUsdShort(free)} right now. ${NOTHING_SPENT}`,
        );
    }

    #warn(balanceE6: bigint) {
        const target = this.#deps.config.PERPS_FLOAT_USD;
        const usd = Number(balanceE6) / 1e6;
        const level = usd < target * FLOAT_LOW ? "low" : usd > target * FLOAT_HIGH ? "high" : "ok";
        if (level !== "ok" && level !== this.#level)
            this.#deps.logger.warn({ balanceUSD: usd, targetUSD: target }, `The Hyperliquid float is ${level}`);
        this.#level = level;
    }
}
