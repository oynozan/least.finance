import { setTimeout as sleep } from "node:timers/promises";
import type { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import type { Collections, DepositOrderDoc } from "../db/mongo.ts";
import type { Bus } from "../events.ts";
import type { OrderState } from "../protocol.ts";
import { coinByKey } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
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
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Order tracking pass failed");
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

        const due = orders.filter((order) => {
            const id = order._id.toHexString();
            if (now - (this.#polled.get(id) ?? -Infinity) < pollInterval(now - order.createdAt.getTime())) return false;
            this.#polled.set(id, now);
            return true;
        });
        let next = 0;
        const worker = async () => {
            for (let order = due[next++]; order; order = due[next++]) {
                await this.#step(order).catch((error: unknown) =>
                    this.#deps.logger.warn({ err: error, order: order._id.toHexString() }, "Couldn't follow an order"),
                );
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
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
        if (chain !== "ethereum" && chain !== "bnb") return;
        const client = this.#deps.sources[chain];
        const receipt = await this.#receipt(client, hash);
        if (receipt) await this.#move(order, receipt.status === "success" ? "in_block" : "failed");
        // A slow transaction can still be mined, so one with no receipt is followed until it is replaced or the order is given up on.
        else if (this.#now() - order.updatedAt.getTime() > GIVE_UP_MS || (await this.#replaced(client, hash))) {
            await this.#move(order, "failed");
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
        if (status?.err) await this.#move(order, "failed");
        else if (status && status.confirmationStatus !== "processed") await this.#move(order, "in_block");
        else if (!status && this.#now() - order.updatedAt.getTime() > this.#expiryMs) await this.#move(order, "failed");
    }

    async #checkBridge(order: DepositOrderDoc) {
        const provider = this.#deps.providers.find((p) => p.name === order.provider);
        if (!provider) return;
        const hash = order.sourceTxHashes.at(-1) ?? null;
        const status = await provider.status({ ref: order.ref }, hash, coinByKey(order.coin));

        if (order.state === "created") {
            if (status.stage !== "waiting") await this.#move(order, "bridging");
            else if (this.#now() - order.createdAt.getTime() > this.#expiryMs) await this.#move(order, "expired");
            return;
        }
        if (status.stage === "pending") {
            if (order.state === "in_block") await this.#move(order, "bridging");
        } else if (status.stage === "refunded" || status.stage === "failed") {
            await this.#move(order, status.stage === "refunded" ? "refunded" : "failed");
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

    /** A conditional update on the state the order was read in; only one that lands is announced. */
    async #move(order: DepositOrderDoc, state: OrderState, set: Partial<DepositOrderDoc> = {}) {
        const moved = await this.#deps.collections.depositOrders.findOneAndUpdate(
            { _id: order._id, state: order.state },
            { $set: { ...set, state, updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        if (!moved) return;
        // A step the wallet's report started is announced first, whichever write returned first.
        await this.#deps.announced?.(order._id);
        this.#deps.bus.emit("order:updated", { order: moved });
    }
}
