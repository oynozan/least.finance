import { expect, test } from "@playwright/test";
import type { PerpPositionView, PerpsView } from "@/lib/account/state";
import {
    livePerpRows,
    liveValue,
    perpCloseBlock,
    positionDetail,
    positionTitle,
    trendOf,
    type LivePerpPosition,
} from "@/components/wallet-data";
import { balanceHistory, byNewest, perpActivity } from "@/lib/trade/activity";

const NOW = Date.UTC(2026, 9, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const position = (over: Partial<PerpPositionView> = {}): PerpPositionView => ({
    id: "p1",
    asset: "BTC",
    side: "long",
    leverage: 5,
    sizeCoin: "0.00769",
    entryPx: "65000",
    collateralUSD: "100",
    liquidationPx: "52400",
    markPx: "66000",
    unrealizedPnlUSD: "7.69",
    cumFundingUSD: "0.5",
    state: "open",
    proceedsUSD: null,
    notice: null,
    openedAt: iso(NOW - 3600_000),
    settledAt: null,
    updatedAt: iso(NOW - 60_000),
    ...over,
});

const rows = (positions: PerpPositionView[], now = NOW): LivePerpPosition[] =>
    livePerpRows({ positions, orders: [] } satisfies PerpsView, now);

const only = (over: Partial<PerpPositionView> = {}, now = NOW) => {
    const [row] = rows([position(over)], now);
    if (!row) throw new Error("no row");
    return row;
};

test.describe("perp rows in the sidebar", () => {
    test("a long shows 'Long BTC at 5x' and the entry and liquidation detail", () => {
        const row = only();
        expect(positionTitle(row)).toBe("Long BTC at 5x");
        expect(positionDetail(row)).toBe("$500 position, entry $65,000, liquidates near $52,400");
        expect(positionTitle(only({ side: "short", asset: "ETH", leverage: 3 }))).toBe("Short ETH at 3x");
    });

    test("worth is collateral plus unrealized PnL and flips tone at zero", () => {
        const gain = liveValue(only(), null);
        // 100 + 7.69 - 0.5 funding paid
        expect(gain?.value).toBeCloseTo(107.19, 6);
        expect(gain?.pnl).toBeCloseTo(7.19, 6);
        expect(trendOf(gain!.pnl)).toBe("gain");
        const loss = liveValue(only({ unrealizedPnlUSD: "-20", cumFundingUSD: "0" }), null);
        expect(loss?.value).toBeCloseTo(80, 6);
        expect(trendOf(loss!.pnl)).toBe("loss");
        const flat = liveValue(only({ unrealizedPnlUSD: "0.5", cumFundingUSD: "0.5" }), null);
        expect(trendOf(Math.round(flat!.pnl * 100) / 100)).toBe("flat");
    });

    test("a null liquidationPx is left out of the detail", () => {
        expect(positionDetail(only({ liquidationPx: null }))).toBe("$500 position, entry $65,000");
    });

    test("a pending position's close button is disabled", () => {
        const pending = only({ id: "pending:req1" });
        expect(pending.status).toBe("pending");
        expect(perpCloseBlock(pending)).toBe("Closing opens when the position is filled.");
        expect(perpCloseBlock(only())).toBeNull();
        expect(perpCloseBlock(only({ state: "closing" }))).toBe("Closing now.");
    });

    test("closing shows the closing state, then Closed, and the row leaves after 7 days", () => {
        expect(only({ state: "closing" }).status).toBe("closing");
        const settledAt = iso(NOW - DAY);
        const closed = only({ state: "closed", proceedsUSD: "112", settledAt });
        expect(closed.status).toBe("closed");
        expect(closed.payout).toBe(112);
        expect(closed.pnl).toBe(12);
        expect(rows([position({ state: "closed", proceedsUSD: "112", settledAt })], NOW + 7 * DAY)).toEqual([]);
    });

    test("a liquidated position shows Liquidated", () => {
        const row = only({ state: "liquidated", proceedsUSD: "0", settledAt: iso(NOW - 60_000) });
        expect(row.status).toBe("liquidated");
        expect(row.pnl).toBe(-100);
    });

    test("a too-small position shows 'Too small to close right now.'", () => {
        const row = only({ notice: "Too small to close right now." });
        expect(perpCloseBlock(row)).toBe("Too small to close right now.");
    });
});

test.describe("perps in the PnL feed", () => {
    test("opening a position does not show as a drop in the balance chart", () => {
        const deposit = {
            id: "deposit:d",
            at: new Date(NOW - 2 * DAY),
            kind: "deposit" as const,
            title: "Deposit",
            detail: "",
            symbols: ["USDC"],
            amountUSD: 300,
            change: 300,
        };
        const feed = [deposit, ...perpActivity(position())];
        const days = balanceHistory(feed, 3, new Date(NOW));
        expect(days.map((d) => d.balance)).toEqual([300, 300, 300]);
    });

    test("perp_open and perp_close ledger rows are trades, not deposits", () => {
        const feed = perpActivity(position({ state: "closed", proceedsUSD: "112", settledAt: iso(NOW - 60_000) }));
        expect(feed.map((a) => a.kind)).toEqual(["long", "close"]);
        const days = balanceHistory(feed, 1, new Date(NOW));
        expect(days[0]).toMatchObject({ deposited: 0, pnl: 12, realized: 12 });
        expect(feed[1]).toMatchObject({ title: "Closed Long BTC at 5x", change: 12 });
    });

    test("a liquidation appears in the feed", () => {
        const feed = perpActivity(
            position({ state: "liquidated", proceedsUSD: "0", settledAt: iso(NOW - 60_000) }),
        ).sort(byNewest);
        expect(feed[0]).toMatchObject({ kind: "close", title: "Liquidated Long BTC at 5x", change: -100 });
    });
});
