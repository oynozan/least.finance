import { setTimeout as sleep } from "node:timers/promises";
import { loopWatch } from "../loop-watch.ts";
import { ObjectId } from "mongodb";
import type { Logger } from "pino";
import type { Collections, PositionDoc } from "../db/mongo.ts";
import { e6ToWei, formatE6, formatUsdc, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import type { GammaMarket } from "../markets/gamma.ts";
import type { PolymarketData } from "../markets/polymarket-data.ts";
import { HourlyLog } from "./rebalance-log.ts";

const MARKETS_PER_PASS = 100;
/** A market that has stayed unsettled this long with open positions is escalated from a warning to an error. */
const WAITING_ERROR_MS = 86_400_000;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    data: PolymarketData;
    bus: Bus;
    logger: Logger;
    resolveMs: number;
    /** Asks for the pool's trader to be connected when a redemption needs it. */
    needTrader?: () => void;
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
    /** The last market of the previous pass, so passes walk every market in turn */
    #cursor: string | null = null;
    /** A market that can't settle yet stays that way for passes, so each is logged once an hour. */
    readonly #hourly: HourlyLog;
    /** When each market with open positions was first seen unable to settle. */
    readonly #waitingSince = new Map<string, number>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#hourly = new HourlyLog(deps.logger, this.#now);
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
        const watch = loopWatch(this.#deps.logger, "prediction resolution");
        while (!signal.aborted) {
            let waitMs = this.#deps.resolveMs;
            try {
                await this.tick();
                watch.ok();
            } catch (error) {
                waitMs = watch.failed(error, this.#deps.resolveMs);
            }
            await sleep(waitMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass over the next markets of open positions, wrapping round after the last; an error on one market leaves the others to settle. */
    async tick(): Promise<void> {
        const { positions } = this.#deps.collections;
        const found = await positions
            .aggregate<{ _id: string }>([
                { $match: { state: "open", ...(this.#cursor === null ? {} : { marketId: { $gt: this.#cursor } }) } },
                { $group: { _id: "$marketId" } },
                { $sort: { _id: 1 } },
                { $limit: MARKETS_PER_PASS },
            ])
            .toArray();
        this.#cursor = found.length < MARKETS_PER_PASS ? null : found[found.length - 1]!._id;
        for (const { _id: marketId } of found) {
            await this.#resolve(marketId).catch((error: unknown) =>
                this.#hourly.once(
                    `market:${marketId}`,
                    "warn",
                    { err: error, market: marketId },
                    "Couldn't settle a market's positions",
                ),
            );
        }
    }

    async #resolve(marketId: string): Promise<void> {
        const market = await this.#deps.data.market(marketId);
        if (!market) return this.#waiting(marketId, null);
        const payouts = resolution(market);
        if (!payouts) return this.#waiting(marketId, market);
        this.#waitingSince.delete(marketId);
        const open = await this.#deps.collections.positions.find({ marketId, state: "open" }).toArray();
        if (open.length === 0) return;

        // Queued before paying, so a crash between the two can't leave tokens nobody redeems
        const conditionId = market.conditionId || open.find((p) => p.conditionId)?.conditionId;
        if (conditionId) {
            // Only winning shares need redeeming again
            const winning = open.filter((p) => (payouts[market.clobTokenIds.indexOf(p.tokenId)] ?? 0n) > 0n);
            const latestBuyAt = winning.reduce<Date | null>(
                (latest, p) => (latest && latest > p.updatedAt ? latest : p.updatedAt),
                null,
            );
            await this.#queueRedemption(conditionId, marketId, latestBuyAt);
        } else
            this.#hourly.once(
                `no-condition:${marketId}`,
                "error",
                { market: marketId },
                "A resolved market has no condition to redeem",
            );

        for (const position of open) {
            const index = market.clobTokenIds.indexOf(position.tokenId);
            if (index < 0) {
                this.#hourly.once(
                    `no-token:${position._id.toHexString()}`,
                    "error",
                    { market: marketId, position: position._id.toHexString() },
                    "A position's token isn't in its market",
                );
                continue;
            }
            await this.#settle(position, payouts[index]!).catch((error: unknown) =>
                // A ledger or database failure leaves someone's winnings unpaid, so it is an error, said once an hour
                this.#hourly.once(
                    `settle:${position._id.toHexString()}`,
                    "error",
                    {
                        err: error,
                        position: position._id.toHexString(),
                        accountId: position.accountId.toHexString(),
                        marketId,
                        tokenId: position.tokenId,
                        shares: formatE6(fromDecimal(position.shares)),
                        payoutUSD: formatUsdc(e6ToWei((fromDecimal(position.shares) * payouts[index]!) / 1_000_000n)),
                    },
                    "Couldn't pay a settled position",
                ),
            );
        }
    }

    /** A market with open positions that can't settle: gone from Polymarket, or closed without a clean result. Open markets are normal and say nothing. */
    async #waiting(marketId: string, market: GammaMarket | null) {
        if (market && !market.closed) {
            this.#waitingSince.delete(marketId);
            return;
        }
        const now = this.#now();
        const since = this.#waitingSince.get(marketId) ?? now;
        this.#waitingSince.set(marketId, since);
        const level = now - since >= WAITING_ERROR_MS ? "error" : "warn";
        const { positions } = this.#deps.collections;
        const open = { marketId, state: "open" as const };
        const [count, first] = await Promise.all([positions.countDocuments(open), positions.findOne(open)]);
        const base = { market: marketId, question: first?.question ?? null, positions: count };
        const waitingSec = Math.round((now - since) / 1000);
        if (!market)
            this.#hourly.once(
                `waiting:${marketId}:${level}`,
                level,
                { ...base, waitingSec },
                "Polymarket no longer returns a market that has open positions, so they can't be paid",
            );
        else
            this.#hourly.once(
                `waiting:${marketId}:${level}`,
                level,
                {
                    ...base,
                    waitingSec,
                    closed: market.closed,
                    umaResolutionStatus: market.umaResolutionStatus ?? null,
                    outcomePrices: market.outcomePrices,
                },
                "A market with open positions is closed but its result isn't clean yet, so they can't be paid",
            );
    }

    /** Queues the condition's redemption, and queues a confirmed one again when winning shares were bought after it confirmed. */
    async #queueRedemption(conditionId: string, marketId: string, latestBuyAt: Date | null) {
        const now = new Date(this.#now());
        const { predictionRedemptions } = this.#deps.collections;
        const requeued = latestBuyAt
            ? await predictionRedemptions.updateOne(
                  {
                      conditionId,
                      state: "confirmed",
                      $expr: { $lt: [{ $ifNull: ["$confirmedAt", "$updatedAt"] }, latestBuyAt] },
                  },
                  [
                      {
                          $set: {
                              state: "pending",
                              transactionId: null,
                              attempts: 0,
                              nextAt: now,
                              lastError: "re-queued: shares bought after the last redemption",
                              updatedAt: now,
                              round: { $add: [{ $ifNull: ["$round", 1] }, 1] },
                          },
                      },
                  ],
              )
            : null;
        const inserted = await predictionRedemptions.updateOne(
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
                    confirmedAt: null,
                    round: 1,
                    createdAt: now,
                },
                $set: { updatedAt: now },
            },
            { upsert: true },
        );
        if (inserted.upsertedCount > 0 || requeued?.modifiedCount) this.#deps.needTrader?.();
    }

    /** Moves one open position to won or lost and pays it, in one transaction; a position that moved or grew meanwhile is left for the next pass. */
    async #settle(position: PositionDoc, priceE6: bigint): Promise<void> {
        const payout = e6ToWei((fromDecimal(position.shares) * priceE6) / 1_000_000n);
        const { positions, accounts } = this.#deps.collections;
        const done = await this.#deps.ledger.runInTransaction(async (session) => {
            const now = new Date(this.#now());
            const moved = await positions.findOneAndUpdate(
                { _id: position._id, state: "open", shares: position.shares },
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
            {
                position: position._id.toHexString(),
                accountId: position.accountId.toHexString(),
                marketId: position.marketId,
                tokenId: position.tokenId,
                shares: formatE6(fromDecimal(position.shares)),
                state: done.position.state,
                payoutUSD: formatUsdc(payout),
            },
            "Position settled",
        );
        this.#deps.bus.emit("position:settled", done);
    }
}
