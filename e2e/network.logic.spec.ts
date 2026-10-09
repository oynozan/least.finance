import { expect, test } from "@playwright/test";
import { chainIdOf, networkName } from "@/lib/wallet/network";

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
