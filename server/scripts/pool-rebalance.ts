/**
 * The operator's side of the pool rebalancer: it reads, and it queues rows for the server's worker. It never signs and
 * sends nothing, so it can run while the server pays withdrawals; the worker starts, follows and ends every row.
 * It refuses unless POOL_REBALANCE is `on`, checked before the config is loaded or Mongo is touched.
 *
 *   node --env-file=.env scripts/pool-rebalance.ts status
 *   node --env-file=.env scripts/pool-rebalance.ts plan
 *   node --env-file=.env scripts/pool-rebalance.ts move arc-to-polygon|polygon-to-arc <usd>
 *   node --env-file=.env scripts/pool-rebalance.ts wrap-idle
 *   node --env-file=.env scripts/pool-rebalance.ts resolve <id> done|failed
 *
 * status prints the treasury, the pool, the idle native USDC, the configured and derived pool wallet, the active row
 * and the last five rows. plan prints what the worker would decide now and queues nothing. move queues one override
 * row that skips the bands but obeys every cap and guard. wrap-idle queues a wrap of the native USDC the pool wallet
 * holds. resolve marks a stuck row done or failed after the chain has been checked by hand.
 */
import { ObjectId, type Collection } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { createKeyring } from "../src/accounts/keyring.ts";
import { createArcClient } from "../src/chain/arc.ts";
import { loadConfig, type Config } from "../src/config.ts";
import {
    connectDatabase,
    isDuplicateKey,
    type Collections,
    type PoolDirection,
    type PoolRebalanceDoc,
    type PoolRebalanceState,
} from "../src/db/mongo.ts";
import { formatE6, fromDecimal, weiToE6 } from "../src/db/money.ts";
import { createPolymarketTrader } from "../src/predictions/polymarket-trader.ts";
import {
    haltedDirections,
    movedLast24hE6,
    newPoolRebalance,
    readDecisionInputs,
    type PoolConfig,
} from "../src/predictions/pool-inputs.ts";
import {
    BAND_HIGH_PCT,
    BAND_LOW_PCT,
    decidePoolMove,
    planPoolMove,
    usdToE6,
    type PoolDecision,
} from "../src/predictions/pool-plan.ts";
import { withTimeouts, type PoolTrader } from "../src/predictions/trader.ts";
import { TREASURY_GAS_RESERVE } from "../src/withdrawals/withdrawals.ts";
import { owedOf } from "./perps-rebalance.ts";
import { describeError } from "./describe-error.ts";

/** How long one call to Polymarket or Polygon may take before status gives up on it. */
const TRADER_CALL_MS = 30_000;
/** The states of a move in flight, which a row resumed from `stuck` is in without its `active` flag. */
const IN_FLIGHT: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping"];
const AMOUNT_MESSAGE = "Enter an amount above zero with at most 6 decimals.";
const USAGE =
    "Usage: pool-rebalance.ts status | plan | wrap-idle | move arc-to-polygon|polygon-to-arc <usd> | resolve <id> done|failed";
const DIRECTIONS = new Map<string, PoolDirection>([
    ["arc-to-polygon", "arc_to_polygon"],
    ["polygon-to-arc", "polygon_to_arc"],
]);

/** The message to refuse with when `POOL_REBALANCE` is not `on`, or null. */
export function refusalWhileOff(env: Record<string, string | undefined>): string | null {
    return env.POOL_REBALANCE === "on"
        ? null
        : "Pool rebalancing is off: set POOL_REBALANCE=on (here and in the server's environment) to use this script.";
}

/** Dollars as E6 USDC units: digits with at most 6 decimals, above zero. */
export function parseUsd(text: string): bigint {
    if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(AMOUNT_MESSAGE);
    const amountE6 = parseUnits(text, 6);
    if (amountE6 <= 0n) throw new Error(AMOUNT_MESSAGE);
    return amountE6;
}

function parseRebalanceId(id: string): ObjectId {
    if (!ObjectId.isValid(id)) throw new Error("That is not a rebalance id.");
    return new ObjectId(id);
}

export type Command =
    | { name: "status" | "plan" | "wrap-idle" }
    | { name: "move"; direction: PoolDirection; amountE6: bigint }
    | { name: "resolve"; id: string; outcome: "done" | "failed" };

/** Reads the arguments after the script name; every odd one throws before any other work. */
export function parseCommand(args: string[]): Command {
    const [name, ...rest] = args;
    if (name === "status" || name === "plan" || name === "wrap-idle") {
        if (rest.length > 0) throw new Error(USAGE);
        return { name };
    }
    if (name === "move") {
        const [route, amount, ...extra] = rest;
        const direction = route === undefined ? undefined : DIRECTIONS.get(route);
        if (!direction || amount === undefined || extra.length > 0) throw new Error(USAGE);
        return { name, direction, amountE6: parseUsd(amount) };
    }
    if (name === "resolve") {
        const [id, outcome, ...extra] = rest;
        if (id === undefined || (outcome !== "done" && outcome !== "failed") || extra.length > 0) {
            throw new Error(USAGE);
        }
        parseRebalanceId(id);
        return { name, id, outcome };
    }
    throw new Error(USAGE);
}

export type Queued = { ok: true; id: ObjectId } | { ok: false; active: PoolRebalanceDoc | null };

/** Inserts `row` unless a move is in flight; the unique index settles two inserts at the same instant. */
async function queue(collection: Collection<PoolRebalanceDoc>, row: PoolRebalanceDoc): Promise<Queued> {
    const inFlight = await collection.findOne({ state: { $in: IN_FLIGHT } });
    if (inFlight) return { ok: false, active: inFlight };
    try {
        await collection.insertOne(row);
        return { ok: true, id: row._id };
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return { ok: false, active: await collection.findOne({ active: true }) };
    }
}

/** Queues one operator move; another move in flight rejects it and is returned. */
export function queueMove(
    collection: Collection<PoolRebalanceDoc>,
    o: { direction: PoolDirection; amountE6: bigint },
): Promise<Queued> {
    return queue(
        collection,
        newPoolRebalance({
            kind: "move",
            direction: o.direction,
            source: "operator",
            reason: "operator",
            amountE6: o.amountE6,
            now: new Date(),
        }),
    );
}

/** Queues a wrap of whatever native USDC the pool wallet holds; another move in flight rejects it and is returned. */
export function queueWrapIdle(collection: Collection<PoolRebalanceDoc>): Promise<Queued> {
    return queue(
        collection,
        newPoolRebalance({
            kind: "wrap_idle",
            direction: null,
            source: "operator",
            reason: "operator",
            amountE6: 0n,
            now: new Date(),
        }),
    );
}

/** Marks a stuck row done or failed and stamps `resolvedAt`; false when no stuck row has that id. */
export async function resolveRow(
    collection: Pick<Collection<PoolRebalanceDoc>, "updateOne">,
    id: string,
    outcome: "done" | "failed",
): Promise<boolean> {
    const _id = parseRebalanceId(id);
    const at = new Date();
    const result = await collection.updateOne(
        { _id, state: "stuck" },
        { $set: { state: outcome, resolvedAt: at, doneAt: at, updatedAt: at } },
    );
    return result.modifiedCount === 1;
}

const dollars = (e6: bigint) => `$${formatE6(e6)}`;
const message = describeError;
const ago = (ms: number) => (ms < 120_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

const rowLine = (row: PoolRebalanceDoc) =>
    [
        row._id.toHexString(),
        row.kind === "wrap_idle" ? "wrap_idle" : `${row.direction} ${dollars(fromDecimal(row.amountE6))}`,
        row.state,
        row.source,
        row.createdAt.toISOString(),
        row.lastError && `(${row.lastError})`,
    ]
        .filter(Boolean)
        .join(" ");

const haltedText = (halted: Record<PoolDirection, boolean>) =>
    (Object.keys(halted) as PoolDirection[]).filter((direction) => halted[direction]).join(", ") || "none";

/** The row holding the one-active slot, or one in flight without it. */
const activeRow = (collections: Collections) =>
    collections.poolRebalances.findOne({ $or: [{ active: true }, { state: { $in: IN_FLIGHT } }] });

/** Runs one read and labels its answer, or says it is unavailable and why. */
async function attempt(label: string, read: () => Promise<string>): Promise<string> {
    try {
        return `${label}: ${await read()}`;
    } catch (error) {
        return `${label}: unavailable (${message(error)})`;
    }
}

type Why = Extract<PoolDecision, { move: null }>["why"];

const WHY: Record<Why, string> = {
    trading_off: "PREDICTIONS_TRADING is off, so the worker decides nothing.",
    stale_float: "The pool's float read is older than 3 minutes (is the server running?).",
    in_pause: "The pause after the last move has not ended.",
    float_before_move: "The pool's float has not been read since the last move.",
    in_band: "The free float is between the bands.",
    too_small: "The move needed is under the smallest automatic move.",
    halted: "Automatic moves of that direction are halted after repeated failures.",
};

/** What the worker would decide now, from the stored float and the rows; it writes nothing. */
export async function planLines(o: {
    collections: Collections;
    config: PoolConfig;
    treasuryFreeE6: () => Promise<bigint>;
    now: number;
}): Promise<string[]> {
    const { collections, config, now } = o;
    const inputs = await readDecisionInputs(collections, config, now);
    const lines = [
        `Target ${dollars(inputs.targetE6)}: the worker tops up below ${dollars((inputs.targetE6 * BigInt(BAND_LOW_PCT)) / 100n)} and drains above ${dollars((inputs.targetE6 * BigInt(BAND_HIGH_PCT)) / 100n)} of free float.`,
        inputs.freeE6 === null || inputs.floatAt === null
            ? "Free float: no float read is stored yet."
            : `Free float: ${dollars(inputs.freeE6)} (read ${ago(now - inputs.floatAt)} ago).`,
        `Automatic moves halted: ${haltedText(inputs.halted)}`,
    ];
    if (inputs.active > 0) {
        const active = await activeRow(collections);
        lines.push(
            `A pool move is already active or queued, so the worker decides nothing until it ends: ${active ? rowLine(active) : "it ended a moment ago"}`,
        );
        return lines;
    }
    if (inputs.freeE6 === null || inputs.floatAt === null) {
        lines.push("Decision: nothing. No float read is stored, so there is nothing to weigh.");
        return lines;
    }

    const decision = decidePoolMove({
        tradingOn: inputs.tradingOn,
        targetE6: inputs.targetE6,
        freeE6: inputs.freeE6,
        floatAt: inputs.floatAt,
        now,
        lastMoveAt: inputs.lastMoveAt,
        pauseMs: inputs.pauseMs,
        minMoveE6: inputs.minMoveE6,
        maxMoveE6: inputs.maxMoveE6,
        halted: inputs.halted,
    });
    if (!decision.move) {
        lines.push(`Decision: nothing. ${WHY[decision.why]}`);
        return lines;
    }

    const { direction, reason, amountE6 } = decision.move;
    lines.push(`Decision: ${direction} ${dollars(amountE6)} (${reason})`);
    let treasuryFreeE6 = 0n;
    if (direction === "arc_to_polygon") {
        try {
            treasuryFreeE6 = await o.treasuryFreeE6();
        } catch (error) {
            lines.push(`Couldn't read the treasury (${message(error)}), so the worker would not decide this move.`);
            return lines;
        }
        lines.push(`The Arc treasury has ${dollars(treasuryFreeE6)} free.`);
    }
    const plan = planPoolMove({
        direction,
        amountE6,
        maxMoveE6: inputs.maxMoveE6,
        treasuryFreeE6,
        arcReserveE6: usdToE6(config.POOL_REBALANCE_ARC_RESERVE_USD),
        movedTodayE6: direction === "arc_to_polygon" ? await movedLast24hE6(collections, now) : 0n,
        maxDayE6: usdToE6(config.POOL_REBALANCE_MAX_DAY_USD),
        freeFloatE6: inputs.freeE6,
    });
    lines.push(plan.ok ? "The limits allow it." : `The worker would skip it: ${plan.reason}`);
    return lines;
}

/** Both sides of the pool, the idle native USDC and both wallets, the active row and the last five rows; a read that fails says so. */
export async function statusLines(o: {
    collections: Collections;
    trader: Pick<PoolTrader, "balanceE6" | "usdcBalanceE6" | "derivedWallet"> | null;
    treasuryFreeE6: () => Promise<bigint>;
    now: number;
}): Promise<string[]> {
    const { collections, trader, now } = o;
    const connected = () => {
        if (!trader) throw new Error("not connected to Polymarket");
        return trader;
    };
    const lines = [await attempt("Arc treasury free", async () => dollars(await o.treasuryFreeE6()))];

    try {
        const float = await collections.poolFloat.findOne({ _id: "polygon" });
        if (!float) {
            lines.push("Pool float: no float read is stored yet (the server stores one while it runs).");
        } else {
            const balance = fromDecimal(float.balanceE6);
            const held = fromDecimal(float.heldE6);
            const unread = fromDecimal(float.unreadFillsE6);
            lines.push(
                `Pool float (read ${ago(now - float.balanceAt.getTime())} ago): balance ${dollars(balance)}, held ${dollars(held)}, unread fills ${dollars(unread)}, free ${dollars(balance - held - unread)}`,
            );
        }
    } catch (error) {
        lines.push(`Pool float: unavailable (${message(error)})`);
    }
    lines.push(
        await attempt("Pool pUSD on Polymarket now", async () => dollars(await connected().balanceE6())),
        await attempt("Idle native USDC in the pool wallet", async () => dollars(await connected().usdcBalanceE6())),
    );

    try {
        const wallet = await connected().derivedWallet();
        lines.push(
            `Pool wallet configured: ${wallet.configured}`,
            `Pool wallet derived from the pool key: ${wallet.derived}`,
        );
        if (wallet.configured.toLowerCase() !== wallet.derived.toLowerCase()) {
            lines.push("Warning: the deposit wallet in the config is not the wallet the pool key controls.");
        }
        if (!wallet.hasCode) lines.push("Warning: the derived pool wallet has no code on Polygon.");
    } catch (error) {
        lines.push(`Pool wallet: unavailable (${message(error)})`);
    }

    try {
        const [halted, active, last] = await Promise.all([
            haltedDirections(collections),
            activeRow(collections),
            collections.poolRebalances.find({}).sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
        ]);
        lines.push(
            `Automatic moves halted: ${haltedText(halted)}`,
            `Active move: ${active ? rowLine(active) : "none"}`,
            "Last five rows:",
            ...(last.length > 0 ? last.map((row) => `  ${rowLine(row)}`) : ["  none"]),
        );
    } catch (error) {
        lines.push(`Rows: unavailable (${message(error)})`);
    }
    return lines;
}

/** The treasury's free USDC in E6, the way `Withdrawals#treasuryFree` counts it: its balance less the payouts and top-ups still to be sent, and the gas reserve. */
function treasuryReader(config: Config, collections: Collections): () => Promise<bigint> {
    const arc = createArcClient(config.ARC_RPC_URLS);
    const treasury = createKeyring(config.DEPOSIT_MNEMONIC).operator().address;
    return async () => {
        const [balance, withdrawals, poolRows] = await Promise.all([
            arc.getBalance({ address: treasury }),
            collections.withdrawals.find({ state: "sending" }).toArray(),
            collections.poolRebalances.find({ direction: "arc_to_polygon", state: "sending" }).toArray(),
        ]);
        const free = balance - owedOf({ withdrawals, poolRows }) - TREASURY_GAS_RESERVE;
        return weiToE6(free > 0n ? free : 0n);
    };
}

function printQueued(what: string, result: Queued) {
    if (result.ok) {
        console.log(
            `Queued ${what} as ${result.id.toHexString()}. It waits for the server's worker, which runs only with POOL_REBALANCE=on.`,
        );
        return;
    }
    console.error(
        result.active
            ? `Another pool move is already in flight: ${rowLine(result.active)}`
            : "Another pool move was in flight a moment ago. Run this again.",
    );
    process.exitCode = 1;
}

async function main() {
    const refusal = refusalWhileOff(process.env);
    if (refusal) throw new Error(refusal);
    const command = parseCommand(process.argv.slice(2));

    const config = loadConfig();
    const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
    try {
        const { collections } = database;
        if (command.name === "move") {
            printQueued(
                `${command.direction} ${dollars(command.amountE6)}`,
                await queueMove(collections.poolRebalances, command),
            );
        } else if (command.name === "wrap-idle") {
            printQueued("a wrap of the idle native USDC", await queueWrapIdle(collections.poolRebalances));
        } else if (command.name === "resolve") {
            const resolved = await resolveRow(collections.poolRebalances, command.id, command.outcome);
            console.log(resolved ? `Marked ${command.outcome}.` : "No stuck row has that id.");
            if (!resolved) process.exitCode = 1;
        } else if (command.name === "plan") {
            const treasuryFreeE6 = treasuryReader(config, collections);
            const lines = await planLines({ collections, config, treasuryFreeE6, now: Date.now() });
            for (const line of lines) console.log(line);
        } else {
            const treasuryFreeE6 = treasuryReader(config, collections);
            let trader: PoolTrader | null = null;
            try {
                trader = withTimeouts(
                    await createPolymarketTrader(config, pino({ level: "warn" }, process.stderr)),
                    TRADER_CALL_MS,
                );
            } catch (error) {
                console.error(`Couldn't connect to Polymarket: ${message(error)}`);
            }
            for (const line of await statusLines({ collections, trader, treasuryFreeE6, now: Date.now() })) {
                console.log(line);
            }
        }
    } finally {
        await database.close();
    }
}

if (import.meta.main) {
    await main().catch((error: unknown) => {
        console.error(message(error));
        process.exitCode = 1;
    });
}
