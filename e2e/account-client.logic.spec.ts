import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Server, type Socket } from "socket.io";
import { AccountClient, type BridgeWallet, type WalletProvider } from "@/components/account-client";
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


test.describe("a deposit the wallet or the server can't take", () => {
    const sending = (error: unknown): typeof wallet => ({
        ...wallet,
        provider: {
            request: async () => {
                throw error;
            },
        } as WalletProvider,
    });

    for (const [name, error, message] of [
        [
            "a wallet short of USDC for the fee",
            { code: -32603, message: "insufficient funds for gas * price + value" },
            "Your wallet doesn't have enough USDC for the deposit plus network fees.",
        ],
        [
            "a wallet with a request already open",
            { code: -32002, message: "Request of type 'wallet_sendTransaction' already pending" },
            "Your wallet already has a request open. Finish or close it, then try again.",
        ],
        [
            "a wallet that says why in its own words",
            { code: -32000, message: "nonce too low.\nTry again" },
            'Your wallet refused the deposit: "nonce too low. Try again".',
        ],
    ] as const) {
        test(`${name} is told what went wrong`, async () => {
            const stack = await fakeServer();
            try {
                expect(await stack.client.deposit("10", sending(error))).toEqual({ failed: message });
                expect(pendingDeposits(stack)).toEqual([]);
            } finally {
                await stack.stop();
            }
        });
    }

    test("a wallet that turns the prompt down is cancelled, in any wording", async () => {
        const stack = await fakeServer();
        try {
            expect(await stack.client.deposit("10", sending({ code: 4001 }))).toBe("cancelled");
            expect(await stack.client.deposit("10", sending(new Error("User denied transaction signature")))).toBe(
                "cancelled",
            );
        } finally {
            await stack.stop();
        }
    });

    test("an answer that isn't a transaction hash warns the deposit may have gone", async () => {
        const stack = await fakeServer();
        try {
            const odd = { ...wallet, provider: { request: async () => "request-id-7" } as WalletProvider };
            const result = await stack.client.deposit("10", odd);
            expect(result).toEqual({
                failed: 'Your wallet answered with something other than a transaction hash ("request-id-7"). Check your wallet\'s activity before trying again; the deposit may have been sent.',
            });
        } finally {
            await stack.stop();
        }
    });

    test("before the account is open, the server is blamed and not the wallet", async () => {
        const client = new AccountClient("http://127.0.0.1:1");
        expect(await client.deposit("10", wallet)).toEqual({
            failed: "Still signing you in; try again in a moment.",
        });
        expect(await client.quote("ethereum:ETH", "1", EVM)).toEqual({
            code: "unavailable",
            message: "Still signing you in; try again in a moment.",
        });
    });

    test("a transaction the server can't see yet stays counted, says so, and is credited when it lands", async () => {
        let reports = 0;
        const stack = await fakeServer((socket) => {
            socket.on("deposit:submit", ({ txHash }, ack) => {
                reports++;
                ack(
                    reports === 1
                        ? {
                              ok: false,
                              error: {
                                  code: "tx_not_found",
                                  message: "Transaction 0xabab…abab hasn't shown up on Arc after 30 seconds.",
                              },
                          }
                        : { ok: true, data: receipt(txHash) },
                );
            });
        });
        try {
            expect(await stack.client.deposit("10", wallet)).toBe("sent");
            await expect
                .poll(() => stack.client.getSnapshot().notice)
                .toMatchObject({
                    kind: "confirming",
                    message: "Transaction 0xabab…abab hasn't shown up on Arc after 30 seconds.",
                });
            expect(pendingDeposits(stack)).toHaveLength(1);
            expect(shown(stack)).toBe(toWei("60"));
            await expect.poll(() => stack.client.getSnapshot().notice?.kind, { timeout: 10_000 }).toBe("credited");
            expect(pendingDeposits(stack)).toEqual([]);
        } finally {
            await stack.stop();
        }
    });
});

test.describe("a bridged deposit the server can't register", () => {
    const order = {
        id: "a".repeat(24),
        coin: "ethereum:ETH",
        amount: "1",
        wallet: EVM,
        usdcOut: "3000",
        etaSeconds: 30,
        state: "created",
        sourceTxHashes: [],
        depositId: null,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
    };
    const evmTx = (chainId = 1) => ({ kind: "evm", chainId, to: EVM, data: "0x", value: "0x1" });
    const bridge = (request: WalletProvider["request"]): BridgeWallet => ({
        from: EVM,
        provider: { request },
        ensure: async () => "ready",
    });
    const serving = (txs: unknown[], source: (payload: unknown, ack: (r: unknown) => void) => void) =>
        fakeServer((socket) => {
            socket.on("deposit:order", (_p, ack) => ack({ ok: true, data: { order, txs } }));
            socket.on("deposit:source", source);
        });

    test("a refusal for good is told with the hash, since the money has gone", async () => {
        const stack = await serving([evmTx()], (_p, ack) =>
            ack({
                ok: false,
                error: { code: "not_found", message: "Order aaaaaa isn't one of yours or has been cleared." },
            }),
        );
        try {
            expect(
                await stack.client.bridgeDeposit(
                    "ethereum:ETH",
                    "1",
                    bridge(async () => HASH),
                ),
            ).toBe("sent");
            expect(stack.client.getSnapshot().notice).toEqual({
                kind: "reverted",
                message:
                    "Your deposit was sent (0xabab…abab) but we couldn't register it with the server: Order aaaaaa isn't one of yours or has been cleared. It will still be credited once the bridge pays out on Arc, but its progress won't show here.",
            });
        } finally {
            await stack.stop();
        }
    });

    test("a refusal that could pass is asked again, and nothing is said once the server takes it", async () => {
        let asked = 0;
        const stack = await serving([evmTx()], (_p, ack) => {
            asked++;
            ack(
                asked === 1
                    ? { ok: false, error: { code: "unavailable", message: "Try again." } }
                    : { ok: true, data: { ...order, state: "sent", sourceTxHashes: [HASH] } },
            );
        });
        try {
            expect(
                await stack.client.bridgeDeposit(
                    "ethereum:ETH",
                    "1",
                    bridge(async () => HASH),
                ),
            ).toBe("sent");
            await expect.poll(() => asked, { timeout: 8_000 }).toBe(2);
            expect(stack.client.getSnapshot().notice).toBeNull();
        } finally {
            await stack.stop();
        }
    });

    test("an approval that reverts says so, and the deposit is not sent", async () => {
        const stack = await serving([evmTx(), evmTx()], () => undefined);
        try {
            const requests: string[] = [];
            const result = await stack.client.bridgeDeposit(
                "ethereum:ETH",
                "1",
                bridge(async ({ method }) => {
                    requests.push(method);
                    return method === "eth_getTransactionReceipt" ? { status: "0x0" } : HASH;
                }),
            );
            expect(result).toEqual({
                failed: "The approval transaction reverted on Ethereum, so the deposit wasn't sent. Nothing was bridged.",
            });
            expect(requests.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
        } finally {
            await stack.stop();
        }
    });

    test("a wallet on the wrong network is told which one it is on", async () => {
        const stack = await serving([evmTx(56)], () => undefined);
        try {
            const result = await stack.client.bridgeDeposit("bnb:USDT", "1", {
                ...bridge(async () => HASH),
                ensure: async () => ({ kind: "wrong_network", actual: 1 }),
            });
            expect(result).toEqual({
                failed: "Your wallet is on Ethereum, not BNB Chain. Switch to BNB Chain in the wallet and try again.",
            });
        } finally {
            await stack.stop();
        }
    });

    test("the server's refusal to open the order is passed on as it is", async () => {
        const stack = await fakeServer((socket) => {
            socket.on("deposit:order", (_p, ack) =>
                ack({
                    ok: false,
                    error: {
                        code: "no_route",
                        message: "Relay's minimum for this route is higher than that. Try a larger amount.",
                    },
                }),
            );
        });
        try {
            expect(
                await stack.client.bridgeDeposit(
                    "ethereum:ETH",
                    "0.0001",
                    bridge(async () => HASH),
                ),
            ).toEqual({
                refused: "Relay's minimum for this route is higher than that. Try a larger amount.",
            });
        } finally {
            await stack.stop();
        }
    });
});
