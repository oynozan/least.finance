import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { Decimal128, ObjectId } from "mongodb";
import { parseUnits, type PublicClient } from "viem";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { createArcClient } from "../../src/chain/arc.ts";
import { connectDatabase, type Database } from "../../src/db/mongo.ts";
import { POLYGON } from "../../src/predictions/pool-moves.ts";
import { heldReaders, type HeldReaders } from "../../src/stats/held.ts";
import { COINS } from "../../src/swaps/coins.ts";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { chainHelpers } from "../support/stack.ts";
import { startFakeSolanaRpc, type FakeSolanaRpc } from "../support/fake-solana-rpc.ts";

const keyring = createKeyring(generateMnemonic(wordlist));
const arcUrl = inject("anvilUrl");
const arc = createArcClient([arcUrl]);
const chain = chainHelpers(arcUrl);

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const POOL = "0x00000000000000000000000000000000000000a1";
const HL = { accountValueE6: 10_000_000n, spotE6: 2_500_000n };

let database: Database;
let solanaRpc: FakeSolanaRpc;

beforeAll(async () => {
    database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    solanaRpc = await startFakeSolanaRpc();
});
afterAll(async () => {
    await database.close();
    await solanaRpc.stop();
});

/** A Polygon or inventory client whose reads come from a table, keyed by token address (lowercase) or "native". */
function fakeClient(balances: Record<string, bigint>, fail = false): PublicClient {
    return {
        getBalance: async () => {
            if (fail) throw new Error("boom at https://rpc.example.com/v2/SECRETKEY");
            return balances.native ?? 0n;
        },
        readContract: async ({ address }: { address: string }) => {
            if (fail) throw new Error("boom");
            return balances[address.toLowerCase()] ?? 0n;
        },
    } as unknown as PublicClient;
}

function readers(over: Partial<Parameters<typeof heldReaders>[0]> = {}): HeldReaders {
    return heldReaders({
        keyring,
        collections: database.collections,
        arc,
        polygon: fakeClient({}),
        evm: {} as never,
        solana: createSolanaRpc([solanaRpc.url]),
        hyperliquid: {
            state: async () => ({ accountValueE6: HL.accountValueE6 }),
            spotUsdcE6: async () => HL.spotE6,
        },
        poolWallet: () => POOL,
        priceOf: () => 1,
        ...over,
    });
}

test("the treasury reads back the exact balance set on its address", async () => {
    await chain.client.setBalance({ address: keyring.operator().address, value: parseUnits("123.456789", 18) });
    const wallet = await readers().treasury();
    expect(wallet).toMatchObject({
        id: "treasury",
        label: "Arc treasury",
        address: keyring.operator().address,
        usd: 123.456789,
        error: null,
    });
});

test("the deposit addresses sum, past ten of them", async () => {
    await database.collections.accounts.deleteMany({});
    const addresses = Array.from({ length: 23 }, (_, i) => keyring.addressAt(i + 1));
    await database.collections.accounts.insertMany(
        addresses.map((depositAddress, i) => ({ _id: new ObjectId(), depositAddress, depositIndex: i + 1 }) as never),
    );
    for (const address of addresses) await chain.client.setBalance({ address, value: parseUnits("2", 18) });
    const wallet = await readers().deposits();
    expect(wallet).toMatchObject({ id: "deposits", label: "Deposit addresses", usd: 46, error: null });
});

test("the pool sums pUSD, native USDC and USDC.e", async () => {
    const polygon = fakeClient({
        [POLYGON.pusd.toLowerCase()]: 5_000_000n,
        [POLYGON.usdc.toLowerCase()]: 2_250_000n,
        [USDC_E.toLowerCase()]: 1_000_000n,
    });
    const wallet = await readers({ polygon }).pool();
    expect(wallet).toMatchObject({ id: "pool", label: "Polymarket pool", address: POOL, usd: 8.25, error: null });
    expect(wallet.parts.map((p) => p.symbol)).toEqual(["pUSD", "USDC", "USDC.e"]);
});

test("the pool with no wallet is Not set up", async () => {
    const wallet = await readers({ poolWallet: () => null }).pool();
    expect(wallet).toMatchObject({ id: "pool", address: null, usd: 0, error: "Not set up" });
});

test("Hyperliquid adds the spot balance to the account value", async () => {
    const wallet = await readers().hyperliquid();
    expect(wallet).toMatchObject({ id: "hyperliquid", address: keyring.perpAddressAt(0), usd: 12.5, error: null });
});

test("Hyperliquid with an empty perps account still counts spot", async () => {
    const wallet = await readers({
        hyperliquid: { state: async () => null, spotUsdcE6: async () => 2_500_000n },
    }).hyperliquid();
    expect(wallet.usd).toBe(2.5);
});

/** The networks' clients: ethereum holds 0.5 ETH and 100 USDC, the rest nothing. */
function evmClients() {
    const usdc = COINS.find((c) => c.symbol === "USDC")!.entries.find((e) => e.network === "ethereum")!;
    const empty = fakeClient({});
    const clients = Object.fromEntries(
        ["ethereum", "arbitrum", "base", "optimism", "polygon", "bnb", "avalanche", "arc"].map((n) => [n, empty]),
    );
    clients.ethereum = fakeClient({ native: 5n * 10n ** 17n, [usdc.address.toLowerCase()]: 100_000_000n });
    return clients as never;
}

test("the EVM inventory prices native and token balances and lists only the non-zero ones", async () => {
    const wallet = await readers({
        evm: evmClients(),
        priceOf: (s) => ({ ETH: 3000, USDC: 1 })[s] ?? null,
    }).inventoryEvm();
    expect(wallet).toMatchObject({
        id: "inventoryEvm",
        address: keyring.inventoryEvm().address,
        usd: 1600,
        error: null,
    });
    expect(wallet.parts).toEqual([
        { symbol: "ETH", amount: "0.5", usd: 1500 },
        { symbol: "USDC", amount: "100", usd: 100 },
    ]);
});

test("a held coin with no price is listed with a null value and counts nothing", async () => {
    const wallet = await readers({ evm: evmClients(), priceOf: (s) => (s === "USDC" ? 1 : null) }).inventoryEvm();
    expect(wallet.usd).toBe(100);
    expect(wallet.parts[0]).toEqual({ symbol: "ETH", amount: "0.5", usd: null });
});

test("the Solana inventory reads SOL and SPL tokens from the RPC", async () => {
    const { address } = keyring.inventorySolana();
    const usdc = COINS.find((c) => c.symbol === "USDC")!.entries.find((e) => e.network === "solana")!;
    solanaRpc.setBalance(address, 2_000_000_000n);
    solanaRpc.setTokenBalance(address, usdc.address, 50_000_000n);
    const wallet = await readers({ priceOf: (s) => ({ SOL: 150, USDC: 1 })[s] ?? null }).inventorySolana();
    expect(wallet).toMatchObject({ id: "inventorySolana", address, usd: 350, error: null });
    expect(wallet.parts).toEqual([
        { symbol: "SOL", amount: "2", usd: 300 },
        { symbol: "USDC", amount: "50", usd: 50 },
    ]);
});

test("in transit sums moves still forwarding and perp rebalances sent, and nothing that ended", async () => {
    const { poolRebalances, perpRebalances } = database.collections;
    await poolRebalances.deleteMany({});
    const base = {
        kind: "move",
        direction: "arc_to_polygon",
        maxFeeE6: Decimal128.fromString("0"),
        updatedAt: new Date(),
    };
    const pool = (state: string, e6: string) =>
        ({ _id: new ObjectId(), ...base, state, amountE6: Decimal128.fromString(e6) }) as never;
    await poolRebalances.insertMany([
        pool("forwarding", "3000000"),
        pool("done", "9000000"),
        pool("failed", "9000000"),
    ]);
    const perp = (state: string, e6: string) =>
        ({
            _id: new ObjectId(),
            direction: "arc_to_hl",
            state,
            amountE6: Decimal128.fromString(e6),
            txHash: "0x",
            createdAt: new Date(),
        }) as never;
    await perpRebalances.insertMany([perp("sent", "4000000"), perp("arrived", "9000000")]);
    const wallet = await readers().transit();
    expect(wallet).toMatchObject({ id: "transit", label: "In transit", address: null, usd: 7, error: null });
});

test("a reader whose client throws reports a short error with URLs cut to the host, and the others carry on", async () => {
    const down = fakeClient({}, true);
    const r = readers({ polygon: down, evm: { ethereum: down } as never });
    const pool = await r.pool();
    expect(pool).toMatchObject({ usd: 0, parts: [], address: POOL });
    expect(pool.error).toBeTruthy();
    const evm = await r.inventoryEvm();
    expect(evm.usd).toBe(0);
    expect(evm.error).toContain("rpc.example.com");
    expect(evm.error).not.toContain("SECRETKEY");
    expect((await r.hyperliquid()).error).toBeNull();
});
