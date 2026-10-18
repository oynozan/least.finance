import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server, type Socket } from "socket.io";
import { AccountClient, type WalletProvider } from "@/components/account-client";
import { optimisticBalance, toWei, type ApiError } from "@/lib/account/state";

const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000b2";
const HASH = `0x${"ab".repeat(32)}`;
const EVM = "0x00000000000000000000000000000000000000d4";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const account = (balance: string, version: number) => ({ depositAddress: DEPOSIT_ADDRESS, balance, version });

const session = () => ({
    account: account("50", 1),
    deposits: { items: [], next: null },
    rules: { chainId: 5042, minDeposit: "0.01" },
    orders: [],
    withdrawals: [],
    solana: { deposits: false, withdrawals: false },
    holdings: [],
});

/** What the server answers when a 10 USDC deposit is credited */
const receipt = (txHash: string) => ({
    txHash,
    deposits: [
        {
            id: "000000000000000000000001",
            txHash,
            logIndex: 0,
            from: "0x00000000000000000000000000000000000000c3",
            amount: "10",
            blockNumber: 101,
            creditedAt: "2026-10-16T00:00:00.000Z",
        },
    ],
    account: account("60", 2),
});

const wallet = {
    from: "0x00000000000000000000000000000000000000c3",
    provider: { request: async () => HASH } as WalletProvider,
};

type Link = { bound: boolean };

/** A socket.io server that opens the account as ours does and lets the test script the rest */
async function fakeServer(script: (socket: Socket, link: Link) => void = () => undefined) {
    const http = createServer();
    const io = new Server(http);
    const log: { name: string; bound: boolean }[] = [];
    const held: (() => void)[] = [];
    let holding = false;
    // A held server leaves new connections waiting, so a test can keep the client unbound
    io.use((_socket, next) => (holding ? held.push(next) : next()));
    io.on("connection", (socket) => {
        const link: Link = { bound: false };
        socket.onAny((name) => log.push({ name, bound: link.bound }));
        socket.on("account:open", (_p, ack) => {
            link.bound = true;
            ack({ ok: true, data: session() });
        });
        script(socket, link);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    client.connect("user", async () => "token");
    await expect.poll(() => client.getSnapshot().pnl.bound).toBe(1);
    return {
        client,
        io,
        log,
        hold: () => {
            holding = true;
        },
        release: () => {
            holding = false;
            for (const next of held.splice(0)) next();
        },
        /** The server hangs up on every socket, as it does when a token expires */
        dropAll: () => {
            for (const socket of io.sockets.sockets.values()) socket.disconnect();
        },
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

type Stack = Awaited<ReturnType<typeof fakeServer>>;

const pendingDeposits = (stack: Stack) => {
    const { state } = stack.client.getSnapshot();
    return state.status === "ready" ? state.pending : [];
};

const pendingWithdrawals = (stack: Stack) => {
    const { state } = stack.client.getSnapshot();
    return state.status === "ready" ? state.pendingWithdrawals : [];
};

const shown = (stack: Stack) => optimisticBalance(stack.client.getSnapshot().state);

test.describe("a sent deposit", () => {
    for (const code of ["wallet_not_connected", "unavailable", "internal", "rate_limited"] as const) {
        test(`stays pending and is reported again when the report is refused with ${code}`, async () => {
            let reports = 0;
            const stack = await fakeServer((socket) => {
                socket.on("deposit:submit", ({ txHash }, ack) => {
                    reports++;
                    const error: ApiError = { code, message: "Not just now." };
                    ack(reports === 1 ? { ok: false, error } : { ok: true, data: receipt(txHash) });
                });
            });
            try {
                expect(await stack.client.deposit("10", wallet)).toBe("sent");
                await expect.poll(() => reports).toBe(1);
                await wait(300);
                // The refusal says nothing about the deposit, so it still counts and nothing says it failed
                expect(stack.client.getSnapshot().notice?.kind).toBe("confirming");
                expect(pendingDeposits(stack)).toHaveLength(1);
                expect(shown(stack)).toBe(toWei("60"));
                await expect.poll(() => stack.client.getSnapshot().notice?.kind, { timeout: 10_000 }).toBe("credited");
                expect(reports).toBe(2);
                expect(pendingDeposits(stack)).toEqual([]);
                expect(shown(stack)).toBe(toWei("60"));
            } finally {
                await stack.stop();
            }
        });
    }

    test("comes back out of the balance when the report is refused for good", async () => {
        let reports = 0;
        const stack = await fakeServer((socket) => {
            socket.on("deposit:submit", (_payload, ack) => {
                reports++;
                ack({ ok: false, error: { code: "tx_reverted", message: "That transaction failed." } });
            });
        });
        try {
            expect(await stack.client.deposit("10", wallet)).toBe("sent");
            await expect.poll(() => stack.client.getSnapshot().notice?.kind).toBe("reverted");
            expect(stack.client.getSnapshot().notice).toMatchObject({ message: "That transaction failed." });
            expect(pendingDeposits(stack)).toEqual([]);
            expect(shown(stack)).toBe(toWei("50"));
            await wait(1_500);
            expect(reports).toBe(1);
        } finally {
            await stack.stop();
        }
    });

    test("is reported only once the socket is bound to the account", async () => {
        const stack = await fakeServer((socket, link) => {
            socket.on("deposit:submit", ({ txHash }, ack) => {
                ack(
                    link.bound
                        ? { ok: true, data: receipt(txHash) }
                        : {
                              ok: false,
                              error: {
                                  code: "wallet_not_connected",
                                  message: "Your account isn't open yet. Reload the page to open it.",
                              },
                          },
                );
            });
        });
        try {
            // The link drops and the new one is held before it can open the account
            stack.hold();
            stack.dropAll();
            await wait(200);
            expect(await stack.client.deposit("10", wallet)).toBe("sent");
            await wait(300);
            expect(stack.log.filter((e) => e.name === "deposit:submit")).toEqual([]);
            stack.release();
            await expect.poll(() => stack.client.getSnapshot().notice?.kind).toBe("credited");
            expect(stack.log.filter((e) => e.name === "deposit:submit")).toEqual([
                { name: "deposit:submit", bound: true },
            ]);
            expect(pendingDeposits(stack)).toEqual([]);
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a withdrawal that never reached the server", () => {
    test("is dropped by the session of the next connection, with its debit", async () => {
        const stack = await fakeServer((socket) => {
            // The request is swallowed, as by a dead link
            socket.on("withdraw:create", () => undefined);
        });
        try {
            void stack.client.withdraw("10", EVM);
            await expect.poll(() => pendingWithdrawals(stack).length).toBe(1);
            expect(shown(stack)).toBe(toWei("40"));
            stack.dropAll();
            await expect.poll(() => stack.client.getSnapshot().pnl.bound).toBe(2);
            expect(pendingWithdrawals(stack)).toEqual([]);
            expect(shown(stack)).toBe(toWei("50"));
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a trade filled in another tab", () => {
    test("moves this tab's USDC balance with the push", async () => {
        const stack = await fakeServer();
        try {
            expect(shown(stack)).toBe(toWei("50"));
            for (const socket of stack.io.sockets.sockets.values()) {
                socket.emit("trade:filled", {
                    id: "t1",
                    requestId: "r1",
                    verb: "buy",
                    paidSymbol: "USDC",
                    paidUnits: "10",
                    gotSymbol: "BNB",
                    gotUnits: "0.0166",
                    usd: "10",
                    at: "2026-10-16T00:00:00.000Z",
                    account: account("40", 2),
                });
            }
            await expect.poll(() => shown(stack)).toBe(toWei("40"));
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a prediction that failed on the server", () => {
    const failedOrder = (over: Record<string, unknown> = {}) => ({
        id: "o1",
        requestId: "r1",
        side: "buy",
        state: "failed",
        reason: "rejected",
        eventId: "ev1",
        tokenId: "tok1",
        question: "Will it rain?",
        outcome: "Yes",
        amountUSD: "10",
        shares: null,
        positionId: null,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
        ...over,
    });
    const push = (stack: Stack, order: Record<string, unknown>) => {
        for (const socket of stack.io.sockets.sockets.values())
            socket.emit("prediction:update", { requestId: "r1", order, position: null, account: account("50", 2) });
    };

    test("shows the server's own words, not the generic line", async () => {
        const stack = await fakeServer();
        try {
            const message = 'Polymarket refused the order: "invalid order size". Nothing was spent.';
            push(stack, failedOrder({ message }));
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message });
        } finally {
            await stack.stop();
        }
    });

    test("shows the server's words for a sale too", async () => {
        const stack = await fakeServer();
        try {
            const message = "The price moved, so the sale didn't go through. Your position is back.";
            push(stack, failedOrder({ side: "sell", message }));
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message });
        } finally {
            await stack.stop();
        }
    });

    test("falls back to the generic line when an older server sends no message", async () => {
        const stack = await fakeServer();
        try {
            push(stack, failedOrder({ reason: "market_closed" }));
            await expect
                .poll(() => stack.client.getSnapshot().tradeNotice)
                .toEqual({ message: "This market just closed. Nothing was spent." });
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a failed withdrawal", () => {
    const failed = {
        id: "w1",
        requestId: "r1",
        amount: "10",
        to: EVM,
        network: "arc",
        fee: null,
        receive: null,
        state: "failed",
        txHash: null,
        forwardTxHash: null,
        delayed: false,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
    };

    test("says why it failed, with the balance reassurance last", async () => {
        const stack = await fakeServer();
        try {
            for (const socket of stack.io.sockets.sockets.values()) {
                socket.emit("withdrawal:update", {
                    withdrawal: { ...failed, reason: "The network rejected the transfer." },
                    account: account("50", 2),
                });
            }
            await expect
                .poll(() => stack.client.getSnapshot().notice)
                .toMatchObject({ message: "The network rejected the transfer. Your balance is back." });
        } finally {
            await stack.stop();
        }
    });

    test("falls back to a plain line when an older server sends no reason", async () => {
        const stack = await fakeServer();
        try {
            for (const socket of stack.io.sockets.sockets.values()) {
                socket.emit("withdrawal:update", { withdrawal: failed, account: account("50", 2) });
            }
            await expect
                .poll(() => stack.client.getSnapshot().notice)
                .toMatchObject({ message: "The withdrawal failed. Your balance is back." });
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a request nothing answers", () => {
    test("before the account is ready says it is still connecting, and a withdrawal says not-ready", async () => {
        const client = new AccountClient("http://127.0.0.1:9");
        expect(await client.loadPnlSeries("UTC")).toEqual({
            code: "unavailable",
            message: "Still connecting to your account.",
        });
        expect(await client.withdraw("1", EVM)).toBe("not-ready");
    });

    test("that the server swallows says how long it waited", async () => {
        test.setTimeout(40_000);
        const stack = await fakeServer((socket) => {
            socket.on("pnl:series", () => undefined);
        });
        try {
            expect(await stack.client.loadPnlSeries("UTC")).toEqual({
                code: "unavailable",
                message: "The server didn't answer in 15 seconds.",
            });
        } finally {
            await stack.stop();
        }
    });
});


test.describe("a refused trade or coin send", () => {
    const sol = { requestId: "t1", verb: "buy", symbol: "SOL", amountUSD: "50", quotedPriceUSD: "147.2" } as const;

    test("shows the server's own words for a price that moved, with its prices, not a fixed line", async () => {
        const message =
            "SOL moved from $147.20 to $150.00, more than the 1% allowed. Review the new price and try again. Nothing was spent.";
        const stack = await fakeServer((socket) =>
            socket.on("trade:order", (_req, ack) => ack({ ok: false, code: "price_moved", message })),
        );
        try {
            const placed = stack.client.placeTrade(sol);

            expect(placed.sent).toBe(true);
            expect(await placed.answer).toBe(message);
            expect(stack.client.getSnapshot().tradeNotice).toEqual({ message });
        } finally {
            await stack.stop();
        }
    });

    test("names the refusal's code when the server sent no words", async () => {
        const stack = await fakeServer((socket) =>
            socket.on("trade:order", (_req, ack) => ack({ ok: false, code: "price_moved", message: "" })),
        );
        try {
            expect(await stack.client.placeTrade(sol).answer).toBe("The server refused the buy (price_moved).");
        } finally {
            await stack.stop();
        }
    });

    test("says which price is missing when a trade can't be counted, and not that the person is offline", async () => {
        const stack = await fakeServer();
        try {
            const placed = stack.client.placeTrade({ ...sol, quotedPriceUSD: "0" });

            expect(placed.sent).toBe(false);
            const message = "Couldn't work out this buy: the SOL price isn't loaded yet. Try again in a moment.";
            expect(await placed.answer).toBe(message);
            expect(stack.client.getSnapshot().tradeNotice).toEqual({ message });

            const swap = stack.client.placeTrade({
                requestId: "t2",
                verb: "swap",
                symbol: "SOL",
                toSymbol: "ETH",
                units: "1",
                quotedPriceUSD: "147.2",
            });
            expect(await swap.answer).toBe(
                "Couldn't work out this swap: the ETH price isn't loaded yet. Try again in a moment.",
            );
        } finally {
            await stack.stop();
        }
    });

    test("a send the server refused shows its words, and one that fails later shows the stored reason", async () => {
        const refused = "You hold 0.1 BNB but this sends 0.5. Nothing was sent.";
        const stack = await fakeServer((socket) =>
            socket.on("holding:withdraw", (_req, ack) =>
                ack({ ok: false, code: "insufficient_holdings", message: refused }),
            ),
        );
        try {
            const sent = stack.client.withdrawHolding({ requestId: "w1", symbol: "BNB", units: "0.5", to: EVM });
            expect(sent.sent).toBe(true);
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message: refused });

            const message =
                "Our sending wallet is out of gas on BNB Chain, so the send was refused. Your BNB is back in your holdings.";
            for (const socket of stack.io.sockets.sockets.values())
                socket.emit("holding:withdrawal", {
                    id: "000000000000000000000009",
                    requestId: "w2",
                    symbol: "BNB",
                    units: "0.5",
                    network: "bnb",
                    to: EVM,
                    state: "failed",
                    txHash: null,
                    reason: "out_of_gas",
                    message,
                    at: "2026-10-16T00:00:00.000Z",
                });
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message });
        } finally {
            await stack.stop();
        }
    });
});

test.describe("the copy for an order that can't be sent or confirmed", () => {
    test("says which of loading, failed, offline and unreachable it is, with what was kept", async () => {
        const { unconfirmedCopy, unsentCopy } = await import("@/lib/account/spot");

        expect(unsentCopy("loading", "buy")).toBe("Your account is still loading. Try again in a moment.");
        expect(unsentCopy("failed", "sell", "Sign in again")).toBe(
            "Your account didn't load: Sign in again. Nothing was sold.",
        );
        expect(unsentCopy("offline", "swap")).toBe("You're offline. Nothing was swapped.");
        expect(unsentCopy("unreachable", "send")).toBe("Can't reach the server right now. Nothing was sent.");
        expect(unconfirmedCopy("buy", 45)).toBe(
            "The server didn't answer in 45 seconds, so we can't confirm this buy. Check your balance and holdings before trying again.",
        );
    });
});


test.describe("a perp close or open the server does not confirm", () => {
    const closeOrder = (over: Record<string, unknown> = {}) => ({
        id: "p1",
        requestId: "c1",
        kind: "close",
        asset: "BTC",
        side: "long",
        leverage: 5,
        state: "done",
        reason: null,
        positionId: "pos1",
        filledSizeCoin: "0.003",
        requestedSizeCoin: "0.00759",
        collateralUSD: "100",
        creditedUSD: null,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
        ...over,
    });

    test("a close that only took part of the position says how much", async () => {
        const stack = await fakeServer();
        try {
            const reason =
                "Closed 0.003 of 0.00759 BTC; the book was too thin for the rest. Press Close again for the rest.";
            for (const socket of stack.io.sockets.sockets.values())
                socket.emit("perp:update", {
                    order: closeOrder({ reason }),
                    position: null,
                    account: account("50", 2),
                });
            await expect.poll(() => stack.client.getSnapshot().tradeNotice).toEqual({ message: reason });
        } finally {
            await stack.stop();
        }
    });

    test("a close whose answer is lost with the connection says it was not confirmed", async () => {
        const stack = await fakeServer((socket) => socket.on("perp:close", () => undefined));
        try {
            const closing = stack.client.closePerp("pos1");
            await expect.poll(() => stack.log.some((entry) => entry.name === "perp:close")).toBe(true);
            stack.dropAll();
            await closing;
            expect(stack.client.getSnapshot().tradeNotice?.message).toMatch(
                /^(You went offline before the server confirmed the close|The server didn't confirm the close within 45 seconds)\. Check whether the position is still open before trying again\.$/,
            );
        } finally {
            await stack.stop();
        }
    });

    test("an open whose answer is lost with the connection says it may still go through", async () => {
        const stack = await fakeServer((socket) => socket.on("perp:order", () => undefined));
        try {
            const placed = stack.client.placePerp(
                { requestId: "o1", asset: "BTC", side: "long", leverage: 5, collateralUSD: "100" },
                {
                    entryPx: "65000",
                    sizeCoin: "0.00759",
                    notionalUSD: "495",
                    takerFeeUSD: "0.2",
                    ourFeeUSD: "1",
                    liquidationPx: "52000",
                    fundingPerHour: "0.00001",
                    marginUSD: "99",
                },
            );
            await expect.poll(() => stack.log.some((entry) => entry.name === "perp:order")).toBe(true);
            stack.dropAll();
            expect(await placed.answer).toBeNull();
            expect(stack.client.getSnapshot().tradeNotice?.message).toMatch(
                /your long BTC\.? ?.*It may still go through; check Positions before trying again\.$/,
            );
        } finally {
            await stack.stop();
        }
    });
});
