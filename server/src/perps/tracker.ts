import { setTimeout as sleep } from "node:timers/promises";
import type { ObjectId } from "mongodb";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Collections, PerpOrderDoc, PerpPositionDoc } from "../db/mongo.ts";
import { fromDecimal, toDecimal } from "../db/money.ts";
import type { Bus } from "../events.ts";
import type { AccountState, HyperliquidClient } from "./client.ts";
import type { PerpService } from "./perps.ts";

/** How often a viewer's address is read. */
const VIEWER_MS = 5_000;
/** The least time between reads of an address nobody is watching. */
const OTHER_MS = 10_000;
/** The slow lap that rereads fills for every address. */
const FILLS_LAP_MS = 600_000;
const PASS_MS = 1_000;
/** Half of Hyperliquid's 1200 weight a minute. */
const BUDGET_PER_MINUTE = 600;
const BUDGET_CAP = 120;
const STATE_WEIGHT = 2;
const FILLS_WEIGHT = 20;
const ORDER_WEIGHT = 2;
/** A close still placing this long after it was made was never sent. */
const PLACING_GIVE_UP_MS = 60_000;
const ORDER_RETRY_MS = 5_000;

type Deps = {
    service: PerpService;
    client: HyperliquidClient;
    collections: Collections;
    config: Pick<Config, "PERPS_TRADING">;
    logger: Logger;
    bus: Bus;
    /** The clock, for tests. */
    now?: () => number;
};

/** Races a lookup against the stop signal, so a hung call can't hold shutdown. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(new Error("stopped"));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("stopped"));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

/** Follows open perp positions and unsettled orders, and settles what happened outside the app. It runs whether or not trading is on. */
export class PerpTracker {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #viewers = new Map<string, number>();
    readonly #polled = new Map<string, number>();
    readonly #fillsAt = new Map<string, number>();
    readonly #orderAt = new Map<string, number>();
    readonly #addresses = new Map<number, string>();
    #budget = BUDGET_CAP;
    #budgetAt: number | null = null;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start(): void {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            while (!signal.aborted) {
                try {
                    await this.pass(this.#now(), signal);
                } catch (error) {
                    if (!signal.aborted) this.#deps.logger.warn({ err: error }, "Perp tracking pass failed");
                }
                await sleep(PASS_MS, undefined, { signal }).catch(() => undefined);
            }
        })();
    }

    async stop(): Promise<void> {
        this.#stop?.abort();
        const loop = this.#loop;
        this.#loop = null;
        this.#stop = null;
        await loop;
    }

    /** Marks a person's sidebar open or closed; their address is read every 5 seconds while it is. */
    viewing(accountId: ObjectId, on: boolean): void {
        const key = accountId.toHexString();
        const count = (this.#viewers.get(key) ?? 0) + (on ? 1 : -1);
        if (count > 0) this.#viewers.set(key, count);
        else this.#viewers.delete(key);
    }

    /** One pass at time `at`: the orders in doubt, then the addresses that are due. */
    async pass(at: number, signal?: AbortSignal): Promise<void> {
        await this.#orders(at, signal);
        await this.#positions(at, signal);
    }

    async #orders(at: number, signal: AbortSignal | undefined): Promise<void> {
        const orders = await this.#deps.collections.perpOrders
            .find({
                $or: [
                    { kind: "open", state: { $in: ["posted", "sweeping"] } },
                    { kind: "close", state: { $in: ["placing", "posted", "sweeping"] } },
                ],
            })
            .sort({ _id: 1 })
            .limit(100)
            .toArray();
        for (const order of orders) {
            if (signal?.aborted) return;
            const key = order._id.toHexString();
            if (this.#deps.service.submitting(order._id)) continue;
            if (
                order.kind === "close" &&
                order.state === "placing" &&
                this.#now() - order.createdAt.getTime() < PLACING_GIVE_UP_MS
            )
                continue;
            if (at - (this.#orderAt.get(key) ?? -Infinity) < ORDER_RETRY_MS) continue;
            this.#orderAt.set(key, at);
            this.#spend(ORDER_WEIGHT);
            try {
                await abortable(this.#settle(order), signal);
            } catch (error) {
                if (!signal?.aborted)
                    this.#deps.logger.warn({ err: error, order: key }, "Couldn't follow a perp order");
            }
        }
    }

    #settle(order: PerpOrderDoc): Promise<void> {
        const { service } = this.#deps;
        if (order.kind === "close") return service.settleClose(order);
        return order.state === "posted" ? service.settlePosted(order) : service.retrySweep(order);
    }

    #spend(weight: number): void {
        this.#budget -= weight;
    }

    async #positions(at: number, signal: AbortSignal | undefined): Promise<void> {
        this.#budget = Math.min(
            BUDGET_CAP,
            this.#budget + ((at - (this.#budgetAt ?? at)) / 60_000) * BUDGET_PER_MINUTE,
        );
        this.#budgetAt = at;
        const positions = await this.#deps.collections.perpPositions.find({ active: true }).toArray();
        if (positions.length === 0) return;
        const byIndex = new Map<number, PerpPositionDoc[]>();
        for (const position of positions)
            byIndex.set(position.index, [...(byIndex.get(position.index) ?? []), position]);
        const addresses = await this.#addressesOf([...byIndex.keys()]);

        const due: Array<{ index: number; address: string; viewed: boolean }> = [];
        for (const [index, list] of byIndex) {
            const address = addresses.get(index);
            if (!address) continue;
            const viewed = list.some((p) => this.#viewers.has(p.accountId.toHexString()));
            const last = this.#polled.get(address) ?? -Infinity;
            if (at - last >= (viewed ? VIEWER_MS : OTHER_MS)) due.push({ index, address, viewed });
        }
        // Viewers first, then the longest unread
        due.sort(
            (a, b) =>
                Number(b.viewed) - Number(a.viewed) ||
                (this.#polled.get(a.address) ?? -Infinity) - (this.#polled.get(b.address) ?? -Infinity),
        );
        for (const target of due) {
            if (signal?.aborted) return;
            if (!target.viewed && this.#budget < STATE_WEIGHT) break;
            this.#polled.set(target.address, at);
            this.#spend(STATE_WEIGHT);
            try {
                await abortable(this.#poll(target.address, byIndex.get(target.index)!, at, signal), signal);
            } catch (error) {
                if (!signal?.aborted)
                    this.#deps.logger.warn({ err: error, address: target.address }, "Couldn't read a perp account");
            }
        }
    }

    async #addressesOf(indexes: number[]): Promise<Map<number, string>> {
        const missing = indexes.filter((index) => !this.#addresses.has(index));
        if (missing.length > 0) {
            const rows = await this.#deps.collections.perpAccounts.find({ index: { $in: missing } }).toArray();
            for (const row of rows) this.#addresses.set(row.index, row.address);
        }
        return this.#addresses;
    }

    /** Reads an address once: settles positions that vanished or shrank, otherwise writes each position's snapshot. */
    async #poll(
        address: string,
        positions: PerpPositionDoc[],
        at: number,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        const state = await this.#deps.client.state(address);
        const lapDue = at - (this.#fillsAt.get(address) ?? at) >= FILLS_LAP_MS;
        if (!this.#fillsAt.has(address)) this.#fillsAt.set(address, at);
        for (const position of positions) {
            const real = state?.positions.find((p) => p.asset === position.asset);
            const shrunk = !real || Number(real.sizeCoin) < Number(position.sizeCoin) - 1e-9;
            if (position.state === "open" && shrunk) {
                await this.#outside(address, position, state, signal);
                continue;
            }
            if (real) await this.#snapshot(position, real);
            if (lapDue && position.state === "open") {
                const fills = await this.#fillsOf(address, position);
                if (fills.some((f) => f.liquidation)) await this.#deps.service.settleOutside(position, fills, state);
            }
        }
        if (lapDue) this.#fillsAt.set(address, at);
    }

    async #fillsOf(address: string, position: PerpPositionDoc) {
        this.#spend(FILLS_WEIGHT);
        return this.#deps.client.fills(address, position.openedAt.getTime());
    }

    async #outside(
        address: string,
        position: PerpPositionDoc,
        state: AccountState | null,
        signal: AbortSignal | undefined,
    ) {
        const fills = await abortable(this.#fillsOf(address, position), signal);
        await this.#deps.service.settleOutside(position, fills, state);
    }

    /** Writes the poll onto the position and announces it when something other than the mark changed. */
    async #snapshot(position: PerpPositionDoc, real: AccountState["positions"][number]): Promise<void> {
        const { perpPositions, perpOrders, accounts } = this.#deps.collections;
        const mark = this.#deps.service.markOf(position.asset) ?? Number(real.entryPx);
        const before = position.snapshot;
        const snapshot = {
            markPx: String(Number(mark.toPrecision(7))),
            unrealizedPnlE6: toDecimal(real.unrealizedPnlE6),
            liquidationPx: real.liquidationPx,
            cumFundingE6: toDecimal(real.cumFundingE6),
            at: new Date(this.#now()),
        };
        const changed =
            !before ||
            before.liquidationPx !== snapshot.liquidationPx ||
            fromDecimal(before.cumFundingE6) !== real.cumFundingE6;
        const updated = await perpPositions.findOneAndUpdate(
            { _id: position._id, active: true },
            { $set: changed ? { snapshot, updatedAt: snapshot.at } : { snapshot } },
            { returnDocument: "after" },
        );
        if (!updated || !changed) return;
        const [order, account] = await Promise.all([
            perpOrders.findOne({
                accountId: position.accountId,
                kind: "open",
                "steps.positionId": position._id.toHexString(),
            }),
            accounts.findOne({ _id: position.accountId }),
        ]);
        if (order && account) this.#deps.bus.emit("perp:updated", { order, position: updated, account });
    }
}
