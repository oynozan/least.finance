import { expect, test } from "@playwright/test";
import {
    REFRESH_INTERVAL_MS,
    dropAfterSend,
    loadCachedBalances,
    needsRefresh,
    saveCachedBalances,
} from "@/lib/account/balances";
import type { BalancesView, CoinBalance } from "@/server/src/protocol";

const EVM = "0xAbCdEf0000000000000000000000000000000001";
const SOL = "So11111111111111111111111111111111111111112";

const row = (coin: string, wallet: string, amount: string | null, extra: Partial<CoinBalance> = {}): CoinBalance => ({
    coin,
    chain: wallet === SOL ? "solana" : "arc",
    chainId: null,
    chainName: "Arc",
    symbol: coin.split(":")[1],
    decimals: 6,
    wallet,
    amount,
    spendable: amount,
    usd: null,
    ...extra,
});

const view = (rows: CoinBalance[], readAt = "2026-10-12T10:00:00.000Z"): BalancesView => ({ readAt, rows });
const T0 = Date.parse("2026-10-12T10:00:00.000Z");

const setStorage = (value: unknown) =>
    Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });

function fakeStorage(store: Record<string, string>) {
    setStorage({
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => void (store[k] = v),
    });
}

test.afterEach(() => {
    setStorage(undefined);
});

test("the cache round-trips under balances:<user>", () => {
    const store: Record<string, string> = {};
    fakeStorage(store);
    const v = view([row("arc:USDC", EVM, "5")]);
    saveCachedBalances("u1", v);
    expect(Object.keys(store)).toEqual(["balances:u1"]);
    expect(loadCachedBalances("u1")).toEqual(v);
    expect(loadCachedBalances("u2")).toBeNull();
});

test("a throwing localStorage gives null and does not throw", () => {
    setStorage({
        getItem: () => {
            throw new Error("denied");
        },
        setItem: () => {
            throw new Error("denied");
        },
    });
    expect(loadCachedBalances("u1")).toBeNull();
    expect(() => saveCachedBalances("u1", view([]))).not.toThrow();
});

test("a malformed cache entry gives null", () => {
    fakeStorage({ "balances:u1": "{nope" });
    expect(loadCachedBalances("u1")).toBeNull();
    fakeStorage({ "balances:u1": '{"x":1}' });
    expect(loadCachedBalances("u1")).toBeNull();
});

test("dropAfterSend lowers the matching row only", () => {
    const v = view([row("arc:USDC", EVM, "5.5"), row("ethereum:USDC", EVM, "9"), row("arc:USDC", "0xother", "7")]);
    const out = dropAfterSend(v, "arc:USDC", EVM, "2");
    expect(out.rows.map((r) => r.amount)).toEqual(["3.5", "9", "7"]);
    expect(out.rows[0].spendable).toBe("3.5");
    expect(v.rows[0].amount).toBe("5.5");
});

test("dropAfterSend matches EVM case-insensitively and Solana exactly", () => {
    const v = view([row("arc:USDC", EVM, "5"), row("solana:USDC", SOL, "5")]);
    expect(dropAfterSend(v, "arc:USDC", EVM.toLowerCase(), "1").rows[0].amount).toBe("4");
    expect(dropAfterSend(v, "solana:USDC", SOL, "1").rows[1].amount).toBe("4");
    expect(dropAfterSend(v, "solana:USDC", SOL.toLowerCase(), "1").rows[1].amount).toBe("5");
});

test("dropAfterSend never goes below 0 and leaves unknown amounts alone", () => {
    const v = view([row("arc:USDC", EVM, "1", { spendable: "0.5" }), row("arc:USDC", "0xb", null)]);
    const out = dropAfterSend(v, "arc:USDC", EVM, "3");
    expect(out.rows[0].amount).toBe("0");
    expect(out.rows[0].spendable).toBe("0");
    expect(dropAfterSend(v, "arc:USDC", "0xb", "3").rows[1].amount).toBeNull();
});

test("a refresh is skipped inside 30 s and sent at 30 s", () => {
    const v = view([row("arc:USDC", EVM, "1")]);
    expect(needsRefresh(v, [EVM], T0 + REFRESH_INTERVAL_MS - 1)).toBe(false);
    expect(needsRefresh(v, [EVM], T0 + REFRESH_INTERVAL_MS)).toBe(true);
    expect(needsRefresh(null, [], T0)).toBe(true);
});

test("a wallet with no rows is read at once, even inside 30 s", () => {
    const v = view([row("arc:USDC", EVM, "1")]);
    const now = T0 + 1_000;
    expect(needsRefresh(v, [EVM.toLowerCase()], now)).toBe(false);
    expect(needsRefresh(v, [EVM, SOL], now)).toBe(true);
    expect(needsRefresh(view([row("solana:USDC", SOL, "1")]), [SOL.toLowerCase()], now)).toBe(true);
    expect(needsRefresh(view([row("solana:USDC", SOL, "1")]), [SOL], now)).toBe(false);
});
