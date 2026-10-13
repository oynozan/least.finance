import { expect, test } from "@playwright/test";
import {
    clearUnreported,
    dropHolding,
    keepUnreported,
    loadUnreported,
    reportUnreported,
    settleHoldings,
    settlesReport,
    trackOrder,
    type Tracking,
} from "@/lib/account/swaps";
import type { SwapHoldingsView, SwapOrderView, SwapQuoteView } from "@/server/src/protocol";
import { swapActivity } from "@/lib/trade/activity";
import { CATALOG, TOKENS } from "@/lib/trade/catalog";
import type { TradeCtx } from "@/lib/trade/context";
import { toSwapRequest } from "@/lib/trade/swap-request";
import { formatEta, swapQuoteRows } from "@/lib/trade/swap-quote";

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

const priced = TOKENS.map((t) => ({ ...t, priceUSD: t.symbol === "ETH" ? 3000 : t.symbol === "USDC" ? 1 : null }));
const ctx = (units: Record<string, Record<string, number>> = {}): TradeCtx => ({
    catalog: { ...CATALOG, tokens: priced },
    holdings: null,
    wallet: { units, unread: [] },
});
const BOTH = { evm: EVM, solana: SOL };

test("a swap maps straight to a request with the wallets of each network's kind", () => {
    const intent = {
        type: "swap" as const,
        fromToken: "ETH",
        fromNetwork: "base" as const,
        toToken: "SOL",
        toNetwork: "solana" as const,
        amountUSD: "10",
    };
    expect(toSwapRequest(intent, ctx(), BOTH, BOTH)).toEqual({
        from: { token: "ETH", network: "base" },
        to: { token: "SOL", network: "solana" },
        amountUSD: "10",
        wallet: EVM,
        receiver: SOL,
    });
    expect(toSwapRequest(intent, ctx(), { evm: EVM }, BOTH)).toEqual({ missing: "solana" });
    expect(toSwapRequest(intent, ctx(), { solana: SOL }, BOTH)).toEqual({ missing: "evm" });
});

test("buy pays USDC where the wallet holds it and sell pays the coin for USDC on its network", () => {
    const buy = {
        type: "spot" as const,
        side: "buy" as const,
        token: "ETH",
        network: "base" as const,
        amountUSD: "50",
    };
    const richOnEthereum = ctx({ USDC: { ethereum: 500, base: 5 } });
    expect(toSwapRequest(buy, richOnEthereum, BOTH, BOTH)).toMatchObject({
        from: { token: "USDC", network: "ethereum" },
        to: { token: "ETH", network: "base" },
    });
    expect(toSwapRequest(buy, ctx({ USDC: { base: 80 } }), BOTH, BOTH)).toMatchObject({
        from: { token: "USDC", network: "base" },
    });
    const sell = { ...buy, side: "sell" as const };
    expect(toSwapRequest(sell, richOnEthereum, BOTH, BOTH)).toMatchObject({
        from: { token: "ETH", network: "base" },
        to: { token: "USDC", network: "base" },
        amountUSD: "50",
    });
});

const quote = (): SwapQuoteView => ({
    request: {
        from: { token: "ETH", network: "ethereum" },
        to: { token: "USDC", network: "base" },
        amountUSD: "10",
        wallet: EVM,
        receiver: EVM,
    },
    fromAmount: "0.003333",
    toAmount: "9.975",
    toAmountMin: "9.925",
    fees: [
        { name: "LIFI Fixed Fee", usd: 0.025 },
        { name: "Relayer", usd: 0.1 },
    ],
    gasUSD: 0.05,
    etaSeconds: 20,
    tool: "Fake Bridge",
    needsApproval: false,
});

test("the quote's rows show what is paid, got, at least, the fees, the gas, the time and the route", () => {
    const rows = swapQuoteRows(quote(), ctx());
    expect(rows.map((r) => [r.label, r.value])).toEqual([
        ["You pay", "0.003333 ETH ($10.00) on Ethereum"],
        ["You get", "≈ 9.975 USDC on Base"],
        ["At least", "9.925 USDC ($9.93)"],
        ["Fees", "LI.FI 0.25% ($0.03), Relayer ($0.10)"],
        ["Network gas", "≈ $0.05"],
        ["Time", "about 20 s"],
        ["Route", "Fake Bridge"],
    ]);
    expect(rows.filter((r) => r.primary).map((r) => r.id)).toEqual(["pay", "get"]);
});

test("a coin without a price shows a dash, never $0", () => {
    const q = quote();
    q.request.to = { token: "SOL", network: "solana" };
    expect(swapQuoteRows(q, ctx()).find((r) => r.id === "min")!.value).toBe("9.925 SOL (—)");
    expect(formatEta(1080)).toBe("about 18 min");
    expect(swapQuoteRows({ ...quote(), fees: [] }, ctx()).find((r) => r.id === "fees")!.value).toBe("None");
});

test("a swap is an activity with the networks and the state, and no change to the balance", () => {
    const row = swapActivity(order("a", "sent"), 10);
    expect(row).toMatchObject({
        kind: "swap",
        title: "Swap USDC to SOL",
        detail: "Base to Solana, on its way",
        symbols: ["USDC", "SOL"],
        amountUSD: 10,
        change: 0,
        pending: true,
    });
    expect(swapActivity(order("b", "done")).pending).toBeUndefined();
    expect(swapActivity(order("b", "done")).amountUSD).toBeNull();
});

const answer = (code: string) => ({ ok: false as const, error: { code, message: "" } });

test("a report attempted before the bind waits, then is sent once bound", async () => {
    fakeStorage({});
    keepUnreported("w1", { orderId: "b1", txHashes: ["0xaa"] });
    const sent: string[] = [];
    const send = async (entry: { orderId: string }) => {
        sent.push(entry.orderId);
        return true;
    };
    const inFlight = new Set<string>();
    await reportUnreported("w1", inFlight, send, false);
    expect(sent).toEqual([]);
    expect(loadUnreported("w1")).toHaveLength(1);
    await reportUnreported("w1", inFlight, send, true);
    expect(sent).toEqual(["b1"]);
    expect(loadUnreported("w1")).toEqual([]);
});

test("only a definitive answer about the order clears its kept hashes", async () => {
    fakeStorage({});
    const outcomes: [string, boolean][] = [
        ["wallet_not_connected", false],
        ["rate_limited", false],
        ["unavailable", false],
        ["internal", false],
        ["not_found", true],
        ["forbidden", true],
    ];
    for (const [code, settles] of outcomes) expect(settlesReport(answer(code)), code).toBe(settles);
    expect(settlesReport({ ok: true })).toBe(true);
    keepUnreported("w2", { orderId: "b2", txHashes: ["0xaa"] });
    // A timeout or a disconnect is a send that says no.
    await reportUnreported("w2", new Set(), async () => false);
    expect(loadUnreported("w2")).toHaveLength(1);
    await reportUnreported("w2", new Set(), async () => settlesReport({ ok: true }));
    expect(loadUnreported("w2")).toEqual([]);
});

test("with storage throwing, the hashes are still reported once bound", async () => {
    const blocked = () => {
        throw new Error("blocked");
    };
    setStorage({ getItem: blocked, setItem: blocked, removeItem: blocked });
    keepUnreported("w3", { orderId: "b3", txHashes: ["0xaa"] });
    expect(loadUnreported("w3").map((e) => e.orderId)).toEqual(["b3"]);
    const sent: string[] = [];
    await reportUnreported("w3", new Set(), async (e) => (sent.push(e.orderId), true), false);
    await reportUnreported("w3", new Set(), async (e) => (sent.push(e.orderId), true), true);
    expect(sent).toEqual(["b3"]);
    expect(loadUnreported("w3")).toEqual([]);
});

test("the paying wallet must be connected here; the receiver need only be linked", () => {
    const intent = {
        type: "swap" as const,
        fromToken: "ETH",
        fromNetwork: "base" as const,
        toToken: "SOL",
        toNetwork: "solana" as const,
        amountUSD: "10",
    };
    // Linked but not connected here: connect it.
    expect(toSwapRequest(intent, ctx(), BOTH, {})).toEqual({ connect: EVM });
    expect(toSwapRequest(intent, ctx(), BOTH, { solana: SOL })).toEqual({ connect: EVM });
    // Another connected wallet is not the one that pays.
    expect(toSwapRequest(intent, ctx(), BOTH, { evm: "0x0000000000000000000000000000000000000002" })).toEqual({
        connect: EVM,
    });
    // Connected (any case) it signs, and the receiver can be linked only.
    expect(toSwapRequest(intent, ctx(), BOTH, { evm: EVM.toLowerCase() })).toMatchObject({
        wallet: EVM,
        receiver: SOL,
    });
    // A Solana payer is matched exactly.
    const back = {
        ...intent,
        fromToken: "SOL",
        fromNetwork: "solana" as const,
        toToken: "ETH",
        toNetwork: "base" as const,
    };
    expect(toSwapRequest(back, ctx(), BOTH, { evm: EVM })).toEqual({ connect: SOL });
    expect(toSwapRequest(back, ctx(), BOTH, { solana: SOL })).toMatchObject({ wallet: SOL, receiver: EVM });
});
