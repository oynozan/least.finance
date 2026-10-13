import { expect, test } from "@playwright/test";
import {
    accountReducer,
    initialAccountState,
    optimisticBalance,
    toWei,
    type AccountAction,
    type AccountState,
    type AccountView,
    type Hex,
    type PositionView,
    type PredictionOrderView,
    type WalletSession,
} from "@/lib/account/state";
import { livePredictionRows, positionDetail } from "@/components/wallet-data";

const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000b2" as Hex;
const RULES = { chainId: 5042, minDeposit: "0.01" };
const REQ_A = "11111111-1111-4111-8111-111111111111";
const REQ_B = "22222222-2222-4222-8222-222222222222";

const account = (balance: string, version: number): AccountView => ({
    depositAddress: DEPOSIT_ADDRESS,
    balance,
    version,
});

const session = (balance: string, version: number): WalletSession => ({
    account: account(balance, version),
    deposits: { items: [], next: null },
    rules: RULES,
    orders: [],
    withdrawals: [],
});

const at = (n: number) => new Date(Date.UTC(2026, 9, 12, 0, 0, n)).toISOString();

const order = (requestId: string, over: Partial<PredictionOrderView> = {}): PredictionOrderView => ({
    id: `order-${requestId.slice(0, 4)}`,
    requestId,
    side: "buy",
    state: "filled",
    reason: null,
    eventId: "ev1",
    tokenId: "tok1",
    question: "Will it rain?",
    outcome: "Yes",
    amountUSD: "10",
    shares: "20",
    positionId: "pos1",
    createdAt: at(1),
    updatedAt: at(1),
    ...over,
});

const position = (over: Partial<PositionView> = {}): PositionView => ({
    id: "pos1",
    eventId: "ev1",
    marketId: "m1",
    tokenId: "tok1",
    question: "Will it rain?",
    outcome: "Yes",
    shares: "20",
    costUSD: "10",
    state: "open",
    proceedsUSD: null,
    payoutUSD: null,
    openedAt: at(1),
    settledAt: null,
    updatedAt: at(1),
    ...over,
});

const predict = (requestId: string, usdc: string, connection = 1): AccountAction => ({
    type: "predict",
    trade: {
        requestId,
        side: "buy",
        eventId: "ev1",
        tokenId: "tok1",
        question: "Will it rain?",
        outcome: "Yes",
        amountWei: toWei(usdc),
        shares: "20",
        at: 1000,
        connection,
    },
});

const run = (actions: AccountAction[], from: AccountState = initialAccountState) =>
    actions.reduce(accountReducer, from);

function ready(state: AccountState) {
    if (state.status !== "ready") throw new Error(`expected ready, got ${state.status}`);
    return state;
}

const open = (balance = "100", version = 1) =>
    run([{ type: "connecting" }, { type: "session", session: session(balance, version) }]);

const usdc = (state: AccountState) => optimisticBalance(state);

test.describe("optimistic predictions", () => {
    test("an accepted prediction lowers the balance at once", () => {
        const state = run([predict(REQ_A, "10")], open("100"));
        expect(usdc(state)).toBe(toWei("90"));
        expect(ready(state).optimistic).toHaveLength(1);
    });

    test("the server's filled update replaces it without lowering twice", () => {
        const state = run(
            [
                predict(REQ_A, "10"),
                {
                    type: "prediction",
                    update: { requestId: REQ_A, order: order(REQ_A), position: position(), account: account("90", 2) },
                },
            ],
            open("100"),
        );
        expect(usdc(state)).toBe(toWei("90"));
        const r = ready(state);
        expect(r.optimistic).toEqual([]);
        expect(r.predictions.orders.map((o) => o.id)).toEqual([order(REQ_A).id]);
        expect(r.predictions.positions.map((p) => p.id)).toEqual(["pos1"]);
    });

    test("a failed update restores the balance", () => {
        const state = run(
            [
                predict(REQ_A, "10"),
                {
                    type: "prediction",
                    update: {
                        requestId: REQ_A,
                        order: order(REQ_A, { state: "failed", reason: "price_moved", positionId: null }),
                        position: null,
                        account: account("100", 3),
                    },
                },
            ],
            open("100"),
        );
        expect(usdc(state)).toBe(toWei("100"));
        expect(ready(state).optimistic).toEqual([]);
    });

    test("a rejected request drops its entry", () => {
        const state = run(
            [predict(REQ_A, "10"), predict(REQ_B, "5"), { type: "predict-failed", requestId: REQ_A }],
            open("100"),
        );
        expect(ready(state).optimistic.map((t) => t.requestId)).toEqual([REQ_B]);
        expect(usdc(state)).toBe(toWei("95"));
    });

    test("a positions push after a reload keeps the in-flight order and doesn't double-count", () => {
        const placing = order(REQ_A, { state: "placing", positionId: null, shares: null });
        const state = run(
            [
                predict(REQ_A, "10"),
                predict(REQ_B, "5"),
                // the server already debited A; B is still on its way
                { type: "session", session: session("90", 2) },
                { type: "positions", connection: 1, positions: { positions: [], orders: [placing] } },
            ],
            open("100"),
        );
        expect(ready(state).optimistic.map((t) => t.requestId)).toEqual([REQ_B]);
        expect(usdc(state)).toBe(toWei("85"));
    });

    test("a positions push on a later connection drops a trade the server never got", () => {
        const placing = order(REQ_B, { state: "placing", positionId: null, shares: null });
        const state = run(
            [
                predict(REQ_A, "10", 1),
                predict(REQ_B, "5", 2),
                { type: "session", session: session("100", 1) },
                { type: "positions", connection: 2, positions: { positions: [], orders: [] } },
            ],
            open("100"),
        );
        expect(ready(state).optimistic.map((t) => t.requestId)).toEqual([REQ_B]);
        expect(usdc(state)).toBe(toWei("95"));
        const later = run(
            [{ type: "positions", connection: 2, positions: { positions: [], orders: [placing] } }],
            state,
        );
        expect(ready(later).optimistic).toEqual([]);
    });

    test("an older order update is ignored", () => {
        const newer = order(REQ_A, { updatedAt: at(5) });
        const state = run(
            [
                {
                    type: "prediction",
                    update: { requestId: REQ_A, order: newer, position: position(), account: account("90", 2) },
                },
                {
                    type: "prediction",
                    update: {
                        requestId: REQ_A,
                        order: order(REQ_A, { state: "posted", updatedAt: at(2) }),
                        position: null,
                        account: account("90", 2),
                    },
                },
            ],
            open("100"),
        );
        expect(ready(state).predictions.orders).toEqual([newer]);
    });

    test("session keeps optimistic trades", () => {
        const state = run([predict(REQ_A, "10"), { type: "session", session: session("100", 1) }], open("100"));
        expect(ready(state).optimistic.map((t) => t.requestId)).toEqual([REQ_A]);
        expect(usdc(state)).toBe(toWei("90"));
    });

    test("the ack takes the server's debit, so an earlier push doesn't leave it counted twice", () => {
        const placing = order(REQ_A, { state: "placing", positionId: null, shares: null });
        const state = run(
            [
                predict(REQ_A, "10"),
                // a push that already carries the debit lands before the ack
                { type: "session", session: session("90", 2) },
                { type: "placed", order: placing, account: account("90", 2) },
            ],
            open("100"),
        );
        expect(usdc(state)).toBe(toWei("90"));
        const r = ready(state);
        expect(r.optimistic).toEqual([]);
        expect(r.predictions.orders.map((o) => o.id)).toEqual([placing.id]);
        expect(r.predictions.orders[0]!.shares).toBe("20");
    });

    test("an ack that follows the settling push doesn't bring the order back to placing", () => {
        const filled = order(REQ_A, { updatedAt: at(5) });
        const state = run(
            [
                predict(REQ_A, "10"),
                {
                    type: "prediction",
                    update: { requestId: REQ_A, order: filled, position: position(), account: account("90", 3) },
                },
                {
                    type: "placed",
                    order: order(REQ_A, { state: "placing", positionId: null, updatedAt: at(1) }),
                    account: account("90", 2),
                },
            ],
            open("100"),
        );
        expect(ready(state).predictions.orders).toEqual([filled]);
        expect(usdc(state)).toBe(toWei("90"));
    });

    test("a snapshot older than a settling push keeps the settled order and its position", () => {
        const filled = order(REQ_A, { updatedAt: at(5) });
        const stale = order(REQ_A, { state: "posted", positionId: null, shares: null, updatedAt: at(2) });
        const state = run(
            [
                {
                    type: "prediction",
                    update: {
                        requestId: REQ_A,
                        order: filled,
                        position: position({ updatedAt: at(5) }),
                        account: account("90", 2),
                    },
                },
                { type: "positions", connection: 1, positions: { positions: [], orders: [stale] } },
            ],
            open("100"),
        );
        const r = ready(state);
        expect(r.predictions.orders).toEqual([filled]);
        expect(r.predictions.positions.map((p) => p.id)).toEqual(["pos1"]);
    });
});

const sell = (requestId: string, usdc: string, connection = 1): AccountAction => ({
    type: "predict",
    trade: { requestId, side: "sell", positionId: "pos1", proceedsWei: toWei(usdc), at: 1000, connection },
});

const withPosition = (balance = "90") =>
    run([{ type: "positions", connection: 1, positions: { positions: [position()], orders: [] } }], open(balance, 2));

test.describe("optimistic sells", () => {
    test("a pending sell raises the balance and hides the position; a failure restores both", () => {
        const state = run([sell(REQ_B, "12")], withPosition("90"));
        expect(usdc(state)).toBe(toWei("102"));
        expect(livePredictionRows(ready(state).predictions, ready(state).optimistic)).toEqual([]);

        const failed = run([{ type: "predict-failed", requestId: REQ_B }], state);
        expect(usdc(failed)).toBe(toWei("90"));
        expect(livePredictionRows(ready(failed).predictions, ready(failed).optimistic)).toHaveLength(1);

        // The server's failed update puts the position back and takes the entry away
        const refused = run(
            [
                {
                    type: "prediction",
                    update: {
                        requestId: REQ_B,
                        order: order(REQ_B, { side: "sell", state: "failed", reason: "price_moved" }),
                        position: position({ updatedAt: at(3) }),
                        account: account("90", 3),
                    },
                },
            ],
            state,
        );
        expect(usdc(refused)).toBe(toWei("90"));
        expect(ready(refused).optimistic).toEqual([]);
    });

    test("a sell the server is still working on keeps counting until it fills", () => {
        const working = order(REQ_B, { side: "sell", state: "placing", positionId: "pos1" });
        const state = run(
            [sell(REQ_B, "12"), { type: "positions", connection: 1, positions: { positions: [], orders: [working] } }],
            withPosition("90"),
        );
        expect(usdc(state)).toBe(toWei("102"));
        const filled = run(
            [
                {
                    type: "prediction",
                    update: {
                        requestId: REQ_B,
                        order: order(REQ_B, { side: "sell", state: "filled", updatedAt: at(4) }),
                        position: position({ state: "closed", proceedsUSD: "12", updatedAt: at(4) }),
                        account: account("102", 3),
                    },
                },
            ],
            state,
        );
        expect(usdc(filled)).toBe(toWei("102"));
    });

    test("position:settled applies the payout balance once", () => {
        const won = position({ state: "won", payoutUSD: "20", settledAt: at(9), updatedAt: at(9) });
        const settled: AccountAction = { type: "position-settled", position: won, account: account("110", 3) };
        const once = run([settled], withPosition("90"));
        const twice = run([settled], once);
        expect(usdc(once)).toBe(toWei("110"));
        expect(usdc(twice)).toBe(toWei("110"));
        expect(ready(twice).predictions.positions).toEqual([won]);
    });
});

test.describe("live prediction rows", () => {
    const view = (positions: PositionView[]) => livePredictionRows({ positions, orders: [] }, []);

    test("a buy restored by a reload shows no shares rather than the amount", () => {
        const placing = order(REQ_A, { state: "placing", positionId: null, shares: null });
        const [row] = livePredictionRows({ positions: [], orders: [placing] }, []);
        expect(row!.shares).toBe("");
        expect(positionDetail(row!)).toBe("Yes");
    });

    test("two buys still waiting for their fills show no shares rather than 0", () => {
        const a = order(REQ_A, { state: "placing", positionId: null, shares: null });
        const b = order(REQ_B, { id: "order-b", state: "posted", positionId: null, shares: null });
        const rows = livePredictionRows({ positions: [], orders: [a, b] }, []);
        expect(rows).toHaveLength(1);
        expect([rows[0]!.shares, rows[0]!.size]).toEqual(["", 20]);
    });

    test("won and lost positions of the last 7 days are settled rows; older and sold ones are gone", () => {
        const now = Date.parse(at(0)) + 3 * 86_400_000;
        const rows = livePredictionRows(
            {
                positions: [
                    position({ id: "w", state: "won", payoutUSD: "20", settledAt: at(0) }),
                    position({ id: "l", tokenId: "t2", state: "lost", settledAt: at(0) }),
                    position({
                        id: "old",
                        tokenId: "t3",
                        state: "won",
                        payoutUSD: "5",
                        settledAt: "2026-09-01T00:00:00.000Z",
                    }),
                    position({ id: "c", tokenId: "t4", state: "closed", settledAt: at(0) }),
                ],
                orders: [],
            },
            [],
            now,
        );
        expect(rows.map((r) => [r.id, r.status, r.payout])).toEqual([
            ["w", "won", 20],
            ["l", "lost", 0],
        ]);
        expect(view([position()])[0]!.status).toBe("open");
    });
});
