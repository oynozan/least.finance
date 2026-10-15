import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server } from "socket.io";
import { AccountClient } from "@/components/account-client";
import { withdrawalEntries, withdrawalProgress } from "@/components/history-entries";
import {
    accountReducer,
    initialAccountState,
    type AccountAction,
    type ApiError,
    type Hex,
    type WithdrawalView,
} from "@/lib/account/state";
import {
    floorFor,
    pickerRows,
    quoteLines,
    showsConnect,
    WithdrawQuoter,
    type WithdrawWallet,
} from "@/lib/account/withdraw-form";
import type { WithdrawQuote } from "@/server/src/protocol";

const EVM: WithdrawWallet = { kind: "evm", address: "0x00000000000000000000000000000000000000d4" };
const EVM_2: WithdrawWallet = { kind: "evm", address: "0x00000000000000000000000000000000000000e5" };
const SOLANA: WithdrawWallet = { kind: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" };
const oid = (n: number) => n.toString(16).padStart(24, "0");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe("the wallet picker", () => {
    test("the picker lists every linked wallet with its network and short address, default the wallet in use", () => {
        const rows = pickerRows([EVM, SOLANA, EVM_2], SOLANA.address, null);
        expect(rows.map((r) => [r.network, r.short, r.checked])).toEqual([
            ["Arc", "0x0000…00d4", false],
            ["Solana", "7xKXtg…gAsU", true],
            ["Arc", "0x0000…00e5", false],
        ]);
        // A pick wins over the wallet in use, whatever the casing of an Ethereum address.
        expect(
            pickerRows([EVM, SOLANA], SOLANA.address, EVM.address.toUpperCase().replace("0X", "0x")).map(
                (r) => r.checked,
            ),
        ).toEqual([true, false]);
        // With no wallet in use, the first one is picked.
        expect(pickerRows([EVM, SOLANA], undefined, null).map((r) => r.checked)).toEqual([true, false]);
    });

    test("'Connect an EVM wallet' shows only with no wallet of either kind", () => {
        expect(showsConnect([])).toBe(true);
        expect(showsConnect([EVM])).toBe(false);
        expect(showsConnect([SOLANA])).toBe(false);
    });

    test("the Solana minimum of 1 replaces the floor for that wallet", () => {
        expect(floorFor("solana", 5)).toBe(1);
        expect(floorFor("solana", null)).toBe(1);
        expect(floorFor("evm", 5)).toBe(5);
        expect(floorFor(undefined, null)).toBeNull();
    });
});

const QUOTE: WithdrawQuote = { fee: "0.127", receive: "9.873", setup: false, setupFee: null };

test.describe("the quote line", () => {
    test("shows 'Fee 0.13 USDC · you receive 9.87 USDC'", () => {
        expect(quoteLines(QUOTE)).toEqual({ fee: "Fee 0.13 USDC · you receive 9.87 USDC", setup: null });
    });

    test("setup shows 'Includes 0.16 USDC to set up your USDC account.'", () => {
        const lines = quoteLines({ fee: "0.286", receive: "9.714", setup: true, setupFee: "0.159" });
        expect(lines.setup).toBe("Includes 0.16 USDC to set up your USDC account.");
        expect(lines.fee).toBe("Fee 0.29 USDC · you receive 9.71 USDC");
    });

    test("picking Solana asks withdraw:quote debounced and shows the line", async () => {
        const asked: [string, string][] = [];
        const quoter = new WithdrawQuoter(async (amount, to) => {
            asked.push([amount, to]);
            return QUOTE;
        }, 30);
        quoter.request({ amount: "1", to: SOLANA.address });
        quoter.request({ amount: "10", to: SOLANA.address });
        expect(quoter.getSnapshot().status).toBe("loading");
        await wait(10);
        expect(asked).toEqual([]);
        await wait(60);
        expect(asked).toEqual([["10", SOLANA.address]]);
        const state = quoter.getSnapshot();
        expect(state.status === "ready" && quoteLines(state.quote).fee).toBe("Fee 0.13 USDC · you receive 9.87 USDC");
        expect(quoter.reviewedFee()).toBe("0.127");
        // An Arc wallet, or no amount, asks nothing and clears the line.
        quoter.request(null);
        await wait(60);
        expect(asked).toHaveLength(1);
        expect(quoter.reviewedFee()).toBeNull();
    });

    test("an answer for an amount the person has since changed is dropped", async () => {
        let release: (quote: WithdrawQuote) => void = () => undefined;
        const quoter = new WithdrawQuoter(() => new Promise<WithdrawQuote>((resolve) => (release = resolve)), 0);
        quoter.request({ amount: "10", to: SOLANA.address });
        await wait(10);
        quoter.request(null);
        release(QUOTE);
        await wait(10);
        expect(quoter.getSnapshot().status).toBe("idle");
    });

    test("a refused quote shows the server's message and no fee to send", async () => {
        const error: ApiError = { code: "bad_request", message: "That address can't receive USDC." };
        const quoter = new WithdrawQuoter(async () => error, 0);
        quoter.request({ amount: "10", to: SOLANA.address });
        await wait(20);
        expect(quoter.getSnapshot()).toEqual({ status: "error", message: error.message });
        expect(quoter.reviewedFee()).toBeNull();
    });
});

/** A socket.io server that opens the account and answers withdrawals as the test scripts. */
async function fakeServer(create: (payload: Record<string, unknown>) => unknown) {
    const http = createServer();
    const io = new Server(http);
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    io.on("connection", (socket) => {
        socket.onAny((name, payload) => events.push({ name, payload }));
        socket.on("account:open", (_p, ack) =>
            ack({
                ok: true,
                data: {
                    account: {
                        depositAddress: "0x00000000000000000000000000000000000000b2",
                        balance: "50",
                        version: 1,
                    },
                    deposits: { items: [], next: null },
                    rules: { chainId: 5042, minDeposit: "0.01" },
                    orders: [],
                    withdrawals: [],
                    solana: { deposits: true, withdrawals: true },
                    holdings: [],
                },
            }),
        );
        socket.on("withdraw:quote", (_p, ack) => ack({ ok: true, data: { ...QUOTE, setup: true, setupFee: "0.159" } }));
        socket.on("withdraw:create", (payload, ack) => ack(create(payload)));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    client.connect("user", async () => "token");
    await expect.poll(() => client.getSnapshot().state.status).toBe("ready");
    return {
        client,
        events,
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

test.describe("the client", () => {
    test("withdrawQuote asks withdraw:quote and returns the quote", async () => {
        const stack = await fakeServer(() => ({ ok: false, error: { code: "unavailable", message: "x" } }));
        try {
            expect(await stack.client.withdrawQuote("10", SOLANA.address)).toEqual({
                ...QUOTE,
                setup: true,
                setupFee: "0.159",
            });
            expect(stack.events.find((e) => e.name === "withdraw:quote")?.payload).toEqual({
                amount: "10",
                to: SOLANA.address,
            });
        } finally {
            await stack.stop();
        }
    });

    test("quote_changed sends nothing more until Withdraw is pressed again, and carries the fee last shown", async () => {
        let changed = true;
        const stack = await fakeServer(() =>
            changed
                ? {
                      ok: false,
                      error: {
                          code: "quote_changed",
                          message: "The fee is now 0.4 USDC and you'd receive 9.6 USDC. Nothing was taken.",
                      },
                  }
                : { ok: false, error: { code: "unavailable", message: "stop" } },
        );
        try {
            expect(await stack.client.withdraw("10", SOLANA.address, "0.127")).toBe("changed");
            // The refusal is not a notice, and the pending withdrawal is gone.
            expect(stack.client.getSnapshot().notice).toBeNull();
            const state = stack.client.getSnapshot().state;
            expect(state.status === "ready" && state.pendingWithdrawals).toEqual([]);
            await wait(100);
            expect(stack.events.filter((e) => e.name === "withdraw:create")).toHaveLength(1);
            expect(stack.events.find((e) => e.name === "withdraw:create")?.payload).toMatchObject({
                to: SOLANA.address,
                reviewedFee: "0.127",
            });
            changed = false;
            expect(await stack.client.withdraw("10", SOLANA.address, "0.4")).toBe("refused");
            expect(stack.events.filter((e) => e.name === "withdraw:create")).toHaveLength(2);
        } finally {
            await stack.stop();
        }
    });

    test("an Arc withdrawal carries no reviewed fee", async () => {
        const stack = await fakeServer(() => ({ ok: false, error: { code: "unavailable", message: "x" } }));
        try {
            await stack.client.withdraw("10", EVM.address);
            expect(stack.events.find((e) => e.name === "withdraw:create")?.payload).not.toHaveProperty("reviewedFee");
        } finally {
            await stack.stop();
        }
    });
});

const view = (over: Partial<WithdrawalView> = {}): WithdrawalView => ({
    id: oid(1),
    requestId: "req-1",
    amount: "10",
    to: SOLANA.address,
    network: "solana",
    fee: "0.127",
    receive: "9.873",
    state: "sending",
    txHash: null,
    forwardTxHash: null,
    delayed: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
});

const push = (withdrawal: WithdrawalView): AccountAction => ({
    type: "withdrawal",
    withdrawal,
    account: { depositAddress: "0x00000000000000000000000000000000000000b2" as Hex, balance: "40", version: 2 },
});

test.describe("history", () => {
    test("reads Sending, 'Sending to Solana' for forwarding, then Sent, and an old push can't undo a newer one", () => {
        const at = (n: number) => `2026-09-01T00:00:0${n}.000Z`;
        let state = [{ type: "connecting" } as AccountAction].reduce(accountReducer, initialAccountState);
        state = accountReducer(state, {
            type: "session",
            session: {
                account: {
                    depositAddress: "0x00000000000000000000000000000000000000b2" as Hex,
                    balance: "50",
                    version: 1,
                },
                deposits: { items: [], next: null },
                rules: { chainId: 5042, minDeposit: "0.01" },
                orders: [],
                withdrawals: [],
                solana: { deposits: true, withdrawals: true },
                holdings: [],
            },
        });
        const label = () => {
            if (state.status !== "ready") throw new Error("not ready");
            const [entry] = withdrawalEntries(state.withdrawals, state.pendingWithdrawals);
            return entry ? withdrawalProgress(entry) : undefined;
        };
        state = accountReducer(state, push(view({ updatedAt: at(1) })));
        expect(label()).toBe("Sending");
        state = accountReducer(state, push(view({ state: "forwarding", updatedAt: at(2) })));
        expect(label()).toBe("Sending to Solana");
        // An older "sending" arriving late changes nothing.
        state = accountReducer(state, push(view({ state: "sending", updatedAt: at(1) })));
        expect(label()).toBe("Sending to Solana");
        state = accountReducer(state, push(view({ state: "forwarding", delayed: true, updatedAt: at(3) })));
        expect(label()).toBe("Taking longer than expected");
        state = accountReducer(state, push(view({ state: "sent", forwardTxHash: "sig", updatedAt: at(4) })));
        expect(label()).toBeNull();
        state = accountReducer(state, push(view({ state: "forwarding", updatedAt: at(2) })));
        expect(label()).toBeNull();
        expect(state.status === "ready" && state.withdrawals.map((w) => w.state)).toEqual(["sent"]);
    });
});
