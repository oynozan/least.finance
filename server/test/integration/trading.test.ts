import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { Ack, ActivityPage, PnlSeries, WalletSession } from "../../src/protocol.ts";
import type {
    CoinWithdrawalView,
    CoinWithdrawRequest,
    HoldingView,
    TradeOrderRequest,
    TradeResult,
    TradeVerb,
    TradingAck,
    TradingServerEvents,
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

/** BNB is priced at $600, and a buy fills at the ask, 0.3% over that: $601.80 a coin. So $60.18 buys exactly 0.1 BNB. */
const TENTH_BNB = "60.18";
/** What $100 comes to after buying 0.1 BNB. */
const AFTER_TENTH = "39.82";

type TradeFill = Parameters<TradingServerEvents["trade:filled"]>[0];

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
        const result = ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        expect(result.trade).toMatchObject({
            verb: "buy",
            paidSymbol: "USDC",
            paidUnits: TENTH_BNB,
            gotSymbol: "BNB",
            gotUnits: "0.1",
            usd: TENTH_BNB,
        });
        expect(result.balance).toBe(AFTER_TENTH);
        expect(result.holdings).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);

        const { ledger, trades } = stack.server.services.database.collections;
        expect(await trades.countDocuments({ accountId })).toBe(1);
        const entry = await ledger.findOne({ accountId, kind: "trade_buy" });
        expect(fromDecimal(entry!.amount)).toBe(-wei(TENTH_BNB));
        expect(await balanceOf(stack, accountId)).toBe(wei(AFTER_TENTH));
    });

    test("a buy rounds the units down to the coin's decimals and charges only what they cost", async () => {
        const { socket } = await person(stack);
        const result = ok(
            await trade(socket, { verb: "buy", symbol: "BTC", amountUSD: "100", quotedPriceUSD: "97300" }),
        );
        // $100 at the ask of $97,591.90 a coin, rounded down to BTC's 8 places
        expect(result.trade.gotUnits).toBe("0.00102467");
        expect(result.trade.paidUnits).toBe("99.999492173");
    });

    test("a repeated requestId returns the same result and fills once", async () => {
        const { socket, accountId } = await person(stack);
        const requestId = randomUUID();
        const first = ok(await trade(socket, { requestId, verb: "buy", symbol: "BNB", amountUSD: "30.09" }));
        const second = ok(await trade(socket, { requestId, verb: "buy", symbol: "BNB", amountUSD: "30.09" }));
        expect(second.trade).toEqual(first.trade);
        expect(second.balance).toBe("69.91");
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

    test("a sell credits the balance at the bid and takes the units", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        const sold = ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.04" }));
        expect(sold.trade).toMatchObject({
            verb: "sell",
            paidSymbol: "BNB",
            paidUnits: "0.04",
            gotSymbol: "USDC",
            // 0.04 BNB at the bid of $598.20 a coin
            gotUnits: "23.928",
        });
        expect(sold.balance).toBe("63.748");
        expect(sold.holdings).toEqual([{ symbol: "BNB", units: "0.06", network: "bnb" }]);
        const { ledger } = stack.server.services.database.collections;
        expect(fromDecimal((await ledger.findOne({ accountId, kind: "trade_sell" }))!.amount)).toBe(wei("23.928"));
    });

    test("a sell over the holding is refused and changes nothing", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        const refused = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.11" });
        expect(refused).toMatchObject({ ok: false, code: "insufficient_holdings" });
        const none = await trade(socket, { verb: "sell", symbol: "ETH", units: "1", quotedPriceUSD: "3210.4" });
        expect(none).toMatchObject({ ok: false, code: "insufficient_holdings" });
        expect(await balanceOf(stack, accountId)).toBe(wei(AFTER_TENTH));
        const { holdings } = stack.server.services.database.collections;
        const bnb = await holdings.findOne({ accountId, symbol: "BNB" });
        expect(fromUnitsDecimal(bnb!.units)).toBe(toBig("0.1"));
    });

    test("a swap sells the first coin at its bid, buys the second at its market price and leaves the balance", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
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
            // 0.05 BNB at the bid of $598.20 is $29.91: the one spread of the swap, not two
            gotUnits: "29.91",
            usd: "29.91",
        });
        expect(swapped.balance).toBe(AFTER_TENTH);
        expect(swapped.holdings).toEqual([
            { symbol: "BNB", units: "0.05", network: "bnb" },
            { symbol: "USDT", units: "29.91", network: expect.any(String) },
        ]);
        const { ledger } = stack.server.services.database.collections;
        const entry = await ledger.findOne({ accountId, kind: "trade_swap" });
        expect(fromDecimal(entry!.amount)).toBe(0n);
        expect(fromDecimal(entry!.balanceAfter)).toBe(wei(AFTER_TENTH));
    });

    test("a price more than 1% worse than the quote is refused, within 1% is filled at the server's price", async () => {
        const { socket, accountId } = await person(stack);
        const dearer = await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB, quotedPriceUSD: "590" });
        expect(dearer).toMatchObject({ ok: false, code: "price_moved" });
        const within = ok(
            await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB, quotedPriceUSD: "595" }),
        );
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
        expect(await balanceOf(stack, accountId)).toBe(wei(AFTER_TENTH));
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
        // $0.10 of BNB at $600, rounded down to 8 places as the app sends it, is $0.099996, and $0.09969 at the bid
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
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB, quotedPriceUSD: "600" }));
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
        expect(await balanceOf(stack, accountId)).toBe(wei(AFTER_TENTH));
    });

    test("a holding worth under $0.10 sells or swaps only whole, and a partial sale of it is refused", async () => {
        const { socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "6.018" }));
        // 0.01 BNB bought, 0.0001 ($0.06) left
        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.0099" }));
        const before = await balanceOf(stack, accountId);

        const partial = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.00005" });
        expect(partial).toMatchObject({ ok: false, code: "below_minimum" });
        const partialSwap = await trade(socket, {
            verb: "swap",
            symbol: "BNB",
            toSymbol: "USDT",
            units: "0.00005",
            quotedToPriceUSD: "1",
        });
        expect(partialSwap).toMatchObject({ ok: false, code: "below_minimum" });
        expect(await balanceOf(stack, accountId)).toBe(before);

        const sold = ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.0001" }));
        // 0.0001 BNB at the bid of $598.20 a coin
        expect(sold.trade).toMatchObject({ paidUnits: "0.0001", gotUnits: "0.05982" });
        expect(sold.holdings).toEqual([]);
        expect(await balanceOf(stack, accountId)).toBe(before + wei("0.05982"));
    });

    test("a whole holding worth under $0.10 swaps into another coin", async () => {
        const { socket } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "6.018" }));
        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.0099" }));

        const swapped = ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.0001",
                quotedToPriceUSD: "1",
            }),
        );
        expect(swapped.trade).toMatchObject({ paidUnits: "0.0001", gotSymbol: "USDT", gotUnits: "0.05982" });
        expect(swapped.holdings).toEqual([{ symbol: "USDT", units: "0.05982", network: expect.any(String) }]);
    });

    test("a holding with nothing in it can't be sold under $0.10", async () => {
        const { socket } = await person(stack);
        expect(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.0001" })).toMatchObject({
            ok: false,
            code: "insufficient_holdings",
        });
    });

    test("two concurrent buys that together exceed the balance fill exactly one", async () => {
        const { socket, accountId } = await person(stack, "100");
        const answers = await Promise.all([
            trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }),
            trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }),
        ]);
        expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
        expect(answers.filter((answer) => !answer.ok)).toEqual([
            expect.objectContaining({ code: "insufficient_balance" }),
        ]);
        expect(await balanceOf(stack, accountId)).toBe(wei(AFTER_TENTH));
        const { holdings } = stack.server.services.database.collections;
        expect(fromUnitsDecimal((await holdings.findOne({ accountId, symbol: "BNB" }))!.units)).toBe(toBig("0.1"));
    });

    test("holdings come with the account snapshot and a fill is pushed to the account's sockets", async () => {
        const { user, socket } = await person(stack);
        const other = await stack.socket(user);
        const pushed = new Promise<HoldingView[]>((resolve) =>
            other.once("holdings:update", ({ holdings }) => resolve(holdings)),
        );
        const filled = new Promise<TradeFill>((resolve) => other.once("trade:filled", resolve));
        await other.timeout(5000).emitWithAck("account:open", {});
        const placed = ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        expect(await pushed).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);
        const fill = await filled;
        expect(fill.gotSymbol).toBe("BNB");
        // The fill moved the USDC balance, so the push carries the account as it stands
        expect(fill.account).toMatchObject({ balance: placed.balance, version: expect.any(Number) });
        expect(fill.account.balance).toBe(AFTER_TENTH);

        const reopened = (await other.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
        expect(reopened.ok && reopened.data.holdings).toEqual([{ symbol: "BNB", units: "0.1", network: "bnb" }]);
    });

    test("a coin withdrawal is refused while sending is off", async () => {
        const { user, socket, accountId } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        const refused = await withdraw(socket, { symbol: "BNB", units: "0.04", to: user.wallet });
        expect(refused).toMatchObject({ ok: false, code: "unavailable" });
        const { holdings, coinWithdrawals } = stack.server.services.database.collections;
        expect(fromUnitsDecimal((await holdings.findOne({ accountId, symbol: "BNB" }))!.units)).toBe(toBig("0.1"));
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(0);
    });

    test("a coin withdrawal subtracts the units and queues a document while sending is on", async () => {
        const { user, socket, accountId } = await person(open);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
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

    test("a coin withdrawal worth under $1 at the server's price is refused and changes nothing", async () => {
        const { user, socket, accountId } = await person(open);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        // $0.60 of BNB at $600
        const small = await withdraw(socket, { symbol: "BNB", units: "0.001", to: user.wallet });
        expect(small).toMatchObject({
            ok: false,
            code: "bad_request",
            message: expect.stringContaining("the smallest send is $1"),
        });
        const { holdings, coinWithdrawals } = open.server.services.database.collections;
        expect(fromUnitsDecimal((await holdings.findOne({ accountId, symbol: "BNB" }))!.units)).toBe(toBig("0.1"));
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(0);

        // $1.20
        ok(await withdraw(socket, { symbol: "BNB", units: "0.002", to: user.wallet }));
        expect(await coinWithdrawals.countDocuments({ accountId })).toBe(1);
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

describe("the trade spread", () => {
    test("a buy spends the amount and gets 0.3% fewer coins than at the market price", async () => {
        const { socket } = await person(stack);
        const result = ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "60" }));
        // $60 at the ask of $601.80 is 0.0997008973... BNB, where $600 would have bought 0.1; the coin amount rounds
        // down and the cost rounds up, so the person pays $60 less a hair
        expect(result.trade).toMatchObject({
            gotUnits: "0.099700897308075772",
            paidUnits: "59.99999999999999959",
            usd: "59.99999999999999959",
        });
        expect(result.balance).toBe("40.00000000000000041");
    });

    test("a fill records the price the person got, the other coin's market price and the dollars of spread", async () => {
        const { socket, accountId } = await person(stack);
        const { trades } = stack.server.services.database.collections;
        const filled = async (verb: TradeVerb) => (await trades.findOne({ accountId, verb }))!;

        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        expect(await filled("buy")).toMatchObject({ priceUSD: "601.8", toPriceUSD: null });
        // 0.1 BNB cost $60.18 where the market price would have charged $60
        expect(String((await filled("buy")).spreadUSD)).toBe("0.18");

        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.04" }));
        expect(await filled("sell")).toMatchObject({ priceUSD: "598.2", toPriceUSD: null });
        // $24 at the market price, $23.928 at the bid
        expect(String((await filled("sell")).spreadUSD)).toBe("0.072");

        ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.05",
                quotedToPriceUSD: "1",
            }),
        );
        // The coin given up is priced at its bid and the coin got at its market price
        expect(await filled("swap")).toMatchObject({ priceUSD: "598.2", toPriceUSD: "1" });
        expect(String((await filled("swap")).spreadUSD)).toBe("0.09");
    });

    test("the price tolerance compares market prices, so the spread uses none of it", async () => {
        const { socket } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        // The server's 600 is within 1% of a quote down to 594.06, though the ask of 601.8 would need one of 595.84
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "1", quotedPriceUSD: "594.1" }));
        expect(
            await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "1", quotedPriceUSD: "593.9" }),
        ).toMatchObject({ ok: false, code: "price_moved" });
        // And of a quote up to 606.06, though the bid of 598.2 would be too low for one over 604.24
        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.01", quotedPriceUSD: "605.9" }));
        expect(
            await trade(socket, { verb: "sell", symbol: "BNB", units: "0.01", quotedPriceUSD: "606.1" }),
        ).toMatchObject({ ok: false, code: "price_moved" });
        ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.01",
                quotedPriceUSD: "605.9",
                quotedToPriceUSD: "1",
            }),
        );
    });

    test("a $0.10 sale priced 1% over the server's still fills, with the spread taken from what it gets", async () => {
        const { socket } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: "10" }));
        // $0.10 at the quote of $606 is 0.00016501 BNB, worth $0.099006 at $600 and $0.098709 at the bid
        const sold = ok(
            await trade(socket, { verb: "sell", symbol: "BNB", units: "0.00016501", quotedPriceUSD: "606" }),
        );
        expect(sold.trade.gotUnits).toBe("0.098708982");
        // 0.00016 BNB nets $0.0957, under the floor, so only the whole holding could sell it
        const under = await trade(socket, { verb: "sell", symbol: "BNB", units: "0.00016", quotedPriceUSD: "600" });
        expect(under).toMatchObject({ ok: false, code: "below_minimum" });
    });

    test("a buy costs what was paid for the coins, a sell and a swap realize the net of the spread", async () => {
        const { socket } = await person(stack);
        ok(await trade(socket, { verb: "buy", symbol: "BNB", amountUSD: TENTH_BNB }));
        ok(
            await trade(socket, {
                verb: "swap",
                symbol: "BNB",
                toSymbol: "USDT",
                units: "0.05",
                quotedToPriceUSD: "1",
            }),
        );
        ok(await trade(socket, { verb: "sell", symbol: "BNB", units: "0.05" }));

        const page = (await socket.timeout(5000).emitWithAck("activity:list", {})) as Ack<ActivityPage>;
        if (!page.ok) throw new Error(page.error.code);
        const realized = page.data.items.flatMap((item) =>
            item.kind === "trade" ? [[item.trade.verb, item.trade.realized]] : [],
        );
        // The basis of 0.05 BNB is $30.09. The swap nets $29.91 of it, and the sale of the rest nets $29.91 too
        expect(realized).toEqual([
            ["sell", "-0.18"],
            ["swap", "-0.18"],
            ["buy", undefined],
        ]);

        const series = (await socket.timeout(5000).emitWithAck("pnl:series", { tz: "UTC" })) as Ack<PnlSeries>;
        if (!series.ok) throw new Error(series.error.code);
        const total = series.data.ranges.All.points.reduce((sum, point) => sum + wei(point.pnl), 0n);
        expect(total).toBe(wei("-0.36"));
    });
});

const toBig = (units: string) => parseUnits18(units)!;
