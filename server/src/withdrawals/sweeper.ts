import { setTimeout as sleep } from "node:timers/promises";
import { createWalletClient, custom, parseGwei, type Hex } from "viem";
import type { Logger } from "pino";
import type { Keyring } from "../accounts/keyring.ts";
import { MIN_BASE_FEE, type ArcClient } from "../chain/arc.ts";
import type { Collections } from "../db/mongo.ts";
import type { Bus } from "../events.ts";

export const SWEEP_INTERVAL_MS = 600_000;

const GAS_LIMIT = 21_000n;
const PRIORITY_FEE = parseGwei("1");
/** Below this many sends' worth of gas, a balance isn't worth moving. */
const DUST_GAS_MULTIPLE = 10n;
const DEPOSIT_INDEX = "depositIndex";

type Deps = {
    client: ArcClient;
    keyring: Keyring;
    collections: Collections;
    bus: Bus;
    logger: Logger;
    intervalMs?: number;
};

/** Moves every deposit address's balance into the treasury, so withdrawals can be paid from one place. */
export class Sweeper {
    readonly #deps: Deps;
    readonly #queues = new Map<number, Promise<unknown>>();
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #unsubscribe: (() => void) | null = null;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    start() {
        if (this.#loop) return;
        const { bus, keyring, logger } = this.#deps;
        logger.info(`Treasury: ${keyring.operator().address}`);
        const onCredited = ({ account }: { account: { depositIndex: number } }) => {
            this.sweep(account.depositIndex).catch((error: unknown) => {
                logger.warn({ err: error, index: account.depositIndex }, "Sweep failed");
            });
        };
        bus.on("deposit:credited", onCredited);
        this.#unsubscribe = () => bus.off("deposit:credited", onCredited);
        this.#stop = new AbortController();
        this.#loop = this.#run(this.#stop.signal);
    }

    async stop() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#stop?.abort();
        await this.#loop;
        await Promise.allSettled([...this.#queues.values()]);
        this.#loop = null;
        this.#stop = null;
    }

    /** Sends one address's balance, less gas, to the treasury; null when there's only dust. One sweep per index at a time. */
    sweep(index: number): Promise<Hex | null> {
        const previous = this.#queues.get(index) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => this.#sweepNow(index));
        const tail = run.catch(() => undefined);
        this.#queues.set(index, tail);
        void tail.then(() => {
            if (this.#queues.get(index) === tail) this.#queues.delete(index);
        });
        return run;
    }

    /** Sweeps every deposit address ever assigned, for what the bus never mentioned. */
    async sweepAll(signal?: AbortSignal): Promise<void> {
        const { collections, logger } = this.#deps;
        const counter = await collections.counters.findOne({ _id: DEPOSIT_INDEX });
        for (let index = 1; index <= (counter?.seq ?? 0); index++) {
            if (signal?.aborted) return;
            try {
                await this.sweep(index);
            } catch (error) {
                logger.warn({ err: error, index }, "Sweep failed");
            }
        }
    }

    /** Rejects as soon as stop() is called, so a slow receipt can't hold shutdown. */
    #abortable<T>(work: Promise<T>): Promise<T> {
        const signal = this.#stop?.signal;
        if (!signal) return work;
        if (signal.aborted) return Promise.reject(new Error("Sweeper stopped"));
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new Error("Sweeper stopped"));
            signal.addEventListener("abort", onAbort, { once: true });
            work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
        });
    }

    async #sweepNow(index: number): Promise<Hex | null> {
        const { client, keyring } = this.#deps;
        const signer = keyring.signerAt(index);
        const [balance, gasPrice] = await Promise.all([
            client.getBalance({ address: signer.address }),
            client.getGasPrice(),
        ]);
        const maxFeePerGas = (gasPrice > MIN_BASE_FEE ? gasPrice : MIN_BASE_FEE) + PRIORITY_FEE;
        const gasCost = GAS_LIMIT * maxFeePerGas;
        if (balance <= DUST_GAS_MULTIPLE * gasCost) return null;
        const wallet = createWalletClient({ account: signer, chain: client.chain, transport: custom(client) });
        const hash = await wallet.sendTransaction({
            chain: client.chain,
            to: keyring.operator().address,
            value: balance - gasCost,
            gas: GAS_LIMIT,
            maxFeePerGas,
            maxPriorityFeePerGas: PRIORITY_FEE,
        });
        const receipt = await this.#abortable(client.waitForTransactionReceipt({ hash }));
        if (receipt.status !== "success") throw new Error(`Sweep ${hash} reverted`);
        return hash;
    }

    async #run(signal: AbortSignal) {
        while (!signal.aborted) {
            try {
                await this.sweepAll(signal);
            } catch (error) {
                this.#deps.logger.warn({ err: error }, "Sweep pass failed");
            }
            await sleep(this.#deps.intervalMs ?? SWEEP_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
        }
    }
}
