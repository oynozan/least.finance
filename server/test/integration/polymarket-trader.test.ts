import { pino } from "pino";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { createPolymarketTrader } from "../../src/predictions/polymarket-trader.ts";
import type { PoolTrader } from "../../src/predictions/trader.ts";
import { startFakeClob, type FakeClob } from "../support/fake-clob.ts";

const TOKEN = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const OTHER = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
const HASH = `0x${"b".repeat(64)}`;

let fake: FakeClob;
let trader: PoolTrader & { wallet: string };

beforeAll(async () => {
    fake = await startFakeClob();
    const config = loadConfig({
        MONGODB_URI: "mongodb://localhost:27017",
        PRIVY_APP_ID: "app",
        PRIVY_APP_SECRET: "secret",
        DEPOSIT_MNEMONIC: "test test test test test test test test test test test junk",
        PREDICTIONS_TRADING: "on",
        POLYMARKET_POOL_KEY: generatePrivateKey(),
        POLYMARKET_BUILDER_API_KEY: "builder-key",
        POLYMARKET_BUILDER_API_SECRET: Buffer.from("builder-secret").toString("base64"),
        POLYMARKET_BUILDER_API_PASSPHRASE: "builder-pass",
        POLYMARKET_CLOB_URL: fake.url,
        POLYMARKET_GAMMA_URL: fake.url,
        POLYMARKET_RELAYER_URL: fake.url,
        POLYMARKET_DATA_URL: fake.url,
        POLYGON_RPC_URL: fake.url,
    });
    trader = await createPolymarketTrader(config, pino({ level: "silent" }));
});

afterAll(async () => {
    await fake.stop();
});

beforeEach(() => {
    for (const token of [TOKEN, OTHER]) {
        fake.setBook(token, {
            bids: [
                { price: "0.50", size: "100" },
                { price: "0.54", size: "100" },
            ],
            asks: [
                { price: "0.60", size: "100" },
                { price: "0.55", size: "100" },
            ],
        });
    }
    fake.posted.length = 0;
});

const matched = (making: string, taking: string) => ({
    json: {
        success: true,
        errorMsg: "",
        orderID: HASH,
        status: "matched",
        makingAmount: making,
        takingAmount: taking,
        transactionsHashes: [],
        tradeIDs: ["t1"],
    },
});

const fok = {
    json: {
        success: false,
        errorMsg: "order couldn't be fully filled. FOK orders are fully filled or killed.",
        orderID: "",
        status: "",
        makingAmount: "",
        takingAmount: "",
        transactionsHashes: [],
        tradeIDs: [],
    },
};

describe("the Polymarket trader", () => {
    it("signBuy returns the order hash the signer saw, and posting a matched answer gives filled with e6 amounts", async () => {
        const record = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        expect(record.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
        const again = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        expect(again.orderHash).not.toBe(record.orderHash);

        fake.nextPost(matched("4.5", "8.181818"));
        const result = await trader.post(record);
        expect(result).toEqual({ kind: "filled", orderId: HASH, makingE6: 4_500_000n, takingE6: 8_181_818n });
        expect(trader.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("an ok:false fok_not_filled and an HTTP 400 with the FOK text both give price_moved", async () => {
        const record = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        fake.nextPost(fok);
        expect(await trader.post(record)).toMatchObject({ kind: "rejected", reason: "price_moved" });

        fake.nextPost({ status: 400, body: { error: fok.json.errorMsg } });
        expect(await trader.post(record)).toMatchObject({ kind: "rejected", reason: "price_moved" });

        fake.nextPost({ status: 400, body: { error: "the market is not yet ready to process new orders" } });
        expect(await trader.post(record)).toMatchObject({ kind: "rejected", reason: "market_closed" });

        fake.nextPost({ status: 400, body: { error: "not enough balance / allowance" } });
        expect(await trader.post(record)).toMatchObject({ kind: "rejected", reason: "unavailable" });

        fake.nextPost({ status: 400, body: { error: "order is invalid. Duplicated." } });
        expect(await trader.post(record)).toMatchObject({ kind: "rejected", reason: "rejected" });
    });

    it("a delayed answer gives delayed", async () => {
        const record = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        fake.nextPost({ json: { ...matched("0", "0").json, status: "delayed" } });
        expect(await trader.post(record)).toEqual({ kind: "delayed", orderId: HASH });
    });

    it("a post that times out gives unknown", async () => {
        const record = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        fake.nextPost("hold");
        const arrived = fake.postArrived();
        const posting = trader.post(record);
        await arrived;
        fake.dropConnections();
        expect(await posting).toEqual({ kind: "unknown" });

        fake.nextPost({ status: 503, body: { error: "unavailable" } });
        expect(await trader.post(record)).toEqual({ kind: "unknown" });
    });

    it("lookup maps MATCHED, LIVE, CANCELED and 404", async () => {
        const order = (status: string, matchedSize: string) => ({
            id: HASH,
            status,
            owner: "o",
            maker_address: "0x0",
            market: `0x${"c".repeat(64)}`,
            asset_id: TOKEN,
            side: "BUY",
            original_size: "10",
            size_matched: matchedSize,
            price: "0.55",
            outcome: "Yes",
            expiration: "0",
            order_type: "FOK",
            associate_trades: [],
            created_at: 1_760_000_000,
        });
        const ask = (clobOrderId: string | null = HASH) =>
            trader.lookup({ orderHash: "0xhash", clobOrderId, tokenId: TOKEN });

        fake.setOrder(HASH, order("MATCHED", "10"));
        expect(await ask()).toEqual({ kind: "filled", makingE6: 5_500_000n, takingE6: 10_000_000n });
        fake.setOrder(HASH, order("live", "0"));
        expect(await ask()).toEqual({ kind: "open" });
        // MATCHED with nothing matched yet is not a fill of zero shares
        fake.setOrder(HASH, order("MATCHED", "0"));
        expect(await ask()).toEqual({ kind: "open" });
        fake.setOrder(HASH, order("MATCHED", ""));
        expect(await ask()).toEqual({ kind: "open" });
        fake.setOrder(HASH, order("CANCELED_MARKET_RESOLVED", "0"));
        expect(await ask()).toEqual({ kind: "cancelled" });
        fake.setOrder(HASH, order("INVALID", "0"));
        expect(await ask()).toEqual({ kind: "cancelled" });
        fake.setOrder(HASH, null);
        expect(await ask()).toEqual({ kind: "missing" });
        // Without a CLOB id it looks the order up by the hash it signed
        fake.setOrder("0xhash", order("LIVE", "0"));
        expect(await ask(null)).toEqual({ kind: "open" });
    });

    it("lookup prices a fill from the trades, not the order's limit price", async () => {
        const makerOrder = (price: string, matched: string) => ({
            order_id: `0x${"1".repeat(64)}`,
            maker_address: "0x0",
            owner: "o",
            matched_amount: matched,
            price,
            asset_id: TOKEN,
            outcome: "Yes",
            side: "SELL",
            fee_rate_bps: "0",
        });
        const trade = {
            id: "trade-1",
            taker_order_id: HASH,
            market: `0x${"c".repeat(64)}`,
            asset_id: TOKEN,
            side: "BUY",
            size: "10",
            fee_rate_bps: "0",
            price: "0.508",
            status: "CONFIRMED",
            match_time: "1760000000",
            last_update: "1760000000",
            outcome: "Yes",
            bucket_index: 0,
            owner: "o",
            maker_address: "0x0",
            transaction_hash: `0x${"d".repeat(64)}`,
            trader_side: "TAKER",
            maker_orders: [makerOrder("0.50", "6"), makerOrder("0.52", "4")],
        };
        const order = (side: string) => ({
            id: HASH,
            status: "MATCHED",
            owner: "o",
            maker_address: "0x0",
            market: `0x${"c".repeat(64)}`,
            asset_id: TOKEN,
            side,
            original_size: "10",
            size_matched: "10",
            price: "0.60",
            outcome: "Yes",
            expiration: "0",
            order_type: "FOK",
            associate_trades: ["trade-1"],
            created_at: 1_760_000_000,
        });
        fake.setTrade("trade-1", trade);
        const ask = () => trader.lookup({ orderHash: "0xhash", clobOrderId: HASH, tokenId: TOKEN });
        fake.setOrder(HASH, order("BUY"));
        expect(await ask()).toEqual({ kind: "filled", makingE6: 5_080_000n, takingE6: 10_000_000n });
        fake.setOrder(HASH, order("SELL"));
        expect(await ask()).toEqual({ kind: "filled", makingE6: 10_000_000n, takingE6: 5_080_000n });
        // With no trade to price it, the limit price is the bound that keeps the pool whole
        fake.setTrade("trade-1", { ...trade, id: "other" });
        fake.setOrder(HASH, order("BUY"));
        expect(await ask()).toEqual({ kind: "filled", makingE6: 6_000_000n, takingE6: 10_000_000n });
    });

    describe("findFill", () => {
        const makerOrder = (price: string, matched: string) => ({
            order_id: `0x${"1".repeat(64)}`,
            maker_address: "0x0",
            owner: "o",
            matched_amount: matched,
            price,
            asset_id: TOKEN,
            outcome: "Yes",
            side: "SELL",
            fee_rate_bps: "0",
        });
        const tradeOf = (id: string, taker: string, side: string, makers: ReturnType<typeof makerOrder>[]) => ({
            id,
            taker_order_id: taker,
            market: `0x${"c".repeat(64)}`,
            asset_id: TOKEN,
            side,
            size: "10",
            fee_rate_bps: "0",
            price: "0.5",
            status: "CONFIRMED",
            match_time: "1760000000",
            last_update: "1760000000",
            outcome: "Yes",
            bucket_index: 0,
            owner: "o",
            maker_address: "0x0",
            transaction_hash: `0x${"d".repeat(64)}`,
            trader_side: "TAKER",
            maker_orders: makers,
        });
        const since = new Date(1_760_000_000_000);
        const FILL = `0x${"a".repeat(64)}`;
        const find = (side: "buy" | "sell" = "buy", orderHash = FILL) =>
            trader.findFill({ orderHash, tokenId: TOKEN, side, since });

        afterEach(() => fake.failTrades(null));

        it("sums the taker's trades and ignores others", async () => {
            fake.setTrade("a", tradeOf("a", FILL, "BUY", [makerOrder("0.50", "6")]));
            fake.setTrade("b", tradeOf("b", FILL.toUpperCase().replace("0X", "0x"), "BUY", [makerOrder("0.52", "4")]));
            fake.setTrade("c", tradeOf("c", `0x${"e".repeat(64)}`, "BUY", [makerOrder("0.90", "9")]));
            expect(await find("buy")).toEqual({ makingE6: 5_080_000n, takingE6: 10_000_000n });
            expect(await find("sell")).toEqual({ makingE6: 10_000_000n, takingE6: 5_080_000n });
            expect(fake.tradeQueries.at(-1)).toContain(`after=${since.getTime() / 1000}`);
        });

        it("answers null when no trade names the order", async () => {
            fake.setTrade("c", tradeOf("c", `0x${"e".repeat(64)}`, "BUY", [makerOrder("0.90", "9")]));
            expect(await find("buy", `0x${"f".repeat(64)}`)).toBeNull();
        });

        it("answers unlinked for a trade with no taker order id", async () => {
            fake.setTrade("d", tradeOf("d", "", "BUY", [makerOrder("0.90", "9")]));
            expect(await find("buy", `0x${"f".repeat(64)}`)).toBe("unlinked");
        });

        it("throws on a failing page instead of answering null", async () => {
            fake.failTrades(400);
            await expect(find()).rejects.toThrow();
        });
    });

    it("balanceE6 parses the e6 balance", async () => {
        fake.setBalance(123_456_789n);
        expect(await trader.balanceE6()).toBe(123_456_789n);
    });

    it("the order's maxPrice is on the tick and orderType is FOK", async () => {
        const record = await trader.signBuy({ tokenId: TOKEN, spendE6: 5_000_000n, maxPrice: 0.57 });
        fake.nextPost(matched("4.5", "8"));
        await trader.post(record);
        const body = fake.posted[0] as {
            orderType: string;
            order: { side: string; makerAmount: string; takerAmount: string };
        };
        expect(body.orderType).toBe("FOK");
        expect(body.order.side).toBe("BUY");
        const maker = Number(body.order.makerAmount);
        expect(maker).toBeLessThanOrEqual(5_000_000);
        // The ratio of spend to shares is the limit price, rounded up to the tick at most
        const limit = maker / Number(body.order.takerAmount);
        expect(limit).toBeGreaterThan(0.56);
        expect(limit).toBeLessThanOrEqual(0.57 + 1e-4);
    });

    it("signSell signs a sell by shares with a floor price", async () => {
        const record = await trader.signSell({ tokenId: TOKEN, sharesE6: 10_000_000n, minPrice: 0.52 });
        fake.nextPost(matched("10", "5.3"));
        expect(await trader.post(record)).toEqual({
            kind: "filled",
            orderId: HASH,
            makingE6: 10_000_000n,
            takingE6: 5_300_000n,
        });
        const body = fake.posted[0] as {
            orderType: string;
            order: { side: string; makerAmount: string; takerAmount: string };
        };
        expect(body.order.side).toBe("SELL");
        expect(body.order.makerAmount).toBe("10000000");
        expect(Number(body.order.takerAmount)).toBeGreaterThanOrEqual(5_200_000);
    });

    it("book reads best first and meta reads the market", async () => {
        const book = await trader.book(TOKEN);
        expect(book.bids.map((level) => level.price)).toEqual([0.54, 0.5]);
        expect(book.asks.map((level) => level.price)).toEqual([0.55, 0.6]);
        expect(book).toMatchObject({ tickSize: 0.01, minOrderSize: 5, negRisk: false });
        expect(await trader.meta(TOKEN)).toEqual({
            conditionId: `0x${"c".repeat(64)}`,
            negRisk: false,
            tickSize: 0.01,
            feeRate: 0.05,
            feeExponent: 1,
        });
    });

    it("redeem returns the relayer transaction id and transaction maps its states", async () => {
        const conditionId = `0x${"d".repeat(64)}`;
        const { transactionId } = await trader.redeem(conditionId);
        expect(transactionId).toBe(fake.submitted.at(-1)!.id);
        expect(fake.requests).toContain("POST /submit");

        for (const [state, expected] of [
            ["STATE_NEW", "pending"],
            ["STATE_EXECUTED", "pending"],
            ["STATE_MINED", "pending"],
            ["STATE_CONFIRMED", "confirmed"],
            ["STATE_FAILED", "failed"],
            ["STATE_INVALID", "failed"],
        ] as const) {
            fake.setTransactionState(transactionId, state);
            expect(await trader.transaction(transactionId)).toBe(expected);
        }
    });

    it("holdings reads /v2/positions across pages", async () => {
        fake.setPositionsPageSize(1);
        const pages = () => fake.requests.filter((r) => r === "GET /v2/positions").length;
        const before = pages();
        fake.setPositions([
            { tokenId: TOKEN, size: "12.5", status: "OPEN" },
            { tokenId: OTHER, size: "3.000001", status: "OPEN" },
            { tokenId: "tok-won", size: "20", status: "REDEEMABLE" },
            { tokenId: "tok-lost", size: "0.25", status: "REDEEMABLE" },
            { tokenId: "tok-gone", size: "9", status: "CLOSED" },
        ]);
        const holdings = await trader.holdings();
        expect(holdings).toEqual(
            expect.arrayContaining([
                { tokenId: TOKEN, sharesE6: 12_500_000n },
                { tokenId: OTHER, sharesE6: 3_000_001n },
                { tokenId: "tok-won", sharesE6: 20_000_000n },
                { tokenId: "tok-lost", sharesE6: 250_000n },
            ]),
        );
        expect(holdings).toHaveLength(4);
        expect(pages() - before).toBe(4);
    });
});
