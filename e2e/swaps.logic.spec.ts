import { expect, test } from "@playwright/test";
import {
    clearUnreported,
    dropHolding,
    keepUnreported,
    loadUnreported,
    reportUnreported,
    settleHoldings,
    trackOrder,
    type Tracking,
} from "@/lib/account/swaps";
import type { SwapHoldingsView, SwapOrderView } from "@/server/src/protocol";

const EVM = "0xAbCdEf0000000000000000000000000000000001";
const SOL = "So11111111111111111111111111111111111111112";

const view = (): SwapHoldingsView => ({
    readAt: "2026-10-13T10:00:00.000Z",
    rows: [
        { wallet: EVM, network: "base", symbol: "USDC", amount: "100", usd: 100 },
        { wallet: EVM, network: "ethereum", symbol: "USDC", amount: "50", usd: 50 },
        { wallet: EVM, network: "base", symbol: "ETH", amount: "0.5", usd: 1605.2 },
    ],
    read: [{ wallet: EVM, network: "base" }],
});

const order = (id: string, state: SwapOrderView["state"], extra: Partial<SwapOrderView["to"]> = {}): SwapOrderView => ({
    id,
    state,
    from: { token: "USDC", network: "base", amount: "10" },
    to: { token: "SOL", network: "solana", amount: "0.067", received: null, receivedSymbol: null, ...extra },
    wallet: EVM,
    txHashes: [],
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
});

const paid = (amount: string) => ({ wallet: EVM.toLowerCase(), network: "base" as const, symbol: "USDC", amount });
const tracked = (amount: string) => ({
    paid: paid(amount),
    receiver: SOL,
    to: { network: "solana" as const, symbol: "SOL" },
});

const setStorage = (value: unknown) =>
    Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
function fakeStorage(store: Record<string, string>) {
    setStorage({
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => void (store[k] = v),
        removeItem: (k: string) => void delete store[k],
    });
}

test("dropping and restoring a holding touches only that row", () => {
    const before = view();
    const dropped = dropHolding(before, paid("10"));
    expect(dropped.rows.map((r) => r.amount)).toEqual(["90", "50", "0.5"]);
    expect(dropped.rows[0].usd).toBeCloseTo(90);
    expect(dropped.read).toEqual(before.read);
    let tracking: Tracking = trackOrder({}, "o1", tracked("10"));
    const settled = settleHoldings(dropped, tracking, order("o1", "refunded"));
    expect(settled.view.rows.map((r) => r.amount)).toEqual(["100", "50", "0.5"]);
    expect(settled.tracking).toEqual({});
    // An order this client never tracked changes nothing.
    tracking = {};
    expect(settleHoldings(dropped, tracking, order("o9", "refunded")).view).toBe(dropped);
    // Dropping to nothing removes the row.
    expect(dropHolding(before, paid("100")).rows.map((r) => r.symbol + r.network)).toEqual(["USDCethereum", "ETHbase"]);
});

test("a done swap raises the received coin", () => {
    const tracking = trackOrder({}, "o1", tracked("10"));
    const dropped = dropHolding(view(), paid("10"));
    const done = settleHoldings(dropped, tracking, order("o1", "done", { received: "0.066", receivedSymbol: "SOL" }));
    expect(done.view.rows.find((r) => r.network === "solana")).toMatchObject({
        wallet: SOL,
        symbol: "SOL",
        amount: "0.066",
    });
    expect(done.view.rows[0].amount).toBe("90");
    expect(done.tracking).toEqual({});
    const again = settleHoldings(
        done.view,
        trackOrder({}, "o2", tracked("5")),
        order("o2", "partial", { received: "0.01", receivedSymbol: "SOL" }),
    );
    expect(again.view.rows.find((r) => r.network === "solana")?.amount).toBe("0.076");
    // A sent order is still waiting.
    expect(settleHoldings(dropped, tracking, order("o1", "sent")).tracking).toEqual(tracking);
});

test("unreported hashes survive a reload and are reported once", async () => {
    const store: Record<string, string> = {};
    fakeStorage(store);
    keepUnreported("u1", { orderId: "o1", txHashes: ["0xaa"] });
    keepUnreported("u1", { orderId: "o2", txHashes: ["0xbb", "0xcc"] });
    keepUnreported("u2", { orderId: "o3", txHashes: ["0xdd"] });
    // A reload keeps only what storage holds.
    fakeStorage(store);
    expect(loadUnreported("u1").map((e) => e.orderId)).toEqual(["o1", "o2"]);
    const sent: string[] = [];
    const inFlight = new Set<string>();
    const send = async (entry: { orderId: string }) => {
        sent.push(entry.orderId);
        return entry.orderId === "o1";
    };
    await Promise.all([reportUnreported("u1", inFlight, send), reportUnreported("u1", inFlight, send)]);
    expect(sent).toEqual(["o1", "o2"]);
    expect(loadUnreported("u1").map((e) => e.orderId)).toEqual(["o2"]);
    clearUnreported("u1", "o2");
    expect(loadUnreported("u1")).toEqual([]);
    expect(loadUnreported("u2")).toHaveLength(1);
    setStorage({
        getItem: () => {
            throw new Error("blocked");
        },
        setItem: () => {
            throw new Error("blocked");
        },
    });
    expect(loadUnreported("u1")).toEqual([]);
    expect(() => keepUnreported("u1", { orderId: "x", txHashes: [] })).not.toThrow();
});

test("two orders from two tabs each drop their own amount", () => {
    let holdings = view();
    let tracking: Tracking = {};
    for (const [id, amount] of [
        ["a", "10"],
        ["b", "7.5"],
    ] as const) {
        holdings = dropHolding(holdings, paid(amount));
        tracking = trackOrder(tracking, id, tracked(amount));
    }
    expect(holdings.rows[0].amount).toBe("82.5");
    const refunded = settleHoldings(holdings, tracking, order("a", "failed"));
    expect(refunded.view.rows[0].amount).toBe("92.5");
    expect(Object.keys(refunded.tracking)).toEqual(["b"]);
    const both = settleHoldings(refunded.view, refunded.tracking, order("b", "refunded"));
    expect(both.view.rows[0].amount).toBe("100");
});
