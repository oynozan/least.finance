import { expect, test } from "@playwright/test";
import {
    accountReducer,
    initialAccountState,
    optimisticBalance,
    optimisticHoldings,
    toUsdc,
    toWei,
    type AccountAction,
    type AccountState,
    type Hex,
    type WalletSession,
} from "@/lib/account/state";
import { estimateTrade } from "@/lib/account/spot";
import { askOf, lessSpread } from "@/lib/trade/spread";
import { cleanAmount, normalizeAmount } from "@/components/deposit-form";
import { holdingRows, recentSends, sendAddress, sendDecimals, sendIssue, validAddress } from "@/lib/account/holdings";
import { toTradeRequest, type SpotInputs, type SpotIntent } from "@/lib/trade/spot-request";
import type { CoinWithdrawalView, HoldingView, TradeOrderRequest } from "@/server/src/trading/types";

const session = (balance: string, holdings: HoldingView[] = []): WalletSession => ({
    account: { depositAddress: "0x00000000000000000000000000000000000000b2" as Hex, balance, version: 1 },
    deposits: { items: [], next: null },
    rules: { chainId: 5042, minDeposit: "0.01" },
    orders: [],
    withdrawals: [],
    solana: { deposits: false, withdrawals: false },
    holdings,
});

const sol = (units: string): HoldingView => ({ symbol: "SOL", units, network: "solana" });
const eth = (units: string): HoldingView => ({ symbol: "ETH", units, network: "ethereum" });

function run(start: WalletSession, ...actions: AccountAction[]): AccountState {
    return [{ type: "session", session: start } as AccountAction, ...actions].reduce(
        (state, action) => accountReducer(state, action),
        initialAccountState,
    );
}

/** $147.20 at SOL's market price of $147.20, which a buy fills at 0.3% more: the ask of $147.6416 buys 0.99700897 SOL. */
const buy = (id: string): TradeOrderRequest => ({
    requestId: id,
    verb: "buy",
    symbol: "SOL",
    amountUSD: "147.2",
    quotedPriceUSD: "147.2",
});

const usd = (state: AccountState) => toUsdc(optimisticBalance(state) ?? BigInt(0));

test.describe("the snapshot's holdings", () => {
    test("a session puts the holdings in the state, and a push replaces them", () => {
        const state = run(session("100", [sol("2")]));
        expect(optimisticHoldings(state)).toEqual([sol("2")]);
        const pushed = accountReducer(state, { type: "holdings", holdings: [sol("3"), eth("1")] });
        expect(optimisticHoldings(pushed)).toEqual([sol("3"), eth("1")]);
    });

    test("a fresh session drops estimates sent on the old connection", () => {
        const sent = run(session("500"), { type: "spot", trade: estimateTrade(buy("a"))! });
        expect(usd(sent)).toBe(352.8);
        const again = accountReducer(sent, { type: "session", session: session("352.8", [sol("1")]) });
        expect(usd(again)).toBe(352.8);
        expect(optimisticHoldings(again)).toEqual([sol("1")]);
    });
});

test.describe("an optimistic trade", () => {
    test("a buy takes the dollars and adds the coin at once, at the ask", () => {
        const state = run(session("500"), { type: "spot", trade: estimateTrade(buy("a"))! });
        expect(usd(state)).toBe(352.8);
        expect(optimisticHoldings(state)).toEqual([sol("0.99700897")]);
    });

    test("a sell adds the dollars less the spread and takes the units, and selling it all removes the holding", () => {
        const req: TradeOrderRequest = {
            requestId: "s",
            verb: "sell",
            symbol: "SOL",
            units: "2",
            quotedPriceUSD: "147.2",
        };
        const state = run(session("10", [sol("2")]), { type: "spot", trade: estimateTrade(req)! });
        // 2 SOL at $147.20 is $294.40, and the sale is paid 0.3% less
        expect(usd(state)).toBeCloseTo(303.5168, 6);
        expect(optimisticHoldings(state)).toEqual([]);
    });

    test("a swap moves one holding into another, less one spread, and leaves the balance", () => {
        const req: TradeOrderRequest = {
            requestId: "w",
            verb: "swap",
            symbol: "SOL",
            toSymbol: "ETH",
            units: "1",
            quotedPriceUSD: "150",
            quotedToPriceUSD: "3000",
        };
        const state = run(session("10", [sol("2")]), { type: "spot", trade: estimateTrade(req)! });
        expect(usd(state)).toBe(10);
        // 1 SOL is $150, $149.55 after the spread, which buys 0.04985 ETH at $3,000
        expect(optimisticHoldings(state)).toEqual([sol("1"), eth("0.04985")]);
    });

    test("an error ack rolls the balance and the holdings back", () => {
        const sent = run(session("500", [sol("1")]), { type: "spot", trade: estimateTrade(buy("a"))! });
        expect(optimisticHoldings(sent)).toEqual([sol("1.99700897")]);
        const refused = accountReducer(sent, { type: "spot-failed", requestId: "a" });
        expect(usd(refused)).toBe(500);
        expect(optimisticHoldings(refused)).toEqual([sol("1")]);
    });

    test("the fill's answer replaces the estimate with the server's balance and holdings", () => {
        const sent = run(session("500"), { type: "spot", trade: estimateTrade(buy("a"))! });
        const filled = accountReducer(sent, {
            type: "spot-filled",
            requestId: "a",
            balance: "352.8",
            holdings: [sol("0.99999999")],
        });
        expect(usd(filled)).toBe(352.8);
        expect(optimisticHoldings(filled)).toEqual([sol("0.99999999")]);
    });

    test("trade:filled settles the estimate once and a repeat changes nothing", () => {
        const sent = run(session("500"), { type: "spot", trade: estimateTrade(buy("a"))! });
        const pushed = accountReducer(sent, { type: "holdings", holdings: [sol("1")] });
        const settled = accountReducer(pushed, { type: "spot-settled", requestId: "a" });
        expect(optimisticHoldings(settled)).toEqual([sol("1")]);
        expect(accountReducer(settled, { type: "spot-settled", requestId: "a" })).toEqual(settled);
    });

    test("the same request counted twice moves nothing twice", () => {
        const trade = estimateTrade(buy("a"))!;
        const state = run(session("500"), { type: "spot", trade }, { type: "spot", trade });
        expect(usd(state)).toBe(352.8);
    });

    test("an estimate needs a price and an amount", () => {
        expect(estimateTrade({ ...buy("a"), quotedPriceUSD: "0" })).toBeNull();
        expect(estimateTrade({ ...buy("a"), amountUSD: undefined })).toBeNull();
        expect(
            estimateTrade({ requestId: "w", verb: "swap", symbol: "SOL", units: "1", quotedPriceUSD: "1" }),
        ).toBeNull();
    });
});

test.describe("the spread", () => {
    test("is the server's: a buy pays 0.3% over the market price and a sale is paid 0.3% under", () => {
        expect(askOf(600)).toBe(601.8);
        expect(lessSpread(600)).toBe(598.2);
    });

    test("the estimates match the server's fills at BNB's $600, as server/test/integration/trading.test.ts has them", () => {
        const bnb = { symbol: "BNB", quotedPriceUSD: "600" };
        const bought = estimateTrade({ requestId: "b", verb: "buy", amountUSD: "60.18", ...bnb });
        expect(bought).toMatchObject({ got: { symbol: "BNB", units: "0.1" } });
        const sold = estimateTrade({ requestId: "s", verb: "sell", units: "0.04", ...bnb });
        expect(sold).toMatchObject({ balanceWei: toWei("23.928"), got: { symbol: "USDC", units: "23.928000" } });
        const swapped = estimateTrade({
            requestId: "w",
            verb: "swap",
            units: "0.05",
            toSymbol: "USDT",
            quotedToPriceUSD: "1",
            ...bnb,
        });
        expect(swapped).toMatchObject({ got: { symbol: "USDT", units: "29.91" } });
    });
});

test.describe("sending a held coin", () => {
    const withdrawal = (state: CoinWithdrawalView["state"], at = "2026-10-15T10:00:00.000Z"): CoinWithdrawalView => ({
        id: "w1",
        requestId: "r1",
        symbol: "SOL",
        units: "0.5",
        network: "solana",
        to: "So11111111111111111111111111111111111111112",
        state,
        txHash: null,
        reason: null,
        at,
    });

    test("the units leave the holding at once and come back on a refusal", () => {
        const sent = run(session("0", [sol("2")]), {
            type: "coin-send",
            send: { requestId: "r1", symbol: "SOL", units: "0.5" },
        });
        expect(optimisticHoldings(sent)).toEqual([sol("1.5")]);
        const refused = accountReducer(sent, { type: "coin-send-failed", requestId: "r1" });
        expect(optimisticHoldings(refused)).toEqual([sol("2")]);
    });

    test("the answer shows the withdrawal with the server's holdings, and a push moves it on", () => {
        const sent = run(session("0", [sol("2")]), {
            type: "coin-send",
            send: { requestId: "r1", symbol: "SOL", units: "0.5" },
        });
        const answered = accountReducer(sent, {
            type: "coin-withdrawal",
            withdrawal: withdrawal("sending"),
            holdings: [sol("1.5")],
        });
        expect(optimisticHoldings(answered)).toEqual([sol("1.5")]);
        const done = accountReducer(answered, { type: "coin-withdrawal", withdrawal: withdrawal("sent") });
        expect(done.status === "ready" && done.coinWithdrawals.map((w) => w.state)).toEqual(["sent"]);
    });

    test("recent sends keep the last hour, newest first", () => {
        const now = Date.parse("2026-10-15T11:00:00.000Z");
        const old = { ...withdrawal("sent", "2026-10-15T09:00:00.000Z"), id: "old" };
        expect(recentSends([withdrawal("sending", "2026-10-15T10:30:00.000Z"), old], now).map((w) => w.id)).toEqual([
            "w1",
        ]);
    });

    test("the address starts as the linked wallet of the coin's network", () => {
        const wallets = { evm: "0xabc", solana: "SoLwallet" };
        expect(sendAddress("solana", wallets)).toBe("SoLwallet");
        expect(sendAddress("base", wallets)).toBe("0xabc");
        expect(sendAddress("base", {})).toBe("");
        expect(validAddress("base", "0x00000000000000000000000000000000000000b2")).toBe(true);
        expect(validAddress("base", "SoLwallet")).toBe(false);
        expect(validAddress("solana", "So11111111111111111111111111111111111111112")).toBe(true);
    });

    test("the amount must be positive and within the holding", () => {
        expect(sendIssue("", "2")).toBe("Enter an amount.");
        expect(sendIssue("0", "2")).toBe("Enter an amount.");
        expect(sendIssue("3", "2")).toBe("That's more than you hold.");
        expect(sendIssue("2", "2")).toBeNull();
        expect(sendIssue("0.000001", "2")).toBeNull();
    });

    test("the amount is typed in the coin's own decimals, and a decimal comma is a point", () => {
        expect(sendDecimals("SOL")).toBe(9);
        expect(sendDecimals("BTC")).toBe(8);
        expect(sendDecimals("ETH")).toBe(18);
        expect(sendDecimals("NOPE")).toBe(18);
        const half = cleanAmount("0,5", sendDecimals("SOL"));
        expect(half).toBe("0.5");
        expect(sendIssue(half, "5")).toBeNull();
        expect(cleanAmount("0.1234567891", sendDecimals("SOL"))).toBe("0.123456789");
    });

    test("a trailing point or a bare fraction is a number to send", () => {
        expect(sendIssue(normalizeAmount("5.") ?? "", "5")).toBeNull();
        expect(sendIssue(normalizeAmount(".5") ?? "", "5")).toBeNull();
        expect(normalizeAmount(".5")).toBe("0.5");
        expect(sendIssue(normalizeAmount(".") ?? "", "5")).toBe("Enter an amount.");
    });
});

test.describe("holdings rows", () => {
    test("are valued at the live price, the most valuable first, an unpriced coin last", () => {
        const prices: Record<string, number> = { SOL: 150, ETH: 3000 };
        const rows = holdingRows(
            [sol("2"), eth("1"), { symbol: "DOGE", units: "5", network: "dogecoin" }],
            (s) => prices[s] ?? null,
        );
        expect(rows.map((r) => [r.symbol, r.usd])).toEqual([
            ["ETH", 3000],
            ["SOL", 300],
            ["DOGE", null],
        ]);
    });
});

test.describe("the request a review places", () => {
    const holdings: Record<string, string> = { SOL: "2", ETH: "0.5" };
    const prices: Record<string, number> = { SOL: 150, ETH: 3000, USDC: 1 };
    const inputs: SpotInputs = {
        price: (s) => prices[s] ?? null,
        held: (s) => Number(holdings[s] ?? 0),
        heldText: (s) => holdings[s] ?? "0",
    };
    const spot = (side: "buy" | "sell", amountUSD: string): Extract<SpotIntent, { type: "spot" }> => ({
        type: "spot",
        side,
        token: "SOL",
        amountUSD,
    });

    test("a buy carries the dollars and the price shown", () => {
        expect(toTradeRequest(spot("buy", "30"), inputs, "r")).toEqual({
            requestId: "r",
            verb: "buy",
            symbol: "SOL",
            amountUSD: "30",
            quotedPriceUSD: "150",
        });
    });

    test("a sell carries units rounded down, and the whole holding when the amount is all of it", () => {
        expect(toTradeRequest(spot("sell", "100"), inputs, "r")).toMatchObject({ verb: "sell", units: "0.66666666" });
        expect(toTradeRequest(spot("sell", "300"), inputs, "r")).toMatchObject({ units: "2" });
        expect(toTradeRequest(spot("sell", "299.9999999999"), inputs, "r")).toMatchObject({ units: "2" });
    });

    test("an amount within a cent of the holding's value sells all of it, not a rounded figure", () => {
        // 1.99724 SOL at $150 is $299.586, and the amount's two places cut it to $299.58
        const odd: SpotInputs = { ...inputs, held: () => 1.99724, heldText: () => "1.99724" };
        expect(toTradeRequest(spot("sell", "299.58"), odd, "r")).toMatchObject({ units: "1.99724" });
        expect(toTradeRequest(spot("sell", "299.59"), odd, "r")).toMatchObject({ units: "1.99724" });
        expect(toTradeRequest(spot("sell", "299.57"), odd, "r")).toMatchObject({ units: "1.99713333" });
        const swap: SpotIntent = { type: "swap", fromToken: "SOL", toToken: "ETH", amountUSD: "299.58" };
        expect(toTradeRequest(swap, odd, "r")).toMatchObject({ verb: "swap", units: "1.99724" });
        expect(toTradeRequest({ ...swap, amountUSD: "299.57" }, odd, "r")).toMatchObject({ units: "1.99713333" });
    });

    test("a swap carries both prices", () => {
        const swap: SpotIntent = { type: "swap", fromToken: "SOL", toToken: "ETH", amountUSD: "150" };
        expect(toTradeRequest(swap, inputs, "r")).toEqual({
            requestId: "r",
            verb: "swap",
            symbol: "SOL",
            toSymbol: "ETH",
            units: "1",
            quotedPriceUSD: "150",
            quotedToPriceUSD: "3000",
        });
    });

    test("waits for a price", () => {
        expect(toTradeRequest({ ...spot("buy", "30"), token: "DOGE" }, inputs, "r")).toBeNull();
        expect(toTradeRequest(spot("buy", "0"), inputs, "r")).toBeNull();
    });
});
