import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server } from "socket.io";
import { AccountClient } from "@/components/account-client";
import {
    accountReducer,
    initialAccountState,
    optimisticBalance,
    toWei,
    type AccountAction,
    type AccountView,
    type Hex,
} from "@/lib/account/state";
import { quoteRows } from "@/lib/trade/perp-quote";
import type { PerpOrderView, PerpPositionView, PerpQuoteView, PerpUpdate } from "@/server/src/protocol";

const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000b2" as Hex;
const REQ = "11111111-1111-4111-8111-111111111111";

const account = (balance: string, version: number): AccountView => ({
    depositAddress: DEPOSIT_ADDRESS,
    balance,
    version,
});
const at = (n: number) => new Date(Date.UTC(2026, 9, 14, 0, 0, n)).toISOString();

const QUOTE: PerpQuoteView = {
    entryPx: "66000",
    sizeCoin: "0.00757",
    notionalUSD: "500",
    takerFeeUSD: "0.225",
    ourFeeUSD: "0",
    liquidationPx: "53100",
    fundingPerHour: "0.0000125",
    marginUSD: "100",
};
const CTX = { side: "long" as const, asset: "BTC", leverage: 5, collateralUSD: "100" };

const order = (requestId: string, over: Partial<PerpOrderView> = {}): PerpOrderView => ({
    id: "o1",
    requestId,
    kind: "open",
    state: "filled",
    reason: null,
    positionId: "p1",
    filledSizeCoin: "0.00757",
    requestedSizeCoin: "0.00757",
    collateralUSD: "100",
    creditedUSD: null,
    createdAt: at(1),
    updatedAt: at(1),
    ...over,
});

const position = (over: Partial<PerpPositionView> = {}): PerpPositionView => ({
    id: "p1",
    asset: "BTC",
    side: "long",
    leverage: 5,
    sizeCoin: "0.00757",
    entryPx: "65990",
    collateralUSD: "100",
    liquidationPx: "53090",
    markPx: "66010",
    unrealizedPnlUSD: "0.1",
    cumFundingUSD: "0",
    state: "open",
    proceedsUSD: null,
    notice: null,
    openedAt: at(1),
    settledAt: null,
    updatedAt: at(1),
    ...over,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket.io server that opens the account with $300 and answers perp orders as the test scripts. */
async function fakeServer(onOrder: (ack: (result: unknown) => void, payload: Record<string, unknown>) => void) {
    const http = createServer();
    const io = new Server(http);
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    io.on("connection", (socket) => {
        socket.onAny((name, payload) => events.push({ name, payload }));
        socket.on("account:open", (_p, ack) =>
            ack({
                ok: true,
                data: {
                    account: account("300", 1),
                    deposits: { items: [], next: null },
                    rules: { chainId: 5042, minDeposit: "0.01" },
                    orders: [],
                    withdrawals: [],
                    solana: { deposits: true, withdrawals: true },
                },
            }),
        );
        socket.on("perp:order", (payload, ack) => onOrder(ack, payload));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    client.connect("user", async () => "token");
    await expect.poll(() => client.getSnapshot().state.status).toBe("ready");
    const state = () => {
        const s = client.getSnapshot().state;
        if (s.status !== "ready") throw new Error("not ready");
        return s;
    };
    return {
        client,
        events,
        state,
        push: (update: PerpUpdate) => io.emit("perp:update", update),
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

test.describe("perp review rows", () => {
    test("the review shows Position, Entry price (about), Liquidation price (about), Fees, Funding and Most you can lose from the quote", () => {
        const rows = quoteRows(QUOTE, { ...CTX, collateralUSD: "100" });
        expect(rows.map((r) => r.label)).toEqual([
            "Position",
            "Entry price (about)",
            "Liquidation price (about)",
            "Fees",
            "Funding",
            "Most you can lose",
        ]);
        const value = (label: string) => rows.find((r) => r.label === label)?.value;
        expect(value("Position")).toContain("$500");
        expect(value("Position")).toContain("0.00757 BTC");
        expect(value("Entry price (about)")).toBe("$66,000");
        expect(value("Liquidation price (about)")).toContain("$53,100");
        expect(value("Liquidation price (about)")).toContain("funding");
        expect(value("Fees")).toContain("$0.23");
        expect(value("Funding")).toContain("per hour");
        expect(value("Most you can lose")).toBe("$100.00");
    });
});

test.describe("placing a perp", () => {
    test("confirm lowers the balance by the collateral and adds a pending position at once, while the order is held", async () => {
        let release: (result: unknown) => void = () => undefined;
        const stack = await fakeServer((ack) => (release = ack));
        try {
            const placed = stack.client.placePerp({ ...CTX, collateralUSD: "100", requestId: REQ }, QUOTE);
            expect(placed.sent).toBe(true);
            expect(optimisticBalance(stack.state())).toBe(toWei("200"));
            expect(stack.state().perps.positions).toMatchObject([
                { id: `pending:${placed.requestId}`, asset: "BTC", sizeCoin: "0.00757", entryPx: "66000" },
            ]);
            await expect.poll(() => stack.events.some((e) => e.name === "perp:order")).toBe(true);
            expect(stack.events.find((e) => e.name === "perp:order")?.payload).toMatchObject({
                requestId: placed.requestId,
                asset: "BTC",
                leverage: 5,
            });
            release({
                ok: true,
                data: {
                    order: order(placed.requestId, { state: "placing", positionId: null }),
                    account: account("200", 2),
                },
            });
            await expect.poll(() => stack.state().account.version).toBe(2);
            expect(optimisticBalance(stack.state())).toBe(toWei("200"));
            expect(stack.state().perps.positions).toHaveLength(1);
        } finally {
            await stack.stop();
        }
    });

    test("the fill replaces the numbers in place", async () => {
        const stack = await fakeServer(() => undefined);
        try {
            const { requestId } = stack.client.placePerp({ ...CTX, requestId: REQ }, QUOTE);
            stack.push({ order: order(requestId), position: position(), account: account("200", 2) });
            await expect.poll(() => stack.state().perps.positions[0]?.id).toBe("p1");
            expect(stack.state().perps.positions).toHaveLength(1);
            expect(stack.state().perps.positions[0]).toMatchObject({ entryPx: "65990", sizeCoin: "0.00757" });
            expect(stack.state().optimisticPerps).toEqual([]);
            expect(optimisticBalance(stack.state())).toBe(toWei("200"));
            expect(stack.client.getSnapshot().tradeNotice).toBeNull();
        } finally {
            await stack.stop();
        }
    });

    test("a rejection removes the position, restores the balance and shows 'The price moved, so your position didn't open. Nothing was spent.'", async () => {
        const stack = await fakeServer(() => undefined);
        try {
            const { requestId } = stack.client.placePerp({ ...CTX, requestId: REQ }, QUOTE);
            expect(optimisticBalance(stack.state())).toBe(toWei("200"));
            const message = "The price moved, so your position didn't open. Nothing was spent.";
            stack.push({
                order: order(requestId, { state: "rejected", reason: message, positionId: null, creditedUSD: "100" }),
                position: null,
                account: account("300", 3),
            });
            await expect.poll(() => stack.state().perps.positions).toEqual([]);
            expect(optimisticBalance(stack.state())).toBe(toWei("300"));
            expect(stack.client.getSnapshot().tradeNotice).toEqual({ message });
        } finally {
            await stack.stop();
        }
    });

    test("a refused order is taken back with the server's message", async () => {
        const stack = await fakeServer((ack) =>
            ack({ ok: false, error: { code: "below_minimum", message: "Positions start at $10." } }),
        );
        try {
            stack.client.placePerp({ ...CTX, requestId: REQ }, QUOTE);
            await expect.poll(() => stack.state().perps.positions).toEqual([]);
            expect(optimisticBalance(stack.state())).toBe(toWei("300"));
            expect(stack.client.getSnapshot().tradeNotice).toEqual({ message: "Positions start at $10." });
        } finally {
            await stack.stop();
        }
    });

    test("a partial fill shows 'Opened $X of your $Y. The rest is back in your balance.'", async () => {
        const stack = await fakeServer(() => undefined);
        try {
            const { requestId } = stack.client.placePerp({ ...CTX, requestId: REQ }, QUOTE);
            const message = "Opened $250 of your $500. The rest is back in your balance.";
            stack.push({
                order: order(requestId, { reason: message, creditedUSD: "50" }),
                position: position({ collateralUSD: "50" }),
                account: account("250", 2),
            });
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message });
            expect(optimisticBalance(stack.state())).toBe(toWei("250"));
        } finally {
            await stack.stop();
        }
    });

    test("an older perp:update is ignored", async () => {
        const stack = await fakeServer(() => undefined);
        try {
            stack.push({
                order: order("r-old", { updatedAt: at(5) }),
                position: position({ updatedAt: at(5), markPx: "70000" }),
                account: account("200", 2),
            });
            await expect.poll(() => stack.state().perps.positions[0]?.markPx).toBe("70000");
            stack.push({
                order: order("r-old", { state: "posted", positionId: null, updatedAt: at(2) }),
                position: position({ updatedAt: at(2), markPx: "60000" }),
                account: account("200", 2),
            });
            await wait(150);
            expect(stack.state().perps.positions[0]?.markPx).toBe("70000");
            expect(stack.state().perps.orders[0]?.state).toBe("filled");
        } finally {
            await stack.stop();
        }
    });

    test("offline at confirm shows the offline message and changes nothing", () => {
        const idle = new AccountClient("http://127.0.0.1:1");
        const result = idle.placePerp({ ...CTX, requestId: REQ }, QUOTE);
        expect(result.sent).toBe(false);
        expect(idle.getSnapshot().tradeNotice).toEqual({ message: "You're offline. Nothing was spent." });
        expect(idle.getSnapshot().state.status).toBe("idle");
    });

    test("a reload while held keeps the pending position from the server's perps snapshot", () => {
        const pending = position({ id: `pending:${REQ}`, entryPx: "66000" });
        const held = order(REQ, { state: "posted", positionId: null });
        const actions: AccountAction[] = [
            { type: "connecting" },
            {
                type: "session",
                session: {
                    account: account("300", 1),
                    deposits: { items: [], next: null },
                    rules: { chainId: 5042, minDeposit: "0.01" },
                    orders: [],
                    withdrawals: [],
                    solana: { deposits: false, withdrawals: false },
                },
            },
            { type: "perpAccepted", requestId: REQ, position: pending, collateralWei: toWei("100"), connection: 1 },
            // The reconnect's session already has the debit, then the snapshot lists the order in flight.
            {
                type: "session",
                session: {
                    account: account("200", 2),
                    deposits: { items: [], next: null },
                    rules: { chainId: 5042, minDeposit: "0.01" },
                    orders: [],
                    withdrawals: [],
                    solana: { deposits: false, withdrawals: false },
                },
            },
            { type: "perpsSnapshot", perps: { positions: [], orders: [held] }, connection: 2 },
        ];
        const state = actions.reduce(accountReducer, initialAccountState);
        if (state.status !== "ready") throw new Error("not ready");
        expect(state.perps.positions.map((p) => p.id)).toEqual([`pending:${REQ}`]);
        expect(optimisticBalance(state)).toBe(toWei("200"));
    });
});
