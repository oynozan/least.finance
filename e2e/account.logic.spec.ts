import { expect, test } from "@playwright/test";
import {
    accountReducer,
    historyRows,
    initialAccountState,
    optimisticBalance,
    toUsdc,
    toWei,
    type AccountAction,
    type AccountState,
    type AccountView,
    type DepositOrderView,
    type DepositReceipt,
    type DepositView,
    type Hex,
    type WalletSession,
    type WithdrawalView,
} from "@/lib/account/state";

const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000b2" as Hex;
const RULES = { chainId: 5042, minDeposit: "0.01" };

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const oid = (n: number) => n.toString(16).padStart(24, "0");

const account = (balance: string, version: number): AccountView => ({
    depositAddress: DEPOSIT_ADDRESS,
    balance,
    version,
});

function deposit(n: number, amount: string, over: Partial<DepositView> = {}): DepositView {
    return {
        id: oid(n),
        txHash: hash(n),
        logIndex: 0,
        from: "0x00000000000000000000000000000000000000c3" as Hex,
        amount,
        blockNumber: 100 + n,
        creditedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
        ...over,
    };
}

function session(
    balance: string,
    version: number,
    items: DepositView[] = [],
    next: string | null = null,
    orders: DepositOrderView[] = [],
): WalletSession {
    return {
        account: account(balance, version),
        deposits: { items, next },
        rules: RULES,
        orders,
        withdrawals: [],
        solana: { deposits: false, withdrawals: false },
    };
}

const order = (n: number, state: DepositOrderView["state"] = "sent"): DepositOrderView => ({
    id: oid(n),
    coin: "ethereum:ETH",
    amount: "0.1",
    wallet: "0x00000000000000000000000000000000000000c3",
    usdcOut: "300000000000000000000",
    etaSeconds: 60,
    state,
    sourceTxHashes: [],
    depositId: null,
    createdAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
});

const receipt = (txHash: Hex, deposits: DepositView[], acct: AccountView): DepositReceipt => ({
    txHash,
    deposits,
    account: acct,
});

function run(actions: AccountAction[], from: AccountState = initialAccountState) {
    return actions.reduce(accountReducer, from);
}

function ready(state: AccountState) {
    if (state.status !== "ready") throw new Error(`expected ready, got ${state.status}`);
    return state;
}

const sent = (n: number, usdc: string, sentAt = 1000 + n): AccountAction => ({
    type: "sent",
    txHash: hash(n),
    amount: toWei(usdc),
    sentAt,
});

const open = (balance = "25", version = 1, items: DepositView[] = []) =>
    run([{ type: "connecting" }, { type: "session", session: session(balance, version, items) }]);

test.describe("connecting", () => {
    test("idle becomes connecting, then ready with the session", () => {
        expect(run([{ type: "connecting" }])).toEqual({ status: "connecting" });
        const items = [deposit(2, "5"), deposit(1, "20")];
        const state = ready(open("25", 3, items));
        expect(state.account.version).toBe(3);
        expect(state.deposits).toEqual(items);
        expect(state.pending).toEqual([]);
        expect(state.next).toBeNull();
        expect(state.rules).toEqual(RULES);
    });

    test("the balance is parsed exactly at 18 decimals", () => {
        expect(ready(open("0.000000000000000001")).balance).toBe(BigInt(1));
        expect(ready(open("13540.25")).balance).toBe(BigInt("13540250000000000000000"));
        expect(ready(open("0")).balance).toBe(BigInt(0));
    });

    test("the session keeps the older-page cursor", () => {
        const state = run([{ type: "session", session: session("1", 1, [deposit(1, "1")], "cursor-1") }]);
        expect(ready(state).next).toBe("cursor-1");
    });

    test("a reconnect while ready keeps the ready state", () => {
        const before = open("25", 1, [deposit(1, "25")]);
        expect(accountReducer(before, { type: "connecting" })).toBe(before);
    });

    test("failing before ready is a failed state; after ready it is ignored", () => {
        const error = { code: "unavailable" as const, message: "Nope" };
        expect(run([{ type: "connecting" }, { type: "failed", error }])).toEqual({ status: "failed", error });
        const before = open();
        expect(accountReducer(before, { type: "failed", error })).toBe(before);
    });

    test("a failed state can connect again", () => {
        const error = { code: "unavailable" as const, message: "Nope" };
        const state = run([{ type: "failed", error }, { type: "connecting" }]);
        expect(state).toEqual({ status: "connecting" });
    });

    test("reset goes back to idle from any state", () => {
        expect(run([{ type: "reset" }], open())).toEqual({ status: "idle" });
        expect(run([{ type: "connecting" }, { type: "reset" }])).toEqual({ status: "idle" });
    });

    test("actions before ready are ignored", () => {
        const actions: AccountAction[] = [
            sent(1, "5"),
            { type: "reverted", txHash: hash(1) },
            { type: "older", deposits: [deposit(1, "5")], next: null },
            { type: "credited", deposit: deposit(1, "5"), account: account("5", 2) },
            { type: "settled", receipt: receipt(hash(1), [deposit(1, "5")], account("5", 2)) },
        ];
        for (const action of actions) {
            expect(accountReducer(initialAccountState, action), action.type).toBe(initialAccountState);
            const connecting = accountReducer(initialAccountState, { type: "connecting" });
            expect(accountReducer(connecting, action), action.type).toBe(connecting);
        }
    });
});

test.describe("sending", () => {
    test("a sent deposit is pending, counted in the balance and first in the history", () => {
        const state = run([sent(9, "7.5")], open("25", 1, [deposit(1, "25")]));
        expect(ready(state).pending).toEqual([{ txHash: hash(9), amount: toWei("7.5"), sentAt: 1009 }]);
        expect(ready(state).balance).toBe(toWei("25"));
        expect(optimisticBalance(state)).toBe(toWei("32.5"));
        const rows = historyRows(state);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ key: hash(9), amount: toWei("7.5"), at: new Date(1009), pending: true });
        expect(rows[1].pending).toBe(false);
    });

    test("newer pending deposits go on top", () => {
        const state = run([sent(8, "1"), sent(9, "2")], open());
        expect(ready(state).pending.map((p) => p.txHash)).toEqual([hash(9), hash(8)]);
        expect(optimisticBalance(state)).toBe(toWei("28"));
        expect(historyRows(state).map((r) => r.key)).toEqual([hash(9), hash(8)]);
    });

    test("a duplicate sent for the same hash is ignored", () => {
        const once = run([sent(9, "7.5")], open());
        const twice = accountReducer(once, sent(9, "99", 5000));
        expect(twice).toBe(once);
        expect(optimisticBalance(twice)).toBe(toWei("32.5"));
    });

    test("a sent for a hash that is already credited is ignored", () => {
        const before = open("25", 1, [deposit(1, "25")]);
        const after = accountReducer(before, sent(1, "25"));
        expect(after).toBe(before);
        expect(optimisticBalance(after)).toBe(toWei("25"));
    });

    test("reverted removes only that pending deposit and the balance falls back", () => {
        const state = run([sent(8, "1"), sent(9, "2")], open());
        const reverted = accountReducer(state, { type: "reverted", txHash: hash(9) });
        expect(ready(reverted).pending.map((p) => p.txHash)).toEqual([hash(8)]);
        expect(optimisticBalance(reverted)).toBe(toWei("26"));
        expect(historyRows(reverted).map((r) => r.key)).toEqual([hash(8)]);
    });

    test("reverting an unknown hash changes nothing visible", () => {
        const state = run([sent(8, "1")], open());
        const after = accountReducer(state, { type: "reverted", txHash: hash(77) });
        expect(optimisticBalance(after)).toBe(toWei("26"));
        expect(ready(after).pending).toHaveLength(1);
    });
});

test.describe("settling", () => {
    test("a receipt credits the deposit, removes the pending and takes the account balance", () => {
        const credited = deposit(9, "7.5");
        const state = run(
            [sent(9, "7.5"), { type: "settled", receipt: receipt(hash(9), [credited], account("32.5", 2)) }],
            open("25", 1, [deposit(1, "25")]),
        );
        const s = ready(state);
        expect(s.pending).toEqual([]);
        expect(s.balance).toBe(toWei("32.5"));
        expect(s.account.version).toBe(2);
        expect(s.deposits.map((d) => d.id)).toEqual([oid(9), oid(1)]);
        expect(optimisticBalance(state)).toBe(toWei("32.5"));
    });

    test("the pending is matched to the receipt case-insensitively", () => {
        const lower = `0x${"ab".repeat(32)}` as Hex;
        const upper = `0x${"AB".repeat(32)}` as Hex;
        const credited = deposit(9, "3", { txHash: upper });
        const state = run(
            [
                { type: "sent", txHash: lower, amount: toWei("3"), sentAt: 1 },
                { type: "settled", receipt: receipt(upper, [credited], account("28", 2)) },
            ],
            open(),
        );
        expect(ready(state).pending).toEqual([]);
        expect(optimisticBalance(state)).toBe(toWei("28"));
    });

    test("a receipt leaves other pending deposits alone", () => {
        const state = run(
            [
                sent(8, "1"),
                sent(9, "2"),
                { type: "settled", receipt: receipt(hash(9), [deposit(9, "2")], account("27", 2)) },
            ],
            open(),
        );
        expect(ready(state).pending.map((p) => p.txHash)).toEqual([hash(8)]);
        expect(optimisticBalance(state)).toBe(toWei("28"));
    });

    test("a receipt that credited several logs adds them all", () => {
        const logs = [deposit(9, "1", { logIndex: 0, id: oid(9) }), deposit(9, "2", { logIndex: 1, id: oid(10) })];
        const state = run(
            [sent(9, "3"), { type: "settled", receipt: receipt(hash(9), logs, account("28", 2)) }],
            open(),
        );
        expect(ready(state).deposits.map((d) => d.id)).toEqual([oid(10), oid(9)]);
        expect(ready(state).pending).toEqual([]);
        expect(historyRows(state).map((r) => r.key)).toEqual([`${hash(9)}:1`, `${hash(9)}:0`]);
    });

    test("a settled receipt arriving after the push does not duplicate the deposit", () => {
        const credited = deposit(9, "7.5");
        const state = run(
            [
                sent(9, "7.5"),
                { type: "credited", deposit: credited, account: account("32.5", 2) },
                { type: "settled", receipt: receipt(hash(9), [credited], account("32.5", 2)) },
            ],
            open(),
        );
        expect(ready(state).deposits.filter((d) => d.id === credited.id)).toHaveLength(1);
        expect(ready(state).pending).toEqual([]);
        expect(optimisticBalance(state)).toBe(toWei("32.5"));
    });
});

test.describe("pushes", () => {
    test("a credited push merges by id, newest first", () => {
        const state = run(
            [{ type: "credited", deposit: deposit(0xabc, "4"), account: account("29", 2) }],
            open("25", 1, [deposit(0xf0, "10"), deposit(0x10, "15")]),
        );
        expect(ready(state).deposits.map((d) => d.id)).toEqual([oid(0xabc), oid(0xf0), oid(0x10)]);
        expect(ready(state).balance).toBe(toWei("29"));
    });

    test("an older id slots in below newer ones, hex ids sorted as strings", () => {
        const state = run(
            [{ type: "credited", deposit: deposit(0x2f, "1"), account: account("26", 2) }],
            open("25", 1, [deposit(0xa0, "10"), deposit(0x10, "15")]),
        );
        expect(ready(state).deposits.map((d) => d.id)).toEqual([oid(0xa0), oid(0x2f), oid(0x10)]);
    });

    test("a repeated push is deduped", () => {
        const push: AccountAction = { type: "credited", deposit: deposit(5, "4"), account: account("29", 2) };
        const state = run([push, push, push], open());
        expect(ready(state).deposits).toHaveLength(1);
        expect(optimisticBalance(state)).toBe(toWei("29"));
    });

    test("a credited push settles the matching pending deposit", () => {
        const state = run(
            [sent(5, "4"), { type: "credited", deposit: deposit(5, "4"), account: account("29", 2) }],
            open(),
        );
        expect(ready(state).pending).toEqual([]);
        expect(optimisticBalance(state)).toBe(toWei("29"));
        const rows = historyRows(state);
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe(hash(5));
        expect(rows[0].pending).toBe(false);
    });

    test("an account view with a lower version does not roll the balance back, but its deposit is added", () => {
        const state = run(
            [
                { type: "credited", deposit: deposit(6, "5"), account: account("35", 3) },
                { type: "credited", deposit: deposit(5, "5"), account: account("30", 2) },
            ],
            open("25", 1),
        );
        const s = ready(state);
        expect(s.balance).toBe(toWei("35"));
        expect(s.account.version).toBe(3);
        expect(s.deposits.map((d) => d.id)).toEqual([oid(6), oid(5)]);
    });

    test("a stale receipt still settles the pending and adds its deposits", () => {
        const state = run(
            [
                { type: "credited", deposit: deposit(6, "5"), account: account("35", 3) },
                sent(5, "5"),
                { type: "settled", receipt: receipt(hash(5), [deposit(5, "5")], account("30", 2)) },
            ],
            open("25", 1),
        );
        expect(ready(state).balance).toBe(toWei("35"));
        expect(ready(state).pending).toEqual([]);
        expect(ready(state).deposits).toHaveLength(2);
    });

    test("an equal version is taken", () => {
        const state = run([{ type: "credited", deposit: deposit(5, "5"), account: account("31", 1) }], open("25", 1));
        expect(ready(state).balance).toBe(toWei("31"));
    });
});

test.describe("reconnecting and paging", () => {
    test("a new session keeps pending deposits not yet credited and drops credited ones", () => {
        const before = run([sent(8, "1"), sent(9, "2")], open("25", 1));
        const after = accountReducer(before, {
            type: "session",
            session: session("27", 2, [deposit(9, "2"), deposit(1, "25")]),
        });
        expect(ready(after).pending.map((p) => p.txHash)).toEqual([hash(8)]);
        expect(ready(after).balance).toBe(toWei("27"));
        expect(optimisticBalance(after)).toBe(toWei("28"));
    });

    test("a new session replaces deposits and cursor", () => {
        const before = run(
            [{ type: "older", deposits: [deposit(1, "1")], next: "c2" }],
            run([{ type: "session", session: session("1", 1, [deposit(2, "1")], "c1") }]),
        );
        const after = accountReducer(before, {
            type: "session",
            session: session("5", 2, [deposit(3, "5")], null),
        });
        expect(ready(after).deposits.map((d) => d.id)).toEqual([oid(3)]);
        expect(ready(after).next).toBeNull();
    });

    test("older appends older deposits and sets the cursor", () => {
        const state = run([{ type: "session", session: session("30", 1, [deposit(5, "10"), deposit(4, "10")], "c1") }]);
        const after = accountReducer(state, {
            type: "older",
            deposits: [deposit(3, "5"), deposit(2, "5")],
            next: "c2",
        });
        expect(ready(after).deposits.map((d) => d.id)).toEqual([oid(5), oid(4), oid(3), oid(2)]);
        expect(ready(after).next).toBe("c2");
        expect(ready(after).balance).toBe(toWei("30"));
        const last = accountReducer(after, { type: "older", deposits: [deposit(1, "5")], next: null });
        expect(ready(last).next).toBeNull();
        expect(ready(last).deposits).toHaveLength(5);
    });

    test("older does not duplicate deposits already shown", () => {
        const state = open("10", 1, [deposit(5, "10")]);
        const after = accountReducer(state, { type: "older", deposits: [deposit(5, "10")], next: null });
        expect(ready(after).deposits).toHaveLength(1);
    });
});

test.describe("derived values", () => {
    test("optimisticBalance is null unless ready", () => {
        expect(optimisticBalance({ status: "idle" })).toBeNull();
        expect(optimisticBalance({ status: "connecting" })).toBeNull();
        expect(optimisticBalance({ status: "failed", error: { code: "internal", message: "x" } })).toBeNull();
        expect(optimisticBalance(open("0"))).toBe(BigInt(0));
    });

    test("historyRows is empty unless ready", () => {
        expect(historyRows({ status: "idle" })).toEqual([]);
        expect(historyRows({ status: "connecting" })).toEqual([]);
        expect(historyRows({ status: "failed", error: { code: "internal", message: "x" } })).toEqual([]);
    });

    test("a single-log transaction is keyed by its hash", () => {
        const rows = historyRows(open("5", 1, [deposit(2, "2"), deposit(1, "3")]));
        expect(rows.map((r) => r.key)).toEqual([hash(2), hash(1)]);
        expect(rows.map((r) => r.amount)).toEqual([toWei("2"), toWei("3")]);
        expect(rows[0].at).toEqual(new Date(deposit(2, "2").creditedAt));
        expect(rows.every((r) => !r.pending)).toBe(true);
    });

    test("a multi-log transaction is keyed by hash and log index", () => {
        const items = [
            deposit(3, "1", { id: oid(4), txHash: hash(3), logIndex: 7 }),
            deposit(3, "2", { id: oid(3), txHash: hash(3), logIndex: 2 }),
            deposit(1, "3"),
        ];
        expect(historyRows(open("6", 1, items)).map((r) => r.key)).toEqual([`${hash(3)}:7`, `${hash(3)}:2`, hash(1)]);
    });

    test("toWei and toUsdc round trip", () => {
        expect(toWei("1")).toBe(BigInt(10) ** BigInt(18));
        expect(toWei("0.01")).toBe(BigInt(10) ** BigInt(16));
        expect(toWei("1.000000000000000001")).toBe(BigInt(10) ** BigInt(18) + BigInt(1));
        expect(toUsdc(toWei("12480.52"))).toBe(12480.52);
        expect(toUsdc(BigInt(0))).toBe(0);
        expect(toUsdc(toWei("0.5"))).toBe(0.5);
    });
});

test.describe("bridged deposits", () => {
    test("an order upserts by id, newest first", () => {
        const state = run(
            [
                { type: "order", order: order(1) },
                { type: "order", order: order(2) },
                { type: "order", order: order(1, "bridging") },
            ],
            open(),
        );
        expect(ready(state).orders.map((o) => [o.id, o.state])).toEqual([
            [oid(2), "sent"],
            [oid(1), "bridging"],
        ]);
    });

    test("an older version of an order does not move it back", () => {
        const late = { ...order(1, "sent"), updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, 1)).toISOString() };
        const newer = { ...order(1, "bridging"), updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, 5)).toISOString() };
        const state = run(
            [
                { type: "order", order: newer },
                { type: "order", order: late },
            ],
            open(),
        );
        expect(ready(state).orders.map((o) => o.state)).toEqual(["bridging"]);
    });

    test("an expired order leaves the list", () => {
        const state = run(
            [
                { type: "order", order: order(1) },
                { type: "order", order: order(1, "expired") },
            ],
            open(),
        );
        expect(ready(state).orders).toEqual([]);
    });

    test("the session restores open orders", () => {
        const state = run([{ type: "session", session: session("1", 1, [], null, [order(1), order(2)]) }]);
        expect(ready(state).orders.map((o) => o.id)).toEqual([oid(2), oid(1)]);
    });

    test("a delivered order gives the credited deposit its origin", () => {
        const delivered = { ...order(1, "delivered"), depositId: oid(5), sourceTxHashes: [hash(8), hash(9)] };
        const state = run([{ type: "order", order: delivered }], open("300", 1, [deposit(5, "300")]));
        expect(historyRows(state).map((r) => r.origin)).toEqual([
            { coin: "ethereum:ETH", amount: "0.1", txHash: hash(9) },
        ]);
    });

    test("a deposit credited after its order was delivered still gets the origin", () => {
        const delivered = { ...order(1, "delivered"), depositId: oid(5), sourceTxHashes: [hash(9)] };
        const state = run(
            [
                { type: "order", order: delivered },
                { type: "credited", deposit: deposit(5, "300"), account: account("300", 2) },
            ],
            open("0", 1),
        );
        expect(historyRows(state).map((r) => r.origin?.txHash)).toEqual([hash(9)]);
    });

    test("a delivered order leaves a deposit that already has an origin alone", () => {
        const origin = { coin: "bnb:BNB", amount: "1", txHash: hash(7) };
        const delivered = { ...order(1, "delivered"), depositId: oid(5), sourceTxHashes: [hash(9)] };
        const state = run([{ type: "order", order: delivered }], open("300", 1, [deposit(5, "300", { origin })]));
        expect(historyRows(state).map((r) => r.origin)).toEqual([origin]);
    });

    test("a bridged deposit's history row keeps its origin", () => {
        const origin = { coin: "ethereum:ETH", amount: "0.1", txHash: hash(7) };
        const rows = historyRows(open("300", 1, [deposit(2, "5"), deposit(1, "300", { origin })]));
        expect(rows.map((r) => r.origin)).toEqual([undefined, origin]);
    });
});

const withdrawal = (n: number, over: Partial<WithdrawalView> = {}): WithdrawalView => ({
    id: oid(n),
    requestId: `req-${n}`,
    amount: "10",
    to: "0x00000000000000000000000000000000000000d4",
    network: "arc",
    fee: null,
    receive: null,
    state: "sending",
    txHash: null,
    forwardTxHash: null,
    delayed: false,
    createdAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    ...over,
});

const pendingWithdrawal = (n: number, usdc = "10"): AccountAction => ({
    type: "withdraw",
    withdrawal: {
        requestId: `req-${n}`,
        amount: toWei(usdc),
        to: "0x00000000000000000000000000000000000000d4",
        at: 1000 + n,
    },
});

test.describe("withdrawals", () => {
    test("a withdrawal upserts by id and ignores a stale update", () => {
        const sending = withdrawal(1);
        const sentView = withdrawal(1, { state: "sent", updatedAt: new Date(Date.UTC(2026, 8, 2)).toISOString() });
        let state = run([{ type: "withdrawal", withdrawal: sending, account: account("15", 2) }], open());
        expect(ready(state).withdrawals).toEqual([sending]);
        state = run(
            [
                { type: "withdrawal", withdrawal: withdrawal(2), account: account("15", 2) },
                { type: "withdrawal", withdrawal: sentView, account: account("15", 2) },
            ],
            state,
        );
        expect(ready(state).withdrawals.map((w) => [w.id, w.state])).toEqual([
            [oid(2), "sending"],
            [oid(1), "sent"],
        ]);
        state = run([{ type: "withdrawal", withdrawal: sending, account: account("15", 2) }], state);
        expect(ready(state).withdrawals.find((w) => w.id === oid(1))?.state).toBe("sent");
    });

    test("a pending withdrawal lowers the balance until the server's view arrives", () => {
        let state = run([pendingWithdrawal(1, "10")], open("25", 1));
        expect(optimisticBalance(state)).toBe(toWei("15"));
        state = run([{ type: "withdrawal", withdrawal: withdrawal(1), account: account("15", 2) }], state);
        expect(ready(state).pendingWithdrawals).toEqual([]);
        // The view brings the debited account: counted once
        expect(optimisticBalance(state)).toBe(toWei("15"));
    });

    test("a sent withdrawal keeps the debit without a newer account", () => {
        let state = run([pendingWithdrawal(1, "10")], open("25", 1));
        state = run([{ type: "withdrawal", withdrawal: withdrawal(1), account: account("15", 2) }], state);
        state = run(
            [
                {
                    type: "withdrawal",
                    withdrawal: withdrawal(1, { state: "sent", updatedAt: "2026-09-03T00:00:00.000Z" }),
                    account: account("15", 2),
                },
            ],
            state,
        );
        expect(optimisticBalance(state)).toBe(toWei("15"));
    });

    test("a failed withdrawal's refund shows even after later account events", () => {
        let state = run([pendingWithdrawal(1, "10")], open("25", 1));
        state = run([{ type: "withdrawal", withdrawal: withdrawal(1), account: account("15", 2) }], state);
        state = run([{ type: "credited", deposit: deposit(5, "1"), account: account("16", 3) }], state);
        state = run(
            [
                {
                    type: "withdrawal",
                    withdrawal: withdrawal(1, { state: "failed", updatedAt: "2026-09-03T00:00:00.000Z" }),
                    account: account("26", 4),
                },
            ],
            state,
        );
        expect(optimisticBalance(state)).toBe(toWei("26"));
    });

    test("a refused withdrawal leaves the pending list", () => {
        const state = run([pendingWithdrawal(1), { type: "withdraw-refused", requestId: "req-1" }], open("25", 1));
        expect(ready(state).pendingWithdrawals).toEqual([]);
        expect(optimisticBalance(state)).toBe(toWei("25"));
    });

    test("a failed withdrawal doesn't lower the balance", () => {
        const failed = withdrawal(1, { state: "failed" });
        const state = run(
            [pendingWithdrawal(1), { type: "withdrawal", withdrawal: failed, account: account("25", 2) }],
            open("25", 1),
        );
        expect(optimisticBalance(state)).toBe(toWei("25"));
    });

    test("the session restores withdrawals", () => {
        const views = [withdrawal(2), withdrawal(1, { state: "sent" })];
        const state = run([{ type: "session", session: { ...session("20", 4), withdrawals: views } }]);
        expect(ready(state).withdrawals).toEqual(views);
        // The session's balance already has them taken
        expect(optimisticBalance(state)).toBe(toWei("20"));
    });

    test("a session keeps a pending withdrawal the server doesn't have yet", () => {
        let state = run([pendingWithdrawal(1), pendingWithdrawal(2)], open("25", 1));
        state = run([{ type: "session", session: { ...session("15", 2), withdrawals: [withdrawal(1)] } }], state);
        expect(ready(state).pendingWithdrawals.map((p) => p.requestId)).toEqual(["req-2"]);
    });
});

test.describe("optimistic perps", () => {
    const pendingPosition = {
        id: "pending:req-p",
        asset: "BTC",
        side: "long" as const,
        leverage: 5,
        sizeCoin: "0.0076",
        entryPx: "66000",
        collateralUSD: "100",
        liquidationPx: "53000",
        markPx: null,
        unrealizedPnlUSD: "0",
        cumFundingUSD: "0",
        state: "open" as const,
        proceedsUSD: null,
        notice: null,
        openedAt: new Date(Date.UTC(2026, 9, 14)).toISOString(),
        settledAt: null,
        updatedAt: new Date(Date.UTC(2026, 9, 14)).toISOString(),
    };
    const accepted: AccountAction = {
        type: "perpAccepted",
        requestId: "req-p",
        position: pendingPosition,
        collateralWei: toWei("100"),
        connection: 1,
    };
    const placing = {
        id: oid(7),
        requestId: "req-p",
        kind: "open" as const,
        asset: "BTC",
        side: "long" as const,
        leverage: 5,
        state: "placing",
        reason: null,
        positionId: null,
        filledSizeCoin: null,
        requestedSizeCoin: "0.0076",
        collateralUSD: "100",
        creditedUSD: null,
        createdAt: new Date(Date.UTC(2026, 9, 14)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 9, 14)).toISOString(),
    };

    test("optimisticBalance counts a pending perp open once, and not again after the server's account arrives", () => {
        const pending = run([accepted], open("300", 1));
        expect(optimisticBalance(pending)).toBe(toWei("200"));
        const held = run(
            [{ type: "perp", update: { order: placing, position: null, account: account("200", 2) } }],
            pending,
        );
        expect(optimisticBalance(held)).toBe(toWei("200"));
        // The pending position stays until the fill replaces it.
        expect(held.status === "ready" && held.perps.positions.map((p) => p.id)).toEqual(["pending:req-p"]);
    });
});
