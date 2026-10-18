import { pino, stdSerializers, type DestinationStream, type Logger } from "pino";
import type { Config } from "./config.ts";

/** Field names whose values never reach a log, at the top of a log object or one level down. */
const SECRETS = [
    "token",
    "accessToken",
    "refreshToken",
    "mnemonic",
    "seed",
    "privateKey",
    "secret",
    "apiKey",
    "apiSecret",
    "passphrase",
    "password",
    "authorization",
    "cookie",
];

/** A URL cut to its host: an RPC or API URL can carry the provider's key in its path or query. */
const hostOnly = (url: string) => {
    try {
        return `${new URL(url).origin}/***`;
    } catch {
        return "[url]";
    }
};

/** Text with every URL cut to its host and any request body dropped, as viem and fetch put both in their messages. */
export const scrubUrls = (text: string) =>
    text.replace(/^\s*Request body:.*$/gim, "").replace(/https?:\/\/[^\s"'<>)]+/g, hostOnly);

type Serialized = Record<string, unknown>;

/** An error as pino writes it, with no provider key in any URL and no request body, down the whole cause chain. */
export function serializeError(error: unknown): unknown {
    const out = stdSerializers.err(error as Error) as Serialized | undefined;
    if (!out || typeof out !== "object") return out;
    return scrubError(out);
}

function scrubError(out: Serialized): Serialized {
    for (const key of ["message", "stack", "shortMessage", "details", "url"]) {
        if (typeof out[key] === "string") out[key] = scrubUrls(out[key]);
    }
    if (Array.isArray(out.metaMessages)) out.metaMessages = out.metaMessages.map((line) => scrubUrls(String(line)));
    delete out.body;
    delete out.headers;
    if (out.cause && typeof out.cause === "object") out.cause = scrubError(out.cause as Serialized);
    return out;
}

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">, destination?: DestinationStream): Logger {
    const pretty = config.NODE_ENV === "development" && process.stdout.isTTY;
    return pino(
        {
            level: config.LOG_LEVEL,
            base: { service: "least-finance-server" },
            serializers: { err: serializeError },
            redact: {
                paths: [
                    ...["authorization", "cookie", "x-api-key", "x-auth-token", "proxy-authorization"].map(
                        (name) => `req.headers["${name}"]`,
                    ),
                    'res.headers["set-cookie"]',
                    ...SECRETS,
                    ...SECRETS.map((name) => `*.${name}`),
                    ...SECRETS.map((name) => `*.*.${name}`),
                ],
                censor: "[redacted]",
            },
            transport: pretty
                ? {
                      target: "pino-pretty",
                      options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" },
                  }
                : undefined,
        },
        destination,
    );
}
