import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { getAddress, type Address } from "viem";
import { IrisError, type Iris } from "../crosschain/iris.ts";
import type { IrisLimiter } from "../crosschain/iris-limiter.ts";
import type { Collections, PoolRebalanceDoc, PoolRebalanceState } from "../db/mongo.ts";
import { formatE6, fromDecimal, toDecimal, weiToE6 } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import { maxFeeWithHeadroom } from "../withdrawals/cctp-burn.ts";
import type { Withdrawals } from "../withdrawals/withdrawals.ts";
import { movedLast24hE6, poolFreeFloatE6, type PoolConfig } from "./pool-inputs.ts";
import { planPoolMove, usdToE6 } from "./pool-plan.ts";
import type { PredictionService } from "./predictions.ts";
import { announce, FLOWS, flowKey, stateChange, type FlowContext } from "./rebalance-flows.ts";
import { HourlyLog, POOL_ERRORS, rowFields } from "./rebalance-log.ts";
import type { RelayerGate } from "./relayer-gate.ts";
import type { PoolTrader } from "./trader.ts";

/** How often the worker starts a queued row and follows the rows in a fast state. */
const TICK_MS = 2_000;
/** How often a row in a slow state is followed. */
const SLOW_MS = 30_000;
/** The states whose rows hold a move that needs the trader, so `sending` (Payouts') is not among the flow states. */
const OPEN_STATES: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping", "stuck"];
const FLOW_STATES: PoolRebalanceState[] = ["submitting", "forwarding", "wrapping", "stuck"];
const FAST_STATES: ReadonlySet<PoolRebalanceState> = new Set(["submitting"]);
const TREASURY_LOW_KEY = "treasury-low";

type Deps = {
    collections: Collections;
    ledger: Ledger;
    withdrawals: Pick<Withdrawals, "treasuryFree" | "withTreasuryLock">;
    service: PredictionService;
    trader: () => PoolTrader | null;
    /** Asks for the pool's trader to be connected. */
    needTrader: () => void;
    /** The Arc treasury, where a drain's burn mints. */
    treasury: Address;
    iris: Iris;
    limiter: IrisLimiter;
    gate: RelayerGate;
    bus: Bus;
    logger: Logger;
    config: PoolConfig;
    /** The clock, for tests. */
    now?: () => number;
};

/** The rows that still hold or need a pool move: queued, sending, submitting, forwarding, wrapping and stuck ones. */
export function poolRowsOpen(collections: Collections): Promise<number> {
    return collections.poolRebalances.countDocuments({ state: { $in: OPEN_STATES } });
}

/** A drain's reservation that its row could not take because another writer moved the row first. */
class Superseded extends Error {}

/** Starts the queued pool move under the guards and caps, and follows the rows in flight through their flows. */
export class PoolRebalancer {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #log: HourlyLog;
    readonly #pendingSend = new Set<string>();
    /** When each slow row was last followed, by `id:state`. */
    #followedAt = new Map<string, number>();
    /** The configured pool wallet, once the derived-wallet check passed in this process. */
    #wallet: Address | null = null;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #pass: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#log = new HourlyLog(deps.logger, this.#now);
    }

    /** Ids of drain rows reserved by this process and not yet sent. */
    get pendingSend(): ReadonlySet<string> {
        return this.#pendingSend;
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
            await this.tick().catch((error: unknown) =>
                this.#log.once("pass", "warn", { err: error }, "Pool rebalancer pass failed"),
            );
            await sleep(TICK_MS, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass: starts the queued row, then follows the rows in a flow state; a pass already running is joined. */
    tick(): Promise<void> {
        this.#pass ??= this.#tick().finally(() => (this.#pass = null));
        return this.#pass;
    }

    async #tick() {
        const { collections, needTrader } = this.#deps;
        const trader = this.#deps.trader();
        if (!trader) {
            if ((await poolRowsOpen(collections)) > 0) needTrader();
            return;
        }
        const ctx = this.#context(trader);
        const queued = await collections.poolRebalances.findOne({ state: "queued" }, { sort: { createdAt: 1 } });
        if (queued) await this.#start(ctx, queued).catch((error: unknown) => this.#failed(queued, error));

        const rows = await collections.poolRebalances
            .find({ state: { $in: FLOW_STATES } })
            .sort({ createdAt: 1 })
            .toArray();
        const now = this.#now();
        const followed = new Map<string, number>();
        for (const row of rows) {
            if (this.#stop?.signal.aborted) break;
            const flow = FLOWS[flowKey(row)];
            if (!flow) continue;
            const key = `${row._id}:${row.state}`;
            if (!FAST_STATES.has(row.state)) {
                const last = this.#followedAt.get(key);
                if (last !== undefined && now - last < SLOW_MS) {
                    followed.set(key, last);
                    continue;
                }
                followed.set(key, now);
            }
            await flow(ctx, row).catch((error: unknown) => this.#failed(row, error, "A pool rebalance step failed"));
        }
        this.#followedAt = followed;
    }

    #failed(row: PoolRebalanceDoc, error: unknown, message = "A pool rebalance start failed") {
        this.#log.once(`failed:${row._id}:${row.state}`, "warn", { ...rowFields(row), err: error }, message);
    }

    #context(trader: PoolTrader): FlowContext {
        const { collections, treasury, iris, limiter, gate, service, ledger, bus, logger, config } = this.#deps;
        const ctx: FlowContext = {
            collections,
            trader,
            treasury,
            pendingSend: this.#pendingSend,
            iris,
            limiter,
            gate,
            service,
            ledger,
            bus,
            logger,
            now: this.#now,
            config,
            log: this.#log,
            move: async (row, to, patch = {}) => {
                const moved = await stateChange(collections, row, to, patch, new Date(this.#now()));
                if (moved) announce(ctx, moved, row.state);
                return moved;
            },
        };
        return ctx;
    }

    async #start(ctx: FlowContext, row: PoolRebalanceDoc) {
        if (row.kind === "wrap_idle") {
            await ctx.move(row, "wrapping");
            return;
        }
        if (row.direction === null) {
            await ctx.move(row, "failed", { lastError: "The move has no direction." });
            return;
        }
        if (fromDecimal(row.amountE6) <= 0n) {
            await ctx.move(row, "failed", { lastError: "The amount must be above zero." });
            return;
        }
        if (row.direction === "arc_to_polygon") await this.#startTopUp(ctx, row);
        else await this.#startDrain(ctx, row);
    }

    /** Prices a top-up, checks the pool wallet, and under the treasury lock moves the row to `sending` or ends it `failed`. */
    async #startTopUp(ctx: FlowContext, row: PoolRebalanceDoc) {
        const amountE6 = fromDecimal(row.amountE6);
        const maxFeeE6 = await this.#maxFee(ctx, row, { from: 26, to: 7 });
        if (maxFeeE6 === null) return;
        const wallet = await this.#poolWallet(ctx, row);
        if (!wallet) return;

        const { withdrawals } = this.#deps;
        const { config } = ctx;
        try {
            await withdrawals.withTreasuryLock(async () => {
                const treasuryFreeE6 = weiToE6(await withdrawals.treasuryFree());
                const plan = planPoolMove({
                    direction: "arc_to_polygon",
                    amountE6,
                    maxMoveE6: usdToE6(config.POOL_REBALANCE_MAX_MOVE_USD),
                    treasuryFreeE6,
                    arcReserveE6: usdToE6(config.POOL_REBALANCE_ARC_RESERVE_USD),
                    movedTodayE6: await movedLast24hE6(ctx.collections, ctx.now(), row._id),
                    maxDayE6: usdToE6(config.POOL_REBALANCE_MAX_DAY_USD),
                    freeFloatE6: 0n,
                });
                if (!plan.ok) {
                    if (plan.kind === "reserve") {
                        ctx.log.once(
                            TREASURY_LOW_KEY,
                            "error",
                            {
                                ...rowFields(row),
                                treasuryFreeUSD: formatE6(treasuryFreeE6),
                                reserveUSD: config.POOL_REBALANCE_ARC_RESERVE_USD,
                            },
                            POOL_ERRORS.treasuryLow,
                        );
                    }
                    await ctx.move(row, "failed", { lastError: plan.reason });
                    return;
                }
                await ctx.move(row, "sending", { maxFeeE6: toDecimal(maxFeeE6), mintRecipient: wallet });
            });
        } catch (error) {
            this.#log.once(
                `start:${row._id}`,
                "warn",
                { ...rowFields(row), err: error },
                "Couldn't start a pool move, so it waits",
            );
        }
    }

    /** Prices a drain and, in one transaction, reserves its free float and moves the row to `submitting`. */
    async #startDrain(ctx: FlowContext, row: PoolRebalanceDoc) {
        const amountE6 = fromDecimal(row.amountE6);
        const maxFeeE6 = await this.#maxFee(ctx, row, { from: 7, to: 26 });
        if (maxFeeE6 === null) return;
        const { config } = ctx;
        const plan = planPoolMove({
            direction: "polygon_to_arc",
            amountE6,
            maxMoveE6: usdToE6(config.POOL_REBALANCE_MAX_MOVE_USD),
            treasuryFreeE6: 0n,
            arcReserveE6: 0n,
            movedTodayE6: 0n,
            maxDayE6: 0n,
            freeFloatE6: await poolFreeFloatE6(ctx.collections),
        });
        if (!plan.ok) {
            await ctx.move(row, "failed", { lastError: plan.reason });
            return;
        }

        let started: PoolRebalanceDoc;
        try {
            started = await ctx.ledger.runInTransaction(async (session) => {
                await ctx.service.reserveForMove(session, amountE6);
                const moved = await stateChange(
                    ctx.collections,
                    row,
                    "submitting",
                    { reservedE6: toDecimal(amountE6), maxFeeE6: toDecimal(maxFeeE6) },
                    new Date(ctx.now()),
                    session,
                );
                // Another writer moved the row first: abort, so the reservation is not kept
                if (!moved) throw new Superseded();
                return moved;
            });
        } catch (error) {
            if (error instanceof Superseded) return;
            if (error instanceof AppError && error.code === "float_short") {
                await ctx.move(row, "failed", { lastError: "Free float is short." });
                return;
            }
            throw error;
        }
        ctx.pendingSend.add(row._id.toString());
        announce(ctx, started, row.state);
    }

    /** The most Circle may take for the row's burn on one route, or null (with a warning) while Iris can't be asked. */
    async #maxFee(
        ctx: FlowContext,
        row: PoolRebalanceDoc,
        route: { from: number; to: number },
    ): Promise<bigint | null> {
        const now = ctx.now();
        if (!ctx.limiter.take(now)) {
            ctx.log.once(
                `iris-budget:${row._id}`,
                "warn",
                rowFields(row),
                "Iris's request budget is spent, so a pool move waits",
            );
            return null;
        }
        try {
            const fee = await ctx.iris.forwardFee(route);
            return maxFeeWithHeadroom({
                amount6: fromDecimal(row.amountE6),
                high6: weiToE6(fee.high),
                minimumFeeBps: fee.minimumFeeBps,
            });
        } catch (error) {
            if (error instanceof IrisError && error.kind === "rate_limited") ctx.limiter.backoff(now);
            ctx.log.once(
                `iris:${row._id}`,
                "warn",
                { ...rowFields(row), err: error },
                "Iris couldn't price a pool move, so it waits",
            );
            return null;
        }
    }

    /** The pool wallet a burn may mint to, checked once per process; null (the row left queued or failed) when it can't be trusted. */
    async #poolWallet(ctx: FlowContext, row: PoolRebalanceDoc): Promise<Address | null> {
        if (this.#wallet) return this.#wallet;
        let found: Awaited<ReturnType<PoolTrader["derivedWallet"]>>;
        try {
            found = await ctx.trader.derivedWallet();
        } catch (error) {
            ctx.log.once(
                `wallet:${row._id}`,
                "warn",
                { ...rowFields(row), err: error },
                "Couldn't check the pool wallet, so a pool move waits",
            );
            return null;
        }
        if (found.configured.toLowerCase() !== found.derived.toLowerCase() || !found.hasCode) {
            ctx.log.once(`mismatch:${row._id}`, "error", { ...rowFields(row), ...found }, POOL_ERRORS.walletMismatch);
            await ctx.move(row, "failed", { lastError: POOL_ERRORS.walletMismatch });
            return null;
        }
        this.#wallet = getAddress(found.configured);
        return this.#wallet;
    }
}
