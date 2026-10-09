import { pino, type Logger } from "pino";
import type { Config } from "./config.ts";

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
    const pretty = config.NODE_ENV === "development" && process.stdout.isTTY;
    return pino({
        level: config.LOG_LEVEL,
        base: { service: "trade-everything-server" },
        redact: {
            paths: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.mnemonic"],
            censor: "[redacted]",
        },
        transport: pretty
            ? { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" } }
            : undefined,
    });
}
