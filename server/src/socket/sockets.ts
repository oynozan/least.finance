import type { Server as HttpServer } from "node:http";
import type { ObjectId } from "mongodb";
import type { Address } from "viem";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { Server, type Socket } from "socket.io";
import type { Identity } from "../auth/identity.ts";
import { orderView, sourceTxView } from "../crosschain/views.ts";
import { swapOrderView } from "../swaps/views.ts";
import { positionView, predictionUpdate } from "../predictions/views.ts";
import { accountView, depositView } from "../deposits/views.ts";
import { formatUsdc } from "../db/money.ts";
import { withdrawalView } from "../withdrawals/views.ts";
import { AppError, isAppError, toApiError } from "../errors.ts";
import type { Ack, ApiError, ClientToServerEvents, HandshakeAuth, ServerToClientEvents } from "../protocol.ts";
import type { Services } from "../services.ts";
import {
    coinWalletAmount,
    depositPage,
    depositReport,
    parse,
    predictionClose,
    predictionOrder,
    predictionQuote,
    sellQuote,
    sourceReport,
    swapOrder,
    swapRequest,
    swapSent,
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
    const swapQuotes = new RateLimiterMemory({ keyPrefix: "swap-quote", points: 60, duration: 60 });
    const swapOrders = new RateLimiterMemory({ keyPrefix: "swap-order", points: 10, duration: 60 });
    const predictionQuotes = new RateLimiterMemory({ keyPrefix: "prediction-quote", points: 60, duration: 60 });
    const withdrawals = new RateLimiterMemory({ keyPrefix: "withdraw", points: 10, duration: 60 });
    const withdrawLimits = new RateLimiterMemory({ keyPrefix: "withdraw-limits", points: 30, duration: 60 });
    const predictionOrders = new RateLimiterMemory({ keyPrefix: "prediction", points: 10, duration: 60 });

    io.use(async (socket, next) => {
        try {
            const ip = clientIp(
                socket.handshake.headers["x-forwarded-for"],
                socket.handshake.address,
                config.TRUST_PROXY,
            );
            await handshakes.consume(ip).catch(() => {
                throw new AppError("rate_limited", "Too many connections. Try again shortly.");
            });
            const token = (socket.handshake.auth as Partial<HandshakeAuth> | undefined)?.token;
            if (typeof token !== "string" || token === "") throw new AppError("unauthorized", "Sign in first.");
            socket.data.identity = await services.identity.verify(token);
            socket.data.account = null;
            next();
        } catch (error) {
            if (!isAppError(error)) logger.error({ err: error }, "Socket handshake failed");
            next(connectError(toApiError(error)));
        }
    });

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

        socket.use(([, ...args], next) => {
            events.consume(socket.data.identity.userId).then(
                () => next(),
                () => {
                    const ack = args.at(-1);
                    if (typeof ack === "function") {
                        ack(failure({ code: "rate_limited", message: "Too many requests. Try again shortly." }));
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
                        logger.warn({ err: error }, "Couldn't read balances at sign-in");
                    });
                services.swapHoldings
                    .refresh(account, socket.data.identity, "bind", (view) => socket.emit("swap:holdings", view))
                    .catch((error: unknown) => {
                        logger.warn({ err: error }, "Couldn't read swap holdings at sign-in");
                    });
                // Read and sent in the account's push order, so a settling push can't be overwritten by an older snapshot
                enqueue(account._id.toHexString(), async () => {
                    try {
                        socket.emit("positions", await services.predictions.positions(account));
                    } catch (error) {
                        logger.warn({ err: error }, "Couldn't read positions at sign-in");
                    }
                });
                enqueue(account._id.toHexString(), async () => {
                    try {
                        const recent = await services.swapOrders.recent(account._id);
                        socket.emit("swaps", { orders: recent.map(swapOrderView) });
                    } catch (error) {
                        logger.warn({ err: error }, "Couldn't read swaps at sign-in");
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

        socket.on("swap:holdings:refresh", (_payload, ack) =>
            reply(ack, async () =>
                services.swapHoldings.refresh(await boundAccount(socket), socket.data.identity, "click"),
            ),
        );

        socket.on("deposit:submit", (payload, ack) =>
            reply(ack, async () => {
                const { txHash } = parse(depositReport, payload);
                await reports.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many deposits reported. Try again shortly.");
                });
                return services.deposits.report(await boundAccount(socket), txHash);
            }),
        );

        socket.on("deposit:quote", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(coinWalletAmount, payload);
                await quotes.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many quotes. Try again shortly.");
                });
                const account = await boundAccount(socket);
                const wallet = await authorizedWallet(socket, input.wallet);
                return services.orders.preview(account, wallet, input.coin, input.amount);
            }),
        );

        socket.on("deposit:order", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(coinWalletAmount, payload);
                await orders.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many deposit orders. Try again shortly.");
                });
                const account = await boundAccount(socket);
                const wallet = await authorizedWallet(socket, input.wallet);
                const { order, txs } = await services.orders.create(account, wallet, input.coin, input.amount);
                return { order: orderView(order), txs: txs.map(sourceTxView) };
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
                await withdrawLimits.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many requests. Try again shortly.");
                });
                const { max, min } = await services.withdrawals.limits(await boundAccount(socket));
                return { max: formatUsdc(max), min: formatUsdc(min) };
            }),
        );

        socket.on("withdraw:create", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(withdrawRequest, payload);
                await withdrawals.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many withdrawals. Try again shortly.");
                });
                if (BASE58_ADDRESS.test(input.to)) {
                    throw new AppError(
                        "bad_request",
                        "USDC on Arc can't go to a Solana wallet. Link an EVM wallet to withdraw.",
                    );
                }
                const account = await boundAccount(socket);
                const to = (await services.identity.authorizeWallet(socket.data.identity, input.to)) as Address;
                const withdrawal = await services.withdrawals.create(account, { ...input, to });
                // Read after the debit, so it already has the amount taken
                const held = await services.accounts.findById(account._id);
                return { ...withdrawalView(withdrawal), account: accountView(held ?? account) };
            }),
        );

        socket.on("swap:quote", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(swapRequest, payload);
                await swapQuotes.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many quotes. Try again shortly.");
                });
                return services.swapOrders.quote(await boundAccount(socket), socket.data.identity, input);
            }),
        );

        socket.on("swap:order", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(swapOrder, payload);
                await swapOrders.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many swaps. Try again shortly.");
                });
                const ip = clientIp(
                    socket.handshake.headers["x-forwarded-for"],
                    socket.handshake.address,
                    config.TRUST_PROXY,
                );
                const { order, txs } = await services.swapOrders.create(
                    await boundAccount(socket),
                    socket.data.identity,
                    input,
                    ip,
                );
                return { order: swapOrderView(order), txs };
            }),
        );

        socket.on("swap:sent", (payload, ack) =>
            reply(ack, async () => {
                const input = parse(swapSent, payload);
                const order = await services.swapOrders.reportSent(
                    await boundAccount(socket),
                    input.orderId,
                    input.txHashes,
                );
                return swapOrderView(order);
            }),
        );

        socket.on("prediction:quote", (payload, ack) =>
            reply(ack, async () => {
                const selling = typeof payload === "object" && payload !== null && "positionId" in payload;
                const input = selling ? parse(sellQuote, payload) : parse(predictionQuote, payload);
                await predictionQuotes.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many quotes. Try again shortly.");
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
                await predictionOrders.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many predictions. Try again shortly.");
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
                await predictionOrders.consume(socket.data.identity.userId).catch(() => {
                    throw new AppError("rate_limited", "Too many predictions. Try again shortly.");
                });
                return services.predictions.close(await boundAccount(socket), input);
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
                    if (socket.data.identity.userId === account.privyUserId) socket.emit("deposit:credited", payload);
                    else socket.leave(roomOf(deposit.accountId));
                }
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
            });
    });

    bus.on("swap:holdings", ({ accountId, privyUserId, view }) => {
        void io
            .in(roomOf(accountId))
            .fetchSockets()
            .then((sockets) => {
                for (const socket of sockets) {
                    if (socket.data.identity.userId === privyUserId) socket.emit("swap:holdings", view);
                    else socket.leave(roomOf(accountId));
                }
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
                logger.warn({ err: error }, "Couldn't push an order update");
            }
        });
    });

    bus.on("swap:updated", ({ order }) => {
        enqueue(order.accountId.toHexString(), async () => {
            try {
                const room = roomOf(order.accountId);
                const owner = await services.accounts.findById(order.accountId);
                const payload = { order: swapOrderView(order) };
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === owner?.privyUserId) socket.emit("swap:update", payload);
                    else socket.leave(room);
                }
            } catch (error) {
                logger.warn({ err: error }, "Couldn't push a swap update");
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
                    if (socket.data.identity.userId === owner?.privyUserId) socket.emit("withdrawal:update", payload);
                    else socket.leave(room);
                }
            } catch (error) {
                logger.warn({ err: error }, "Couldn't push a withdrawal update");
            }
        });
    });

    bus.on("prediction:updated", (update) => {
        enqueue(update.account._id.toHexString(), async () => {
            try {
                const room = roomOf(update.account._id);
                const payload = predictionUpdate(update);
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === update.account.privyUserId)
                        socket.emit("prediction:update", payload);
                    else socket.leave(room);
                }
            } catch (error) {
                logger.warn({ err: error }, "Couldn't push a prediction update");
            }
        });
    });

    bus.on("position:settled", ({ position, account }) => {
        enqueue(account._id.toHexString(), async () => {
            try {
                const room = roomOf(account._id);
                const payload = { position: positionView(position), account: accountView(account) };
                for (const socket of await io.in(room).fetchSockets()) {
                    if (socket.data.identity.userId === account.privyUserId) socket.emit("position:settled", payload);
                    else socket.leave(room);
                }
            } catch (error) {
                logger.warn({ err: error }, "Couldn't push a settled position");
            }
        });
    });

    /** The wallet as the account knows it: Solana is turned away before Privy is asked, an EVM wallet must be linked. */
    async function authorizedWallet(socket: IoSocket, wallet: string) {
        if (BASE58_ADDRESS.test(wallet)) throw new AppError("bad_request", "Deposits from Solana aren't open yet.");
        return (await services.identity.authorizeWallet(socket.data.identity, wallet)) as Address;
    }

    async function boundAccount(socket: IoSocket) {
        const bound = socket.data.account;
        if (!bound) throw new AppError("wallet_not_connected", "Open your account first.");
        const account = await services.accounts.findById(bound.id);
        // The account belongs to another Privy user than this socket's.
        if (account && account.privyUserId !== socket.data.identity.userId) {
            await socket.leave(bound.room);
            socket.data.account = null;
        }
        if (!account || !socket.data.account) throw new AppError("wallet_not_connected", "Open your account first.");
        return account;
    }

    async function reply<T>(ack: unknown, work: () => Promise<T>) {
        // Every event is a request; one sent without an acknowledgement has nowhere to answer.
        if (typeof ack !== "function") return;
        try {
            ack({ ok: true, data: await work() } satisfies Ack<T>);
        } catch (error) {
            if (!isAppError(error)) logger.error({ err: error }, "Socket request failed");
            else if (error.status >= 500) logger.error({ err: error.cause ?? error }, error.message);
            ack(failure(toApiError(error)));
        }
    }

    return io;
}

const failure = (error: ApiError): Ack<never> => ({ ok: false, error });

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
