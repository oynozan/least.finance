import { setTimeout as sleep } from "node:timers/promises";
import type { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import type { Collections, DepositOrderDoc } from "../db/mongo.ts";
import { brief, refOf } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { OrderState } from "../protocol.ts";
import { coinByKey } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
import { orderFailureMessage, type OrderFailureInput } from "./failures.ts";
import { GIVE_UP_MS } from "./orders.ts";
import type { BridgeProvider } from "./providers/types.ts";
import type { SolanaRpc } from "./solana.ts";

const DEFAULT_EXPIRY_MS = 600_000;
const OPEN: OrderState[] = ["created", "sent", "in_block", "bridging"];
/** Polled on every pass for the first minute, every 15 s up to 10 minutes, then every minute. */
const FAST_AGE_MS = 60_000;
const SLOW_AGE_MS = 600_000;
const SLOW_POLL_MS = 15_000;
const SLOWEST_POLL_MS = 60_000;
/** Status requests in flight at once. */
const CONCURRENCY = 8;
/** A stuck order's failed status check is logged at most this often. */
const REPEAT_LOG_MS = 600_000;

type Deps = {
    collections: Collections;
    providers: readonly BridgeProvider[];
    sources: SourceClients;
    solana: SolanaRpc;
    bus: Bus;
    logger: Logger;
    pollMs: number;
    expiryMs?: number;
    /** Resolves once the order's last report has been announced. */
    announced?: (orderId: ObjectId) => Promise<void>;
    /** The clock, for tests. */
    now?: () => number;
};

/** How long to leave an order of this age between status requests. */
const pollInterval = (ageMs: number) =>
    ageMs < FAST_AGE_MS ? 0 : ageMs < SLOW_AGE_MS ? SLOW_POLL_MS : SLOWEST_POLL_MS;

/** Follows each open deposit order from the source chain across the bridge, and announces every step. */
export class OrderTracker {
    readonly #deps: Deps;
    readonly #expiryMs: number;
    readonly #now: () => number;
    /** When each open order was last followed. */
    readonly #polled = new Map<string, number>();
    /** When each order whose status check is failing was last logged. */
    readonly #failing = new Map<string, number>();
    /** Orders already logged as ones this tracker can't follow. */
    readonly #unfollowed = new Set<string>();
    #failedPasses = 0;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
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
                this.#failedPasses = 0;
            } catch (error) {
                // Logged on the 1st, 2nd, 4th, 8th... failed pass in a row, so a database that is down doesn't fill the log
                this.#failedPasses += 1;
                if ((this.#failedPasses & (this.#failedPasses - 1)) === 0) {
                    this.#deps.logger.warn(
                        {
                            op: "deposit.order.list",
                            err: error,
                            pollMs: this.#deps.pollMs,
                            consecutiveFailures: this.#failedPasses,
                        },
                        "Couldn't list open deposit orders",
                    );
                }
            }
            await sleep(this.#deps.pollMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass over the open orders that are due; an error on one leaves it as it was and doesn't stop the others. */
    async tick(): Promise<void> {
        const now = this.#now();
        const orders = await this.#deps.collections.depositOrders
            .find({
                state: { $in: OPEN },
                $or: [{ state: { $in: ["created", "sent"] } }, { updatedAt: { $gt: new Date(now - GIVE_UP_MS) } }],
            })
            .toArray();
        const ids = new Set(orders.map((order) => order._id.toHexString()));
        for (const id of this.#polled.keys()) if (!ids.has(id)) this.#polled.delete(id);
        for (const id of this.#failing.keys()) if (!ids.has(id)) this.#failing.delete(id);

        const due = orders.filter((order) => {
            const id = order._id.toHexString();
            if (now - (this.#polled.get(id) ?? -Infinity) < pollInterval(now - order.createdAt.getTime())) return false;
            this.#polled.set(id, now);
            return true;
        });
        let next = 0;
        const worker = async () => {
            for (let order = due[next++]; order; order = due[next++]) {
                await this.#step(order).then(
                    () => this.#recovered(order),
                    (error: unknown) => this.#couldntFollow(order, error, now),
                );
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
    }

    /** Says once per 10 minutes that an order's status can't be read, with what it is and why. */
    #couldntFollow(order: DepositOrderDoc, error: unknown, now: number) {
        const id = order._id.toHexString();
        const last = this.#failing.get(id);
        if (last !== undefined && now - last < REPEAT_LOG_MS) return;
        this.#failing.set(id, now);
        this.#deps.logger.warn(
            {
                op: "deposit.order.follow",
                orderId: id,
                accountId: order.accountId.toHexString(),
                provider: order.provider,
                coin: order.coin,
                state: order.state,
                sourceTx: order.sourceTxHashes.at(-1) ?? null,
                ageMs: now - order.createdAt.getTime(),
                err: error,
            },
            "Couldn't check a deposit order's status",
        );
    }

    #recovered(order: DepositOrderDoc) {
        const id = order._id.toHexString();
        if (!this.#failing.delete(id)) return;
        this.#deps.logger.info(
            {
                op: "deposit.order.follow",
                orderId: id,
                accountId: order.accountId.toHexString(),
                provider: order.provider,
            },
            "A deposit order's status can be read again",
        );
    }

    /** Says once that an order is one this tracker can't follow, and why. */
    #cantFollow(order: DepositOrderDoc, why: string, fields: object) {
        const id = order._id.toHexString();
        if (this.#unfollowed.has(id)) return;
        this.#unfollowed.add(id);
        this.#deps.logger.error(
            {
                op: "deposit.order.unfollowed",
                orderId: id,
                accountId: order.accountId.toHexString(),
                provider: order.provider,
                coin: order.coin,
                state: order.state,
                ...fields,
            },
            why,
        );
    }

    async #step(order: DepositOrderDoc) {
        if (order.state === "sent") return this.#checkSource(order);
        return this.#checkBridge(order);
    }

    /** The receipt (EVM) or signature status (Solana) of the last transaction decides whether the order is in a block. */
    async #checkSource(order: DepositOrderDoc) {
        const hash = order.sourceTxHashes.at(-1) as Hex;
        const chain = coinByKey(order.coin).chain;
        if (chain === "solana") return this.#checkSolanaSource(order, hash);
        if (chain !== "ethereum" && chain !== "bnb") {
            return this.#cantFollow(order, "Deposit order is on a chain the tracker does not follow", { chain });
        }
        const client = this.#deps.sources[chain];
        const receipt = await this.#receipt(client, hash);
        if (receipt?.status === "success") await this.#move(order, "in_block");
        else if (receipt) {
            const detail = `reverted in block ${receipt.blockNumber} (${hash})`;
            await this.#move(order, "failed", {}, { code: "source_reverted", detail });
        }
        // A slow transaction can still be mined, so one with no receipt is followed until it is replaced or the order is given up on.
        else if (this.#now() - order.updatedAt.getTime() > GIVE_UP_MS) {
            await this.#move(
                order,
                "failed",
                {},
                { code: "given_up", detail: `no receipt for ${hash} after 24 hours` },
            );
        } else if (await this.#replaced(client, hash)) {
            const detail = `${hash} was replaced by another transaction with the same nonce`;
            await this.#move(order, "failed", {}, { code: "source_replaced", detail });
        }
    }

    /** The transaction's receipt, or null while the node has none. */
    async #receipt(client: PublicClient, hash: Hex) {
        return client.getTransactionReceipt({ hash }).catch((error: unknown) => {
            if (error instanceof TransactionReceiptNotFoundError) return null;
            throw error;
        });
    }

    /** True when the transaction is pending but its sender has since mined another one with the same nonce. */
    async #replaced(client: PublicClient, hash: Hex) {
        const tx = await client.getTransaction({ hash }).catch((error: unknown) => {
            if (error instanceof TransactionNotFoundError) return null;
            throw error;
        });
        // A node that doesn't know it may just not have heard of it yet, so that isn't proof.
        if (!tx || tx.blockNumber !== null) return false;
        if ((await client.getTransactionCount({ address: tx.from })) <= tx.nonce) return false;
        // The nonce may have been spent by this very transaction landing since the receipt was read.
        return (await this.#receipt(client, hash)) === null;
    }

    /** A confirmed or finalized signature is in a block; one that errored failed; an unknown one fails once it is old. */
    async #checkSolanaSource(order: DepositOrderDoc, signature: string) {
        const [status] = await this.#deps.solana.getSignatureStatuses([signature]);
        if (status?.err) {
            const detail = brief(JSON.stringify(status.err), 200);
            await this.#move(order, "failed", {}, { code: "source_failed", detail });
        } else if (status && status.confirmationStatus !== "processed") await this.#move(order, "in_block");
        else if (!status && this.#now() - order.updatedAt.getTime() > this.#expiryMs) {
            const detail = `signature ${signature} unknown to the cluster for ${Math.round(this.#expiryMs / 60_000)} minutes`;
            await this.#move(order, "failed", {}, { code: "source_not_found", detail });
        }
    }

    async #checkBridge(order: DepositOrderDoc) {
        const provider = this.#deps.providers.find((p) => p.name === order.provider);
        if (!provider) {
            const configured = this.#deps.providers.map((p) => p.name);
            return this.#cantFollow(order, "Deposit order uses a bridge that is not configured", { configured });
        }
        const hash = order.sourceTxHashes.at(-1) ?? null;
        const status = await provider.status({ ref: order.ref }, hash, coinByKey(order.coin));

        if (order.state === "created") {
            if (status.stage !== "waiting") await this.#move(order, "bridging");
            else if (this.#now() - order.createdAt.getTime() > this.#expiryMs) {
                const detail = `no transaction reported within ${Math.round(this.#expiryMs / 60_000)} minutes`;
                await this.#move(order, "expired", {}, { code: "expired", detail });
            }
            return;
        }
        if (status.stage === "pending") {
            if (order.state === "in_block") await this.#move(order, "bridging");
            await this.#note(order, status.detail);
        } else if (status.stage === "refunded" || status.stage === "failed") {
            const refunded = status.stage === "refunded";
            await this.#move(
                order,
                refunded ? "refunded" : "failed",
                {},
                { code: refunded ? "bridge_refunded" : "bridge_failed", detail: status.detail ?? "" },
            );
        } else if (status.stage === "filled") {
            const fill = (order.fillTxHash ?? status.fillTxHash)?.toLowerCase();
            if (fill) await this.#deliver(order, fill, hash);
        }
    }

    /** Links the credited deposit of the fill to the order; until the watcher has credited it, only the hash is kept. */
    async #deliver(order: DepositOrderDoc, fill: string, sourceHash: string | null) {
        const { deposits } = this.#deps.collections;
        const deposit = await deposits.findOne({ accountId: order.accountId, txHash: fill });
        if (!deposit || (deposit.origin && !deposit.origin.orderId.equals(order._id))) {
            // Filled but not yet credited here: an order still counted as in a block is now waiting on the bridge's payout.
            const waiting = order.state === "in_block" ? "bridging" : order.state;
            if (order.fillTxHash === null || waiting !== order.state)
                await this.#move(order, waiting, { fillTxHash: fill });
            return;
        }
        if (!deposit.origin) {
            const origin = { coin: order.coin, amount: order.amount, txHash: sourceHash ?? fill, orderId: order._id };
            const set = await deposits.updateOne(
                { _id: deposit._id, origin: { $exists: false } },
                { $set: { origin } },
            );
            if (set.modifiedCount === 0) return;
        }
        await this.#move(order, "delivered", { fillTxHash: fill, depositId: deposit._id });
    }

    /** Keeps what a bridge says about an order that is still open, such as a hold, so the person can read it. */
    async #note(order: DepositOrderDoc, note: string | undefined) {
        if (!note || note === order.note) return;
        const moved = await this.#deps.collections.depositOrders.findOneAndUpdate(
            { _id: order._id, state: order.state },
            { $set: { note } },
            { returnDocument: "after" },
        );
        if (!moved) return;
        await this.#deps.announced?.(order._id);
        this.#deps.bus.emit("order:updated", { order: moved });
    }

    /** A conditional update on the state the order was read in; only one that lands is announced and logged. */
    async #move(
        order: DepositOrderDoc,
        state: OrderState,
        set: Partial<DepositOrderDoc> = {},
        failure?: OrderFailureInput,
    ) {
        const reason = failure && {
            ...failure,
            message: orderFailureMessage(
                { provider: order.provider, coin: coinByKey(order.coin), ref: refOf(order._id) },
                failure,
                Math.round(this.#expiryMs / 60_000),
            ),
            at: new Date(),
        };
        const moved = await this.#deps.collections.depositOrders.findOneAndUpdate(
            { _id: order._id, state: order.state },
            {
                $set: { ...set, ...(reason && { failure: reason }), state, updatedAt: new Date() },
                ...(order.note !== undefined && { $unset: { note: "" as const } }),
            },
            { returnDocument: "after" },
        );
        if (!moved) return;
        const problem = state === "failed" || state === "refunded" || state === "expired";
        this.#deps.logger[problem ? "warn" : "info"](
            {
                op: "deposit.order.moved",
                orderId: order._id.toHexString(),
                accountId: order.accountId.toHexString(),
                provider: order.provider,
                coin: order.coin,
                amount: order.amount,
                from: order.state,
                to: state,
                sourceTxHashes: order.sourceTxHashes,
                fillTxHash: moved.fillTxHash,
                reason: failure?.code,
                detail: failure?.detail,
                ref: problem ? refOf(order._id) : undefined,
            },
            `Deposit order moved to ${state}`,
        );
        // A step the wallet's report started is announced first, whichever write returned first.
        await this.#deps.announced?.(order._id);
        this.#deps.bus.emit("order:updated", { order: moved });
    }
}
