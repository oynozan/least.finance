import { encodeFunctionData, erc20Abi, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import type { PublicClient } from "viem";

export type TxIntent = { to: Address; data: Hex; value: bigint };

/** A signed transaction that has not been sent: its hash is known, so it can be recorded first. */
export type PreparedTx = { hash: Hex; raw: Hex; nonce: number };

export type Receipt = "success" | "reverted" | null;

/** The inventory wallet's view of the EVM networks: the only place that signs with its key. */
export type InventoryChain = {
    /** The next nonce on a network, counting every one this process has handed out. */
    nextNonce(network: EvmNetworkId): Promise<number>;
    /** Keeps nonces at or below this one from being handed out again, for one recorded before a restart. */
    reserve(network: EvmNetworkId, nonce: number): void;
    prepare(network: EvmNetworkId, tx: TxIntent, nonce?: number): Promise<PreparedTx>;
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

/** Signs the inventory wallet's transactions on each network through the swap clients. */
export function createInventoryChain(options: {
    account: HDAccount;
    clients: Record<EvmNetworkId, PublicClient>;
}): InventoryChain {
    const { account, clients } = options;
    const floors = new Map<EvmNetworkId, number>();
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
                const nonce = Math.max(pending, floors.get(network) ?? 0);
                floors.set(network, nonce + 1);
                return nonce;
            }),

        reserve(network, nonce) {
            floors.set(network, Math.max(floors.get(network) ?? 0, nonce + 1));
        },

        async prepare(network, tx, nonce) {
            const client = clients[network];
            const useNonce = nonce ?? (await chain.nextNonce(network));
            const gas = await client.estimateGas({ account: account.address, ...tx });
            const fees = await client.estimateFeesPerGas();
            const raw = await account.signTransaction({
                chainId: client.chain!.id,
                to: tx.to,
                data: tx.data,
                value: tx.value,
                nonce: useNonce,
                gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN,
                ...(fees.maxFeePerGas !== undefined
                    ? {
                          type: "eip1559" as const,
                          maxFeePerGas: fees.maxFeePerGas,
                          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                      }
                    : { type: "legacy" as const, gasPrice: fees.gasPrice }),
            });
            return { hash: keccak256(raw), raw, nonce: useNonce };
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
            const prepared = await chain.prepare(network, {
                to: token,
                data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
                value: 0n,
            });
            await chain.broadcast(network, prepared);
            const receipt = await clients[network].waitForTransactionReceipt({
                hash: prepared.hash,
                timeout: APPROVAL_WAIT_MS,
            });
            if (receipt.status !== "success") throw new Error("The approval reverted");
        },
    };
    return chain;
}
