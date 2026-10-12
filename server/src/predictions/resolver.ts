import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import type { Collections, PositionDoc } from "../db/mongo.ts";
import { e6ToWei, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import type { GammaMarket } from "../markets/gamma.ts";
import type { PolymarketData } from "../markets/polymarket-data.ts";

const MARKETS_PER_PASS = 100;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    data: PolymarketData;
    bus: Bus;
    logger: Logger;
    resolveMs: number;
    /** The clock, for tests. */
    now?: () => number;
};

/** A price of 1, 0 or 0.5 as e6; null for anything else, which is a live price rather than a result. */
const PAYOUTS = new Map<number, bigint>([
    [0, 0n],
    [0.5, 500_000n],
    [1, 1_000_000n],
]);

/** The payout per share of each outcome, once Gamma shows the market resolved to a clean result. */
function resolution(market: GammaMarket): bigint[] | null {
    if (!market.closed || market.umaResolutionStatus !== "resolved") return null;
    const prices = market.outcomePrices.map((price) => PAYOUTS.get(price));
    if (prices.length !== market.clobTokenIds.length || prices.some((price) => price === undefined)) return null;
    const e6 = prices as bigint[];
    // A binary win is 1 and 0, a 50/50 is half each; anything else waits
    return e6.reduce((sum, price) => sum + price, 0n) === 1_000_000n ? e6 : null;
}

/** Pays each open position when its market resolves, from Gamma's prices. */
export class PredictionResolver {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    async #run(signal: AbortSignal) {
        while (!signal.aborted) {
            try {
                await this.tick();
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Prediction resolution pass failed");
            }
            await sleep(this.#deps.resolveMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass over the markets of open positions; an error on one market leaves the others to settle. */
    async tick(): Promise<void> {
        const { positions } = this.#deps.collections;
        const found = await positions
            .aggregate<{ _id: string }>([
                { $match: { state: "open" } },
                { $group: { _id: "$marketId" } },
                { $limit: MARKETS_PER_PASS },
            ])
            .toArray();
        for (const { _id: marketId } of found) {
            await this.#resolve(marketId).catch((error: unknown) =>
                this.#deps.logger.warn({ err: error, market: marketId }, "Couldn't settle a market's positions"),
            );
        }
    }

    async #resolve(marketId: string): Promise<void> {
        const market = await this.#deps.data.market(marketId);
        if (!market) return;
        const payouts = resolution(market);
        if (!payouts) return;
        const open = await this.#deps.collections.positions.find({ marketId, state: "open" }).toArray();
        if (open.length === 0) return;

        // Queued before paying, so a crash between the two can't leave tokens nobody redeems
        const conditionId = market.conditionId || open.find((p) => p.conditionId)?.conditionId;
        if (conditionId) await this.#queueRedemption(conditionId, marketId);
        else this.#deps.logger.error({ market: marketId }, "A resolved market has no condition to redeem");

        for (const position of open) {
            const index = market.clobTokenIds.indexOf(position.tokenId);
            if (index < 0) {
                this.#deps.logger.error(
                    { market: marketId, position: position._id.toHexString() },
                    "A position's token isn't in its market",
                );
                continue;
            }
            await this.#settle(position, payouts[index]!).catch((error: unknown) =>
                this.#deps.logger.warn(
                    { err: error, position: position._id.toHexString() },
                    "Couldn't settle a position",
                ),
            );
        }
    }

    async #queueRedemption(conditionId: string, marketId: string) {
        const now = new Date(this.#now());
        await this.#deps.collections.predictionRedemptions.updateOne(
            { conditionId },
            {
                $setOnInsert: {
                    _id: new ObjectId(),
                    marketId,
                    state: "pending",
                    transactionId: null,
                    attempts: 0,
                    nextAt: now,
                    lastError: null,
                    createdAt: now,
                },
                $set: { updatedAt: now },
            },
            { upsert: true },
        );
    }

    /** Moves one open position to won or lost and pays it, in one transaction; a position that moved meanwhile is left alone. */
    async #settle(position: PositionDoc, priceE6: bigint): Promise<void> {
        const payout = e6ToWei((fromDecimal(position.shares) * priceE6) / 1_000_000n);
        const { positions, accounts } = this.#deps.collections;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const now = new Date(this.#now());
            const moved = await positions.findOneAndUpdate(
                { _id: position._id, state: "open" },
                {
                    $set: {
                        state: payout > 0n ? "won" : "lost",
                        payout: toDecimal(payout),
                        settledAt: now,
                        updatedAt: now,
                    },
                },
                { session, returnDocument: "after" },
            );
            if (!moved) return null;
            const account =
                payout > 0n
                    ? await this.#deps.ledger.creditInSession(
                          session,
                          moved.accountId,
                          payout,
                          "prediction_payout",
                          moved._id,
                      )
                    : await accounts.findOne({ _id: moved.accountId }, { session });
            if (!account) throw new Error("The account vanished");
            return { position: moved, account };
        });
        if (!done) return;
        this.#deps.logger.info(
            { position: position._id.toHexString(), state: done.position.state },
            "Position settled",
        );
        this.#deps.bus.emit("position:settled", done);
    }
}
