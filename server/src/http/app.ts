import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Identity } from "../auth/identity.ts";
import { scrubUrls } from "../logger.ts";
import { AppError, toApiError } from "../errors.ts";
import { describeUpstream } from "../markets/upstream.ts";
import { outageLog } from "../log-throttle.ts";
import type { ApiError, PoolState } from "../protocol.ts";
import type { Services } from "../services.ts";
import {
    depositPage,
    depositReport,
    marketHistoryQuery,
    marketId,
    marketSearch,
    parse,
    priceHistory,
} from "../validation.ts";

const REQUEST_ID = /^[\w.:-]{1,64}$/;

/** A URL without its query string, which can carry tokens. */
const pathOf = (url = "") => url.split("?")[0]!;

/** Answers a refused request and logs it once, with what the person was told and why; the access log then stays quiet. */
/** How /health reports the prediction pool: ready only while it can take an order. */
const predictionsHealth = (state: PoolState) =>
    state === "open" ? "ready" : state === "off" ? "off" : state === "unread" ? "unavailable" : "paused";

function refuse(
    req: Request,
    res: Response,
    status: number,
    error: ApiError,
    fields: Record<string, unknown>,
    msg: string,
) {
    res.status(status).json(errorBody(error));
    res.locals.logged = true;
    const startedAt = res.locals.startedAt as number | undefined;
    req.log.warn(
        {
            ...fields,
            res,
            responseTime: startedAt ? Date.now() - startedAt : undefined,
            accountId: (res.locals.identity as Identity | undefined)?.userId,
        },
        msg,
    );
}

/** The HTTP API. Everything under /v1 needs a Privy access token as a Bearer token. */
export function createApp(services: Services): express.Express {
    const { config, logger } = services;
    // Probes and charts ask again every few seconds while a source is down, so that is said when it starts, once an hour, and when it clears
    const outage = outageLog(logger);
    const app = express();
    app.disable("x-powered-by");
    // A hop count, never `true`: trusting every X-Forwarded-For would let clients pick their own IP.
    app.set("trust proxy", config.TRUST_PROXY);

    app.use((_req, res, next) => {
        res.locals.startedAt = Date.now();
        next();
    });
    app.use(
        pinoHttp({
            logger,
            genReqId: (req, res) => {
                const given = req.headers["x-request-id"];
                const id = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
                res.setHeader("X-Request-Id", id);
                return id;
            },
            // A success writes nothing; a failure the error handler already logged writes nothing more
            customLogLevel: (_req, res, error) =>
                res.locals.logged
                    ? "silent"
                    : error || res.statusCode >= 500
                      ? "error"
                      : res.statusCode >= 400
                        ? "warn"
                        : "silent",
            customSuccessMessage: (req, res) => `${req.method} ${pathOf(req.url)} answered ${res.statusCode}`,
            customErrorMessage: (req, res) => `${req.method} ${pathOf(req.url)} failed with ${res.statusCode}`,
            // Only what finding a request takes: no headers, no query string, no body
            serializers: {
                req: (req: { id: unknown; method: string; url: string }) => ({
                    id: req.id,
                    method: req.method,
                    path: pathOf(req.url),
                }),
                res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
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

    app.get("/ready", async (req, res) => {
        const scan = services.watcher.status();
        const scanAge = scan.lastSuccessAt === null ? null : Date.now() - scan.lastSuccessAt.getTime();
        const scanFresh = scanAge !== null && scanAge < 60_000;
        const database = await services.database.db
            .command({ ping: 1 })
            .then(() => {
                outage.ok("database", "MongoDB answers pings again");
                return true;
            })
            .catch((error: unknown) => {
                outage.failed(
                    "database",
                    "warn",
                    { err: error, event: "ready.database_ping" },
                    "MongoDB didn't answer a ping",
                );
                return false;
            });
        const ready = database && scanFresh;
        // What is wrong, in words, so a 503 explains itself
        const reasons = [
            ...(database ? [] : ["The database didn't answer."]),
            ...(scanFresh
                ? []
                : [
                      scanAge === null
                          ? "The deposit scan hasn't succeeded since the server started."
                          : `The deposit scan last succeeded ${Math.round(scanAge / 1000)} seconds ago.`,
                  ]),
        ];
        res.status(ready ? 200 : 503).json({
            status: ready ? "ready" : "degraded",
            reasons,
            database,
            // Reported, not a reason to take the server out of rotation: signed-in people don't need Privy.
            privy: services.identity.apiState(),
            predictions:
                services.config.PREDICTIONS_TRADING !== "on"
                    ? "off"
                    : predictionsHealth(services.predictions.pool().state),
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
    /** Logs a failed Polymarket read once, with which route and what it asked, and answers with the cause in plain words. */
    const unavailable =
        (req: express.Request, what: string, asked: Record<string, unknown>, log = true) =>
        (error: unknown): never => {
            const { message, level, fields } = describeUpstream(error);
            if (log)
                req.log[level]({ ...fields, ...asked, requestId: req.id, err: error }, `Polymarket ${what} failed`);
            throw new AppError("unavailable", message, { cause: error, logged: true });
        };

    app.get("/markets/trending", noStore, limit(120, 60_000), (_req, res) => {
        res.json(services.markets.trending());
    });

    app.get("/markets/search", noStore, limit(60, 60_000), async (req, res) => {
        const { q } = parse(marketSearch, req.query);
        res.json(await services.markets.search(q).catch(unavailable(req, "search", { route: "markets.search", q })));
    });

    app.get("/markets/:eventId", noStore, limit(120, 60_000), async (req, res) => {
        const id = parse(marketId, req.params.eventId);
        const market = await services.markets
            .event(id)
            .catch(unavailable(req, "market read", { route: "markets.event", eventId: id }));
        if (!market) throw new AppError("not_found", "That market isn't available.");
        res.json(market);
    });

    // Public: the swap coins and their prices are the same for everyone.
    app.get("/markets/:eventId/history", noStore, limit(120, 60_000), async (req, res) => {
        const id = parse(marketId, req.params.eventId);
        const { outcomes } = parse(marketHistoryQuery, req.query);
        const view = await services.marketHistory
            .view(id, outcomes)
            // The history service already logged the failed read, once for everyone waiting on it
            .catch(unavailable(req, "price history read", {}, false));
        if (!view) throw new AppError("not_found", "That market isn't available.");
        res.json(view);
    });

    app.get("/swaps/catalog", noStore, limit(120, 60_000), (_req, res) => {
        res.json(services.swapCatalog.view());
    });

    // Public: the markets and their leverage caps are the same for everyone.
    app.get("/perps/markets", noStore, limit(120, 60_000), (_req, res) => {
        res.json(services.perpMarkets.view());
    });

    // Public: the same for everyone, and it's only DefiLlama's and Hyperliquid's public prices.
    // The browser never calls either itself.
    app.get("/prices/history", noStore, limit(120, 60_000), async (req, res) => {
        const { range, coins } = parse(priceHistory, req.query);
        const view = await services.priceHistory.view(range, coins);
        if (view) outage.ok(`prices.history:${range}`, "Price history is ready again", { range });
        if (!view) {
            outage.failed(
                `prices.history:${range}`,
                "warn",
                { event: "prices.history", path: req.path, range, coins: (coins ?? []).slice(0, 8) },
                "No price history is ready for this range yet",
            );
            throw new AppError(
                "unavailable",
                "The price source hasn't answered yet, so this chart isn't ready. It retries on its own.",
            );
        }
        // A range changes every few minutes at most, so a minute in the browser misses nothing;
        // a coin left without points (its read failed) or left out (not listed yet) is asked for again soon.
        const answered = new Set(view.coins.map((coin) => coin.symbol.toLowerCase()));
        const complete =
            (coins ?? []).every((name) => answered.has(name.toLowerCase())) &&
            view.coins.every((coin) => coin.points.length > 0);
        res.set("Cache-Control", complete ? "public, max-age=60" : "public, max-age=5");
        res.json(view);
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

    app.use((req) => {
        const path = pathOf(req.originalUrl).slice(0, 80);
        throw new AppError("not_found", `No such endpoint: ${req.method} ${path}.`, { detail: "no_route" });
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
        handler: (req, res, _next, options) => {
            const wait = Number(res.getHeader("Retry-After"));
            const seconds = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : Math.ceil(windowMs / 1000);
            refuse(
                req,
                res,
                429,
                {
                    code: "rate_limited",
                    message: `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
                },
                {
                    event: "http.rate_limited",
                    code: "rate_limited",
                    ip: req.ip,
                    limit: options.limit,
                    retryInSeconds: seconds,
                },
                `Rate limited ${req.method} ${pathOf(req.originalUrl)}`,
            );
        },
    });
}

function authenticate(services: Services): RequestHandler {
    return async (req, res, next) => {
        const token = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
        if (!token) {
            throw new AppError("unauthorized", "Your session expired. Sign in again.", { detail: "no_token" });
        }
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
        const message =
            bodyError === "entity.too.large"
                ? "The request was larger than 16 KB."
                : bodyError === "entity.parse.failed"
                  ? "The request wasn't valid JSON."
                  : "The request body couldn't be read.";
        refuse(
            req,
            res,
            status,
            { code: "bad_request", message },
            { event: "http.bad_body", code: "bad_request", type: bodyError, length: req.get("content-length") },
            `Refused ${req.method} ${pathOf(req.originalUrl)}: ${message}`,
        );
        return;
    }
    if (error instanceof AppError) {
        const cause = error.cause ?? error;
        // An unexpected internal error carries the ref, like any other, so the person can quote it
        const ref = error.status >= 500 && error.code === "internal" ? String(req.id).slice(0, 8) : undefined;
        if (error.logged) {
            res.locals.logged = true;
            res.status(error.status).json(errorBody(toApiError(error, ref)));
            return;
        }
        if (error.status >= 500) {
            res.locals.logged = true;
            req.log.error(
                { err: cause, code: error.code, detail: error.detail, ref },
                `${error.message} (${req.method} ${pathOf(req.originalUrl)})`,
            );
            res.status(error.status).json(errorBody(toApiError(error, ref)));
            return;
        }
        refuse(
            req,
            res,
            error.status,
            toApiError(error),
            {
                code: error.code,
                reason: scrubUrls(error.message),
                detail: error.detail,
                cause:
                    error.cause instanceof Error ? scrubUrls(`${error.cause.name}: ${error.cause.message}`) : undefined,
            },
            `Refused ${req.method} ${pathOf(req.originalUrl)}`,
        );
        return;
    }
    // The ref is the head of the request id, which every log line of this request carries
    const ref = String(req.id).slice(0, 8);
    res.locals.logged = true;
    req.log.error({ err: error, ref }, `Unexpected error in ${req.method} ${pathOf(req.originalUrl)}`);
    res.status(500).json(errorBody(toApiError(error, ref)));
};
