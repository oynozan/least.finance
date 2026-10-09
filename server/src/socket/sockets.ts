import type { Server as HttpServer } from "node:http";
import type { ObjectId } from "mongodb";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { Server, type Socket } from "socket.io";
import type { Identity } from "../auth/identity.ts";
import { accountView, depositView } from "../deposits/views.ts";
import { AppError, isAppError, toApiError } from "../errors.ts";
import type { Ack, ApiError, ClientToServerEvents, HandshakeAuth, ServerToClientEvents } from "../protocol.ts";
import type { Services } from "../services.ts";
import { connectWallet, depositPage, depositReport, parse } from "../validation.ts";

type SocketData = {
    identity: Identity;
    /** The account `wallet:connect` bound this socket to. */
    account: { id: ObjectId; room: string } | null;
};

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** setTimeout fires at once past this many milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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

    const handshakes = new RateLimiterMemory({ keyPrefix: "handshake", points: 30, duration: 60 });
    const events = new RateLimiterMemory({ keyPrefix: "event", points: 40, duration: 10 });
    // Reports make the server watch the chain for a while, so they get a tighter limit of their own.
    const reports = new RateLimiterMemory({ keyPrefix: "report", points: 20, duration: 60 });

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

        socket.on("wallet:connect", (payload, ack) =>
            reply(ack, async () => {
                const { address } = parse(connectWallet, payload);
                const account = await services.sessions.open(socket.data.identity, address);
                const room = roomOf(account._id);
                const previous = socket.data.account;
                if (previous && previous.room !== room) await socket.leave(previous.room);
                // Joined before reading the account, so a deposit credited meanwhile is pushed, not lost.
                await socket.join(room);
                socket.data.account = { id: account._id, room };
                return services.sessions.describe(account);
            }),
        );

        socket.on("deposits:list", (payload, ack) =>
            reply(ack, async () => services.deposits.list(await boundAccount(socket), parse(depositPage, payload))),
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
    });

    bus.on("deposit:credited", ({ deposit, account }) => {
        const payload = { deposit: depositView(deposit), account: accountView(account) };
        // Only to the wallet's current owner: a socket bound before the wallet moved to another user gets nothing.
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

    async function boundAccount(socket: IoSocket) {
        const bound = socket.data.account;
        if (!bound) throw new AppError("wallet_not_connected", "Connect a wallet first.");
        const account = await services.accounts.findById(bound.id);
        // The wallet has since been verified for another Privy user, who owns the account now.
        if (account && account.privyUserId !== socket.data.identity.userId) {
            await socket.leave(bound.room);
            socket.data.account = null;
        }
        if (!account || !socket.data.account) throw new AppError("wallet_not_connected", "Connect a wallet first.");
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
