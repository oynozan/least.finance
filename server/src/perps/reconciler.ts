import { setTimeout as sleep } from "node:timers/promises";
import type { Address } from "viem";
import type { Logger } from "pino";
import type { Keyring } from "../accounts/keyring.ts";
import type { ArcClient } from "../chain/arc.ts";
import type { Config } from "../config.ts";
import type { Collections } from "../db/mongo.ts";
import { fromDecimal, weiToE6 } from "../db/money.ts";
import { nextNonce, type AccountState, type HyperliquidClient } from "./client.ts";
import { ACTIVATION_E6 } from "./float.ts";

export const RECONCILE_EVERY_MS = 600_000;
/** An idle address holding more than this is a stuck sweep. */
const STUCK_E6 = 1_000_000n;
const ARC_READS_AT_ONCE = 10;
/** A rebalance still `sent` after this long is no longer money in flight. */
const IN_FLIGHT_MAX_MS = 3_600_000;

export type ReconcileReport = {
    mismatches: number;
    swept: number;
    shortfallE6: bigint;
    activationE6: bigint;
    ourFeeE6: bigint;
};

type Deps = {
    collections: Collections;
    client: Pick<HyperliquidClient, "state" | "usdSend">;
    keyring: Pick<Keyring, "perpSignerAt" | "perpAddressAt">;
    logger: Logger;
    config: Pick<Config, "PERPS_RECONCILE_TOLERANCE_USD">;
    /** Runs a step that reads a perp address and then moves its money, one at a time per index. */
    withIndexLock: <T>(index: number, fn: () => Promise<T>) => Promise<T>;
    /** The wei held on Arc: the treasury and the deposit addresses not yet swept into it. */
    arcAssets: () => Promise<bigint>;
    /** The pool's USDC in E6 (free float, idle wallet USDC, moves in flight); `stale` makes a shortfall a warning. */
    poolAssets?: () => Promise<{ assetsE6: bigint; stale: boolean }>;
};

/** The Arc treasury plus every deposit address, in wei. */
export function arcHoldings(o: {
    client: ArcClient;
    treasury: Address;
    collections: Collections;
}): () => Promise<bigint> {
    return async () => {
        const addresses = [
            o.treasury,
            ...(await o.collections.accounts.find({}, { projection: { depositAddress: 1 } }).toArray()).map(
                (account) => account.depositAddress as Address,
            ),
        ];
        let total = 0n;
        for (let at = 0; at < addresses.length; at += ARC_READS_AT_ONCE) {
            const balances = await Promise.all(
                addresses.slice(at, at + ARC_READS_AT_ONCE).map((address) => o.client.getBalance({ address })),
            );
            for (const balance of balances) total += balance;
        }
        return total;
    };
}

const sameSize = (a: string, b: string) => Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(Number(a), Number(b), 1);

/** Compares Hyperliquid with the books every ten minutes; it logs what is wrong and moves nothing but a stuck balance back to the master. */
export class PerpReconciler {
    readonly #deps: Deps;
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
                await sleep(RECONCILE_EVERY_MS, undefined, { signal }).catch(() => undefined);
                if (signal.aborted) break;
                await this.run().catch((error: unknown) =>
                    this.#deps.logger.warn({ err: error }, "Perp reconciliation failed"),
                );
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

    /** Whether an order or a position of the index exists now, read fresh so a trade begun since the snapshot isn't swept. */
    async #busy(index: number): Promise<boolean> {
        const { perpOrders, perpPositions } = this.#deps.collections;
        const [order, position] = await Promise.all([
            perpOrders.findOne({ index, state: { $in: ["placing", "funding", "posted", "sweeping"] } }),
            perpPositions.findOne({ index, active: true }),
        ]);
        return order !== null || position !== null;
    }

    /** Re-reads the address under its lock and sends what is above the kept fee to the master; returns what moved. */
    async #sweepStuck(person: { index: number; address: string }): Promise<bigint> {
        const { client, keyring } = this.#deps;
        if (await this.#busy(person.index)) return 0n;
        const [state, row] = await Promise.all([
            client.state(person.address),
            this.#deps.collections.perpAccounts.findOne({ index: person.index }),
        ]);
        if (!state || state.positions.length > 0) return 0n;
        const stuck = state.withdrawableE6 - (row?.retainedE6 ? fromDecimal(row.retainedE6) : 0n);
        if (stuck <= STUCK_E6) return 0n;
        const sent = await client.usdSend(
            keyring.perpSignerAt(person.index),
            keyring.perpAddressAt(0),
            stuck,
            nextNonce(person.address),
        );
        if (sent.kind !== "ok") throw new Error(sent.kind === "rejected" ? sent.message : "duplicate nonce");
        return stuck;
    }

    async run(): Promise<ReconcileReport> {
        const { collections, client, keyring, logger, config } = this.#deps;
        const { perpAccounts, perpPositions, perpOrders, perpRebalances, accounts, perpFloat } = collections;
        const [people, positions, orders] = await Promise.all([
            perpAccounts.find().toArray(),
            perpPositions.find({ active: true }).toArray(),
            perpOrders.find().toArray(),
        ]);
        const retainedBy = new Map(people.map((p) => [p.index, p.retainedE6 ? fromDecimal(p.retainedE6) : 0n]));
        const ourFeeE6 = [...orders]
            .filter((o) => o.kind === "open" && o.state === "filled")
            .reduce((sum, o) => sum + BigInt(String(o.steps.ourFeeE6 ?? "0")), 0n);
        const moving = new Set(
            orders.filter((o) => ["placing", "funding", "posted", "sweeping"].includes(o.state)).map((o) => o.index),
        );
        const activationE6 = BigInt(people.filter((p) => p.activatedAt).length) * ACTIVATION_E6;

        let mismatches = 0;
        let swept = 0;
        let readable = true;
        const valueBy = new Map<number, bigint>();
        const states = new Map<number, AccountState | null>();
        for (const person of people) {
            try {
                const state = await client.state(person.address);
                states.set(person.index, state);
                valueBy.set(person.index, state?.accountValueE6 ?? 0n);
            } catch (error) {
                readable = false;
                logger.warn({ err: error, index: person.index }, "Couldn't read a Hyperliquid account to reconcile");
            }
        }

        for (const position of positions) {
            if (moving.has(position.index) || !states.has(position.index)) continue;
            const real = states.get(position.index)?.positions.find((p) => p.asset === position.asset);
            if (real && real.side === position.side && sameSize(real.sizeCoin, position.sizeCoin)) continue;
            mismatches++;
            logger.error(
                { index: position.index, asset: position.asset, side: position.side, size: position.sizeCoin, real },
                "A position doesn't match its Hyperliquid account",
            );
        }

        const holding = new Set(positions.map((p) => p.index));
        for (const person of people) {
            const state = states.get(person.index);
            if (!state || moving.has(person.index)) continue;
            for (const real of state.positions) {
                if (positions.some((p) => p.index === person.index && p.asset === real.asset)) continue;
                logger.error(
                    { index: person.index, asset: real.asset, side: real.side, size: real.sizeCoin },
                    "A Hyperliquid position has no active record",
                );
            }
            if (holding.has(person.index) || state.positions.length > 0) continue;
            if (state.withdrawableE6 - (retainedBy.get(person.index) ?? 0n) <= STUCK_E6) continue;
            try {
                const moved = await this.#deps.withIndexLock(person.index, () => this.#sweepStuck(person));
                if (moved === 0n) continue;
                swept++;
                valueBy.set(person.index, (valueBy.get(person.index) ?? 0n) - moved);
                logger.warn(
                    { index: person.index, address: person.address, amountE6: moved.toString() },
                    "Swept a stuck balance to the master",
                );
            } catch (error) {
                logger.error({ err: error, index: person.index }, "Couldn't sweep a stuck balance to the master");
            }
        }

        let shortfallE6 = 0n;
        if (readable) {
            const [arc, master, floatDoc, inFlight, owed, pool] = await Promise.all([
                this.#deps.arcAssets(),
                client.state(keyring.perpAddressAt(0)),
                perpFloat.findOne({ _id: "hyperliquid" }),
                perpRebalances.find({ state: "sent" }).toArray(),
                accounts
                    .aggregate<{ total: { toString(): string } }>([
                        { $group: { _id: null, total: { $sum: "$balance" } } },
                    ])
                    .toArray(),
                this.#deps.poolAssets?.() ?? { assetsE6: 0n, stale: false },
            ]);
            const fresh = inFlight.filter((row) => Date.now() - row.createdAt.getTime() < IN_FLIGHT_MAX_MS);
            for (const row of inFlight) {
                if (fresh.includes(row)) continue;
                logger.error(
                    { rebalanceId: row._id.toHexString(), amountE6: fromDecimal(row.amountE6).toString() },
                    "A rebalance has been sent for over an hour; mark it arrived once it has",
                );
            }
            const sentE6 = fresh.reduce((sum, row) => sum + fromDecimal(row.amountE6), 0n);
            // A person's Hyperliquid money is theirs: only the kept fee, and a balance nobody holds a trade on, is ours
            let peopleOursE6 = 0n;
            for (const person of people) {
                const value = valueBy.get(person.index) ?? 0n;
                const retained = retainedBy.get(person.index) ?? 0n;
                const idle = !holding.has(person.index) && !moving.has(person.index);
                const open = (states.get(person.index)?.positions.length ?? 0) > 0;
                peopleOursE6 += idle && !open ? value : value < retained ? value : retained;
            }
            const assets = weiToE6(arc) + (master?.accountValueE6 ?? 0n) + peopleOursE6 + sentE6 + pool.assetsE6;
            const liabilities =
                weiToE6(BigInt(owed[0]?.total.toString() ?? "0")) + (floatDoc ? fromDecimal(floatDoc.heldE6) : 0n);
            if (liabilities > assets) shortfallE6 = liabilities - assets;
            const tolerance = BigInt(Math.round(config.PERPS_RECONCILE_TOLERANCE_USD * 1e6));
            if (shortfallE6 > tolerance) {
                logger[pool.stale ? "warn" : "error"](
                    {
                        shortfallE6: shortfallE6.toString(),
                        assetsE6: assets.toString(),
                        liabilitiesE6: liabilities.toString(),
                        poolAssetsE6: pool.assetsE6.toString(),
                        poolStale: pool.stale,
                    },
                    "Solvency shortfall: the assets don't cover what people are owed",
                );
            }
        }

        const report = { mismatches, swept, shortfallE6, activationE6, ourFeeE6 };
        logger.info(
            {
                mismatches,
                swept,
                shortfallE6: shortfallE6.toString(),
                activationE6: activationE6.toString(),
                ourFeeE6: ourFeeE6.toString(),
            },
            "Perp reconciliation",
        );
        return report;
    }
}
