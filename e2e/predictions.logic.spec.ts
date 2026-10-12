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
});
