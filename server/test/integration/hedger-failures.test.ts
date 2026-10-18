import { MongoClient, ObjectId, type Collection } from "mongodb";
import { pino } from "pino";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test, vi } from "vitest";
import type { Collections } from "../../src/db/mongo.ts";
import { createLifi, LifiError, type Lifi } from "../../src/swaps/lifi.ts";
import type { HedgeDoc, TradeDoc } from "../../src/trading/docs.ts";
import { TradeHedger } from "../../src/trading/hedger.ts";
import { toUnitsDecimal } from "../../src/trading/units.ts";
import { startFakeLifi, type FakeLifi } from "../support/fake-lifi.ts";
import { fakeInventoryChain, type FakeInventoryChain } from "../support/fake-inventory-chain.ts";

type Line = Record<string, any> & { level: number; msg: string };

let client: MongoClient;
let trades: Collection<TradeDoc>;
let hedges: Collection<HedgeDoc>;
let fakeLifi: FakeLifi;
let lifi: Lifi;
let chain: FakeInventoryChain;
let clock: number;
const lines: Line[] = [];
const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
const INVENTORY = privateKeyToAddress(generatePrivateKey()) as Address;
const TREASURY = privateKeyToAddress(generatePrivateKey()) as Address;
const OTHER = privateKeyToAddress(generatePrivateKey());
const WARN = 40;

beforeAll(async () => {
    client = await new MongoClient(inject("mongoUri")).connect();
    const db = client.db(`hedger-failures-${Date.now()}`);
    trades = db.collection("trades");
    hedges = db.collection("hedges");
    fakeLifi = await startFakeLifi({ prices: { ETH: 2000, USDC: 1 } });
    lifi = createLifi({ url: fakeLifi.url });
});
afterAll(async () => {
    await fakeLifi?.stop();
    await client?.close();
});
beforeEach(async () => {
    await Promise.all([trades.deleteMany({}), hedges.deleteMany({})]);
    chain = fakeInventoryChain();
    clock = 1_800_000_000_000;
    lines.length = 0;
});

const hedger = (over: Partial<Lifi> = {}, intervalMs?: number) =>
    new TradeHedger({
        client,
        collections: { trades, hedges } as Pick<Collections, "trades" | "hedges">,
        lifi: { ...lifi, chains: () => lifi.chains(), quote: lifi.quote, status: lifi.status, ...over },
        chain,
        inventory: INVENTORY,
        treasury: TREASURY,
        integrator: "test",
        logger,
        now: () => clock,
        intervalMs,
    });

async function sellOfEth() {
    const doc: TradeDoc = {
        _id: new ObjectId(),
        accountId: new ObjectId(),
        requestId: new ObjectId().toString(),
        verb: "sell",
        symbol: "ETH",
        toSymbol: null,
        paidSymbol: "ETH",
        paidUnits: toUnitsDecimal(10n ** 18n),
        gotSymbol: "USDC",
        gotUnits: toUnitsDecimal(2000n * 10n ** 18n),
        usd: toUnitsDecimal(2000n * 10n ** 18n),
        priceUSD: "2000",
        toPriceUSD: null,
        hedged: false,
        createdAt: new Date(),
    };
    await trades.insertOne(doc);
}

const only = async () => (await hedges.find({}).toArray())[0]!;
const logged = (event: string) => lines.filter((line) => line.event === event);

describe("a hedge that fails keeps its reason", () => {
    test("no route says the pair and amount and keeps LI.FI's words, and the log line has the hedge's numbers", async () => {
        await sellOfEth();
        fakeLifi.noRoute();

        await hedger().tick();

        const hedge = await only();
        expect(hedge).toMatchObject({
            state: "failed",
            reason: "LI.FI found no route for 1 ETH on Ethereum to USDC on Arc",
        });
        expect(hedge.detail).toMatch(/^LI\.FI answered 404/);
        const failures = logged("hedge:failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            level: WARN,
            hedge: hedge._id.toHexString(),
            symbol: "ETH",
            side: "sell",
            units: "1",
            usd: "2000",
            network: "ethereum",
            step: "quote",
            request: { fromChain: 1, fromAmount: "1000000000000000000" },
            msg: "A hedge failed: LI.FI found no route for 1 ETH on Ethereum to USDC on Arc",
        });
    });

    test("a revert says which transaction on which network", async () => {
        await sellOfEth();
        const worker = hedger();
        await worker.tick();
        chain.mineAll("reverted");

        await worker.tick();

        const hedge = await only();
        expect(hedge.reason).toBe(`The sell reverted on Ethereum (tx ${chain.prepared[0]!.tx.hash})`);
        expect(logged("hedge:failed")[0]).toMatchObject({ txHash: chain.prepared[0]!.tx.hash, nonce: 0 });
    });

    test("LI.FI reporting the sell failed keeps its substatus and its sentence", async () => {
        await sellOfEth();
        const worker = hedger();
        await worker.tick();
        chain.mineAll("success");
        const hash = chain.prepared[0]!.tx.hash;
        fakeLifi.setStatus(hash, {
            status: "FAILED",
            substatus: "SLIPPAGE_EXCEEDED",
            substatusMessage: "Price moved too far",
        });

        await worker.tick();

        expect(await only()).toMatchObject({
            state: "failed",
            reason: "LI.FI reports the sell failed: SLIPPAGE_EXCEEDED (Price moved too far)",
        });
    });
});

describe("a hedge that can't move yet", () => {
    test("a quote that isn't the sell we asked for is logged once with both sides and says so on the hedge", async () => {
        await sellOfEth();
        const worker = hedger({ quote: async (request) => ({ ...(await lifi.quote(request)), fromAddress: OTHER }) });

        await worker.tick();
        await worker.tick();
        await worker.tick();

        const hedge = await only();
        expect(hedge.state).toBe("planned");
        expect(hedge.reason).toBe(
            `LI.FI's quote didn't match the sell we asked for (sender: expected ${INVENTORY}, got ${OTHER}), so nothing was sent.`,
        );
        expect(hedge.detail).toBe(`sender: expected ${INVENTORY}, got ${OTHER}`);
        const rejected = logged("quote:rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({
            level: WARN,
            hedge: hedge._id.toHexString(),
            symbol: "ETH",
            rule: "sender",
            expected: INVENTORY,
            got: OTHER,
        });
        // The hedger doesn't log the same refusal a second time
        expect(logged("hedge:stuck")).toHaveLength(0);
    });

    test("LI.FI being down is logged once with the step and the request, whatever the number of passes", async () => {
        await sellOfEth();
        const worker = hedger({
            quote: async () => {
                throw new LifiError(
                    "rate_limited",
                    'LI.FI is rate limiting us, it answered 429 for a quote: "slow down"',
                    {
                        said: { status: 429, upstream: "slow down" },
                    },
                );
            },
        });

        await worker.tick();
        await worker.tick();
        await worker.tick();

        const stuck = logged("hedge:stuck");
        expect(stuck).toHaveLength(1);
        expect(stuck[0]).toMatchObject({
            level: WARN,
            symbol: "ETH",
            side: "sell",
            state: "planned",
            step: "quote",
            request: { fromChain: 1 },
            upstream: { status: 429, upstream: "slow down" },
            msg: 'Couldn\'t move a hedge along at its quote step: LI.FI is rate limiting us, it answered 429 for a quote: "slow down"',
        });
        expect((await only()).reason).toBe(
            'Retrying (quote): LI.FI is rate limiting us, it answered 429 for a quote: "slow down"',
        );

        // It is said again once the interval has passed, with how many were left out
        clock += 61 * 60_000;
        await worker.tick();
        expect(logged("hedge:stuck")).toHaveLength(2);
        expect(logged("hedge:stuck")[1]).toMatchObject({ repeatsLeftOut: 2 });
    });

    test("a minimum too far under the amount waits, says so on the hedge, and is logged once", async () => {
        await sellOfEth();
        const worker = hedger({
            quote: async (request) => ({ ...(await lifi.quote(request)), toAmountMin: "1", shortfall: 1 }),
        });

        await worker.tick();
        await worker.tick();

        expect((await only()).reason).toBe("Waiting: LI.FI's minimum is 100% under the amount (limit 2%), retrying");
        const waits = logged("hedge:too-far-under");
        expect(waits).toHaveLength(1);
        expect(waits[0]).toMatchObject({ symbol: "ETH", units: "1", usd: "2000", limit: 0.02, toAmountMin: "1" });
    });

    test("a pass that fails every time is logged once as an error, not on every pass", async () => {
        const worker = hedger({}, 5);
        let fails = 0;
        const original = trades.find.bind(trades);
        trades.find = (() => {
            fails += 1;
            throw new Error("Mongo is down");
        }) as never;
        try {
            worker.start();
            await vi.waitFor(() => expect(fails).toBeGreaterThanOrEqual(4));
        } finally {
            await worker.stop();
            trades.find = original;
        }

        const passes = logged("hedge:pass");
        expect(passes).toHaveLength(1);
        expect(passes[0]).toMatchObject({ level: 50, msg: "Hedge pass failed, hedges are not being moved" });
        expect(passes[0]!.err.message).toBe("Mongo is down");
    });
});
