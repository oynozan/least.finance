import { MongoClient, ObjectId, type Collection } from "mongodb";
import { pino } from "pino";
import { createPublicClient, decodeFunctionData, erc20Abi, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test, vi } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import type { Collections } from "../../src/db/mongo.ts";
import { createSwapClients } from "../../src/swaps/clients.ts";
import { CoinSender, type SolanaSender } from "../../src/trading/coin-sender.ts";
import type { CoinWithdrawalDoc, HoldingDoc } from "../../src/trading/docs.ts";
import { createInventoryChain } from "../../src/trading/inventory-chain.ts";
import { fromUnitsDecimal, toUnitsDecimal } from "../../src/trading/units.ts";
import { fakeInventoryChain, type FakeInventoryChain } from "../support/fake-inventory-chain.ts";

let client: MongoClient;
let withdrawals: Collection<CoinWithdrawalDoc>;
let holdings: Collection<HoldingDoc>;
let chain: FakeInventoryChain;
let clock: number;
const logger = pino({ level: "silent" });
const accountId = new ObjectId();
const WALLET = privateKeyToAddress(generatePrivateKey());

beforeAll(async () => {
    client = await new MongoClient(inject("mongoUri")).connect();
    const db = client.db(`coin-sender-${Date.now()}`);
    withdrawals = db.collection("coin_withdrawals");
    holdings = db.collection("holdings");
});
afterAll(() => client?.close());

beforeEach(async () => {
    await Promise.all([withdrawals.deleteMany({}), holdings.deleteMany({})]);
    chain = fakeInventoryChain();
    clock = 1_800_000_000_000;
});

const sender = (extra: Partial<ConstructorParameters<typeof CoinSender>[0]> = {}) =>
    new CoinSender({
        client,
        collections: { coinWithdrawals: withdrawals, holdings } as Pick<Collections, "coinWithdrawals" | "holdings">,
        chain,
        logger,
        now: () => clock,
        ...extra,
    });

async function queue(symbol: string, units: string, network: string, to: string = WALLET) {
    const doc: CoinWithdrawalDoc = {
        _id: new ObjectId(),
        accountId,
        requestId: new ObjectId().toString(),
        symbol,
        units: toUnitsDecimal(BigInt(Math.round(Number(units) * 1e6)) * 10n ** 12n),
        network,
        to,
        state: "sending",
        txHash: null,
        nonce: null,
        reason: null,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
    };
    await withdrawals.insertOne(doc);
    return doc;
}

const reload = (doc: CoinWithdrawalDoc) => withdrawals.findOne({ _id: doc._id });
const held = async (symbol: string) => {
    const row = await holdings.findOne({ accountId, symbol });
    return row ? fromUnitsDecimal(row.units) : 0n;
};

describe("CoinSender on EVM", () => {
    test("sends a native coin, stores the nonce and hash first, and marks it sent once mined", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        const worker = sender();

        await worker.tick();
        const sending = await reload(doc);
        expect(sending).toMatchObject({ state: "sending", nonce: 0 });
        expect(chain.prepared).toHaveLength(1);
        expect(chain.prepared[0]!.intent).toEqual({ to: WALLET, data: "0x", value: parseEther("0.5") });
        expect(sending?.txHash).toBe(chain.prepared[0]!.tx.hash);
        expect(chain.broadcasts).toEqual([sending?.txHash]);

        // Nothing is mined yet, so another pass sends nothing more
        await worker.tick();
        expect(chain.prepared).toHaveLength(1);

        chain.mineAll();
        await worker.tick();
        expect(await reload(doc)).toMatchObject({ state: "sent", txHash: sending?.txHash });
        expect(await held("ETH")).toBe(0n);
    });

    test("sends a token with an ERC-20 transfer in the token's own decimals", async () => {
        await queue("USDT", "12.5", "ethereum");
        await sender().tick();

        const { intent } = chain.prepared[0]!;
        expect(intent.to.toLowerCase()).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
        expect(intent.value).toBe(0n);
        expect(decodeFunctionData({ abi: erc20Abi, data: intent.data })).toEqual({
            functionName: "transfer",
            args: [WALLET, 12_500_000n],
        });
    });

    test("gives nonces to successive withdrawals in order", async () => {
        const first = await queue("ETH", "0.1", "ethereum");
        const second = await queue("ETH", "0.2", "ethereum");
        await sender().tick();
        expect((await reload(first))?.nonce).toBe(0);
        expect((await reload(second))?.nonce).toBe(1);
    });

    test("a refused withdrawal gives the units back once", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext("prepare", new Error("insufficient funds for gas * price + value"));
        const worker = sender();

        await worker.tick();
        expect(await reload(doc)).toMatchObject({ state: "failed" });
        expect((await reload(doc))?.reason).toMatch(/refused/);
        expect(await held("ETH")).toBe(5n * 10n ** 17n);

        await worker.tick();
        await sender().tick();
        expect(await held("ETH")).toBe(5n * 10n ** 17n);
    });

    test("a refusal at broadcast adds the units to what is still held", async () => {
        await holdings.insertOne({
            _id: new ObjectId(),
            accountId,
            symbol: "ETH",
            units: toUnitsDecimal(10n ** 18n),
            network: "ethereum",
            updatedAt: new Date(clock),
        });
        const doc = await queue("ETH", "0.25", "ethereum");
        chain.failNext("broadcast", new Error("replacement transaction underpriced"));
        await sender().tick();
        expect((await reload(doc))?.state).toBe("failed");
        expect(await held("ETH")).toBe(125n * 10n ** 16n);
    });

    test("a reverted transfer is given back", async () => {
        const doc = await queue("USDT", "3", "ethereum");
        const worker = sender();
        await worker.tick();
        chain.mineAll("reverted");
        await worker.tick();
        expect((await reload(doc))?.state).toBe("failed");
        expect(await held("USDT")).toBe(3n * 10n ** 18n);
    });

    test("a timed-out send is not given back, and a restart reuses the stored nonce", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext("broadcast", new Error("fetch failed: ETIMEDOUT"));
        await sender().tick();

        const stuck = await reload(doc);
        expect(stuck).toMatchObject({ state: "sending", nonce: 0 });
        expect(await held("ETH")).toBe(0n);

        // Within the resend window a pass leaves it alone
        clock += 30_000;
        await sender().tick();
        expect(chain.prepared).toHaveLength(1);

        // A fresh process, after the window, signs on the stored nonce again
        const restarted = fakeInventoryChain();
        chain = restarted;
        clock += 200_000;
        await sender().tick();
        expect(restarted.prepared).toHaveLength(1);
        expect(restarted.prepared[0]!.tx.nonce).toBe(0);
        expect(await held("ETH")).toBe(0n);

        // Another withdrawal does not take the reserved nonce
        const next = await queue("ETH", "0.1", "ethereum");
        await sender().tick();
        expect((await reload(next))?.nonce).toBe(1);
    });

    test("an unreachable node during signing leaves the withdrawal sending", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext("prepare", new Error("HTTP request failed. fetch failed"));
        await sender().tick();
        expect(await reload(doc)).toMatchObject({ state: "sending", txHash: null });
        expect(await held("ETH")).toBe(0n);
        // The next pass signs on the stored nonce
        await sender().tick();
        expect((await reload(doc))?.txHash).toBe(chain.prepared[0]!.tx.hash);
        expect(chain.prepared[0]!.tx.nonce).toBe(0);
    });
});

describe("CoinSender on Solana", () => {
    const fakeSolana = () => {
        const statuses = new Map<string, "confirmed" | "failed">();
        const sent: { to: string; lamports: bigint; signature: string }[] = [];
        const solana: SolanaSender = {
            async prepare(to, lamports) {
                const signature = `sig-${sent.length + 1}`;
                return { signature, broadcast: async () => void sent.push({ to, lamports, signature }) };
            },
            async status(signature) {
                return statuses.get(signature) ?? null;
            },
        };
        return { solana, statuses, sent };
    };

    test("without a Solana sender the units go back", async () => {
        const doc = await queue("SOL", "1.5", "solana", "11111111111111111111111111111112");
        await sender().tick();
        expect((await reload(doc))?.state).toBe("failed");
        expect(await held("SOL")).toBe(15n * 10n ** 17n);
    });

    test("sends SOL in lamports and marks it sent once confirmed", async () => {
        const { solana, statuses, sent } = fakeSolana();
        const doc = await queue("SOL", "1.5", "solana", "11111111111111111111111111111112");
        const worker = sender({ solana });
        await worker.tick();
        expect(sent).toEqual([
            { to: "11111111111111111111111111111112", lamports: 1_500_000_000n, signature: "sig-1" },
        ]);
        expect((await reload(doc))?.txHash).toBe("sig-1");

        await worker.tick();
        expect(sent).toHaveLength(1);
        statuses.set("sig-1", "confirmed");
        await worker.tick();
        expect(await reload(doc)).toMatchObject({ state: "sent", txHash: "sig-1" });
    });

    test("a transaction still unknown after the window is signed again", async () => {
        const { solana, sent } = fakeSolana();
        await queue("SOL", "1", "solana", "11111111111111111111111111111112");
        const worker = sender({ solana });
        await worker.tick();
        clock += 200_000;
        await worker.tick();
        expect(sent.map((entry) => entry.signature)).toEqual(["sig-1", "sig-2"]);
    });
});

describe("CoinSender on a real chain", () => {
    test("sends ETH from the inventory wallet on anvil and marks it sent", async () => {
        const account = createKeyring("test test test test test test test test test test test junk").inventoryEvm();
        const url = inject("ethereumUrl");
        const refused = ["http://127.0.0.1:9"];
        const clients = createSwapClients({
            ethereum: [url],
            arbitrum: refused,
            base: refused,
            optimism: refused,
            polygon: refused,
            bnb: refused,
            avalanche: refused,
            arc: refused,
        });
        const rpc = createPublicClient({ chain: mainnet, transport: http(url) });
        await rpc.request({
            method: "anvil_setBalance" as never,
            params: [account.address, `0x${parseEther("5").toString(16)}`] as never,
        });
        const to = privateKeyToAddress(generatePrivateKey()) as Address;
        const doc = await queue("ETH", "0.75", "ethereum", to);

        const worker = sender({ chain: createInventoryChain({ account, clients }), now: Date.now });
        await worker.tick();
        await vi.waitFor(async () => {
            await worker.tick();
            expect((await reload(doc))?.state).toBe("sent");
        });
        expect(await rpc.getBalance({ address: to })).toBe(parseEther("0.75"));
    });
});
