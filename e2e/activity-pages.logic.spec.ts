import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server } from "socket.io";
import { AccountClient } from "@/components/account-client";
import { answerStamp } from "@/components/pnl/use-activity-feed";
import type { ApiError } from "@/lib/account/state";
import {
    NO_FEED,
    NO_PAGES,
    bodyState,
    feedReducer,
    firstPage,
    itemKey,
    matchesFilter,
    olderPage,
    overlay,
    type FeedState,
    type PagesState,
} from "@/lib/pnl/activity-pages";
import { activityFromItem, saleActivity, swapActivity, type Activity } from "@/lib/trade/activity";
import type {
    ActivityFilter,
    ActivityItem,
    ActivityPage,
    DepositView,
    PerpPositionView,
    PositionView,
    PredictionOrderView,
    SwapOrderView,
    WithdrawalView,
} from "@/server/src/protocol";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const hex = (n: number) => n.toString(16).padStart(24, "0");
const ctx = { now: NOW, priceOf: (symbol: string) => (symbol === "ETH" ? 2 : null) };

const deposit = (n: number, over: Partial<DepositView> = {}): DepositView => ({
    id: hex(n),
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    from: "0x00000000000000000000000000000000000000c3",
    amount: "25",
    blockNumber: 100 + n,
    creditedAt: iso(NOW.getTime() - n * DAY),
    ...over,
});

const withdrawal = (n: number, over: Partial<WithdrawalView> = {}): WithdrawalView => ({
    id: hex(n),
    requestId: `req-${n}`,
    amount: "10",
    to: "0x00000000000000000000000000000000000000d4",
    network: "arc",
    fee: null,
    receive: null,
    state: "sent",
    txHash: null,
    forwardTxHash: null,
    delayed: false,
    createdAt: iso(NOW.getTime() - n * DAY),
    updatedAt: iso(NOW.getTime() - n * DAY),
    ...over,
});

const swap = (n: number, createdAt: string, over: Partial<SwapOrderView> = {}): SwapOrderView => ({
    id: hex(n),
    state: "done",
    from: { network: "ethereum", token: "ETH", amount: "0.5" },
    to: { network: "arc", token: "USDC", amount: "1", received: "1", receivedSymbol: "USDC" },
    wallet: "0x00000000000000000000000000000000000000c3",
    txHashes: ["0xabc"],
    createdAt,
    updatedAt: createdAt,
    ...over,
});

const position = (n: number, over: Partial<PositionView> = {}): PositionView => ({
    id: hex(n),
    eventId: "e1",
    marketId: "m1",
    tokenId: "t1",
    question: "Will it rain?",
    outcome: "Yes",
    shares: "20",
    costUSD: "10",
    state: "won",
    proceedsUSD: null,
    payoutUSD: "20",
    openedAt: iso(NOW.getTime() - 3 * DAY),
    settledAt: iso(NOW.getTime() - 1 * DAY),
    updatedAt: iso(NOW.getTime() - 1 * DAY),
    ...over,
});

const perp = (n: number, over: Partial<PerpPositionView> = {}): PerpPositionView => ({
    id: hex(n),
    asset: "ETH",
    side: "long",
    leverage: 3,
    sizeCoin: "1",
    entryPx: "2000",
    collateralUSD: "100",
    liquidationPx: null,
    markPx: null,
    unrealizedPnlUSD: "0",
    cumFundingUSD: "0",
    state: "closed",
    proceedsUSD: "130",
    notice: null,
    openedAt: iso(NOW.getTime() - 4 * DAY),
    settledAt: iso(NOW.getTime() - 2 * DAY),
    updatedAt: iso(NOW.getTime() - 2 * DAY),
    ...over,
});

const sale = (n: number, over: Partial<PredictionOrderView> = {}): PredictionOrderView => ({
    id: hex(n),
    requestId: `sell-${n}`,
    side: "sell",
    state: "filled",
    reason: null,
    eventId: "e1",
    tokenId: "t1",
    question: "Will it rain?",
    outcome: "Yes",
    amountUSD: null,
    shares: "5",
    positionId: hex(1),
    soldPart: { costUSD: "2.5", proceedsUSD: "4", at: iso(NOW.getTime() - 1 * DAY) },
    createdAt: iso(NOW.getTime() - 1 * DAY),
    updatedAt: iso(NOW.getTime() - 1 * DAY),
    ...over,
});

const depositItem = (n: number): ActivityItem => {
    const d = deposit(n);
    return { kind: "deposit", at: d.creditedAt, deposit: d };
};

const activity = (id: string, atMs: number, over: Partial<Activity> = {}): Activity => ({
    id,
    at: new Date(atMs),
    kind: "deposit",
    title: "Deposit",
    detail: "",
    symbols: ["USDC"],
    amountUSD: 1,
    change: 1,
    ...over,
});

const page = (items: ActivityItem[], next: string | null): ActivityPage => ({ items, next });

test.describe("mapping", () => {
    test("a trade from the balance maps to a row of its verb with both coins", () => {
        const trade = {
            id: hex(9),
            requestId: "r9",
            verb: "swap" as const,
            paidSymbol: "BNB",
            paidUnits: "0.5",
            gotSymbol: "ETH",
            gotUnits: "0.1",
            usd: "250",
            at: iso(NOW.getTime() - 1000),
        };
        const row = activityFromItem({ kind: "trade", at: trade.at, trade }, ctx);
        expect(row).toMatchObject({
            id: `trade:${hex(9)}`,
            kind: "swap",
            title: "Swapped BNB to ETH",
            symbols: ["BNB", "ETH"],
            amountUSD: 250,
            change: 0,
        });
        expect(itemKey({ kind: "trade", at: trade.at, trade })).toBe(`trade:${hex(9)}`);
    });

    test("a sell or swap row carries its realized PnL as the change", () => {
        const trade = {
            id: hex(9),
            requestId: "r9",
            verb: "sell" as const,
            paidSymbol: "BNB",
            paidUnits: "0.5",
            gotSymbol: "USDC",
            gotUnits: "250",
            usd: "250",
            realized: "-12.5",
            at: iso(NOW.getTime() - 1000),
        };
        expect(activityFromItem({ kind: "trade", at: trade.at, trade }, ctx)).toMatchObject({ change: -12.5 });
    });

    test("each part maps to the same Activity id the live rows use", () => {
        const p = position(1);
        const perpPos = perp(2);
        const d = deposit(3);
        const w = withdrawal(4);
        const s = swap(5, iso(NOW.getTime() - DAY));
        const o = sale(6);
        const items: ActivityItem[] = [
            { kind: "prediction", at: p.openedAt, part: "open", position: p },
            { kind: "prediction", at: p.settledAt!, part: "settle", position: p },
            { kind: "perp", at: perpPos.openedAt, part: "open", position: perpPos },
            { kind: "perp", at: perpPos.settledAt!, part: "settle", position: perpPos },
            { kind: "deposit", at: d.creditedAt, deposit: d },
            { kind: "withdrawal", at: w.createdAt, withdrawal: w },
            { kind: "swap", at: s.createdAt, order: s },
            { kind: "sale", at: o.soldPart!.at, order: o },
        ];
        expect(items.map((item) => activityFromItem(item, ctx)?.id)).toEqual([
            `prediction:${p.id}:open`,
            `prediction:${p.id}:settle`,
            `perp:${perpPos.id}:open`,
            `perp:${perpPos.id}:settle`,
            `deposit:${d.id}`,
            `withdrawal:${w.requestId}`,
            `swap:${s.id}`,
            `sale:${o.id}`,
        ]);
    });

    test("a deposit row carries the document's amount and time, a withdrawal takes its amount off", () => {
        const d = deposit(3, { amount: "7.5" });
        const row = activityFromItem({ kind: "deposit", at: d.creditedAt, deposit: d }, ctx)!;
        expect(row.kind).toBe("deposit");
        expect(row.at).toEqual(new Date(d.creditedAt));
        expect(row.amountUSD).toBe(7.5);
        expect(row.change).toBe(7.5);
        expect(row.pending).toBeUndefined();
        const w = withdrawal(4, { amount: "10", state: "sending" });
        const out = activityFromItem({ kind: "withdrawal", at: w.createdAt, withdrawal: w }, ctx)!;
        expect(out.change).toBe(-10);
        expect(out.pending).toBe(true);
        const sent = activityFromItem({ kind: "withdrawal", at: w.createdAt, withdrawal: withdrawal(4) }, ctx)!;
        expect(sent.pending).toBeUndefined();
    });

    test("a settled prediction's two parts carry the open and the result", () => {
        const p = position(1);
        const open = activityFromItem({ kind: "prediction", at: p.openedAt, part: "open", position: p }, ctx)!;
        const settle = activityFromItem({ kind: "prediction", at: p.settledAt!, part: "settle", position: p }, ctx)!;
        expect(open.change).toBe(0);
        expect(open.at).toEqual(new Date(p.openedAt));
        expect(settle.change).toBe(10);
        expect(settle.at).toEqual(new Date(p.settledAt!));
    });

    test("a sale row's change is proceeds minus cost", () => {
        const o = sale(6);
        const row = saleActivity(o)!;
        expect(row).toEqual({
            id: `sale:${o.id}`,
            at: new Date(o.soldPart!.at),
            kind: "close",
            title: "Sold part of Yes on Will it rain?",
            detail: "5 shares, $4 back",
            symbols: ["USDC"],
            amountUSD: 2.5,
            change: 1.5,
        });
        expect(activityFromItem({ kind: "sale", at: o.soldPart!.at, order: o }, ctx)).toEqual(row);
        const cents = sale(7, { soldPart: { costUSD: "2.5", proceedsUSD: "1.25", at: o.soldPart!.at } });
        expect(saleActivity(cents)).toMatchObject({ detail: "5 shares, $1.25 back", change: -1.25 });
    });

    test("a sell without soldPart has no sale row", () => {
        expect(saleActivity(sale(6, { soldPart: undefined }))).toBeNull();
    });

    test("a swap older than 7 days has no USD size and a recent one is priced", () => {
        const recent = swap(5, iso(NOW.getTime() - 6 * DAY));
        const edge = swap(6, iso(NOW.getTime() - 7 * DAY));
        const old = swap(7, iso(NOW.getTime() - 7 * DAY - 1));
        const row = (s: SwapOrderView, c = ctx) => activityFromItem({ kind: "swap", at: s.createdAt, order: s }, c)!;
        expect(row(recent).amountUSD).toBe(1);
        expect(row(edge).amountUSD).toBe(1);
        expect(row(old).amountUSD).toBeNull();
        expect(row(old).id).toBe(`swap:${old.id}`);
    });

    test("a recent swap of a coin with no price has no USD size", () => {
        const s = swap(5, iso(NOW.getTime() - DAY), { from: { network: "ethereum", token: "PEPE", amount: "9" } });
        expect(activityFromItem({ kind: "swap", at: s.createdAt, order: s }, ctx)!.amountUSD).toBeNull();
    });

    test("a swap is an activity with the networks and the state, and no change to the balance", () => {
        const order = (id: number, state: SwapOrderView["state"]) =>
            swap(id, iso(NOW.getTime() - DAY), {
                state,
                from: { network: "base", token: "USDC", amount: "10" },
                to: { network: "solana", token: "SOL", amount: "0.067", received: null, receivedSymbol: null },
            });
        const row = swapActivity(order(5, "sent"), 10);
        expect(row).toMatchObject({
            kind: "swap",
            title: "Swap USDC to SOL",
            detail: "Base to Solana, on its way",
            symbols: ["USDC", "SOL"],
            amountUSD: 10,
            change: 0,
            pending: true,
        });
        expect(swapActivity(order(6, "done")).pending).toBeUndefined();
        expect(swapActivity(order(6, "done")).amountUSD).toBeNull();
    });

    test("a settle part of an open position maps to null", () => {
        const open = position(1, { state: "open", settledAt: null, payoutUSD: null });
        expect(
            activityFromItem({ kind: "prediction", at: open.openedAt, part: "settle", position: open }, ctx),
        ).toBeNull();
        expect(activityFromItem({ kind: "prediction", at: open.openedAt, part: "open", position: open }, ctx)?.id).toBe(
            `prediction:${open.id}:open`,
        );
        const live = perp(2, { state: "open", settledAt: null, proceedsUSD: null });
        expect(activityFromItem({ kind: "perp", at: live.openedAt, part: "settle", position: live }, ctx)).toBeNull();
        expect(activityFromItem({ kind: "perp", at: live.openedAt, part: "open", position: live }, ctx)?.id).toBe(
            `perp:${live.id}:open`,
        );
    });
});

test.describe("overlay", () => {
    const T = Date.UTC(2026, 9, 10);
    const none = new Set<string>();

    test("the live row wins a clash", () => {
        const pages = [activity("deposit:a", T, { title: "From the page" })];
        const live = [activity("deposit:a", T, { title: "Live" })];
        const rows = overlay({ pages, more: false, live, hidden: none });
        expect(rows.map((r) => r.title)).toEqual(["Live"]);
    });

    test("live rows older than the oldest page row are dropped while more pages exist, and kept at the end", () => {
        const pages = [activity("deposit:a", T), activity("deposit:b", T - DAY)];
        const live = [activity("deposit:c", T + DAY), activity("deposit:d", T - 2 * DAY)];
        expect(overlay({ pages, more: true, live, hidden: none }).map((r) => r.id)).toEqual([
            "deposit:c",
            "deposit:a",
            "deposit:b",
        ]);
        expect(overlay({ pages, more: false, live, hidden: none }).map((r) => r.id)).toEqual([
            "deposit:c",
            "deposit:a",
            "deposit:b",
            "deposit:d",
        ]);
    });

    test("a live row at the oldest page row's time is kept", () => {
        const pages = [activity("deposit:a", T)];
        const live = [activity("deposit:b", T)];
        expect(overlay({ pages, more: true, live, hidden: none }).map((r) => r.id)).toEqual(["deposit:a", "deposit:b"]);
    });

    test("pending live rows survive the floor", () => {
        const pages = [activity("deposit:a", T)];
        const live = [activity("deposit:p", T - 5 * DAY, { pending: true }), activity("deposit:q", T - 6 * DAY)];
        expect(overlay({ pages, more: true, live, hidden: none }).map((r) => r.id)).toEqual(["deposit:a", "deposit:p"]);
    });

    test("with no page rows yet every live row shows", () => {
        const live = [activity("deposit:q", T), activity("deposit:r", T - 60 * DAY)];
        expect(overlay({ pages: [], more: true, live, hidden: none }).map((r) => r.id)).toEqual([
            "deposit:q",
            "deposit:r",
        ]);
    });

    test("a hidden id is removed even when a page row has it", () => {
        const w = withdrawal(4);
        const row = activityFromItem({ kind: "withdrawal", at: w.createdAt, withdrawal: w }, ctx)!;
        const pages = [row, activity("deposit:a", row.at.getTime() - DAY)];
        const rows = overlay({ pages, more: false, live: [], hidden: new Set([`withdrawal:${w.requestId}`]) });
        expect(rows.map((r) => r.id)).toEqual(["deposit:a"]);
    });

    test("a hidden id is removed from the live rows too", () => {
        const live = [activity("withdrawal:x", T), activity("deposit:a", T - DAY)];
        expect(overlay({ pages: [], more: false, live, hidden: new Set(["withdrawal:x"]) }).map((r) => r.id)).toEqual([
            "deposit:a",
        ]);
    });

    test("rows are newest first", () => {
        const pages = [activity("deposit:a", T - 3 * DAY), activity("deposit:b", T - 4 * DAY)];
        const live = [activity("deposit:c", T - 2 * DAY), activity("deposit:d", T)];
        expect(overlay({ pages, more: false, live, hidden: none }).map((r) => r.id)).toEqual([
            "deposit:d",
            "deposit:c",
            "deposit:a",
            "deposit:b",
        ]);
    });

    test("the inputs are left as they were", () => {
        const pages = [activity("deposit:a", T)];
        const live = [activity("deposit:b", T + DAY)];
        overlay({ pages, more: false, live, hidden: none });
        expect(pages.map((r) => r.id)).toEqual(["deposit:a"]);
        expect(live.map((r) => r.id)).toEqual(["deposit:b"]);
    });
});

test.describe("pages", () => {
    const d = (n: number) => depositItem(n);

    test("itemKey is the kind and the document id, with the part", () => {
        const p = position(1);
        const w = withdrawal(2);
        const o = sale(3);
        const s = swap(4, iso(NOW.getTime() - DAY));
        const pp = perp(5);
        expect(itemKey(d(7))).toBe(`deposit:${hex(7)}`);
        expect(itemKey({ kind: "withdrawal", at: w.createdAt, withdrawal: w })).toBe(`withdrawal:${w.id}`);
        expect(itemKey({ kind: "swap", at: s.createdAt, order: s })).toBe(`swap:${s.id}`);
        expect(itemKey({ kind: "sale", at: o.createdAt, order: o })).toBe(`sale:${o.id}`);
        expect(itemKey({ kind: "prediction", at: p.openedAt, part: "open", position: p })).toBe(
            `prediction:${p.id}:open`,
        );
        expect(itemKey({ kind: "prediction", at: p.openedAt, part: "settle", position: p })).toBe(
            `prediction:${p.id}:settle`,
        );
        expect(itemKey({ kind: "perp", at: pp.openedAt, part: "settle", position: pp })).toBe(`perp:${pp.id}:settle`);
    });

    test("a first page on a state that is not loaded becomes the state", () => {
        const state = firstPage(NO_PAGES, page([d(1), d(2)], "c1"));
        expect(state).toEqual({ items: [d(1), d(2)], next: "c1", loaded: true });
    });

    test("a first page on a loaded state does not duplicate and keeps next", () => {
        const loaded: PagesState = { items: [d(1), d(2), d(3), d(4)], next: "c4", loaded: true };
        const fresh = depositItem(0);
        const state = firstPage(loaded, page([fresh, d(1), d(2)], "c2"));
        expect(state.items.map(itemKey)).toEqual([0, 1, 2, 3, 4].map((n) => `deposit:${hex(n)}`));
        expect(state.next).toBe("c4");
        expect(state.loaded).toBe(true);
    });

    test("a first page's copy of a row wins over the loaded one", () => {
        const stale = deposit(1, { amount: "1" });
        const loaded: PagesState = {
            items: [{ kind: "deposit", at: stale.creditedAt, deposit: stale }],
            next: null,
            loaded: true,
        };
        const fresh = deposit(1, { amount: "2" });
        const state = firstPage(loaded, page([{ kind: "deposit", at: fresh.creditedAt, deposit: fresh }], null));
        expect(state.items).toHaveLength(1);
        expect(state.items[0]).toMatchObject({ deposit: { amount: "2" } });
    });

    test("a first page leaves the loaded state as it was", () => {
        const loaded: PagesState = { items: [d(1)], next: "c1", loaded: true };
        firstPage(loaded, page([d(0), d(1)], "x"));
        expect(loaded).toEqual({ items: [d(1)], next: "c1", loaded: true });
    });

    test("an older page appends and moves next on", () => {
        const loaded: PagesState = { items: [d(1), d(2)], next: "c2", loaded: true };
        const state = olderPage(loaded, "c2", page([d(3), d(4)], "c4"));
        expect(state.items.map(itemKey)).toEqual([1, 2, 3, 4].map((n) => `deposit:${hex(n)}`));
        expect(state.next).toBe("c4");
        expect(olderPage(state, "c4", page([d(5)], null)).next).toBeNull();
    });

    test("an older page whose before is not next is ignored", () => {
        const loaded: PagesState = { items: [d(1), d(2)], next: "c2", loaded: true };
        expect(olderPage(loaded, "c1", page([d(3)], "c3"))).toBe(loaded);
        const ended: PagesState = { items: [d(1)], next: null, loaded: true };
        expect(olderPage(ended, "c1", page([d(3)], null))).toBe(ended);
        expect(olderPage(NO_PAGES, "c1", page([d(3)], null))).toBe(NO_PAGES);
    });

    test("the same older page applied twice appends once", () => {
        const loaded: PagesState = { items: [d(1), d(2)], next: "c2", loaded: true };
        const answer = page([d(3), d(4)], "c4");
        const once = olderPage(loaded, "c2", answer);
        const twice = olderPage(once, "c2", answer);
        expect(twice).toBe(once);
        expect(twice.items).toHaveLength(4);
    });

    test("an older page never repeats a row the state has", () => {
        const loaded: PagesState = { items: [d(1), d(2)], next: "c2", loaded: true };
        const state = olderPage(loaded, "c2", page([d(2), d(3)], "c3"));
        expect(state.items.map(itemKey)).toEqual([1, 2, 3].map((n) => `deposit:${hex(n)}`));
    });

    test("an older page that answers after the person switched filter lands on the filter it was asked for", () => {
        const trades: PagesState = { items: [d(1)], next: "t1", loaded: true };
        const deposits: PagesState = { items: [d(2), d(3)], next: "d3", loaded: true };
        const before: FeedState = { ...NO_FEED, trades, deposits };
        // The person is on trades; the deposits page answers late.
        const after = feedReducer(before, {
            type: "older",
            filter: "deposits",
            before: "d3",
            page: page([d(4)], null),
        });
        expect(after.trades).toBe(trades);
        expect(after.all).toBe(NO_FEED.all);
        expect(after.deposits.items.map(itemKey)).toEqual([2, 3, 4].map((n) => `deposit:${hex(n)}`));
        expect(after.deposits.next).toBeNull();
    });

    test("a first page for one filter leaves the others as they were", () => {
        const trades: PagesState = { items: [d(1)], next: null, loaded: true };
        const before: FeedState = { ...NO_FEED, trades };
        const after = feedReducer(before, { type: "first", filter: "all", page: page([d(2)], "c2") });
        expect(after.trades).toBe(trades);
        expect(after.deposits).toBe(NO_FEED.deposits);
        expect(after.all).toEqual({ items: [d(2)], next: "c2", loaded: true });
    });

    test("an ignored older page leaves the feed state as it was", () => {
        const loaded: FeedState = { ...NO_FEED, all: { items: [d(1)], next: "c1", loaded: true } };
        const after = feedReducer(loaded, { type: "older", filter: "all", before: "stale", page: page([d(2)], null) });
        expect(after).toBe(loaded);
    });

    test("a reset forgets every filter's pages", () => {
        const loaded: FeedState = {
            all: { items: [d(1)], next: "c1", loaded: true },
            trades: { items: [d(2)], next: null, loaded: true },
            deposits: { items: [d(3)], next: "c3", loaded: true },
        };
        expect(feedReducer(loaded, { type: "reset" })).toBe(NO_FEED);
        expect(feedReducer(NO_FEED, { type: "reset" })).toBe(NO_FEED);
    });

    test("the empty states are not loaded and hold no rows", () => {
        expect(NO_PAGES).toEqual({ items: [], next: null, loaded: false });
        expect(Object.keys(NO_FEED).sort()).toEqual(["all", "deposits", "trades"]);
        for (const filter of ["all", "trades", "deposits"] as ActivityFilter[]) expect(NO_FEED[filter]).toBe(NO_PAGES);
    });
});

test.describe("matchesFilter", () => {
    const kinds = ["deposit", "withdrawal", "swap", "buy", "sell", "long", "short", "close", "predict"] as const;
    const row = (kind: (typeof kinds)[number]) => activity(`x:${kind}`, 0, { kind });

    test("all matches every kind", () => {
        for (const kind of kinds) expect(matchesFilter("all", row(kind))).toBe(true);
    });

    test("deposits is deposits and withdrawals", () => {
        expect(kinds.filter((kind) => matchesFilter("deposits", row(kind)))).toEqual(["deposit", "withdrawal"]);
    });

    test("trades is the rest", () => {
        expect(kinds.filter((kind) => matchesFilter("trades", row(kind)))).toEqual([
            "swap",
            "buy",
            "sell",
            "long",
            "short",
            "close",
            "predict",
        ]);
    });
});

test.describe("bodyState", () => {
    const filters = ["all", "trades", "deposits"] as const;

    test("bodyState is rows whenever rows exist", () => {
        for (const filter of filters)
            for (const loaded of [false, true])
                for (const more of [false, true]) expect(bodyState({ filter, loaded, more, rows: 1 })).toBe("rows");
    });

    test("bodyState is busy until the first page answers", () => {
        for (const filter of filters)
            for (const more of [false, true]) expect(bodyState({ filter, loaded: false, more, rows: 0 })).toBe("busy");
    });

    test("bodyState is nothing or no-deposits only once loaded with no more pages", () => {
        expect(bodyState({ filter: "all", loaded: true, more: false, rows: 0 })).toBe("nothing");
        expect(bodyState({ filter: "trades", loaded: true, more: false, rows: 0 })).toBe("nothing");
        expect(bodyState({ filter: "deposits", loaded: true, more: false, rows: 0 })).toBe("no-deposits");
    });

    test("with more pages and nothing listed bodyState is busy, never nothing", () => {
        for (const filter of filters) expect(bodyState({ filter, loaded: true, more: true, rows: 0 })).toBe("busy");
    });
});

const OPENED = {
    ok: true,
    data: {
        account: { depositAddress: "0x00000000000000000000000000000000000000b2", balance: "300", version: 1 },
        deposits: { items: [], next: null },
        rules: { chainId: 5042, minDeposit: "0.01" },
        orders: [],
        withdrawals: [],
        solana: { deposits: false, withdrawals: false },
    },
};

type Asked = { before?: string; limit?: number; filter?: ActivityFilter };

/** A socket.io server that opens the account and answers `activity:list` as the test says */
async function fakeServer(onList: (payload: Asked, ack: (result: unknown) => void) => void) {
    const http = createServer();
    const io = new Server(http);
    const asked: Asked[] = [];
    let opens = 0;
    let release: (result: unknown) => void = () => undefined;
    io.on("connection", (socket) => {
        socket.on("account:open", (_payload, ack) => (++opens === 1 ? ack(OPENED) : (release = ack)));
        socket.on("activity:list", (payload, ack) => {
            asked.push(payload);
            onList(payload, ack);
        });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    return {
        client,
        io,
        asked,
        release: () => release(OPENED),
        opens: () => opens,
        open: async () => {
            client.connect("user", async () => "token");
            await expect.poll(() => client.getSnapshot().pnl.bound).toBe(1);
        },
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

test.describe("the account client's page plumbing", () => {
    test("a page is asked with the filter and the cursor, and with no limit", async () => {
        const answer = page([depositItem(1)], "c1");
        const stack = await fakeServer((_payload, ack) => ack({ ok: true, data: answer }));
        try {
            expect(await stack.client.loadActivityPage({ filter: "all" })).toMatchObject({ code: "unavailable" });
            expect(stack.asked).toEqual([]);
            await stack.open();
            expect(await stack.client.loadActivityPage({ filter: "all" })).toEqual(answer);
            expect(await stack.client.loadActivityPage({ filter: "deposits", before: "c0" })).toEqual(answer);
            expect(stack.asked).toEqual([{ filter: "all" }, { filter: "deposits", before: "c0" }]);
        } finally {
            await stack.stop();
        }
    });

    test("an error answer comes back as the error", async () => {
        const error: ApiError = { code: "rate_limited", message: "Slow down." };
        const stack = await fakeServer((_payload, ack) => ack({ ok: false, error }));
        try {
            await stack.open();
            expect(await stack.client.loadActivityPage({ filter: "trades" })).toEqual(error);
        } finally {
            await stack.stop();
        }
    });

    test("nothing is asked while a reconnected socket is not yet bound to the account", async () => {
        const stack = await fakeServer((_payload, ack) => ack({ ok: true, data: page([], null) }));
        try {
            await stack.open();
            for (const socket of stack.io.sockets.sockets.values()) socket.disconnect();
            await expect.poll(() => stack.opens()).toBe(2);
            expect(await stack.client.loadActivityPage({ filter: "all" })).toMatchObject({ code: "unavailable" });
            expect(stack.asked).toEqual([]);
            stack.release();
            await expect.poll(() => stack.client.getSnapshot().pnl.bound).toBe(2);
            expect(await stack.client.loadActivityPage({ filter: "all" })).toEqual(page([], null));
            expect(stack.asked).toEqual([{ filter: "all" }]);
        } finally {
            await stack.stop();
        }
    });
});

test.describe("when the feed asks for its newest page again", () => {
    test("after a bind or a push from the server, and not while neither has come", async () => {
        const stack = await fakeServer((_payload, ack) => ack({ ok: true, data: page([], null) }));
        try {
            await stack.open();
            const opened = answerStamp(stack.client.getSnapshot().pnl);
            expect(answerStamp(stack.client.getSnapshot().pnl)).toBe(opened);
            // A Buy, Sell or Swap moves the PnL, which the server tells the socket
            for (const socket of stack.io.sockets.sockets.values()) socket.emit("pnl:changed");
            await expect.poll(() => stack.client.getSnapshot().pnl.changed).toBe(1);
            const pushed = answerStamp(stack.client.getSnapshot().pnl);
            expect(pushed).not.toBe(opened);
            for (const socket of stack.io.sockets.sockets.values()) socket.emit("pnl:changed");
            await expect.poll(() => stack.client.getSnapshot().pnl.changed).toBe(2);
            expect(answerStamp(stack.client.getSnapshot().pnl)).not.toBe(pushed);
        } finally {
            await stack.stop();
        }
    });

    test("a push count on one bind never reads as another bind's", () => {
        expect(answerStamp({ bound: 1, changed: 23 })).not.toBe(answerStamp({ bound: 12, changed: 3 }));
        expect(answerStamp({ bound: 2, changed: 0 })).not.toBe(answerStamp({ bound: 3, changed: 0 }));
    });
});
