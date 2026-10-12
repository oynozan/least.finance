import { readFileSync } from "node:fs";
import { expect, expectTypeOf, test } from "vitest";
import type { SwapNetworkId } from "../../src/protocol.ts";
import { COINS, NETWORKS, type NetworkId } from "../../src/swaps/coins.ts";

type RawToken = { address: string; decimals: number };

const readFixture = <T>(name: string): T =>
    JSON.parse(readFileSync(new URL(`../fixtures/lifi/${name}`, import.meta.url), "utf8"));
const { tokens } = readFixture<{ tokens: Record<string, RawToken[]> }>("tokens.json");
const { quotable } = readFixture<{ quotable: string[] }>("quotable.json");

const networkOf = (id: NetworkId) => NETWORKS.find((network) => network.id === id)!;
// EVM addresses compare without case, Solana's are case-sensitive
const keyOf = (network: NetworkId, address: string) =>
    networkOf(network).kind === "evm" ? address.toLowerCase() : address;

test("every coin lists its home network", () => {
    for (const coin of COINS) {
        expect(
            coin.entries.map((entry) => entry.network),
            coin.symbol,
        ).toContain(coin.home);
    }
});

test("an address appears once per network", () => {
    const seen = new Set<string>();
    for (const coin of COINS) {
        for (const entry of coin.entries) {
            const key = `${entry.network}:${keyOf(entry.network, entry.address)}`;
            expect(seen.has(key), `${coin.symbol} on ${entry.network}`).toBe(false);
            seen.add(key);
        }
    }
});

test("decimals match LI.FI's list", () => {
    for (const coin of COINS) {
        for (const entry of coin.entries) {
            const listed = tokens[String(networkOf(entry.network).chainId)] ?? [];
            const token = listed.find(
                (candidate) => keyOf(entry.network, candidate.address) === keyOf(entry.network, entry.address),
            );
            expect(token, `${coin.symbol} on ${entry.network}`).toBeDefined();
            expect(token!.decimals, `${coin.symbol} on ${entry.network}`).toBe(entry.decimals);
        }
    }
});

test("every entry is quotable", () => {
    for (const coin of COINS) {
        for (const entry of coin.entries) expect(quotable).toContain(`${entry.network}:${coin.symbol}`);
    }
});

test("NetworkId matches the protocol's", () => {
    expectTypeOf<NetworkId>().toEqualTypeOf<SwapNetworkId>();
});
