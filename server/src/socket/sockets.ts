import type { Server as HttpServer } from "node:http";
import type { ObjectId } from "mongodb";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { Server, type Socket } from "socket.io";
import type { Identity } from "../auth/identity.ts";
import { throttle } from "../log-throttle.ts";
import { ACCOUNT_NOT_OPEN } from "../sessions.ts";
import { solanaOpen } from "../crosschain/solana-switch.ts";
import { orderView, sourceTxView } from "../crosschain/views.ts";
import { perpOrderView, perpUpdate } from "../perps/views.ts";
import { positionView, predictionUpdate } from "../predictions/views.ts";
import { accountView, depositView } from "../deposits/views.ts";
import { formatUsdc } from "../db/money.ts";
import { withdrawalView } from "../withdrawals/views.ts";
import { AppError, isAppError, newRef, toApiError, wentWrong } from "../errors.ts";
import type { Ack, ApiError, ClientToServerEvents, HandshakeAuth, ServerToClientEvents } from "../protocol.ts";
import { listHoldings } from "../trading/holdings.ts";
import { isTradeError, type TradeError } from "../trading/trades.ts";
import { coinWithdrawalView } from "../trading/views.ts";
import type { HoldingView, TradeView, TradingAck, TradingErrorCode } from "../trading/types.ts";
import type { Services } from "../services.ts";
import {
    activityPage,
    coinWalletAmount,
    coinWithdraw,
    depositPage,
    depositReport,
    parse,
    perpClose,
    perpOrder,
    perpQuote,
    pnlSeries,
    predictionClose,
    predictionOrder,
    predictionQuote,
    sellQuote,
    sourceReport,
    tradeOrder,
    withdrawQuoteRequest,
    withdrawRequest,
} from "../validation.ts";

type SocketData = {
    identity: Identity;
    /** The account `account:open` bound this socket to. */
    account: { id: ObjectId; room: string } | null;
};

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** setTimeout fires at once past this many milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const roomOf = (accountId: ObjectId) => `account:${accountId.toHexString()}`;

/** The socket API: the same operations as HTTP, plus deposits pushed as they're credited. */
export function attachSockets(httpServer: HttpServer, services: Services): IoServer {
    const { config, logger, bus } = services;
    const origins = new Set(config.CORS_ORIGINS);
    const io: IoServer = new Server(httpServer, {
        cors: { origin: config.CORS_ORIGINS, methods: ["GET", "POST"] },
        // CORS doesn't cover WebSocket upgrades, so other sites' pages are turned away here. Clients
        // outside a browser send no Origin, and still need a valid token.
        allowRequest: (req, done) => done(null, !req.headers.origin || origins.has(req.headers.origin)),
        serveClient: false,
        maxHttpBufferSize: 16 * 1024,
        connectTimeout: 10_000,
    });

    // A flood of refused connections from one address is one line a minute
    const refusedHandshakes = throttle(60_000);
    const handshakes = new RateLimiterMemory({
        keyPrefix: "handshake",
        points: config.SOCKET_HANDSHAKES_PER_MINUTE,
        duration: 60,
    });
    const events = new RateLimiterMemory({ keyPrefix: "event", points: 40, duration: 10 });
    // Reports make the server watch the chain for a while, so they get a tighter limit of their own.
    const reports = new RateLimiterMemory({ keyPrefix: "report", points: 20, duration: 60 });

    // Quotes ask outside providers, so they get a limit of their own.
    const quotes = new RateLimiterMemory({ keyPrefix: "quote", points: 30, duration: 60 });
    const orders = new RateLimiterMemory({ keyPrefix: "order", points: 10, duration: 60 });
    const predictionQuotes = new RateLimiterMemory({ keyPrefix: "prediction-quote", points: 60, duration: 60 });
    const blockhashes = new RateLimiterMemory({ keyPrefix: "solana-blockhash", points: 30, duration: 60 });
    const withdrawals = new RateLimiterMemory({ keyPrefix: "withdraw", points: 10, duration: 60 });
    const withdrawLimits = new RateLimiterMemory({ keyPrefix: "withdraw-limits", points: 30, duration: 60 });
    const withdrawQuotes = new RateLimiterMemory({ keyPrefix: "withdraw-quote", points: 30, duration: 60 });
    const predictionOrders = new RateLimiterMemory({ keyPrefix: "prediction", points: 10, duration: 60 });
    const tradeOrders = new RateLimiterMemory({ keyPrefix: "trade", points: 10, duration: 60 });
    const coinWithdrawals = new RateLimiterMemory({ keyPrefix: "coin-withdraw", points: 10, duration: 60 });
    const perpQuotes = new RateLimiterMemory({ keyPrefix: "perp-quote", points: 60, duration: 60 });
    const perpOrders = new RateLimiterMemory({ keyPrefix: "perp", points: 10, duration: 60 });
    const pnlSeriesLimit = new RateLimiterMemory({ keyPrefix: "pnl-series", points: 30, duration: 60 });
    const activityList = new RateLimiterMemory({ keyPrefix: "activity-list", points: 60, duration: 60 });

    io.use(async (socket, next) => {
        try {
            const ip = clientIp(
                socket.handshake.headers["x-forwarded-for"],
                socket.handshake.address,
                config.TRUST_PROXY,
            );
            await handshakes.consume(ip).catch((limit: unknown) => {
                throw tooMany(limit, "Too many connections.");
            });
            const token = (socket.handshake.auth as Partial<HandshakeAuth> | undefined)?.token;
            if (typeof token !== "string" || token === "") {
                throw new AppError("unauthorized", "Your session expired. Sign in again.", { detail: "no_token" });
            }
            socket.data.identity = await services.identity.verify(token);
            socket.data.account = null;
            next();
        } catch (error) {
            const where = {
                event: "socket.handshake_refused",
                ip: clientIp(socket.handshake.headers["x-forwarded-for"], socket.handshake.address, config.TRUST_PROXY),
                origin: socket.handshake.headers.origin,
            };
            let ref: string | undefined;
            if (!isAppError(error)) {
                ref = newRef();
                logger.error({ err: error, ref, ...where }, "Socket handshake failed");
            } else if (error.code !== "rate_limited" || refusedHandshakes(where.ip ?? "")) {
                logger.warn(
                    { code: error.code, reason: error.message, detail: error.detail, ...where },
                    "Refused a socket connection",
                );
            }
            next(connectError(toApiError(error, ref)));
        }
    });

    /** What each request's acknowledgement was asked for, so a failure can say which event and whose. */
    const requests = new WeakMap<object, { event: string; accountId: ObjectId | undefined }>();
    const describe = (ack: object) => {
        const request = requests.get(ack);
        return { event: request?.event ?? "unknown", account: request?.accountId?.toHexString() ?? null };
    };

    const refusedEvents = throttle(30_000);

    // Pushes go one at a time per account, so a step never overtakes the one before it.
    const pushing = new Map<string, Promise<void>>();
    function enqueue(key: string, work: () => Promise<void>) {
        const next = (pushing.get(key) ?? Promise.resolve()).then(work);
        pushing.set(key, next);
        void next.then(() => pushing.get(key) === next && pushing.delete(key));
    }

    io.on("connection", (socket) => {
        // The access token lasts about an hour; the client reconnects with a fresh one.
        const expiry = setTimeout(
            () => {
                socket.emit("session:expired");
                socket.disconnect(true);
            },
            Math.min(Math.max(socket.data.identity.expiresAt - Date.now(), 0), MAX_TIMER_MS),
        );
        socket.on("disconnect", () => clearTimeout(expiry));

        socket.use(([event, ...args], next) => {
            // The acknowledgement stands for the request, so a failure can name the event and who sent it
            const ack = args.at(-1);
            if (typeof ack === "function") requests.set(ack, { event, accountId: socket.data.account?.id });
            events.consume(socket.data.identity.userId).then(
                () => next(),
                (limit: unknown) => {
                    const ack = args.at(-1);
                    const seconds = retrySeconds(limit);
                    if (refusedEvents(socket.data.identity.userId)) {
                        logger.warn(
                            { event, accountId: socket.data.identity.userId, retryInSeconds: seconds },
                            "Refused a socket event because the connection sent too many",
                        );
                    }
                    if (typeof ack === "function") {
                        ack(failure({ code: "rate_limited", message: `Too many requests. Try again in ${seconds}.` }));
                    }
                },
            );
        });

        socket.on("account:open", (_payload, ack) =>
            reply(ack, async () => {
                const account = await services.sessions.open(socket.data.identity);
                const room = roomOf(account._id);
                const previous = socket.data.account;
                if (previous && previous.room !== room) await socket.leave(previous.room);
                // Joined before reading the account, so a deposit credited meanwhile is pushed, not lost.
                await socket.join(room);
                socket.data.account = { id: account._id, room };
                const session = await services.sessions.describe(account);
                // Pushed once the ack is on its way; a failed read is logged, never the sign-in's problem.
                services.balances
                    .refresh(account, socket.data.identity, "bind", (view) => socket.emit("balances", view))
                    .catch((error: unknown) => {
                        logger.warn(
                            { err: error, event: "account:open", accountId: account._id.toHexString() },
                            "Couldn't read balances for an account at sign-in",
                        );
                    });
                // Read and sent in the account's push order, so a settling push can't be overwritten by an older snapshot
                enqueue(account._id.toHexString(), async () => {
                    try {
                        socket.emit("positions", await services.predictions.positions(account));
                    } catch (error) {
                        logger.warn(
                            { err: error, event: "account:open", accountId: account._id.toHexString() },
                            "Couldn't read positions for an account at sign-in",
                        );
                    }
                });
                enqueue(account._id.toHexString(), async () => {
                    try {
                        socket.emit("perps", await services.perps.positions(account));
                    } catch (error) {
                        logger.warn(
                            { err: error, event: "account:open", accountId: account._id.toHexString() },
                            "Couldn't read perp positions for an account at sign-in",
                        );
                    }
                });
                return session;
            }),
        );

        socket.on("deposits:list", (payload, ack) =>
            reply(ack, async () => services.deposits.list(await boundAccount(socket), parse(depositPage, payload))),
        );

        socket.on("balances:refresh", (_payload, ack) =>
            reply(ack, async () =>
                services.balances.refresh(await boundAccount(socket), socket.data.identity, "click"),
            ),
        );

        socket.on("deposit:submit", (payload, ack) =>
            reply(ack, async () => {
                const { txHash } = parse(depositReport, payload);
                await reports.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many deposits reported.");
                });
                return services.deposits.report(await boundAccount(socket), txHash);
            }),
        );

        socket.on("deposit:quote", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(coinWalletAmount, payload);
                await quotes.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many quotes.");
                });
                const account = await boundAccount(socket);
                const wallet = await authorizedWallet(socket, input.wallet);
                return services.orders.preview(account, wallet, input.coin, input.amount);
            }),
        );

        socket.on("deposit:order", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(coinWalletAmount, payload);
                await orders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many deposit orders.");
                });
                const account = await boundAccount(socket);
                const wallet = await authorizedWallet(socket, input.wallet);
                const { order, txs, tables } = await services.orders.create(account, wallet, input.coin, input.amount);
                return { order: orderView(order), txs: txs.map((tx) => sourceTxView(tx, tables)) };
            }),
        );

        socket.on("solana:blockhash", (_payload, ack) =>
            reply(ack, async () => {
                solanaOpen(config, "deposits");
                await blockhashes.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                return services.solana.getLatestBlockhash();
            }),
        );

        socket.on("deposit:source", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(sourceReport, payload);
                const order = await services.orders.reportSource(
                    await boundAccount(socket),
                    input.orderId,
                    input.txHashes,
                );
                return orderView(order);
            }),
        );

        socket.on("withdraw:limits", (_payload, ack) =>
            reply(ack, async () => {
                await withdrawLimits.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                const { max, min } = await services.withdrawals.limits(await boundAccount(socket));
                return { max: formatUsdc(max), min: formatUsdc(min) };
            }),
        );

        socket.on("withdraw:quote", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(withdrawQuoteRequest, payload);
                await withdrawQuotes.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                if (!BASE58_ADDRESS.test(input.to)) {
                    throw new AppError("bad_request", "Only withdrawals to a Solana wallet have a quote.");
                }
                const account = await boundAccount(socket);
                const to = await services.identity.authorizeWallet(socket.data.identity, input.to);
                const { fee, receive, setup, setupFee } = await services.withdrawals.quoteSolana(account, {
                    ...input,
                    to,
                });
                return {
                    fee: formatUsdc(fee),
                    receive: formatUsdc(receive),
                    setup,
                    setupFee: setupFee === null ? null : formatUsdc(setupFee),
                };
            }),
        );

        socket.on("withdraw:create", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(withdrawRequest, payload);
                await withdrawals.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many withdrawals.");
                });
                const account = await boundAccount(socket);
                const to = await services.identity.authorizeWallet(socket.data.identity, input.to);
                const network = BASE58_ADDRESS.test(to) ? "solana" : "arc";
                const withdrawal = await services.withdrawals.create(account, { ...input, to, network });
                // Read after the debit, so it already has the amount taken
                const held = await services.accounts.findById(account._id);
                return { ...withdrawalView(withdrawal), account: accountView(held ?? account) };
            }),
        );

        socket.on("prediction:quote", (payload, ack) =>
            reply(ack, async () => {
                const selling = typeof payload === "object" && payload !== null && "positionId" in payload;
                const input = selling ? parse(sellQuote, payload) : parse(predictionQuote, payload);
                await predictionQuotes.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many quotes.");
                });
                const account = await boundAccount(socket);
                return "positionId" in input
                    ? services.predictions.quoteSell(account, input.positionId)
                    : services.predictions.quote(input);
            }),
        );

        socket.on("prediction:order", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(predictionOrder, payload);
                await predictionOrders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many predictions.");
                });
                const account = await boundAccount(socket);
                const placed = await services.predictions.place(account, input);
                // Read after the hold, so it already has the amount taken
                const held = await services.accounts.findById(account._id);
                return { ...placed, account: accountView(held ?? account) };
            }),
        );

        socket.on("prediction:close", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(predictionClose, payload);
                await predictionOrders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many predictions.");
                });
                return services.predictions.close(await boundAccount(socket), input);
            }),
        );

        socket.on("perp:quote", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(perpQuote, payload);
                await perpQuotes.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many quotes.");
                });
                await boundAccount(socket);
                return services.perps.quote(input);
            }),
        );

        socket.on("perp:order", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(perpOrder, payload);
                await perpOrders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many orders.");
                });
                const placed = await services.perps.place(await boundAccount(socket), input);
                return { order: perpOrderView(placed.order), account: accountView(placed.account) };
            }),
        );

        socket.on("perp:close", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(perpClose, payload);
                await perpOrders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many orders.");
                });
                const closed = await services.perps.close(await boundAccount(socket), input);
                return { order: perpOrderView(closed.order) };
            }),
        );

        socket.on("trade:order", (payload, ack) =>
            tradingReply(ack, async () => {
                const input = parse(tradeOrder, payload);
                await tradeOrders.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many trades.");
                });
                const account = await boundAccount(socket);
                const result = await services.trades.order(account, input);
                pushTrading(account._id, account.privyUserId, {
                    holdings: result.holdings,
                    trade: result.trade,
                    moves: true,
                });
                return { ok: true as const, ...result };
            }),
        );

        socket.on("holding:withdraw", (payload, ack) =>
            tradingReply(ack, async () => {
                const input = parse(coinWithdraw, payload);
                await coinWithdrawals.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                const account = await boundAccount(socket);
                services.trades.assertWithdrawalsOpen();
                const to = await services.identity.authorizeWallet(socket.data.identity, input.to);
                const result = await services.trades.withdraw(account, { ...input, to });
                pushTrading(account._id, account.privyUserId, { holdings: result.holdings });
                return { ok: true as const, ...result };
            }),
        );

        socket.on("pnl:series", (payload, ack) =>
            reply(ack, async () => {
                const { tz } = parse(pnlSeries, payload);
                await pnlSeriesLimit.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                const account = await boundAccount(socket);
                return services.pnl.series(account._id, tz);
            }),
        );

        socket.on("activity:list", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(activityPage, payload);
                await activityList.consume(socket.data.identity.userId).catch((limit: unknown) => {
                    throw tooMany(limit, "Too many requests.");
                });
                const account = await boundAccount(socket);
                return services.feed.page(account._id, input);
            }),
        );
    });

    bus.on("deposit:credited", ({ deposit, account }) => {
        const payload = { deposit: depositView(deposit), account: accountView(account) };
        // Only to the account's owner, whoever else ended up in the room.
        void io
            .in(roomOf(deposit.accountId))
            .fetchSockets()
            .then((sockets) => {
                for (const socket of sockets) {
                    if (socket.data.identity.userId === account.privyUserId) {
                        socket.emit("deposit:credited", payload);
                        socket.emit("pnl:changed");
                    } else socket.leave(roomOf(deposit.accountId));
                }
            })
            .catch((error: unknown) => {
                logger.warn(
                    {
                        err: error,
                        event: "deposit:credited",
                        depositId: deposit._id.toHexString(),
                        accountId: deposit.accountId.toHexString(),
                    },
                    "Couldn't push a credited deposit",
                );
            });
    });

    bus.on("balances:updated", ({ accountId, privyUserId, view }) => {
        void io
            .in(roomOf(accountId))
            .fetchSockets()
            .then((sockets) => {
                for (const socket of sockets) {
                    if (socket.data.identity.userId === privyUserId) socket.emit("balances", view);
                    else socket.leave(roomOf(accountId));
                }
            })
            .catch((error: unknown) => {
                // A stray rejection here would stop the whole server, so it ends in a log line
                logger.warn(
                    { err: error, event: "balances:updated", accountId: accountId.toHexString() },
                    "Couldn't push balances to a person's sockets",
                );
            });
    });

    // Pushes go one at a time per account, so a step never overtakes the one before it.
    bus.on("order:updated", ({ order }) => {
        enqueue(order.accountId.toHexString(), async () => {
            try {
                const sockets = await io.in(roomOf(order.accountId)).fetchSockets();
                const owner = await services.accounts.findById(order.accountId);
                const payload = { order: orderView(order) };
                for (const socket of sockets) {
                    if (socket.data.identity.userId === owner?.privyUserId) socket.emit("deposit:progress", payload);
                    else socket.leave(roomOf(order.accountId));
                }
            } catch (error) {
                logger.warn(
                    {
                        err: error,
                        event: "order:updated",
                        orderId: order._id.toHexString(),
                        accountId: order.accountId.toHexString(),
                    },
                    "Couldn't push a deposit order update",
                );
            }
        });
    });

    bus.on("withdrawal:updated", ({ withdrawal, account }) => {
        enqueue(withdrawal.accountId.toHexString(), async () => {
            try {
                const room = roomOf(withdrawal.accountId);
                const owner = await services.accounts.findById(withdrawal.accountId);
                const current = account ?? owner;
                if (!current) return;
                const payload = { withdrawal: withdrawalView(withdrawal), account: accountView(current) };
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === owner?.privyUserId) {
                        socket.emit("withdrawal:update", payload);
                        socket.emit("pnl:changed");
                    } else socket.leave(room);
                }
            } catch (error) {
                logger.warn(
                    {
                        err: error,
                        event: "withdrawal:updated",
                        withdrawalId: withdrawal._id.toHexString(),
                        accountId: withdrawal.accountId.toHexString(),
                    },
                    "Couldn't push a withdrawal update",
                );
            }
        });
    });

    bus.on("prediction:updated", (update) => {
        enqueue(update.account._id.toHexString(), async () => {
            try {
                const room = roomOf(update.account._id);
                const payload = predictionUpdate(update);
                // A buy keeps its money at cost, so only a filled sell moves the series
                const moves = update.order.side === "sell" && update.order.state === "filled";
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === update.account.privyUserId) {
                        socket.emit("prediction:update", payload);
                        if (moves) socket.emit("pnl:changed");
                    } else socket.leave(room);
                }
            } catch (error) {
                logger.warn(
                    {
                        err: error,
                        event: "prediction:updated",
                        orderId: update.order._id.toHexString(),
                        accountId: update.account._id.toHexString(),
                    },
                    "Couldn't push a prediction update",
                );
            }
        });
    });

    bus.on("perp:updated", (update) => {
        enqueue(update.account._id.toHexString(), async () => {
            try {
                const room = roomOf(update.account._id);
                const payload = perpUpdate(update);
                // Funding and liquidation-price ticks on an open position do not move the series
                const moves = !update.position || update.position.settledAt !== null;
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === update.account.privyUserId) {
                        socket.emit("perp:update", payload);
                        if (moves) socket.emit("pnl:changed");
                    } else socket.leave(room);
                }
            } catch (error) {
                logger.warn(
                    { err: error, event: "perp:updated", accountId: update.account._id.toHexString() },
                    "Couldn't push a perp update",
                );
            }
        });
    });

    bus.on("position:settled", ({ position, account }) => {
        enqueue(account._id.toHexString(), async () => {
            try {
                const room = roomOf(account._id);
                const payload = { position: positionView(position), account: accountView(account) };
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === account.privyUserId) {
                        socket.emit("position:settled", payload);
                        socket.emit("pnl:changed");
                    } else socket.leave(room);
                }
            } catch (error) {
                logger.warn(
                    {
                        err: error,
                        event: "position:settled",
                        positionId: position._id.toHexString(),
                        accountId: account._id.toHexString(),
                    },
                    "Couldn't push a settled position",
                );
            }
        });
    });

    bus.on("coin-withdrawal:updated", ({ withdrawal, refunded }) => {
        enqueue(withdrawal.accountId.toHexString(), async () => {
            try {
                const room = roomOf(withdrawal.accountId);
                const owner = await services.accounts.findById(withdrawal.accountId);
                if (!owner) return;
                const holdings = refunded ? await listHoldings(services.database.collections, owner._id) : null;
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId !== owner.privyUserId) {
                        socket.leave(room);
                        continue;
                    }
                    socket.emit("holding:withdrawal", coinWithdrawalView(withdrawal));
                    if (holdings) socket.emit("holdings:update", { holdings });
                }
            } catch (error) {
                logger.warn(
                    {
                        err: error,
                        event: "coin-withdrawal:updated",
                        withdrawalId: withdrawal._id.toHexString(),
                        accountId: withdrawal.accountId.toHexString(),
                    },
                    "Couldn't push a coin withdrawal",
                );
            }
        });
    });

    // Holdings and fills go to every socket of the account's owner, one at a time per account
    function pushTrading(
        accountId: ObjectId,
        privyUserId: string,
        push: { holdings: HoldingView[]; trade?: TradeView; moves?: boolean },
    ) {
        enqueue(accountId.toHexString(), async () => {
            try {
                const room = roomOf(accountId);
                // A fill moves the USDC balance, so it goes out with the account as it stands
                const account = push.trade ? await services.accounts.findById(accountId) : null;
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId !== privyUserId) {
                        socket.leave(room);
                        continue;
                    }
                    if (push.trade && account)
                        socket.emit("trade:filled", { ...push.trade, account: accountView(account) });
                    socket.emit("holdings:update", { holdings: push.holdings });
                    if (push.moves) socket.emit("pnl:changed");
                }
            } catch (error) {
                logger.warn(
                    { err: error, event: "trade:filled", accountId: accountId.toHexString() },
                    "Couldn't push a trade",
                );
            }
        });
    }

    /** The wallet as the account knows it: a linked EVM address checksummed, a linked Solana one as given. */
    async function authorizedWallet(socket: IoSocket, wallet: string) {
        if (BASE58_ADDRESS.test(wallet)) solanaOpen(config, "deposits");
        return services.identity.authorizeWallet(socket.data.identity, wallet);
    }

    async function boundAccount(socket: IoSocket) {
        const bound = socket.data.account;
        if (!bound) throw new AppError("wallet_not_connected", ACCOUNT_NOT_OPEN, { detail: "socket_not_bound" });
        const account = await services.accounts.findById(bound.id);
        // The account belongs to another Privy user than this socket's.
        if (account && account.privyUserId !== socket.data.identity.userId) {
            await socket.leave(bound.room);
            socket.data.account = null;
        }
        if (!account || !socket.data.account)
            throw new AppError("wallet_not_connected", ACCOUNT_NOT_OPEN, { detail: "socket_not_bound" });
        return account;
    }

    /** An expected refusal, logged once as a warning with the event and account, unless the thrower already logged it with its numbers. */
    function refused(ack: object, error: AppError | TradeError) {
        if (error.logged) return;
        const { event, account } = describe(ack);
        logger.warn(
            { event, account, code: error.code, detail: error instanceof AppError ? error.detail : undefined },
            `${error.message} (${event})`,
        );
    }

    async function reply<T>(ack: unknown, work: () => Promise<T>) {
        // Every event is a request; one sent without an acknowledgement has nowhere to answer.
        if (typeof ack !== "function") return;
        try {
            ack({ ok: true, data: await work() } satisfies Ack<T>);
        } catch (error) {
            const { event, account } = describe(ack);
            let ref: string | undefined;
            if (!isAppError(error)) {
                ref = newRef();
                logger.error({ err: error, event, account, ref }, `Unexpected error in socket request ${event}`);
            } else if (error.status >= 500) {
                if (error.code === "internal") ref = newRef();
                logger.error(
                    { err: error.cause ?? error, event, account, code: error.code, detail: error.detail, ref },
                    `${error.message} (${event})`,
                );
            } else refused(ack, error);
            ack(failure(toApiError(error, ref)));
        }
    }

    /** Answers a trading event with the trading ack shape: the result's fields beside `ok`, or `ok: false` with a code. */
    async function tradingReply<T extends { ok: true }>(ack: unknown, work: () => Promise<T>) {
        if (typeof ack !== "function") return;
        try {
            ack(await work());
        } catch (error) {
            let code: TradingErrorCode = "unavailable";
            let message = "Something went wrong on our side. Try again shortly.";
            if (isTradeError(error)) {
                ({ code, message } = error);
                refused(ack, error);
            } else if (isAppError(error)) {
                code = TRADING_CODES[error.code] ?? "unavailable";
                message = error.message;
                if (error.status >= 500) {
                    const { event, account } = describe(ack);
                    logger.error(
                        { err: error.cause ?? error, event, account, code: error.code },
                        `${error.message} (${event})`,
                    );
                } else refused(ack, error);
            } else {
                const ref = newRef();
                const { event, account } = describe(ack);
                logger.error({ err: error, event, account, ref }, `Unexpected error in socket request ${event}`);
                message = wentWrong(ref);
            }
            ack({ ok: false, code, message } satisfies TradingAck<never>);
        }
    }

    return io;
}

const TRADING_CODES: Partial<Record<ApiError["code"], TradingErrorCode>> = {
    bad_request: "bad_request",
    forbidden: "bad_request",
    wallet_not_connected: "unauthenticated",
    unauthorized: "unauthenticated",
    rate_limited: "rate_limited",
};

const failure = (error: ApiError): Ack<never> => ({ ok: false, error });

/** How long until a limiter lets the next one through, in words ("4 seconds"). */
function retrySeconds(limit: unknown) {
    const ms = (limit as { msBeforeNext?: unknown } | null)?.msBeforeNext;
    const seconds = typeof ms === "number" ? Math.max(1, Math.ceil(ms / 1000)) : 10;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** What a limiter's rejection becomes: the refusal with the wait in it, or the real error when it wasn't the limit that said no. */
function tooMany(limit: unknown, what: string) {
    if (limit instanceof Error) return limit;
    return new AppError("rate_limited", `${what} Try again in ${retrySeconds(limit)}.`);
}

/** Socket.io hands `connect_error` listeners the message and `data`. */
function connectError(error: ApiError) {
    return Object.assign(new Error(error.message), { data: error });
}

/** The client's IP, trusting X-Forwarded-For only as far as `hops` proxies, like Express's `trust proxy`. */
export function clientIp(forwardedFor: string | string[] | undefined, remote: string, hops: number): string {
    if (hops === 0 || !forwardedFor) return remote;
    const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    return chain[chain.length - hops] ?? chain[0] ?? remote;
}
