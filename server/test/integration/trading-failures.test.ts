import { randomUUID } from "node:crypto";
import { MongoServerError, ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { afterAll, beforeAll, beforeEach, expect, inject, test, vi } from "vitest";
import { toDecimal } from "../../src/db/money.ts";
import type { Ack, WalletSession } from "../../src/protocol.ts";
import type { TradeOrderRequest, TradeResult, TradingAck } from "../../src/trading/types.ts";
import { startStack, type AppSocket, type Stack } from "../support/stack.ts";

type Line = Record<string, any> & { level: number; msg: string };

const WARN = 40;
const lines: Line[] = [];
let stack: Stack;
beforeAll(async () => {
    const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
    stack = await startStack({
        mongoUri: inject("mongoUri"),
        anvilUrl: inject("anvilUrl"),
        logger,
        env: { COIN_WITHDRAWALS: "on" },
    });
});
afterAll(() => stack?.stop());
beforeEach(() => {
    lines.length = 0;
    vi.restoreAllMocks();
});

async function person(usdc = "100") {
    const user = await stack.user();
    const socket = await stack.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const { accounts, ledger } = stack.server.services.database.collections;
    const account = (await accounts.findOne({ privyUserId: user.userId }))!;
    const updated = await accounts.findOneAndUpdate(
        { _id: account._id },
        { $inc: { balance: toDecimal(parseUnits(usdc, 18)), version: 1 } },
        { returnDocument: "after" },
    );
    await ledger.insertOne({
        _id: new ObjectId(),
        accountId: account._id,
        kind: "deposit",
        amount: toDecimal(parseUnits(usdc, 18)),
        balanceAfter: updated!.balance,
        refId: new ObjectId(),
        createdAt: new Date(),
    });
    return { user, socket, accountId: account._id };
}

const trade = (socket: AppSocket, request: Partial<TradeOrderRequest> & Pick<TradeOrderRequest, "verb" | "symbol">) =>
    socket.timeout(5000).emitWithAck("trade:order", {
        requestId: randomUUID(),
        quotedPriceUSD: "600",
        ...request,
    }) as Promise<TradingAck<TradeResult>>;

const logged = (event: string) => lines.filter((line) => line.event === event && line.level === WARN);

test("a buy at a price that moved says from what to what and is logged once with both prices", async () => {
    const { socket, accountId } = await person();

    const answer = await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "50", quotedPriceUSD: "590" });

    expect(answer).toMatchObject({
        ok: false,
        code: "price_moved",
        message:
            "BNB moved from $590.00 to $600.00, more than the 1% allowed. Review the new price and try again. Nothing was spent.",
    });
    expect(logged("trade:order")).toHaveLength(1);
    expect(logged("trade:order")[0]).toMatchObject({
        account: accountId.toHexString(),
        verb: "buy",
        symbol: "BNB",
        code: "price_moved",
        quotedPriceUSD: "590",
        serverPriceUSD: "600",
        movedBps: 169,
        toleranceBps: 100,
        msg: expect.stringContaining("Refused a buy"),
    });
});

test("a sale and a swap that moved say what was kept", async () => {
    const { socket } = await person();

    const sold = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.1", quotedPriceUSD: "700" });
    expect(sold).toMatchObject({
        ok: false,
        code: "price_moved",
        message: expect.stringContaining("Nothing was sold."),
    });

    const swapped = await trade(socket, {
        verb: "swap",
        symbol: "BNB",
        toSymbol: "ETH",
        units: "0.1",
        quotedPriceUSD: "700",
        quotedToPriceUSD: "3210.4",
    });
    expect(swapped).toMatchObject({
        ok: false,
        code: "price_moved",
        message: expect.stringMatching(/The BNB to ETH rate moved from .* to .* ETH per BNB.*Nothing was swapped\.$/),
    });
    expect(logged("trade:order")).toHaveLength(2);
    expect(logged("trade:order")[1]).toMatchObject({ toSymbol: "ETH", toQuotedPriceUSD: "3210.4" });
});

test("not enough balance says the balance and the cost, and not enough coins says the holding", async () => {
    const { socket } = await person("10");

    const bought = await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60.18" });
    expect(bought).toMatchObject({
        ok: false,
        code: "insufficient_balance",
        message: "You have $10.00 and this costs $60.18. Nothing was spent.",
    });
    expect(logged("trade:order")[0]).toMatchObject({ balanceUSD: "10", costUSD: "60.18" });

    const sold = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.5" });
    expect(sold).toMatchObject({
        ok: false,
        code: "insufficient_holdings",
        message: "You don't hold any BNB but this sells 0.5. Nothing was sold.",
    });
    expect(logged("trade:order")[1]).toMatchObject({ units: "0.5", held: "0" });
});

test("a sale under $0.10 of part of a holding says it has to be all of it", async () => {
    const { socket } = await person();
    await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60.18" });

    const answer = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.0001" });

    expect(answer).toMatchObject({
        ok: false,
        code: "below_minimum",
        message: "A sale under $0.10 has to be all of your BNB (you hold 0.1). Sell everything or at least $0.10.",
    });
});

test("a buy that rounds to nothing says so with the amount, and the minimum names the real cost", async () => {
    const { socket } = await person();

    const answer = await trade(socket, { verb: "buy", symbol: "BTC", amountUSD: "0.05", quotedPriceUSD: "97300" });

    expect(answer).toMatchObject({
        ok: false,
        code: "below_minimum",
        message: expect.stringMatching(/^\$0\.05 buys .* under the smallest trade of \$0\.10\. Try a larger amount\.$/),
    });
});

test("a coin that can't be priced says why: still loading, out of date, or no price", async () => {
    const { socket } = await person();
    const status = vi.spyOn(stack.server.services.swapCatalog, "priceStatus");

    status.mockReturnValueOnce({ reason: "never_read", ageMs: null });
    expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" })).toMatchObject({
        ok: false,
        code: "unavailable",
        message: "Prices are still loading. Try again in a moment.",
    });

    status.mockReturnValueOnce({ reason: "stale", ageMs: 400_000 });
    expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" })).toMatchObject({
        message:
            "Prices for BNB are out of date (last updated 7 minutes ago, LI.FI isn't answering). Try again shortly.",
    });

    status.mockReturnValueOnce({ reason: "no_price", ageMs: 1000 });
    expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" })).toMatchObject({
        message: "LI.FI lists no price for BNB right now. Try again shortly.",
    });
    expect(logged("trade:order").map((line) => line.reason)).toEqual(["never_read", "stale", "no_price"]);
    expect(logged("trade:order")[1]).toMatchObject({ ageMs: 400_000 });
});

test("a buy of USDC or an unknown coin is told apart", async () => {
    const { socket } = await person();

    expect(await trade(socket, { verb: "buy", symbol: "USDC", amountUSD: "10" })).toMatchObject({
        code: "unknown_coin",
        message: "USDC is your cash balance, so it can't be bought or sold. Pick another coin.",
    });
    expect(await trade(socket, { verb: "buy", symbol: "NOPE", amountUSD: "10" })).toMatchObject({
        code: "unknown_coin",
        message: "NOPE isn't a coin we trade.",
    });
});

test("a quoted price that isn't a number says which one, and a swap into itself says so", async () => {
    const { socket } = await person();

    expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10", quotedPriceUSD: "0" })).toMatchObject({
        code: "bad_request",
        message: "The quoted price '0' isn't a usable price.",
    });
    expect(
        await trade(socket, {
            verb: "swap",
            symbol: "BNB",
            toSymbol: "BNB",
            units: "0.1",
            quotedToPriceUSD: "600",
        }),
    ).toMatchObject({ code: "bad_request", message: "You can't swap BNB into itself. Pick a different coin." });
    expect(await trade(socket, { verb: "swap", symbol: "BNB", units: "0.1" })).toMatchObject({
        message: "Pick a coin to swap into.",
    });
});

test("a refused coin send says what it was and what was kept, and is logged once with the numbers", async () => {
    const { user, socket, accountId } = await person();
    await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60.18" });
    const send = (patch: Record<string, string>) =>
        socket.timeout(5000).emitWithAck("holding:withdraw", {
            requestId: randomUUID(),
            symbol: "BNB",
            units: "0.002",
            to: user.wallet,
            ...patch,
        }) as Promise<TradingAck<unknown>>;

    expect(await send({ units: "0.5" })).toMatchObject({
        code: "insufficient_holdings",
        message: "You hold 0.1 BNB but this sends 0.5. Nothing was sent.",
    });
    expect(logged("holding:withdraw")[0]).toMatchObject({
        account: accountId.toHexString(),
        symbol: "BNB",
        units: "0.5",
        held: "0.1",
        to: user.wallet,
    });

    expect(await send({ units: "0.001" })).toMatchObject({
        message: "This send is worth $0.60; the smallest send is $1 because each one costs us network fees.",
    });
    expect(await send({ symbol: "USDC" })).toMatchObject({
        message: "USDC is sent from Withdraw, not from your coins.",
    });
    expect(await send({ symbol: "NOPE" })).toMatchObject({ message: "NOPE isn't a coin we can send." });
    expect(await send({ units: "0" })).toMatchObject({ message: "Enter an amount to send." });
    expect(logged("holding:withdraw")).toHaveLength(5);
});

test("a swap, sell or send refusal is logged by the trade service only, not again by the socket layer", async () => {
    const { socket } = await person();

    await trade(socket, { verb: "sell", symbol: "BNB", units: "0.5" });

    const refusals = lines.filter((line) => line.level === WARN && /Nothing was sold/.test(line.msg));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ event: "trade:order" });
});

test("a clash on another key than the request id is logged, and the trade that vanished names its ids and carries the clash", async () => {
    const { socket, accountId } = await person();
    const clash = new MongoServerError({ code: 11000, errmsg: "E11000 duplicate key error collection: holdings" });
    Object.assign(clash, { keyPattern: { accountId: 1, symbol: 1 } });
    vi.spyOn(stack.server.services.database.collections.trades, "insertOne").mockRejectedValueOnce(clash);
    const requestId = randomUUID();

    const answer = await trade(socket, { requestId, verb: "buy", symbol: "BNB", amountUSD: "10" });

    expect(answer).toMatchObject({
        ok: false,
        message: expect.stringMatching(/^Something went wrong on our side \(ref [0-9a-f]{6}\)\.$/),
    });
    expect(
        lines.find((line) => line.msg === "A duplicate key other than the request id stopped a write"),
    ).toMatchObject({
        level: WARN,
        event: "trade:order",
        account: accountId.toHexString(),
        requestId,
        keyPattern: { accountId: 1, symbol: 1 },
    });
    const unexpected = lines.find((line) => line.msg === "Unexpected error in socket request trade:order")!;
    expect(unexpected.ref).toBe(/ref ([0-9a-f]{6})/.exec((answer as { message: string }).message)![1]);
    expect(unexpected.err.message).toContain(
        `Trade ${requestId} for account ${accountId.toHexString()} vanished after it filled`,
    );
});
