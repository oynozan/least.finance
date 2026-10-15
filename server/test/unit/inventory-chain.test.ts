import type { PublicClient } from "viem";
import { describe, expect, test, vi } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import type { EvmNetworkId } from "../../src/swaps/clients.ts";
import { createInventoryChain } from "../../src/trading/inventory-chain.ts";

const account = createKeyring("test test test test test test test test test test test junk").inventoryEvm();
const TRANSFER = { to: account.address, data: "0x" as const, value: 1n };

/** A node that answers the few calls the chain makes; `state.pending` is the account's transaction count. */
function node() {
    const state = { pending: 0 };
    const client = {
        chain: { id: 1 },
        getTransactionCount: vi.fn(async () => state.pending),
        estimateGas: vi.fn(async () => 21_000n),
        estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })),
        sendRawTransaction: vi.fn(async () => "0x"),
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    };
    const chain = createInventoryChain({
        account,
        clients: { ethereum: client as unknown as PublicClient } as Record<EvmNetworkId, PublicClient>,
    });
    return { chain, client, state };
}

describe("inventory chain nonces", () => {
    test("a refused estimate takes no nonce", async () => {
        const { chain, client } = node();
        client.estimateGas.mockRejectedValueOnce(new Error("execution reverted"));
        await expect(chain.prepare("ethereum", TRANSFER)).rejects.toThrow(/reverted/);
        expect((await chain.prepare("ethereum", TRANSFER)).nonce).toBe(0);
    });

    test("a nonce given back is handed out next, even with a later one already out", async () => {
        const { chain } = node();
        expect(await chain.nextNonce("ethereum")).toBe(0);
        expect(await chain.nextNonce("ethereum")).toBe(1);
        chain.release("ethereum", 0);
        expect(await chain.nextNonce("ethereum")).toBe(0);
        expect(await chain.nextNonce("ethereum")).toBe(2);
    });

    test("a nonce the chain has moved past is not handed out again", async () => {
        const { chain, state } = node();
        expect(await chain.nextNonce("ethereum")).toBe(0);
        chain.release("ethereum", 0);
        state.pending = 1;
        expect(await chain.nextNonce("ethereum")).toBe(1);
    });

    test("a nonce reserved again is not handed out from the ones given back", async () => {
        const { chain } = node();
        chain.release("ethereum", 3);
        chain.reserve("ethereum", 3);
        expect(await chain.nextNonce("ethereum")).toBe(4);
    });

    test("an approval the node refuses gives its nonce back", async () => {
        const { chain, client } = node();
        client.sendRawTransaction.mockRejectedValueOnce(new Error("insufficient funds for gas * price + value"));
        await expect(chain.approve("ethereum", account.address, account.address, 5n)).rejects.toThrow(/insufficient/);
        expect(await chain.nextNonce("ethereum")).toBe(0);
    });
});
