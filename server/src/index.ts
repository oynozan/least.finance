import { ConfigError, loadConfig, publicRpcWarnings } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startServer, type RunningServer } from "./server.ts";

const config = (() => {
    try {
        return loadConfig();
    } catch (error) {
        // A mistake in the environment needs the lines, not a stack
        if (error instanceof ConfigError) {
            console.error(error.message);
            process.exit(1);
        }
        throw error;
    }
})();
const logger = createLogger(config);
for (const warning of publicRpcWarnings(config)) logger.warn(warning);

let server: RunningServer | undefined;
let stopping = false;

async function shutdown(signal: string, code = 0) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Shutting down");
    // Whatever's still open after this long is cut off.
    setTimeout(() => process.exit(code || 1), 10_000).unref();
    try {
        await server?.close();
    } catch (error) {
        logger.error({ err: error }, "Shutdown failed");
        code ||= 1;
    }
    process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Every order, withdrawal and deposit is stored in MongoDB before work on it starts, and each loop picks up where it
// stopped, so one stray rejection is logged for the owner to fix and does not stop everyone's trades.
process.on("unhandledRejection", (reason) => {
    const err =
        reason instanceof Error ? reason : new Error(`Rejected with ${JSON.stringify(reason) ?? String(reason)}`);
    logger.error({ err, event: "process.unhandled_rejection" }, "A promise was rejected and nothing handled it");
});
process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    process.exit(1);
});

try {
    server = await startServer(config, logger);
    logger.info({ url: server.url, db: config.MONGODB_DB }, "Server listening");
} catch (error) {
    logger.fatal({ err: error }, "Server failed to start");
    process.exit(1);
}
