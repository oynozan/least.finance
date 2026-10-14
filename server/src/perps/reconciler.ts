import { setTimeout as sleep } from "node:timers/promises";
import type { Address } from "viem";
import type { Logger } from "pino";
import type { Keyring } from "../accounts/keyring.ts";
import type { ArcClient } from "../chain/arc.ts";
import type { Config } from "../config.ts";
import type { Collections, PerpOrderDoc } from "../db/mongo.ts";
import { fromDecimal, weiToE6 } from "../db/money.ts";
import { nextNonce, type AccountState, type HyperliquidClient } from "./client.ts";
import { ACTIVATION_E6 } from "./float.ts";
import { ourFeeOf } from "./math.ts";

export const RECONCILE_EVERY_MS = 600_000;
/** An idle address holding more than this is a stuck sweep. */
const STUCK_E6 = 1_000_000n;
const ARC_READS_AT_ONCE = 10;

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
    config: Pick<Config, "PERPS_RECONCILE_TOLERANCE_USD" | "PERPS_FEE_BPS">;
    /** The wei held on Arc: the treasury and the deposit addresses not yet swept into it. */
    arcAssets: () => Promise<bigint>;
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

    async run(): Promise<ReconcileReport> {
        const { collections, client, keyring, logger, config } = this.#deps;
        const { perpAccounts, perpPositions, perpOrders, perpRebalances, accounts, perpFloat } = collections;
        const [people, positions, orders] = await Promise.all([
            perpAccounts.find().toArray(),
            perpPositions.find({ active: true }).toArray(),
            perpOrders.find().toArray(),
        ]);
        const rate = config.PERPS_FEE_BPS / 10_000;
        const feeOf = (o: PerpOrderDoc) => ourFeeOf(fromDecimal(o.notionalE6), rate);
        const keptBy = new Map<number, bigint>();
        let ourFeeE6 = 0n;
        for (const o of orders) {
            if (o.kind !== "open" || o.state !== "filled") continue;
            keptBy.set(o.index, (keptBy.get(o.index) ?? 0n) + feeOf(o));
            ourFeeE6 += feeOf(o);
        }
        const moving = new Set(
            orders.filter((o) => ["placing", "funding", "posted", "sweeping"].includes(o.state)).map((o) => o.index),
        );
        const activationE6 = BigInt(people.filter((p) => p.activatedAt).length) * ACTIVATION_E6;

        let mismatches = 0;
        let swept = 0;
        let readable = true;
        let accountValueE6 = 0n;
        const states = new Map<number, AccountState | null>();
        for (const person of people) {
            try {
                const state = await client.state(person.address);
                states.set(person.index, state);
                accountValueE6 += state?.accountValueE6 ?? 0n;
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
            if (!state || holding.has(person.index) || moving.has(person.index) || state.positions.length > 0) continue;
            const stuck = state.withdrawableE6 - (keptBy.get(person.index) ?? 0n);
            if (stuck <= STUCK_E6) continue;
            try {
                const sent = await client.usdSend(
                    keyring.perpSignerAt(person.index),
                    keyring.perpAddressAt(0),
                    stuck,
                    nextNonce(person.address),
                );
                if (sent.kind !== "ok") throw new Error(sent.kind === "rejected" ? sent.message : "duplicate nonce");
                swept++;
                accountValueE6 -= stuck;
                logger.warn(
                    { index: person.index, address: person.address, amountE6: stuck.toString() },
                    "Swept a stuck balance to the master",
                );
            } catch (error) {
                logger.error({ err: error, index: person.index }, "Couldn't sweep a stuck balance to the master");
            }
        }

        let shortfallE6 = 0n;
        if (readable) {
            const [arc, master, floatDoc, inFlight, owed] = await Promise.all([
                this.#deps.arcAssets(),
                client.state(keyring.perpAddressAt(0)),
                perpFloat.findOne({ _id: "hyperliquid" }),
                perpRebalances.find({ state: "sent" }).toArray(),
                accounts
                    .aggregate<{ total: { toString(): string } }>([
                        { $group: { _id: null, total: { $sum: "$balance" } } },
                    ])
                    .toArray(),
            ]);
            const sentE6 = inFlight.reduce((sum, row) => sum + fromDecimal(row.amountE6), 0n);
            const assets = weiToE6(arc) + (master?.accountValueE6 ?? 0n) + accountValueE6 + sentE6;
            const liabilities =
                weiToE6(BigInt(owed[0]?.total.toString() ?? "0")) + (floatDoc ? fromDecimal(floatDoc.heldE6) : 0n);
            if (liabilities > assets) shortfallE6 = liabilities - assets;
            const tolerance = BigInt(Math.round(config.PERPS_RECONCILE_TOLERANCE_USD * 1e6));
            if (shortfallE6 > tolerance) {
                logger.error(
                    {
                        shortfallE6: shortfallE6.toString(),
                        assetsE6: assets.toString(),
                        liabilitiesE6: liabilities.toString(),
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
