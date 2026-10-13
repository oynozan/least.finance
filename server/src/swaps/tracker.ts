import { setTimeout as sleep } from "node:timers/promises";
import type { ObjectId } from "mongodb";
import { formatUnits, isAddress, type PublicClient } from "viem";
import type { Logger } from "pino";
import type { AccountService } from "../accounts/accounts.ts";
import type { Collections, SwapOrderDoc } from "../db/mongo.ts";
import type { Bus } from "../events.ts";
import type { SwapOrderState } from "../protocol.ts";
import type { EvmNetworkId } from "./clients.ts";
import { COINS, NETWORKS } from "./coins.ts";
import type { SwapHoldings } from "./holdings.ts";
import type { Lifi, LifiStatus } from "./lifi.ts";

type Deps = {
    collections: Collections;
    lifi: Lifi;
    clients: Record<EvmNetworkId, PublicClient>;
    bus: Bus;
    holdings: Pick<SwapHoldings, "refresh">;
    /** Whether a Solana signature failed on chain; null while the chain has no verdict. */
    solanaStatus: (signature: string) => Promise<{ failed: boolean } | null>;
    accounts: Pick<AccountService, "findById">;
    logger: Logger;
    /** How often the loop looks for orders that are due. */
    pollMs: number;
    now?: () => number;
};

/** A created order the wallet never reported sent expires after this. */
const UNREPORTED_MS = 15 * 60_000;
/** A sent order still open after this is given up on. */
const GIVE_UP_MS = 24 * 3_600_000;
/** The identity the holdings read needs lives this long. */
const IDENTITY_MS = 60_000;

/** How long to wait between status calls for an order sent `age` ms ago. */
function intervalFor(age: number): number {
    if (age < 60_000) return 10_000;
    if (age < 240_000) return 30_000;
    return 60_000;
}

const sameValue = (a: string, b: string) =>
    isAddress(a, { strict: false }) ? a.toLowerCase() === b.toLowerCase() : a === b;

const networkOf = (id: SwapOrderDoc["to"]["network"]) => NETWORKS.find((network) => network.id === id)!;

const tokenOf = (side: SwapOrderDoc["to"]) =>
    COINS.find((coin) => coin.symbol === side.token)!.entries.find((entry) => entry.network === side.network)!;

type Move = { state: SwapOrderState; received?: string; receivedSymbol?: string };

/** What a swap status is held against: the order's last hash, its wallets and the token it asked for. */
export type StatusExpect = { hash: string; wallet: string; receiver: string; token: string };

/** The move LI.FI's status settles an order to, or null with the reason it doesn't. */
export function moveFromStatus(status: LifiStatus, expect: StatusExpect): { move: Move | null; note: string | null } {
    if (status.status === "NOT_FOUND" || status.status === "INVALID" || status.status === "PENDING") {
        return { move: null, note: null };
    }
    // A failure or refund pays no one, so only the fields LI.FI sent are held to the order
    const lenient = status.status === "FAILED" || status.substatus === "REFUNDED";
    const present = (value: string | null, want: string) => value === null || sameValue(value, want);
    const matches = lenient
        ? present(status.sendingTxHash, expect.hash) &&
          present(status.fromAddress, expect.wallet) &&
          present(status.toAddress, expect.receiver)
        : status.sendingTxHash !== null &&
          status.fromAddress !== null &&
          status.toAddress !== null &&
          sameValue(status.sendingTxHash, expect.hash) &&
          sameValue(status.fromAddress, expect.wallet) &&
          sameValue(status.toAddress, expect.receiver);
    if (!matches) return { move: null, note: "Ignored a swap status for another transaction" };

    if (status.substatus === "REFUNDED") return { move: { state: "refunded" }, note: null };
    if (status.status === "FAILED") return { move: { state: "failed" }, note: null };
    const got = status.receiving;
    if (status.status !== "DONE" || !got || (status.substatus !== "COMPLETED" && status.substatus !== "PARTIAL")) {
        return { move: null, note: "Left a swap status unread" };
    }
    const received = formatUnits(BigInt(got.amount), got.decimals);
    if (status.substatus === "COMPLETED" && sameValue(expect.token, got.tokenAddress)) {
        return { move: { state: "done", received }, note: null };
    }
    return { move: { state: "partial", received, receivedSymbol: got.tokenSymbol || got.tokenAddress }, note: null };
}

/** Follows each sent swap to done, partial, refunded or failed, and expires the ones that never finish. */
export class SwapTracker {
    readonly #deps: Deps;
    readonly #now: () => number;
    /** When each sent order was last looked up. */
    readonly #polled = new Map<string, number>();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
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
                this.#deps.logger.warn({ err: error }, "Swap tracking pass failed");
            }
            await sleep(this.#deps.pollMs, undefined, { signal }).catch(() => undefined);
        }
    }

    /** One pass: expires stale orders and looks up the sent ones that are due; an error on one leaves it as it was. */
    async tick(): Promise<void> {
        const now = this.#now();
        const { swapOrders } = this.#deps.collections;
        const stale = await swapOrders
            .find({ state: "created", createdAt: { $lte: new Date(now - UNREPORTED_MS) } })
            .toArray();
        for (const order of stale) await this.#move(order, { state: "expired" }, "created");

        const open = await swapOrders.find({ state: "sent" }).toArray();
        const live = new Set(open.map((order) => order._id.toHexString()));
        for (const key of this.#polled.keys()) if (!live.has(key)) this.#polled.delete(key);

        for (const order of open) {
            const key = order._id.toHexString();
            const age = now - order.updatedAt.getTime();
            if (age >= GIVE_UP_MS) {
                await this.#move(order, { state: "expired" }, "sent");
                continue;
            }
            const last = this.#polled.get(key);
            if (last !== undefined && now - last < intervalFor(age)) continue;
            this.#polled.set(key, now);
            try {
                const move = await this.#look(order);
                if (move) await this.#move(order, move, "sent");
            } catch (error) {
                this.#deps.logger.warn({ err: error, orderId: key }, "Couldn't follow a swap");
            }
        }
    }

    /** What the order's last transaction and LI.FI's status say happened, or null for no change. */
    async #look(order: SwapOrderDoc): Promise<Move | null> {
        const hash = order.txHashes.at(-1);
        if (!hash) return null;
        const from = networkOf(order.from.network);
        const to = networkOf(order.to.network);

        if (from.kind === "evm") {
            const receipt = await this.#deps.clients[from.id as EvmNetworkId]
                .getTransactionReceipt({ hash: hash as `0x${string}` })
                .catch(() => null);
            if (receipt?.status === "reverted") return { state: "failed" };
        } else if ((await this.#deps.solanaStatus(hash))?.failed) {
            return { state: "failed" };
        }

        const status = await this.#deps.lifi.status({
            txHash: hash,
            fromChain: from.chainId,
            toChain: to.chainId,
            ...(from.id !== to.id && { bridge: order.tool }),
        });
        const { move, note } = moveFromStatus(status, {
            hash,
            wallet: order.wallet,
            receiver: order.receiver,
            token: tokenOf(order.to).address,
        });
        if (note) {
            this.#deps.logger.warn(
                { orderId: order._id.toHexString(), status: status.status, substatus: status.substatus },
                note,
            );
        }
        return move;
    }

    /** Moves the order only if it is still in `from`; a settled move refreshes the account's holdings. */
    async #move(order: SwapOrderDoc, move: Move, from: SwapOrderState) {
        const moved = await this.#deps.collections.swapOrders.findOneAndUpdate(
            { _id: order._id, state: from },
            {
                $set: {
                    state: move.state,
                    ...(move.received !== undefined && { received: move.received }),
                    ...(move.receivedSymbol !== undefined && { receivedSymbol: move.receivedSymbol }),
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!moved) return;
        this.#polled.delete(order._id.toHexString());
        this.#deps.bus.emit("swap:updated", { order: moved });
        if (move.state !== "expired") await this.#refresh(moved.accountId);
    }

    async #refresh(accountId: ObjectId) {
        try {
            const account = await this.#deps.accounts.findById(accountId);
            if (!account) return;
            await this.#deps.holdings.refresh(
                account,
                { userId: account.privyUserId, expiresAt: this.#now() + IDENTITY_MS },
                "settled",
            );
        } catch (error) {
            this.#deps.logger.warn({ err: error }, "Couldn't refresh holdings after a swap settled");
        }
    }
}
