import { expect, test } from "@playwright/test";
import { chainIdOf, ensureNetwork, networkName, type SwitchableWallet } from "@/lib/wallet/network";

test("chainIdOf reads the chain out of an EIP-155 CAIP-2 ID", () => {
    expect(chainIdOf("eip155:1")).toBe(1);
    expect(chainIdOf("eip155:42161")).toBe(42161);
});

test("chainIdOf gives undefined for anything that isn't an EIP-155 chain", () => {
    expect(chainIdOf("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeUndefined();
    expect(chainIdOf("")).toBeUndefined();
    expect(chainIdOf("eip155:")).toBeUndefined();
});

test("networkName names known networks, numbers the rest, and admits when there's none", () => {
    expect(networkName(5042)).toBe("Arc");
    expect(networkName(56)).toBe("BNB Chain");
    expect(networkName("solana")).toBe("Solana");
    expect(networkName(999)).toBe("Chain 999");
    expect(networkName(undefined)).toBe("Unknown network");
});

/** A wallet on `chainId` whose provider reports `reports`, recording each switch it's asked for. */
function fakeWallet(chainId: string, reports: string, switchError?: unknown) {
    const switches: number[] = [];
    const wallet: SwitchableWallet = {
        chainId,
        switchChain: async (id) => {
            switches.push(id);
            if (switchError) throw switchError;
        },
        getEthereumProvider: async () => ({
            request: async ({ method }) => (method === "eth_chainId" ? reports : null),
        }),
    };
    return { wallet, switches };
}

test("ensureNetwork leaves a wallet that is already on the chain alone", async () => {
    const { wallet, switches } = fakeWallet("eip155:5042", "0x13b2");
    expect(await ensureNetwork(wallet, 5042)).toBe("ready");
    expect(switches).toEqual([]);
});

test("ensureNetwork switches a wallet that is on another chain", async () => {
    const { wallet, switches } = fakeWallet("eip155:1", "0x13b2");
    expect(await ensureNetwork(wallet, 5042)).toBe("ready");
    expect(switches).toEqual([5042]);
});

test("a switch the user turns down is declined", async () => {
    const { wallet } = fakeWallet("eip155:1", "0x1", { code: 4001 });
    expect(await ensureNetwork(wallet, 5042)).toBe("declined");
});

test("any other failed switch is switch_failed", async () => {
    const { wallet } = fakeWallet("eip155:1", "0x1", new Error("nope"));
    expect(await ensureNetwork(wallet, 5042)).toBe("switch_failed");
});

test("a switch that leaves the wallet where it was is wrong_network", async () => {
    const { wallet } = fakeWallet("eip155:1", "0x1");
    expect(await ensureNetwork(wallet, 5042)).toBe("wrong_network");
});

test("the provider's chain counts, not a wallet.chainId that hasn't caught up", async () => {
    const { wallet } = fakeWallet("eip155:1", "0x13b2");
    expect(await ensureNetwork(wallet, 5042)).toBe("ready");
    expect(wallet.chainId).toBe("eip155:1");
});
