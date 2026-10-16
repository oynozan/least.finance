import { keccak256, toHex, type Address, type Hex } from "viem";
import type { EvmNetworkId } from "../../src/swaps/clients.ts";
import {
    outbid,
    type GasFees,
    type InventoryChain,
    type PreparedTx,
    type Receipt,
    type TxIntent,
} from "../../src/trading/inventory-chain.ts";

export type FakeInventoryChain = InventoryChain & {
    /** Every transaction signed, in order, with the fees of the attempt it was asked to outbid. */
    prepared: { network: EvmNetworkId; intent: TxIntent; tx: PreparedTx; previous?: GasFees }[];
    /** The hashes sent to the network. */
    broadcasts: Hex[];
    approvals: { network: EvmNetworkId; token: Address; spender: Address; amount: bigint }[];
    /** What the network says about a hash; unknown hashes have no receipt. */
    receipts: Map<Hex, Receipt>;
    /** Allowances by "network:token:spender". */
    allowances: Map<string, bigint>;
    /** Makes the next call of this kind throw. */
    failNext(call: "prepare" | "broadcast" | "approve", error: Error): void;
    /** Marks every transaction signed so far as mined. */
    mineAll(status?: "success" | "reverted"): void;
};

/** A chain that signs nothing real: hashes come from the intent and the nonce, nonces from the chain's count and a floor. */
export function fakeInventoryChain(): FakeInventoryChain {
    const floors = new Map<EvmNetworkId, number>();
    const released = new Map<EvmNetworkId, Set<number>>();
    const failures: { call: string; error: Error }[] = [];
    const take = (call: string) => {
        const at = failures.findIndex((failure) => failure.call === call);
        if (at >= 0) throw failures.splice(at, 1)[0]!.error;
    };
    const fake: FakeInventoryChain = {
        prepared: [],
        broadcasts: [],
        approvals: [],
        receipts: new Map(),
        allowances: new Map(),
        failNext: (call, error) => void failures.push({ call, error }),
        mineAll(status = "success") {
            for (const { tx } of fake.prepared) fake.receipts.set(tx.hash, status);
        },
        async nextNonce(network) {
            const free = released.get(network);
            if (free && free.size > 0) {
                const lowest = Math.min(...free);
                free.delete(lowest);
                return lowest;
            }
            const nonce = floors.get(network) ?? 0;
            floors.set(network, nonce + 1);
            return nonce;
        },
        reserve(network, nonce) {
            floors.set(network, Math.max(floors.get(network) ?? 0, nonce + 1));
            released.get(network)?.delete(nonce);
        },
        release(network, nonce) {
            released.set(network, (released.get(network) ?? new Set()).add(nonce));
        },
        async prepare(network, intent, nonce, previous) {
            take("prepare");
            const used = nonce ?? (await fake.nextNonce(network));
            const raw = toHex(`${network}|${used}|${intent.to}|${intent.data}|${intent.value}|${fake.prepared.length}`);
            const fees = outbid({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, previous);
            const tx = { hash: keccak256(raw), raw, nonce: used, fees };
            fake.prepared.push({ network, intent, tx, previous });
            return tx;
        },
        async broadcast(_network, prepared) {
            take("broadcast");
            fake.broadcasts.push(prepared.hash);
        },
        async receipt(_network, hash) {
            return fake.receipts.get(hash) ?? null;
        },
        async allowance(network, token, spender) {
            return fake.allowances.get(`${network}:${token}:${spender}`.toLowerCase()) ?? 0n;
        },
        async approve(network, token, spender, amount) {
            take("approve");
            fake.approvals.push({ network, token, spender, amount });
            fake.allowances.set(`${network}:${token}:${spender}`.toLowerCase(), amount);
        },
    };
    return fake;
}
