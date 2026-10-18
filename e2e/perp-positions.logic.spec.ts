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
import { byNewest, perpActivity } from "@/lib/trade/activity";

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

/** An open order that filled into `positionId` */
const openOrder = (requestId: string, positionId: string | null): PerpsView["orders"][number] => ({
    id: `o-${requestId}`,
    requestId,
    kind: "open",
    asset: "BTC",
    side: "long",
    leverage: 5,
    state: positionId ? "filled" : "posted",
    reason: null,
    positionId,
    filledSizeCoin: positionId ? "0.00769" : null,
    requestedSizeCoin: "0.00769",
    collateralUSD: "100",
    creditedUSD: null,
    createdAt: iso(NOW - 60_000),
    updatedAt: iso(NOW - 30_000),
});

test("an open keeps one row key from its pending stand-in to its filled position, so the fill updates the row in place", () => {
    const [pending] = livePerpRows({ positions: [position({ id: "pending:req-1" })], orders: [] }, NOW);
    const [filled] = livePerpRows(
        { positions: [position({ id: "pos-1" })], orders: [openOrder("req-1", "pos-1")] },
        NOW,
    );
    expect(pending?.rowKey).toBe("perp:req-1");
    expect(filled?.rowKey).toBe(pending?.rowKey);
    // A position no open order names keeps its own id
    expect(livePerpRows({ positions: [position({ id: "pos-2" })], orders: [] }, NOW)[0]?.rowKey).toBe("perp:pos-2");
});

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

    test("a fresh position starts down by the fees it already paid, and worth follows", () => {
        const fresh = only({ unrealizedPnlUSD: "0", cumFundingUSD: "0", feesUSD: "1.22" });
        expect(fresh.pnl).toBeCloseTo(-1.22, 6);
        expect(liveValue(fresh, null)?.pnl).toBeCloseTo(-1.22, 6);
        expect(liveValue(fresh, null)?.value).toBeCloseTo(98.78, 6);
        // A view from before fees were sent counts none
        expect(only({ unrealizedPnlUSD: "0", cumFundingUSD: "0" }).pnl).toBe(0);
        // A settled row's PnL is its proceeds less the collateral, which already holds the fees
        const closed = only({ state: "closed", proceedsUSD: "98", settledAt: iso(NOW - DAY), feesUSD: "1.22" });
        expect(closed.pnl).toBe(-2);
    });

    test("the position size is the coins at the entry price, not the collateral times the leverage", () => {
        // 0.00759 BTC at 65,000 is $493.35; $100 of collateral holds $1 of fees
        expect(positionDetail(only({ sizeCoin: "0.00759" }))).toBe(
            "$493 position, entry $65,000, liquidates near $52,400",
        );
        // Still waiting for its entry: the old product
        expect(positionDetail(only({ entryPx: null, liquidationPx: null }))).toBe("$500 position");
    });

    test("a perp row's PnL follows the live mark between snapshots", () => {
        const [long] = livePerpRows({ positions: [position()], orders: [] }, NOW, { BTC: 67000 });
        // 0.00769 * (67000 - 65000) = 15.38, less 0.5 funding paid
        expect(long!.pnl).toBeCloseTo(14.88, 6);
        expect(liveValue(long!, null)?.value).toBeCloseTo(114.88, 6);
        const [short] = livePerpRows({ positions: [position({ side: "short" })], orders: [] }, NOW, { BTC: 67000 });
        expect(short!.pnl).toBeCloseTo(-15.88, 6);
        // No mark for the asset, or no entry: the server's snapshot stands
        const [stale] = livePerpRows({ positions: [position()], orders: [] }, NOW, { ETH: 3000 });
        expect(stale!.pnl).toBeCloseTo(7.19, 6);
        const [noEntry] = livePerpRows({ positions: [position({ entryPx: null })], orders: [] }, NOW, { BTC: 67000 });
        expect(noEntry!.pnl).toBeCloseTo(7.19, 6);
    });

    test("a null liquidationPx is left out of the detail", () => {
        expect(positionDetail(only({ liquidationPx: null }))).toBe("$500 position, entry $65,000");
    });

    test("a cheap coin's entry and liquidation keep their digits instead of reading $0.00", () => {
        // 3.2 million HMSTR at $0.000155 is $496
        const cheap = only({ asset: "HMSTR", sizeCoin: "3200000", entryPx: "0.000155", liquidationPx: "0.000124" });
        expect(positionDetail(cheap)).toBe("$496 position, entry $0.000155, liquidates near $0.000124");
    });

    test("a pending position's close button is disabled", () => {
        const pending = only({ id: "pending:req1" });
        expect(pending.status).toBe("pending");
        expect(perpCloseBlock(pending)).toBe("You can close this once it has filled.");
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
        expect(perpCloseBlock(only({ notice: "Too small.", closeBlocked: true }))).toBe("Too small.");
    });

    test("a close that nobody took stays closable, with the reason still on the row", () => {
        const notice =
            "Nobody on the book took your close at an acceptable price. Your position is still open. Try again in a moment.";
        const row = only({ notice, closeBlocked: false });
        expect(row.notice).toBe(notice);
        expect(perpCloseBlock(row)).toBeNull();
    });
});

test.describe("perps in the PnL feed", () => {
    test("opening a position does not show as a drop in the balance chart", () => {
        const feed = perpActivity(position());
        expect(feed.length).toBeGreaterThan(0);
        for (const row of feed) expect(row.change).toBe(0);
    });

    test("perp_open and perp_close ledger rows are trades, not deposits", () => {
        const feed = perpActivity(position({ state: "closed", proceedsUSD: "112", settledAt: iso(NOW - 60_000) }));
        expect(feed.map((a) => a.kind)).toEqual(["long", "close"]);
        expect(feed[1]).toMatchObject({ title: "Closed Long BTC at 5x", change: 12 });
    });

    test("an opening row names the position by its coins at the entry price", () => {
        expect(perpActivity(position({ sizeCoin: "0.00759" }))[0]?.detail).toBe("$493 position");
        expect(perpActivity(position({ entryPx: null }))[0]?.detail).toBe("$500 position");
    });

    test("a liquidation appears in the feed", () => {
        const feed = perpActivity(
            position({ state: "liquidated", proceedsUSD: "0", settledAt: iso(NOW - 60_000) }),
        ).sort(byNewest);
        expect(feed[0]).toMatchObject({ kind: "close", title: "Liquidated Long BTC at 5x", change: -100 });
    });
});
