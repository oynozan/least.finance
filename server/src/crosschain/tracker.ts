import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import { TransactionReceiptNotFoundError, type Hex } from "viem";
import type { Collections, DepositOrderDoc } from "../db/mongo.ts";
import type { Bus } from "../events.ts";
import type { OrderState } from "../protocol.ts";
import { coinByKey } from "./catalog.ts";
import type { SourceClients } from "./chains.ts";
import type { BridgeProvider } from "./providers/types.ts";

const DEFAULT_EXPIRY_MS = 600_000;
const OPEN: OrderState[] = ["created", "sent", "in_block", "bridging"];

type Deps = {
    collections: Collections;
    providers: readonly BridgeProvider[];
    sources: SourceClients;
    bus: Bus;
    logger: Logger;
    pollMs: number;
    expiryMs?: number;
};

/** Follows each open deposit order from the source chain across the bridge, and announces every step. */
export class OrderTracker {
    readonly #deps: Deps;
    readonly #expiryMs: number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
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

    /** One pass over the open orders; an error on one leaves it as it was and doesn't stop the others. */
    async tick(): Promise<void> {
        const orders = await this.#deps.collections.depositOrders.find({ state: { $in: OPEN } }).toArray();
        await Promise.all(
            orders.map((order) =>
                this.#step(order).catch((error: unknown) =>
                    this.#deps.logger.warn({ err: error, order: order._id.toHexString() }, "Couldn't follow an order"),
                ),
            ),
        );
    }

    async #step(order: DepositOrderDoc) {
        if (order.state === "sent") return this.#checkSource(order);
        return this.#checkBridge(order);
    }

    /** The receipt of the last transaction decides whether the order is in a block. */
    async #checkSource(order: DepositOrderDoc) {
        const hash = order.sourceTxHashes.at(-1) as Hex;
        const chain = coinByKey(order.coin).chain;
        if (chain !== "ethereum" && chain !== "bnb") return;
        const receipt = await this.#deps.sources[chain].getTransactionReceipt({ hash }).catch((error: unknown) => {
            if (error instanceof TransactionReceiptNotFoundError) return null;
            throw error;
        });
        if (receipt) await this.#move(order, receipt.status === "success" ? "in_block" : "failed");
        else if (Date.now() - order.updatedAt.getTime() > this.#expiryMs) await this.#move(order, "failed");
    }

    async #checkBridge(order: DepositOrderDoc) {
        const provider = this.#deps.providers.find((p) => p.name === order.provider);
        if (!provider) return;
        const hash = (order.sourceTxHashes.at(-1) as Hex | undefined) ?? null;
        const status = await provider.status({ ref: order.ref }, hash, coinByKey(order.coin));

        if (order.state === "created") {
            if (status.stage !== "waiting") await this.#move(order, "bridging");
            else if (Date.now() - order.createdAt.getTime() > this.#expiryMs) await this.#move(order, "expired");
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
    async #deliver(order: DepositOrderDoc, fill: string, sourceHash: Hex | null) {
        const { deposits } = this.#deps.collections;
        const deposit = await deposits.findOne({ accountId: order.accountId, txHash: fill });
        if (!deposit || (deposit.origin && !deposit.origin.orderId.equals(order._id))) {
            if (order.fillTxHash === null) await this.#move(order, order.state, { fillTxHash: fill });
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
        if (moved) this.#deps.bus.emit("order:updated", { order: moved });
    }
}
