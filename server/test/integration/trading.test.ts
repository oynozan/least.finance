import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { Ack, WalletSession } from "../../src/protocol.ts";
import type {
    CoinWithdrawalView,
    CoinWithdrawRequest,
    HoldingView,
    TradeOrderRequest,
    TradeResult,
    TradingAck,
} from "../../src/trading/types.ts";
import { fromUnitsDecimal, parseUnits18 } from "../../src/trading/units.ts";
import { startStack, type AppSocket, type Stack } from "../support/stack.ts";

let stack: Stack;
let open: Stack;
beforeAll(async () => {
    const base = { mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") };
    stack = await startStack(base);
    open = await startStack({ ...base, env: { COIN_WITHDRAWALS: "on" } });
});
afterAll(async () => {
    await stack?.stop();
    await open?.stop();
});

const wei = (usdc: string) => parseUnits(usdc, 18);

/** A signed-in user whose account holds `usdc`. */
async function person(s: Stack, usdc = "100") {
    const user = await s.user();
    const socket = await s.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const { accounts, ledger } = s.server.services.database.collections;
    const account = (await accounts.findOne({ privyUserId: user.userId }))!;
    const updated = await accounts.findOneAndUpdate(
        { _id: account._id },
        { $inc: { balance: toDecimal(wei(usdc)), version: 1 } },
        { returnDocument: "after" },
    );
    await ledger.insertOne({
        _id: new ObjectId(),
        accountId: account._id,
        kind: "deposit",
        amount: toDecimal(wei(usdc)),
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

const withdraw = (socket: AppSocket, request: Omit<CoinWithdrawRequest, "requestId"> & { requestId?: string }) =>
    socket.timeout(5000).emitWithAck("holding:withdraw", { requestId: randomUUID(), ...request }) as Promise<
        TradingAck<{ withdrawal: CoinWithdrawalView; holdings: HoldingView[] }>
    >;

const ok = <T>(ack: TradingAck<T>) => {
    if (!ack.ok) throw new Error(`${ack.code}: ${ack.message}`);
    return ack;
};

const balanceOf = async (s: Stack, accountId: ObjectId) =>
    fromDecimal((await s.server.services.database.collections.accounts.findOne({ _id: accountId }))!.balance);

describe("account trading", () => {
    test("a buy debits the balance and adds units once, with a ledger entry and a trade", async () => {
        const { socket, accountId } = await person(stack);
        const result = ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        expect(result.trade).toMatchObject({
            verb: "buy",
            paidSymbol: "USDC",
            paidUnits: "60",
            gotSymbol: "BNB",
            gotUnits: "0.1",
            usd: "60",
        });
        expect(result.balance).toBe("40");
        expect(result.holdings).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);

        const { ledger, trades } = stack.server.services.database.collections;
        expect(await trades.countDocuments({ accountId })).toBe(1);
        const entry = await ledger.findOne({ accountId, kind: "trade_buy" });
        expect(fromDecimal(entry!.amount)).toBe(-wei("60"));
        expect(await balanceOf(stack, accountId)).toBe(wei("40"));
    });

    test("a buy rounds the units down to the coin's decimals and charges only what they cost", async () => {
        const { socket } = await person(stack);
        const result = ok(
            await trade(socket, { verb: "buy", symbol: "BTC", amountUSD: "100", quotedPriceUSD: "97300" }),
        );
        expect(result.trade.gotUnits).toBe("0.00102774");
        expect(Number(result.trade.paidUnits)).toBeLessThanOrEqual(100);
        expect(Number(result.trade.paidUnits)).toBeGreaterThan(99.99);
    });

    test("a repeated requestId returns the same result and fills once", async () => {
        const { socket, accountId } = await person(stack);
        const requestId = randomUUID();
        const first = ok(await trade(socket, { requestId, verb: "buy", symbol: "BNB", amountUSD: "30" }));
        const second = ok(await trade(socket, { requestId, verb: "buy", symbol: "BNB", amountUSD: "30" }));
        expect(second.trade).toEqual(first.trade);
        expect(second.balance).toBe("70");
        expect(second.holdings).toEqual([{ symbol: "BNB", units: "0.05", network: "bnb" }]);
        const { trades } = stack.server.services.database.collections;
        expect(await trades.countDocuments({ accountId })).toBe(1);
    });

    test("a buy over the balance is refused and changes nothing", async () => {
        const { socket, accountId } = await person(stack, "50");
        const refused = await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" });
        expect(refused).toMatchObject({ ok: false, code: "insufficient_balance" });
        const { holdings, trades, ledger } = stack.server.services.database.collections;
        expect(await balanceOf(stack, accountId)).toBe(wei("50"));
        expect(await holdings.countDocuments({ accountId })).toBe(0);
        expect(await trades.countDocuments({ accountId })).toBe(0);
        expect(await ledger.countDocuments({ accountId, kind: "trade_buy" })).toBe(0);
    });

    test("a sell credits the balance at the server's price and takes the units", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        const sold = ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.04" }));
        expect(sold.trade).toMatchObject({
            verb: "sell",
            paidSymbol: "BNB",
            paidUnits: "0.04",
            gotSymbol: "USDC",
            gotUnits: "24",
        });
        expect(sold.balance).toBe("64");
        expect(sold.holdings).toEqual([{ symbol: "BNB", units: "0.06", network: "bnb" }]);
        const { ledger } = stack.server.services.database.collections;
        expect(fromDecimal((await ledger.findOne({ accountId, kind: "trade_sell" }))!.amount)).toBe(wei("24"));
    });

    test("a sell over the holding is refused and changes nothing", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        const refused = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.11" });
        expect(refused).toMatchObject({ ok: false, code: "insufficient_holdings" });
        const none = await trade(socket, { verb: "sell", symbol: "ETH", units: "1", quotedPriceUSD: "3210.4" });
        expect(none).toMatchObject({ ok: false, code: "insufficient_holdings" });
        expect(await balanceOf(stack, accountId)).toBe(wei("40"));
        const { holdings } = stack.server.services.database.collections;
        const bnb = await holdings.findOne({ accountId, symbol: "BNB" });
        expect(fromUnitsDecimal(bnb!.units)).toBe(toBig("0.1"));
    });

    test("a swap moves units between holdings at the two prices and leaves the balance", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        const swapped = ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.05",
                quotedPriceUSD: "600",
                quotedToPriceUSD: "1",
            }),
        );
        expect(swapped.trade).toMatchObject({
            verb: "swap",
            paidSymbol: "BNB",
            paidUnits: "0.05",
            gotSymbol: "USDT",
            gotUnits: "30",
            usd: "30",
        });
        expect(swapped.balance).toBe("40");
        expect(swapped.holdings).toEqual([
            { symbol: "BNB", units: "0.05", network: "bnb" },
            { symbol: "USDT", units: "30", network: expect.any(String) },
        ]);
        const { ledger } = stack.server.services.database.collections;
        const entry = await ledger.findOne({ accountId, kind: "trade_swap" });
        expect(fromDecimal(entry!.amount)).toBe(0n);
        expect(fromDecimal(entry!.balanceAfter)).toBe(wei("40"));
    });

    test("a price more than 1% worse than the quote is refused, within 1% is filled at the server's price", async () => {
        const { socket, accountId } = await person(stack);
        const dearer = await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60", quotedPriceUSD: "590" });
        expect(dearer).toMatchObject({ ok: false, code: "price_moved" });
        const within = ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60", quotedPriceUSD: "595" }));
        expect(within.trade.gotUnits).toBe("0.1");
        const cheaper = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.05", quotedPriceUSD: "610" });
        expect(cheaper).toMatchObject({ ok: false, code: "price_moved" });
        const swap = await trade(socket, {
            verb: "swap",
            symbol: "BNB",
            toSymbol: "USDT",
            units: "0.05",
            quotedPriceUSD: "600",
            quotedToPriceUSD: "0.98",
        });
        expect(swap).toMatchObject({ ok: false, code: "price_moved" });
        expect(await balanceOf(stack, accountId)).toBe(wei("40"));
    });

    test("a trade under $0.10 is refused", async () => {
        const { socket } = await person(stack);
        expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "0.09" })).toMatchObject({
            ok: false,
            code: "below_minimum",
        });
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" }));
        expect(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.00005" })).toMatchObject({
            ok: false,
            code: "below_minimum",
        });
    });

    test("a $0.10 trade fills though its coin amount is rounded down", async () => {
        const { socket } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "0.1" }));
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" }));
        // $0.10 of BNB at $600, rounded down to 8 places as the app sends it, is $0.099996
        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.00016666" }));
        ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.00016666",
                quotedToPriceUSD: "1",
            }),
        );
    });

    test("an unknown coin and bad input are refused", async () => {
        const { socket } = await person(stack);
        expect(await trade(socket, { verb: "buy", symbol: "NOPE", amountUSD: "10" })).toMatchObject({
            ok: false,
            code: "unknown_coin",
        });
        expect(await trade(socket, { verb: "buy", symbol: "BNB" })).toMatchObject({ ok: false, code: "bad_request" });
        expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10", requestId: "x" })).toMatchObject({
            ok: false,
            code: "bad_request",
        });
    });

    test("USDC, the cash itself, is refused as a coin to buy, sell or swap into", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60", quotedPriceUSD: "600" }));
        const refusals = [
            await trade(socket, { verb: "buy", symbol: "USDC", amountUSD: "10", quotedPriceUSD: "1" }),
            await trade(socket, { verb: "sell", symbol: "USDC", units: "10", quotedPriceUSD: "1" }),
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDC",
                units: "0.05",
                quotedPriceUSD: "600",
                quotedToPriceUSD: "1",
            }),
        ];
        for (const refused of refusals) expect(refused).toMatchObject({ ok: false, code: "unknown_coin" });
        const { holdings } = stack.server.services.database.collections;
        expect(await holdings.countDocuments({ accountId, symbol: "USDC" })).toBe(0);
        expect(await balanceOf(stack, accountId)).toBe(wei("40"));
    });

    test("two concurrent buys that together exceed the balance fill exactly one", async () => {
        const { socket, accountId } = await person(stack, "100");
        const answers = await Promise.all([
            trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }),
            trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }),
        ]);
        expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
        expect(answers.filter((answer) => !answer.ok)).toEqual([
            expect.objectContaining({ code: "insufficient_balance" }),
        ]);
        expect(await balanceOf(stack, accountId)).toBe(wei("40"));
        const { holdings } = stack.server.services.database.collections;
        expect(fromUnitsDecimal((await holdings.findOne({ accountId, symbol: "BNB" }))!.units)).toBe(toBig("0.1"));
    });

    test("holdings come with the account snapshot and a fill is pushed to the account's sockets", async () => {
        const { user, socket } = await person(stack);
        const other = await stack.socket(user);
        const pushed = new Promise<HoldingView[]>((resolve) =>
            other.once("holdings:update", ({ holdings }) => resolve(holdings)),
        );
        const filled = new Promise<string>((resolve) => other.once("trade:filled", (view) => resolve(view.gotSymbol)));
        await other.timeout(5000).emitWithAck("account:open", {});
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        expect(await pushed).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);
        expect(await filled).toBe("BNB");

        const reopened = (await other.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
        expect(reopened.ok && reopened.data.holdings).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);
    });

    test("a coin withdrawal is refused while sending is off", async () => {
        const { user, socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        const refused = await withdraw(socket, { symbol: "BNB", units: "0.04", to: user.wallet });
        expect(refused).toMatchObject({ ok: false, code: "unavailable" });
        const { holdings, coinWithdrawals } = stack.server.services.database.collections;
        expect(fromUnitsDecimal((await holdings.findOne({ accountId, symbol: "BNB" }))!.units)).toBe(toBig("0.1"));
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(0);
    });

    test("a coin withdrawal subtracts the units and queues a document while sending is on", async () => {
        const { user, socket, accountId } = await person(open);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        const requestId = randomUUID();
        const sent = ok(await withdraw(socket, { requestId, symbol: "BNB", units: "0.04", to: user.wallet }));
        expect(sent.withdrawal).toMatchObject({
            requestId,
            symbol: "BNB",
            units: "0.04",
            network: "bnb",
            to: user.wallet.toLowerCase(),
            state: "sending",
            txHash: null,
        });
        expect(sent.holdings).toEqual([{ symbol: "BNB", units: "0.06", network: "bnb" }]);

        const repeat = ok(await withdraw(socket, { requestId, symbol: "BNB", units: "0.04", to: user.wallet }));
        expect(repeat.withdrawal.id).toBe(sent.withdrawal.id);
        const { coinWithdrawals, ledger } = open.server.services.database.collections;
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(1);
        expect(
            await ledger.countDocuments({ accountId, kind: { $in: ["trade_buy", "trade_sell", "trade_swap"] } }),
        ).toBe(1);

        const over = await withdraw(socket, { symbol: "BNB", units: "0.07", to: user.wallet });
        expect(over).toMatchObject({ ok: false, code: "insufficient_holdings" });
        const stranger = await withdraw(socket, {
            symbol: "BNB",
            units: "0.01",
            to: "0x000000000000000000000000000000000000dEaD",
        });
        expect(stranger).toMatchObject({ ok: false, code: "bad_request" });
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(1);
    });

    test("a coin withdrawal of USDC is refused", async () => {
        const { user, socket, accountId } = await person(open);
        const refused = await withdraw(socket, { symbol: "USDC", units: "10", to: user.wallet });
        expect(refused).toMatchObject({ ok: false, code: "unknown_coin" });
        const { coinWithdrawals } = open.server.services.database.collections;
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(0);
    });

    test("an unbound socket is refused", async () => {
        const user = await stack.user();
        const socket = await stack.socket(user);
        expect(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" })).toMatchObject({
            ok: false,
            code: "unauthenticated",
        });
    });
});

const toBig = (units: string) => parseUnits18(units)!;
