import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Identity } from "../auth/identity.ts";
import { AppError, toApiError } from "../errors.ts";
import type { ApiError } from "../protocol.ts";
import type { Services } from "../services.ts";
import { depositPage, depositReport, marketId, marketSearch, parse } from "../validation.ts";

const REQUEST_ID = /^[\w.:-]{1,64}$/;

/** The HTTP API. Everything under /v1 needs a Privy access token as a Bearer token. */
export function createApp(services: Services): express.Express {
    const { config, logger } = services;
    const app = express();
    app.disable("x-powered-by");
    // A hop count, never `true`: trusting every X-Forwarded-For would let clients pick their own IP.
    app.set("trust proxy", config.TRUST_PROXY);

    app.use(
        pinoHttp({
            logger,
            genReqId: (req, res) => {
                const given = req.headers["x-request-id"];
                const id = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
                res.setHeader("X-Request-Id", id);
                return id;
            },
            customLogLevel: (_req, res, error) =>
                error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
            autoLogging: { ignore: (req) => req.url === "/health" },
        }),
    );
    app.use(
        helmet({
            // A JSON API serves nothing a browser should render or frame.
            contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
            // The web app reads these responses from another origin.
            crossOriginResourcePolicy: { policy: "cross-origin" },
        }),
    );
    const origins = new Set(config.CORS_ORIGINS);
    app.use(
        cors({
            origin: (origin, done) => done(null, !origin || origins.has(origin)),
            methods: ["GET", "POST"],
            allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
            exposedHeaders: ["X-Request-Id", "RateLimit", "RateLimit-Policy", "Retry-After"],
            maxAge: 600,
        }),
    );
    app.use(limit(300, 60_000));
    app.use(express.json({ limit: "16kb" }));

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    app.get("/ready", async (_req, res) => {
        const scan = services.watcher.status();
        const scanFresh = scan.lastSuccessAt !== null && Date.now() - scan.lastSuccessAt.getTime() < 60_000;
        const database = await services.database.db
            .command({ ping: 1 })
            .then(() => true)
            .catch(() => false);
        const ready = database && scanFresh;
        res.status(ready ? 200 : 503).json({
            status: ready ? "ready" : "degraded",
            database,
            // Reported, not a reason to take the server out of rotation: signed-in people don't need Privy.
            privy: services.identity.apiState(),
            depositScan: {
                ...scan,
                lagBlocks: scan.head !== null && scan.scannedThrough !== null ? scan.head - scan.scannedThrough : null,
            },
        });
    });

    // Public: the list is the same for everyone, and it's only Polymarket's data.
    const noStore: RequestHandler = (_req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    };
    const unavailable = () => new AppError("unavailable", "Markets are unavailable right now. Try again shortly.");

    app.get("/markets/trending", noStore, limit(120, 60_000), (_req, res) => {
        res.json(services.markets.trending());
    });

    app.get("/markets/search", noStore, limit(60, 60_000), async (req, res) => {
        const { q } = parse(marketSearch, req.query);
        res.json(
            await services.markets.search(q).catch((error: unknown) => {
                req.log.warn({ err: error }, "Market search failed");
                throw unavailable();
            }),
        );
    });

    app.get("/markets/:eventId", noStore, limit(120, 60_000), async (req, res) => {
        const id = parse(marketId, req.params.eventId);
        const market = await services.markets.event(id).catch((error: unknown) => {
            req.log.warn({ err: error }, "Market read failed");
            throw unavailable();
        });
        if (!market) throw new AppError("not_found", "That market isn't available.");
        res.json(market);
    });

    const v1 = express.Router();
    v1.use(authenticate(services));

    v1.post("/account", limit(30, 60_000), async (_req, res) => {
        const account = await services.sessions.open(identityOf(res));
        res.json(await services.sessions.describe(account));
    });

    v1.get("/account", async (_req, res) => {
        const account = await services.sessions.existing(identityOf(res));
        res.json((await services.sessions.describe(account)).account);
    });

    v1.get("/account/deposits", async (req, res) => {
        const account = await services.sessions.existing(identityOf(res));
        res.json(await services.deposits.list(account, parse(depositPage, req.query)));
    });

    v1.post("/account/deposits", limit(30, 60_000), async (req, res) => {
        const account = await services.sessions.existing(identityOf(res));
        const { txHash } = parse(depositReport, req.body);
        res.json(await services.deposits.report(account, txHash));
    });

    app.use("/v1", v1);

    app.use(() => {
        throw new AppError("not_found", "There's nothing here.");
    });
    app.use(errorHandler);
    return app;
}

function limit(requests: number, windowMs: number) {
    return rateLimit({
        windowMs,
        limit: requests,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json(errorBody({ code: "rate_limited", message: "Too many requests. Try again shortly." }));
        },
    });
}

function authenticate(services: Services): RequestHandler {
    return async (req, res, next) => {
        const token = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
        if (!token) throw new AppError("unauthorized", "Sign in first.");
        res.locals.identity = await services.identity.verify(token);
        next();
    };
}

const identityOf = (res: Response) => res.locals.identity as Identity;

const errorBody = (error: ApiError) => ({ error });

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    // Body parser failures carry their own status: malformed JSON, or a body over the limit.
    const status = (error as { status?: unknown }).status;
    const bodyError = (error as { type?: unknown }).type;
    if (typeof bodyError === "string" && typeof status === "number" && status >= 400 && status < 500) {
        res.status(status).json(
            errorBody({ code: "bad_request", message: "The request body isn't valid JSON, or is too large." }),
        );
        return;
    }
    if (error instanceof AppError) {
        if (error.status >= 500) req.log.error({ err: error.cause ?? error }, error.message);
        res.status(error.status).json(errorBody(toApiError(error)));
        return;
    }
    req.log.error({ err: error }, "Unhandled error");
    res.status(500).json(errorBody(toApiError(error)));
};
