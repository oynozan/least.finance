import { encodeFunctionData, erc20Abi, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import type { PublicClient } from "viem";
import type { SendAttempt } from "./docs.ts";
import { upstreamSaid } from "./failures.ts";
import { refused } from "./send-errors.ts";

export type TxIntent = { to: Address; data: Hex; value: bigint };

/** What a transaction pays per unit of gas, where a network with one gas price pays it as both */
export type GasFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** A signed transaction that has not been sent: its hash is known, so it can be recorded first. */
export type PreparedTx = { hash: Hex; raw: Hex; nonce: number; fees: GasFees };

export type Receipt = "success" | "reverted" | null;

/** The inventory wallet's view of the EVM networks: the only place that signs with its key. */
export type InventoryChain = {
    /** The next nonce on a network, counting every one this process has handed out. */
    nextNonce(network: EvmNetworkId): Promise<number>;
    /** Keeps nonces at or below this one from being handed out again, for one recorded before a restart. */
    reserve(network: EvmNetworkId, nonce: number): void;
    /** Gives back a nonce no transaction was sent on, so the next send fills the gap instead of queueing behind it. */
    release(network: EvmNetworkId, nonce: number): void;
    /** Signs `tx`, and with `previous` (an attempt on the same nonce) pays enough more to replace it */
    prepare(network: EvmNetworkId, tx: TxIntent, nonce?: number, previous?: GasFees): Promise<PreparedTx>;
    broadcast(network: EvmNetworkId, prepared: PreparedTx): Promise<void>;
    /** Null while the transaction is unknown or unmined. */
    receipt(network: EvmNetworkId, hash: Hex): Promise<Receipt>;
    allowance(network: EvmNetworkId, token: Address, spender: Address): Promise<bigint>;
    /** Sends an ERC-20 approval and returns once it is mined. */
    approve(network: EvmNetworkId, token: Address, spender: Address, amount: bigint): Promise<void>;
};

const GAS_MARGIN_NUM = 12n;
const GAS_MARGIN_DEN = 10n;
const APPROVAL_WAIT_MS = 90_000;
// Nodes take a replacement only if both fees rise by 10%, so 12.5% leaves room
const REPLACEMENT_BUMP_PER_MILLE = 125n;
/** Attempts per nonce at most, as each replacement pays 12.5% more than the one before */
export const MAX_ATTEMPTS = 10;

const raised = (fee: bigint) => fee + (fee * REPLACEMENT_BUMP_PER_MILLE + 999n) / 1000n;
const larger = (a: bigint, b: bigint) => (a > b ? a : b);

/** The network's fees, or 12.5% over those of the attempt being replaced where that is more */
export function outbid(estimated: GasFees, previous?: GasFees): GasFees {
    if (!previous) return estimated;
    return {
        maxFeePerGas: larger(estimated.maxFeePerGas, raised(previous.maxFeePerGas)),
        maxPriorityFeePerGas: larger(estimated.maxPriorityFeePerGas, raised(previous.maxPriorityFeePerGas)),
    };
}

/** Every transaction signed on a doc's nonce, where one signed before attempts were kept has only its hash */
export function attemptsOf(doc: { txHash: string | null; attempts?: SendAttempt[] }): SendAttempt[] {
    if (doc.attempts) return doc.attempts;
    return doc.txHash ? [{ hash: doc.txHash, maxFeePerGas: "0", maxPriorityFeePerGas: "0" }] : [];
}

export const attemptOf = (prepared: PreparedTx): SendAttempt => ({
    hash: prepared.hash,
    maxFeePerGas: prepared.fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: prepared.fees.maxPriorityFeePerGas.toString(),
});

/** The highest of each fee across the attempts, which a replacement has to beat */
export function highestFees(attempts: SendAttempt[]): GasFees | undefined {
    if (attempts.length === 0) return undefined;
    return attempts.reduce<GasFees>(
        (top, attempt) => ({
            maxFeePerGas: larger(top.maxFeePerGas, BigInt(attempt.maxFeePerGas)),
            maxPriorityFeePerGas: larger(top.maxPriorityFeePerGas, BigInt(attempt.maxPriorityFeePerGas)),
        }),
        { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
    );
}

/** The attempt that mined, if any, since only one transaction can take a nonce */
export async function minedAmong(
    chain: Pick<InventoryChain, "receipt">,
    network: EvmNetworkId,
    attempts: SendAttempt[],
): Promise<{ hash: Hex; status: "success" | "reverted" } | null> {
    const answers = await Promise.all(
        attempts.map(async ({ hash }) => ({ hash: hash as Hex, status: await chain.receipt(network, hash as Hex) })),
    );
    for (const { hash, status } of answers) if (status !== null) return { hash, status };
    return null;
}

/** Signs the inventory wallet's transactions on each network through the swap clients. */
export function createInventoryChain(options: {
    account: HDAccount;
    clients: Record<EvmNetworkId, PublicClient>;
}): InventoryChain {
    const { account, clients } = options;
    const floors = new Map<EvmNetworkId, number>();
    const released = new Map<EvmNetworkId, Set<number>>();
    const queues = new Map<EvmNetworkId, Promise<unknown>>();

    // Nonces are read and handed out one at a time per network
    function serial<T>(network: EvmNetworkId, work: () => Promise<T>): Promise<T> {
        const run = (queues.get(network) ?? Promise.resolve()).then(work, work);
        queues.set(
            network,
            run.catch(() => undefined),
        );
        return run;
    }

    const chain: InventoryChain = {
        nextNonce: (network) =>
            serial(network, async () => {
                const pending = await clients[network].getTransactionCount({
                    address: account.address,
                    blockTag: "pending",
                });
                const free = released.get(network) ?? new Set<number>();
                // A given back nonce the chain has moved past was used by something else
                for (const nonce of free) if (nonce < pending) free.delete(nonce);
                const lowest = free.size > 0 ? Math.min(...free) : null;
                if (lowest !== null) {
                    free.delete(lowest);
                    return lowest;
                }
                const nonce = Math.max(pending, floors.get(network) ?? 0);
                floors.set(network, nonce + 1);
                return nonce;
            }),

        reserve(network, nonce) {
            floors.set(network, Math.max(floors.get(network) ?? 0, nonce + 1));
            released.get(network)?.delete(nonce);
        },

        release(network, nonce) {
            released.set(network, (released.get(network) ?? new Set<number>()).add(nonce));
        },

        async prepare(network, tx, nonce, previous) {
            const client = clients[network];
            // Gas is estimated before a nonce is taken, so a refused transaction leaves no gap
            const gas = await client.estimateGas({ account: account.address, ...tx });
            // A network without EIP-1559 answers with a gas price alone
            const estimated: { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } =
                await client.estimateFeesPerGas();
            const legacy = estimated.maxFeePerGas === undefined;
            const current: GasFees = legacy
                ? { maxFeePerGas: estimated.gasPrice!, maxPriorityFeePerGas: estimated.gasPrice! }
                : { maxFeePerGas: estimated.maxFeePerGas!, maxPriorityFeePerGas: estimated.maxPriorityFeePerGas! };
            const fees = outbid(current, previous);
            const useNonce = nonce ?? (await chain.nextNonce(network));
            const raw = await account.signTransaction({
                chainId: client.chain!.id,
                to: tx.to,
                data: tx.data,
                value: tx.value,
                nonce: useNonce,
                gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN,
                ...(legacy
                    ? { type: "legacy" as const, gasPrice: fees.maxFeePerGas }
                    : {
                          type: "eip1559" as const,
                          maxFeePerGas: fees.maxFeePerGas,
                          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                      }),
            });
            return { hash: keccak256(raw), raw, nonce: useNonce, fees };
        },

        async broadcast(network, prepared) {
            await clients[network].sendRawTransaction({ serializedTransaction: prepared.raw });
        },

        async receipt(network, hash) {
            try {
                const receipt = await clients[network].getTransactionReceipt({ hash });
                return receipt.status === "success" ? "success" : "reverted";
            } catch (error) {
                if (error instanceof TransactionReceiptNotFoundError) return null;
                throw error;
            }
        },

        allowance: (network, token, spender) =>
            clients[network].readContract({
                address: token,
                abi: erc20Abi,
                functionName: "allowance",
                args: [account.address, spender],
            }),

        async approve(network, token, spender, amount) {
            const what = `The ${token} approval to ${spender} on ${network}`;
            let prepared: PreparedTx;
            try {
                prepared = await chain.prepare(network, {
                    to: token,
                    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
                    value: 0n,
                });
                try {
                    await chain.broadcast(network, prepared);
                } catch (error) {
                    if (refused(error)) chain.release(network, prepared.nonce);
                    throw error;
                }
            } catch (error) {
                throw new Error(`${what} wasn't sent: ${upstreamSaid(error)}`, { cause: error });
            }
            let receipt;
            try {
                receipt = await clients[network].waitForTransactionReceipt({
                    hash: prepared.hash,
                    timeout: APPROVAL_WAIT_MS,
                });
            } catch (error) {
                throw new Error(
                    `${what} wasn't mined within ${APPROVAL_WAIT_MS / 1000} seconds (tx ${prepared.hash}): ${upstreamSaid(error)}`,
                    { cause: error },
                );
            }
            if (receipt.status !== "success") throw new Error(`${what} reverted (tx ${prepared.hash})`);
        },
    };
    return chain;
}
