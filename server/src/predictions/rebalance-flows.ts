import type { ClientSession } from "mongodb";
import type { Logger } from "pino";
import type { Address } from "viem";
import type { Iris } from "../crosschain/iris.ts";
import type { IrisLimiter } from "../crosschain/iris-limiter.ts";
import type { Collections, PoolRebalanceDoc, PoolRebalanceState } from "../db/mongo.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { Bus } from "../events.ts";
import type { PoolConfig } from "./pool-inputs.ts";
import type { PredictionService } from "./predictions.ts";
import { rowFields, type HourlyLog } from "./rebalance-log.ts";
import type { RelayerGate } from "./relayer-gate.ts";
import type { PoolTrader } from "./trader.ts";

/** What a flow gets: the worker's collaborators, and `move`, the one guarded state change of a row. */
export type FlowContext = {
    collections: Collections;
    trader: PoolTrader;
    /** The Arc treasury, where a drain's burn mints. */
    treasury: Address;
    /** Ids of drain rows this process reserved and has not yet tried to send; a restart empties it. */
    pendingSend: Set<string>;
    iris: Iris;
    limiter: IrisLimiter;
    gate: RelayerGate;
    service: PredictionService;
    ledger: Ledger;
    bus: Bus;
    logger: Logger;
    now: () => number;
    config: PoolConfig;
    log: HourlyLog;
    /** Moves the row out of its current state (null when it is no longer in it), tells the server and logs it. */
    move(
        row: PoolRebalanceDoc,
        to: PoolRebalanceState,
        patch?: Record<string, unknown>,
    ): Promise<PoolRebalanceDoc | null>;
};

/** One step of a row in one state; it reads the row it is given and changes it only through `move` and guarded updates. */
export type Flow = (ctx: FlowContext, row: PoolRebalanceDoc) => Promise<void>;

/** The flows by `${direction ?? kind}:${state}`. */
export const FLOWS: Record<string, Flow> = {};

export const flowKey = (row: PoolRebalanceDoc): string => `${row.direction ?? row.kind}:${row.state}`;

/** States that leave `active` off the row, so it stops holding the one-active slot. */
const ENDING: ReadonlySet<PoolRebalanceState> = new Set(["done", "failed", "stuck"]);

/** Moves a row out of the state in `row`, setting `updatedAt` (and `doneAt` on done or failed) and dropping `active` when it ends or sticks; never sets `active`. */
export function stateChange(
    collections: Collections,
    row: PoolRebalanceDoc,
    to: PoolRebalanceState,
    patch: Record<string, unknown>,
    at: Date,
    session?: ClientSession,
): Promise<PoolRebalanceDoc | null> {
    const finished = to === "done" || to === "failed";
    return collections.poolRebalances.findOneAndUpdate(
        { _id: row._id, state: row.state },
        {
            $set: { ...patch, state: to, updatedAt: at, ...(finished && { doneAt: at }) },
            ...(ENDING.has(to) && { $unset: { active: "" as const } }),
        },
        { returnDocument: "after", ...(session && { session }) },
    );
}

/** Tells the rest of the server that a row changed state, and logs it. */
export function announce(
    ctx: Pick<FlowContext, "bus" | "logger">,
    moved: PoolRebalanceDoc,
    from: PoolRebalanceState,
): void {
    ctx.bus.emit("pool-rebalance:updated", { rebalance: moved });
    ctx.logger.info(
        { ...rowFields(moved), from, to: moved.state, lastError: moved.lastError },
        "Pool rebalance changed state",
    );
}
