import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { nextNonce, withPerpTimeouts, type HyperliquidClient } from "../../src/perps/client.ts";
import { createNktkasClient } from "../../src/perps/nktkas-client.ts";
import { startFakeHyperliquid, type FakeHyperliquid } from "../support/fake-hyperliquid.ts";

const MNEMONIC = "test test test test test test test test test test test junk";
const master = mnemonicToAccount(MNEMONIC, { accountIndex: 0 });
const person = mnemonicToAccount(MNEMONIC, { accountIndex: 1 });
const stranger = mnemonicToAccount(MNEMONIC, { accountIndex: 2 });

let fake: FakeHyperliquid;
let client: HyperliquidClient;

beforeAll(async () => {
    fake = await startFakeHyperliquid();
    client = createNktkasClient({ url: fake.url, timeoutMs: 300 });
});
afterAll(() => fake.stop());
beforeEach(() => {
    fake.reset();
    fake.fund(master.address, 100_000_000n);
    fake.fund(person.address, 20_000_000n);
});

const buy = (cloid: string, sz = "0.001") => ({
    asset: "BTC",
    isBuy: true,
    px: "66000",
    sz,
    reduceOnly: false,
    cloid,
});
const CLOID = `0x${"1".repeat(32)}`;

describe("meta", () => {
    it("meta lists the five catalog assets with szDecimals and marginTables", async () => {
        const meta = await client.meta();
        expect(meta.assets.map((a) => a.asset)).toEqual(["BTC", "ETH", "SOL", "LINK", "DOGE"]);
        const btc = meta.assets[0]!;
        expect(btc).toMatchObject({ index: 0, szDecimals: 5, onlyIsolated: false });
        expect(btc.markPx).toBeGreaterThan(0);
        expect(btc.marginTables.length).toBeGreaterThan(1);
        expect(btc.marginTables[0]).toEqual({ lowerBound: "0.0", maxLeverage: btc.maxLeverage });
    });

    it("meta keeps a k-asset's name and the 24-hour volume, and leaves out a delisted market", async () => {
        const ctx = (markPx: string, dayNtlVlm?: string) => ({
            funding: "0.00001",
            markPx,
            oraclePx: markPx,
            ...(dayNtlVlm === undefined ? {} : { dayNtlVlm }),
        });
        const entry = (name: string, extra: Record<string, unknown> = {}) => ({
            name,
            szDecimals: 0,
            maxLeverage: 10,
            marginTableId: 10,
            ...extra,
        });
        const server = createServer((request, response) => {
            request.resume();
            request.on("end", () => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify([
                        {
                            universe: [
                                entry("BTC"),
                                entry("kPEPE"),
                                entry("OLD", { isDelisted: true }),
                                entry("NOVOL"),
                            ],
                            marginTables: [],
                        },
                        [ctx("66000.0", "2480000000.5"), ctx("0.004123", "950000.0"), ctx("1.0", "5.0"), ctx("2.0")],
                    ]),
                );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const raw = createNktkasClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
        const meta = await raw.meta();
        server.close();

        expect(meta.assets.map((a) => [a.asset, a.index, a.markPx, a.dayNtlVlm])).toEqual([
            ["BTC", 0, 66000, 2_480_000_000.5],
            ["kPEPE", 1, 0.004123, 950_000],
            ["NOVOL", 3, 2, 0],
        ]);
    });

    it("book serves bids and asks best first", async () => {
        fake.setBook("BTC", { bids: [{ price: 65_990, size: 2 }], asks: [{ price: 66_010, size: 3 }] });
        expect(await client.book("BTC")).toEqual({
            bids: [{ price: 65_990, size: 2 }],
            asks: [{ price: 66_010, size: 3 }],
        });
    });
});

describe("candles", () => {
    const HOUR = 3_600_000;

    it("candles read a window oldest first as each candle's open time and close", async () => {
        const end = Date.now();
        const candles = await client.candles("BTC", "1h", end - 5 * HOUR, end);

        // The hours opening inside the window, the current one included
        const opens = candles.map((candle) => candle.openMs);
        expect(opens).toEqual(Array.from({ length: opens.length }, (_, i) => opens[0]! + i * HOUR));
        expect(opens.length).toBeGreaterThanOrEqual(5);
        expect(opens[0]!).toBeGreaterThanOrEqual(end - 5 * HOUR);
        expect(opens.at(-1)).toBe(Math.floor(end / HOUR) * HOUR);
        for (const { openMs, close } of candles) expect(close).toBe(fake.candleClose("BTC", openMs));
        expect(fake.candleReads.at(-1)).toEqual({
            coin: "BTC",
            interval: "1h",
            startTime: end - 5 * HOUR,
            endTime: end,
        });
    });

    it("candles of a market Hyperliquid doesn't list are empty", async () => {
        const end = Date.now();
        expect(await client.candles("NOPE", "1h", end - 5 * HOUR, end)).toEqual([]);
    });

    it("a refused read throws", async () => {
        fake.failCandles(true);
        const end = Date.now();
        await expect(client.candles("BTC", "1h", end - HOUR, end)).rejects.toThrow();
    });
});

describe("order", () => {
    it("a filled order parses totalSz and avgPx", async () => {
        fake.setMark("BTC", 65_000);
        await client.updateLeverage(person, "BTC", 5);
        expect(await client.order(person, buy(CLOID))).toEqual({ kind: "filled", totalSz: "0.001", avgPx: "65000.0" });
        const state = await client.state(person.address);
        expect(state?.positions[0]).toMatchObject({ asset: "BTC", side: "long", sizeCoin: "0.001", leverage: 5 });
        expect(fake.orders).toHaveLength(1);
    });

    it("an error status is rejected, even when the top-level status is ok", async () => {
        fake.nextOrder({ reject: "Order has invalid size." });
        expect(await client.order(person, buy(CLOID))).toEqual({
            kind: "rejected",
            message: "Order has invalid size.",
            raw: expect.stringContaining("Order has invalid size."),
        });
        expect(fake.requests.at(-1)).toBe("exchange order");
    });

    it("a price past the limit is rejected", async () => {
        fake.setMark("BTC", 70_000);
        const result = await client.order(person, buy(CLOID));
        expect(result.kind).toBe("rejected");
    });

    it("a partial fill reports the smaller size", async () => {
        fake.nextOrder({ partial: "0.0004" });
        const result = await client.order(person, buy(CLOID));
        expect(result).toMatchObject({ kind: "filled", totalSz: "0.0004" });
    });

    it("a dropped reply from order is unknown through withPerpTimeouts", async () => {
        fake.nextOrder("drop");
        const bounded = withPerpTimeouts(client, 150);
        expect(await bounded.order(person, buy(CLOID))).toEqual({
            kind: "unknown",
            cause: "order timed out after 150 ms",
            timeoutMs: 150,
        });
        expect(fake.orders).toHaveLength(1);
    });

    it("a held order is unknown and never reaches the book", async () => {
        fake.nextOrder("hold");
        const bounded = withPerpTimeouts(client, 150);
        expect(await bounded.order(person, buy(CLOID))).toMatchObject({ kind: "unknown", timeoutMs: 150 });
        expect(fake.orders).toHaveLength(0);
    });

    it("orderStatus by cloid finds a filled order", async () => {
        await client.order(person, buy(CLOID));
        expect(await client.orderStatus(person.address, CLOID)).toMatchObject({ kind: "filled", totalSz: "0.001" });
    });

    it("orderStatus of a partly filled order is filled at the filled size", async () => {
        fake.nextOrder({ partial: "0.0004" });
        await client.order(person, buy(CLOID));
        expect(await client.orderStatus(person.address, CLOID)).toMatchObject({ kind: "filled", totalSz: "0.0004" });
    });

    it("orderStatus of an unknown cloid is missing", async () => {
        expect(await client.orderStatus(person.address, `0x${"2".repeat(32)}`)).toEqual({ kind: "missing" });
    });

    it("a reduce-only sell closes the position and fills carry the cloid and fee", async () => {
        await client.order(person, buy(CLOID));
        const close = { ...buy(`0x${"3".repeat(32)}`), isBuy: false, px: "60000", reduceOnly: true };
        expect(await client.order(person, close)).toMatchObject({ kind: "filled" });
        expect((await client.state(person.address))?.positions).toEqual([]);
        const fills = await client.fills(person.address, 0);
        expect(fills.map((f) => f.dir)).toEqual(["Open Long", "Close Long"]);
        expect(fills[0]).toMatchObject({ cloid: CLOID, asset: "BTC", liquidation: false });
        expect(fills[0]!.feeE6).toBeGreaterThan(0n);
    });

    it("a liquidation shows in fills and removes the position", async () => {
        await client.order(person, buy(CLOID));
        fake.liquidate(person.address, "BTC");
        expect((await client.state(person.address))?.positions).toEqual([]);
        const fills = await client.fills(person.address, 0);
        expect(fills.at(-1)).toMatchObject({ liquidation: true, asset: "BTC" });
    });
});

describe("state and fees", () => {
    it("state of an unknown address is null", async () => {
        expect(await client.state(stranger.address)).toBeNull();
    });

    it("state reads the free balance", async () => {
        const state = await client.state(person.address);
        expect(state).toMatchObject({ withdrawableE6: 20_000_000n, accountValueE6: 20_000_000n, positions: [] });
    });

    it("userFees reads the taker rate", async () => {
        expect(await client.userFees(master.address)).toEqual({ takerRate: 0.00045 });
    });
});

describe("usdSend", () => {
    it("a repeated usdSend nonce is duplicate", async () => {
        const nonce = nextNonce(master.address);
        expect(await client.usdSend(master, person.address, 5_000_000n, nonce)).toEqual({ kind: "ok" });
        expect(await client.usdSend(master, person.address, 5_000_000n, nonce)).toEqual({ kind: "duplicate" });
        expect(fake.usdSends).toHaveLength(1);
        expect(fake.usdSends[0]).toMatchObject({ amountE6: 5_000_000n, nonce });
        expect((await client.state(person.address))?.withdrawableE6).toBe(25_000_000n);
    });

    it("the activation of a new address comes out of the sender on top of the amount", async () => {
        await client.usdSend(master, stranger.address, 5_000_000n, nextNonce(master.address));
        expect((await client.state(stranger.address))?.withdrawableE6).toBe(5_000_000n);
        expect(fake.account(master.address)?.freeE6).toBe(94_000_000n);
        await client.usdSend(master, stranger.address, 5_000_000n, nextNonce(master.address));
        expect(fake.account(master.address)?.freeE6).toBe(89_000_000n);
    });

    it("with activationFrom amount the new address receives one USDC less", async () => {
        fake.activationFrom("amount");
        await client.usdSend(master, stranger.address, 5_000_000n, nextNonce(master.address));
        expect((await client.state(stranger.address))?.withdrawableE6).toBe(4_000_000n);
        expect(fake.account(master.address)?.freeE6).toBe(95_000_000n);
    });

    it("a failing usdSend is rejected with the message", async () => {
        fake.failUsdSend(true);
        const result = await client.usdSend(master, person.address, 1_000_000n, nextNonce(master.address));
        expect(result.kind).toBe("rejected");
    });

    it("an overdraw is rejected", async () => {
        const result = await client.usdSend(person, master.address, 50_000_000n, nextNonce(person.address));
        expect(result).toMatchObject({ kind: "rejected" });
    });
});

describe("transfers", () => {
    it("a usdSend is listed for both accounts, as mainnet records it", async () => {
        await client.usdSend(master, person.address, 5_000_000n, nextNonce(master.address));
        const sent = { from: master.address.toLowerCase(), to: person.address.toLowerCase(), amountE6: 5_000_000n };
        expect(await client.transfers(master.address, 0)).toMatchObject([sent]);
        expect(await client.transfers(person.address, 0)).toMatchObject([sent]);
        expect(await client.transfers(stranger.address, 0)).toEqual([]);
    });
});

describe("nextNonce", () => {
    it("nextNonce is strictly increasing within one millisecond", () => {
        const seen = Array.from({ length: 50 }, () => nextNonce("0xAbC"));
        for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
        expect(nextNonce("0xabc")).toBeGreaterThan(seen.at(-1)!);
    });

    it("signers have their own sequence", () => {
        const a = nextNonce("0x1");
        nextNonce("0x1");
        expect(nextNonce("0x2")).toBeLessThanOrEqual(a + 1);
    });
});

describe("recorded responses", () => {
    const recorded = (name: string) =>
        JSON.parse(readFileSync(new URL(`../fixtures/hyperliquid/${name}.json`, import.meta.url), "utf8")) as unknown;

    async function against(answer: (type: string) => unknown) {
        const server = createServer((request, response) => {
            let raw = "";
            request.on("data", (chunk) => (raw += chunk));
            request.on("end", () => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(answer((JSON.parse(raw) as { type: string }).type)));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const raw = createNktkasClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
        return { raw, stop: () => server.close() };
    }

    it("a recorded clearinghouseState parses into a position", async () => {
        const { raw, stop } = await against(() => recorded("clearinghouse"));
        const state = await raw.state(person.address);
        stop();
        expect(state?.withdrawableE6).toBe(4_941_142n);
        expect(state?.positions[0]).toEqual({
            asset: "BTC",
            sizeCoin: "0.00152",
            side: "long",
            entryPx: "65789.0",
            leverage: 5,
            liquidationPx: "53011.3",
            unrealizedPnlE6: -1_600n,
            cumFundingE6: 2_000n,
            marginUsedE6: 19_999_142n,
        });
    });

    it("a ledger lists an internalTransfer and a USDC send, and skips the rest", async () => {
        const hash = `0x${"0".repeat(64)}`;
        const a = master.address;
        const b = person.address;
        const { raw, stop } = await against(() => [
            { time: 1, hash, delta: { type: "internalTransfer", usdc: "12.5", user: a, destination: b, fee: "1.0" } },
            {
                time: 2,
                hash,
                delta: {
                    type: "send",
                    user: b,
                    destination: a,
                    sourceDex: "",
                    destinationDex: "",
                    token: "USDC",
                    amount: "3.25",
                    usdcValue: "3.25",
                    fee: "0.0",
                    nativeTokenFee: "0.0",
                    nonce: null,
                },
            },
            {
                time: 3,
                hash,
                delta: {
                    type: "send",
                    user: b,
                    destination: a,
                    sourceDex: "",
                    destinationDex: "",
                    token: "HYPE",
                    amount: "9",
                    usdcValue: "9",
                    fee: "0.0",
                    nativeTokenFee: "0.0",
                    nonce: null,
                },
            },
            { time: 4, hash, delta: { type: "deposit", usdc: "100.0" } },
        ]);
        const sent = await raw.transfers(a, 0);
        stop();
        expect(sent).toEqual([
            { from: a.toLowerCase(), to: b.toLowerCase(), amountE6: 12_500_000n, time: 1 },
            { from: b.toLowerCase(), to: a.toLowerCase(), amountE6: 3_250_000n, time: 2 },
        ]);
    });

    it("recorded fills parse with the liquidation marker and the cloid", async () => {
        const { raw, stop } = await against(() => recorded("fills"));
        const fills = await raw.fills(person.address, 0);
        stop();
        expect(fills.map((f) => [f.dir, f.liquidation, f.feeE6])).toEqual([
            ["Open Long", false, 45_000n],
            ["Liquidated Long", true, 36_000n],
        ]);
        expect(fills[0]!.cloid).toBe("0x00000000000000000000000000000001");
        expect(fills[1]!.cloid).toBeNull();
    });
});
