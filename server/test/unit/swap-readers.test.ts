import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { beforeAll, expect, inject, test } from "vitest";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { createSwapClients, type EvmNetworkId } from "../../src/swaps/clients.ts";
import { COINS, NETWORKS, type CoinEntry, type NetworkId } from "../../src/swaps/coins.ts";
import { multicallReader, solanaReader } from "../../src/swaps/holdings.ts";
import { startFakeSolanaRpc } from "../support/fake-solana-rpc.ts";
import { installMulticall3, sourceChain } from "../support/source-chains.ts";

const DEAD = "http://127.0.0.1:9";

const entryOf = (symbol: string, network: NetworkId): CoinEntry =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((entry) => entry.network === network)!;

const EVM_NETWORKS = NETWORKS.filter((network) => network.kind === "evm").map((network) => network.id as EvmNetworkId);
const clients = createSwapClients(
    Object.fromEntries(EVM_NETWORKS.map((id) => [id, [id === "ethereum" ? inject("ethereumUrl") : DEAD]])) as Record<
        EvmNetworkId,
        string[]
    >,
);

const chain = sourceChain(inject("ethereumUrl"), 1);
const usdc = entryOf("USDC", "ethereum");
const owner = privateKeyToAddress(generatePrivateKey());

beforeAll(async () => {
    await installMulticall3(inject("ethereumUrl"));
    await chain.installToken(usdc.address as `0x${string}`);
    await chain.client.setBalance({ address: owner, value: 1_500_000_000_000_000_000n });
    await chain.setTokenBalance(usdc.address as `0x${string}`, owner, 25_000_000n);
});

test("the clients read each network from its own chain", () => {
    expect(Object.keys(clients).sort()).toEqual([...EVM_NETWORKS].sort());
    expect(Object.fromEntries(EVM_NETWORKS.map((id) => [id, clients[id].chain?.id]))).toEqual({
        ethereum: 1,
        arbitrum: 42161,
        base: 8453,
        optimism: 10,
        polygon: 137,
        bnb: 56,
        avalanche: 43114,
        arc: 5042,
    });
});

test("one multicall reads the native coin and tokens, and a missing token is null", async () => {
    const read = multicallReader(clients);
    const entries = [entryOf("ETH", "ethereum"), usdc, entryOf("LINK", "ethereum")];

    expect(await read("ethereum", owner, entries)).toEqual([1_500_000_000_000_000_000n, 25_000_000n, null]);
});

test("a network whose request fails, or where every call fails, throws", async () => {
    const read = multicallReader(clients);

    await expect(read("arbitrum", owner, [entryOf("ETH", "arbitrum"), entryOf("USDC", "arbitrum")])).rejects.toThrow();
    await expect(read("ethereum", owner, [entryOf("LINK", "ethereum")])).rejects.toThrow();
});

test("the Solana reader reads SOL and token balances, and throws when every call fails", async () => {
    const fake = await startFakeSolanaRpc();
    try {
        const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
        const mint = entryOf("USDC", "solana");
        fake.setBalance(wallet, 2_000_000_000n);
        fake.setTokenBalance(wallet, mint.address, 12_500_000n);
        const read = solanaReader(createSolanaRpc([fake.url]));

        expect(await read(wallet, [entryOf("SOL", "solana"), mint, entryOf("USDT", "solana")])).toEqual([
            2_000_000_000n,
            12_500_000n,
            0n,
        ]);

        fake.failNext(1, 429);
        const partial = await read(wallet, [entryOf("SOL", "solana"), mint, entryOf("USDT", "solana")]);
        expect(partial.filter((units) => units === null)).toHaveLength(1);

        fake.failNext(100, 429);
        await expect(read(wallet, [entryOf("SOL", "solana"), mint])).rejects.toThrow();
    } finally {
        await fake.stop();
    }
});
