import { expect, test } from "@playwright/test";
import type { PerpPositionView } from "@/lib/account/state";
import type { LivePerpPosition, LivePredictionPosition, Position } from "@/components/wallet-data";
import { walletWorth } from "@/lib/account/worth";

const prediction = (over: Partial<LivePredictionPosition> = {}): LivePredictionPosition => ({
    id: "pr1",
    kind: "prediction-live",
    symbol: "USDC",
    size: 10,
    pnl: 0,
    eventId: "e1",
    tokenId: "t1",
    question: "Will it rain?",
    outcome: "Yes",
    shares: "20",
    pending: false,
    status: "open",
    openedAt: 1,
    position: null,
    ...over,
});

const perpView = (over: Partial<PerpPositionView> = {}): PerpPositionView => ({
    id: "p1",
    asset: "BTC",
    side: "long",
    leverage: 5,
    sizeCoin: "0.00769",
    entryPx: "65000",
    collateralUSD: "100",
    liquidationPx: "52400",
    markPx: "66000",
    unrealizedPnlUSD: "7.5",
    cumFundingUSD: "0.5",
    feesUSD: "1",
    state: "open",
    proceedsUSD: null,
    notice: null,
    openedAt: new Date(1).toISOString(),
    settledAt: null,
    updatedAt: new Date(1).toISOString(),
    ...over,
});

const perp = (over: Partial<LivePerpPosition> = {}): LivePerpPosition => ({
    id: "p1",
    rowKey: "p1",
    kind: "perp-live",
    symbol: "BTC",
    size: 100,
    pnl: 6,
    asset: "BTC",
    side: "long",
    leverage: 5,
    entryPx: "65000",
    liquidationPx: "52400",
    status: "open",
    openedAt: 1,
    notice: null,
    position: perpView(),
    ...over,
});

const worth = (o: {
    cash?: number | null;
    holdings?: { symbol: string; units: string }[];
    prices?: Record<string, number>;
    positions?: Position[];
    sellPrices?: Record<string, number>;
}) =>
    walletWorth({
        cash: "cash" in o ? o.cash : 50,
        holdings: (o.holdings ?? []).map((h) => ({ ...h, network: "ethereum" })),
        priceOf: (symbol) => o.prices?.[symbol] ?? null,
        positions: o.positions ?? [],
        sellPriceOf: (p) => o.sellPrices?.[p.tokenId] ?? null,
    });

test("with only cash, the total is the cash", () => {
    expect(worth({ cash: 50 })).toEqual({ total: 50, cash: 50, coins: 0, positions: 0 });
});

test("coins count at their price, and a coin with no price yet is left out until it has one", () => {
    expect(
        worth({
            cash: 50,
            holdings: [
                { symbol: "ETH", units: "0.5" },
                { symbol: "NEW", units: "1000" },
            ],
            prices: { ETH: 3000 },
        }),
    ).toEqual({ total: 1550, cash: 50, coins: 1500, positions: 0 });
});

test("a prediction counts at what it would sell for, or at its stake while its price or its fill isn't known", () => {
    expect(worth({ cash: 0, positions: [prediction()], sellPrices: { t1: 0.6 } })?.positions).toBe(12);
    expect(worth({ cash: 0, positions: [prediction()] })?.positions).toBe(10);
    expect(
        worth({
            cash: 0,
            positions: [prediction({ status: "pending", pending: true, shares: "" })],
            sellPrices: { t1: 0.6 },
        })?.positions,
    ).toBe(10);
});

test("a perp counts as its collateral plus what it has made, and an open still filling as its collateral", () => {
    // 7.5 unrealized less 0.5 funding and the 1 opening fee
    expect(worth({ cash: 0, positions: [perp()] })?.positions).toBe(106);
    expect(worth({ cash: 0, positions: [perp({ status: "closing" })] })?.positions).toBe(106);
    expect(worth({ cash: 0, positions: [perp({ status: "pending" })] })?.positions).toBe(100);
    // A position can't be worth less than nothing
    expect(worth({ cash: 0, positions: [perp({ position: perpView({ unrealizedPnlUSD: "-150" }) })] })?.positions).toBe(
        0,
    );
});

test("opening a position moves money from cash to positions without changing the total", () => {
    const before = worth({ cash: 100 });
    const after = worth({ cash: 90, positions: [prediction({ status: "pending", pending: true, shares: "" })] });
    expect(after).toEqual({ total: 100, cash: 90, coins: 0, positions: 10 });
    expect(after?.total).toBe(before?.total);
});

test("the total is loading while the cash is, and unavailable while the cash can't be read", () => {
    expect(worth({ cash: undefined, positions: [perp()] })).toBeUndefined();
    expect(worth({ cash: null, positions: [perp()] })).toBeNull();
});
