import { MongoClient, ObjectId, type Collection } from "mongodb";
import { pino } from "pino";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vitest";
import type { Collections } from "../../src/db/mongo.ts";
import { createLifi, LifiError, type Lifi } from "../../src/swaps/lifi.ts";
import type { HedgeDoc, TradeDoc } from "../../src/trading/docs.ts";
import { TradeHedger } from "../../src/trading/hedger.ts";
import { fromUnitsDecimal, toUnitsDecimal } from "../../src/trading/units.ts";
import { startFakeLifi, type FakeLifi } from "../support/fake-lifi.ts";
import { fakeInventoryChain, type FakeInventoryChain } from "../support/fake-inventory-chain.ts";

let client: MongoClient;
let trades: Collection<TradeDoc>;
let hedges: Collection<HedgeDoc>;
let fakeLifi: FakeLifi;
let lifi: Lifi;
let chain: FakeInventoryChain;
const logger = pino({ level: "silent" });
const INVENTORY = privateKeyToAddress(generatePrivateKey()) as Address;
const TREASURY = privateKeyToAddress(generatePrivateKey()) as Address;
const E18 = 10n ** 18n;

beforeAll(async () => {
    client = await new MongoClient(inject("mongoUri")).connect();
    const db = client.db(`hedger-${Date.now()}`);
    trades = db.collection("trades");
    hedges = db.collection("hedges");
    fakeLifi = await startFakeLifi({ prices: { ETH: 2000, BNB: 500, LINK: 10, SOL: 100, USDC: 1 } });
    lifi = createLifi({ url: fakeLifi.url });
});
afterAll(async () => {
    await fakeLifi?.stop();
    await client?.close();
});

beforeEach(async () => {
    await Promise.all([trades.deleteMany({}), hedges.deleteMany({})]);
    chain = fakeInventoryChain();
});

const hedger = (extra: Partial<ConstructorParameters<typeof TradeHedger>[0]> = {}) =>
    new TradeHedger({
        client,
        collections: { trades, hedges } as Pick<Collections, "trades" | "hedges">,
        lifi,
        chain,
        inventory: INVENTORY,
        treasury: TREASURY,
        integrator: "test",
        logger,
        ...extra,
    });

/** Units are whole coins, usd whole dollars. */
async function trade(
    verb: "buy" | "sell" | "swap",
    symbol: string,
    units: number,
    usd: number,
    toSymbol: string | null = null,
    gotUnits = 0,
) {
    const units18 = BigInt(Math.round(units * 1e6)) * 10n ** 12n;
    const usd18 = BigInt(Math.round(usd * 1e6)) * 10n ** 12n;
    const doc: TradeDoc = {
        _id: new ObjectId(),
        accountId: new ObjectId(),
        requestId: new ObjectId().toString(),
        verb,
        symbol,
        toSymbol,
        paidSymbol: verb === "buy" ? "USDC" : symbol,
        paidUnits: toUnitsDecimal(verb === "buy" ? usd18 : units18),
        gotSymbol: verb === "buy" ? symbol : verb === "sell" ? "USDC" : toSymbol!,
        gotUnits: toUnitsDecimal(
            verb === "buy" ? units18 : verb === "sell" ? usd18 : BigInt(Math.round(gotUnits * 1e6)) * 10n ** 12n,
        ),
        usd: toUnitsDecimal(usd18),
        priceUSD: "1",
        toPriceUSD: null,
        hedged: false,
        createdAt: new Date(),
    };
    await trades.insertOne(doc);
    return doc;
}

const hedgeList = () => hedges.find({}).sort({ _id: 1 }).toArray();

describe("TradeHedger netting", () => {
    test("nets buys against sells into one hedge and marks the trades hedged", async () => {
        await trade("buy", "ETH", 2, 4000);
        await trade("sell", "ETH", 0.5, 1000);
        await trade("buy", "ETH", 0.25, 500);
        await hedger().tick();

        const [only, ...rest] = await hedgeList();
        expect(rest).toHaveLength(0);
        expect(only).toMatchObject({ symbol: "ETH", side: "buy", state: "planned", txHash: null });
        expect(fromUnitsDecimal(only!.units)).toBe(175n * 10n ** 16n);
        expect(fromUnitsDecimal(only!.usd)).toBe(3500n * E18);
        expect(only!.tradeIds).toHaveLength(3);
        expect(await trades.countDocuments({ hedged: false })).toBe(0);
        // Buys are left to the operator, and nothing was signed
        expect(only!.reason).toMatch(/Operator/);
        expect(chain.prepared).toHaveLength(0);
    });

    test("a net of a dollar or less waits and later trades push it over", async () => {
        await trade("buy", "ETH", 0.0004, 0.8);
        const worker = hedger();
        await worker.tick();
        expect(await hedges.countDocuments()).toBe(0);
        expect(await trades.countDocuments({ hedged: false })).toBe(1);

        await trade("buy", "ETH", 0.0004, 0.8);
        await worker.tick();
        const [only] = await hedgeList();
        expect(fromUnitsDecimal(only!.usd)).toBe(16n * 10n ** 17n);
        expect(only!.tradeIds).toHaveLength(2);
    });

    test("a repeat pass never hedges a trade twice", async () => {
        await trade("buy", "ETH", 1, 2000);
        const worker = hedger();
        await worker.tick();
        await worker.tick();
        await hedger().tick();
        expect(await hedges.countDocuments()).toBe(1);

        await trade("buy", "ETH", 1, 2000);
        await worker.tick();
        const all = await hedgeList();
        expect(all).toHaveLength(2);
        expect(new Set(all.flatMap((hedge) => hedge.tradeIds.map(String))).size).toBe(2);
    });

    test("offsetting trades close without an order", async () => {
        await trade("buy", "ETH", 1, 2000);
        await trade("sell", "ETH", 1, 2000);
        await hedger().tick();
        const [only] = await hedgeList();
        expect(only).toMatchObject({ state: "done" });
        expect(await trades.countDocuments({ hedged: false })).toBe(0);
        expect(chain.prepared).toHaveLength(0);
    });

    test("a swap stays unhedged until both its legs are covered, and no leg is hedged twice", async () => {
        // Selling 0.05 ETH for 0.2 BNB, with a sale of nearly all of that BNB: the ETH leg is big, the BNB net small
        await trade("swap", "ETH", 0.05, 100, "BNB", 0.2);
        await trade("sell", "BNB", 0.199, 99.5);
        const worker = hedger();
        await worker.tick();
        expect((await hedgeList()).map((hedge) => `${hedge.symbol}:${hedge.side}`)).toEqual(["ETH:sell"]);
        expect(await trades.countDocuments({ hedged: false })).toBe(2);

        await worker.tick();
        expect(await hedges.countDocuments({ symbol: "ETH" })).toBe(1);

        await trade("buy", "BNB", 0.01, 5);
        await worker.tick();
        expect((await hedges.find({ symbol: "BNB" }).toArray())[0]!.tradeIds).toHaveLength(3);
        expect(await trades.countDocuments({ hedged: false })).toBe(0);
        await worker.tick();
        expect(await hedges.countDocuments()).toBe(2);
    });

    test("a swap whose second leg is small keeps the covered leg from being hedged again", async () => {
        await trade("swap", "ETH", 1, 2000, "BNB", 4);
        // The swap's BNB leg nets above the threshold, so it is hedged in the same pass
        await trade("sell", "BNB", 3.9, 1950);
        const worker = hedger();
        await worker.tick();
        const bnb = await hedges.find({ symbol: "BNB" }).toArray();
        expect(bnb).toHaveLength(1);
        expect(bnb[0]!.side).toBe("buy");
        expect(fromUnitsDecimal(bnb[0]!.usd)).toBe(50n * E18);
        await worker.tick();
        expect(await hedges.countDocuments({ symbol: "ETH" })).toBe(1);
        expect(await hedges.countDocuments({ symbol: "BNB" })).toBe(1);
    });
});

describe("TradeHedger selling", () => {
    test("sells a net surplus from the inventory wallet into the treasury and follows it to done", async () => {
        await trade("sell", "ETH", 1, 2000);
        const worker = hedger();
        await worker.tick();

        const [sent] = await hedgeList();
        expect(sent).toMatchObject({ side: "sell", state: "sent", tool: "fakebridge" });
        expect(sent!.txHash).toBe(chain.prepared[0]!.tx.hash);
        expect(chain.broadcasts).toEqual([sent!.txHash]);
        expect(fakeLifi.quotes.at(-1)).toMatchObject({
            fromChain: 1,
            toChain: 5042,
            fromAddress: INVENTORY,
            toAddress: TREASURY,
            fromAmount: E18.toString(),
            toToken: "0x3600000000000000000000000000000000000000",
        });

        // Unmined, so nothing changes
        await worker.tick();
        expect((await hedgeList())[0]!.state).toBe("sent");

        chain.mineAll();
        fakeLifi.setStatus(sent!.txHash!, { status: "PENDING" });
        await worker.tick();
        expect((await hedgeList())[0]!.state).toBe("sent");

        fakeLifi.setStatus(sent!.txHash!, { status: "DONE" });
        await worker.tick();
        expect((await hedgeList())[0]!.state).toBe("done");
        expect(chain.prepared).toHaveLength(1);
    });

    test("a token sale approves LI.FI first and a second pass doesn't approve again", async () => {
        await trade("sell", "LINK", 100, 1000);
        const worker = hedger();
        await worker.tick();
        expect(chain.approvals).toHaveLength(1);
        expect(chain.approvals[0]).toMatchObject({ network: "ethereum", amount: 100n * E18 });
        expect(chain.prepared).toHaveLength(1);
        await worker.tick();
        expect(chain.approvals).toHaveLength(1);
    });

    test("a restart after the hedge record reuses it instead of recording another", async () => {
        await trade("sell", "ETH", 1, 2000);
        const failing: Lifi = {
            ...lifi,
            quote: async () => {
                throw new LifiError("unavailable", "LI.FI could not be reached");
            },
        };
        await hedger({ lifi: failing }).tick();
        const [recorded] = await hedgeList();
        expect(recorded).toMatchObject({ state: "planned", txHash: null });
        expect(chain.prepared).toHaveLength(0);

        await hedger().tick();
        const after = await hedgeList();
        expect(after).toHaveLength(1);
        expect(after[0]!._id.equals(recorded!._id)).toBe(true);
        expect(after[0]!.state).toBe("sent");
        expect(chain.prepared).toHaveLength(1);
    });

    test("a restart after the hash was recorded follows it and signs nothing more", async () => {
        await trade("sell", "ETH", 1, 2000);
        chain.failNext("broadcast", new Error("fetch failed ETIMEDOUT"));
        await hedger().tick();
        const [sending] = await hedgeList();
        expect(sending).toMatchObject({ state: "sending" });
        expect(sending!.txHash).toBe(chain.prepared[0]!.tx.hash);

        chain.mineAll();
        fakeLifi.setStatus(sending!.txHash!, { status: "DONE" });
        await hedger().tick();
        expect((await hedgeList())[0]!.state).toBe("done");
        expect(chain.prepared).toHaveLength(1);
    });

    test("no route fails the hedge and a refused send fails it with the reason", async () => {
        await trade("sell", "ETH", 1, 2000);
        fakeLifi.noRoute();
        await hedger().tick();
        expect((await hedgeList())[0]).toMatchObject({ state: "failed" });
        expect((await hedgeList())[0]!.reason).toMatch(/no route/i);

        await trade("sell", "ETH", 1, 2000);
        chain.failNext("prepare", new Error("insufficient funds for gas"));
        await hedger().tick();
        const second = (await hedgeList())[1]!;
        expect(second.state).toBe("failed");
        expect(second.reason).toMatch(/refused/);
    });

    test("a reverted sell fails the hedge", async () => {
        await trade("sell", "ETH", 1, 2000);
        const worker = hedger();
        await worker.tick();
        chain.mineAll("reverted");
        await worker.tick();
        expect((await hedgeList())[0]!.state).toBe("failed");
    });

    test("a coin held on Solana is left planned for the operator", async () => {
        await trade("sell", "SOL", 10, 1000);
        await hedger().tick();
        const [only] = await hedgeList();
        expect(only).toMatchObject({ side: "sell", state: "planned" });
        expect(only!.reason).toMatch(/Solana/);
        expect(chain.prepared).toHaveLength(0);
        expect(fakeLifi.quotes.filter((quote) => quote.fromChain !== 1)).toHaveLength(0);
    });
});
