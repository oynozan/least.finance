import { pino, type DestinationStream, type Logger } from "pino";
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

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">, destination?: DestinationStream): Logger {
    const pretty = config.NODE_ENV === "development" && process.stdout.isTTY;
    return pino(
        {
            level: config.LOG_LEVEL,
            base: { service: "least-finance-server" },
            redact: {
                paths: [
                    ...["authorization", "cookie", "x-api-key", "x-auth-token", "proxy-authorization"].map(
                        (name) => `req.headers["${name}"]`,
                    ),
                    'res.headers["set-cookie"]',
                    ...SECRETS,
                    ...SECRETS.map((name) => `*.${name}`),
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
