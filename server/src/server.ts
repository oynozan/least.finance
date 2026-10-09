import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { AccountService } from "./accounts/accounts.ts";
import { createKeyring } from "./accounts/keyring.ts";
import { PrivyIdentity, type IdentityProvider } from "./auth/identity.ts";
import { ARC_CHAIN_ID, assertArc, createArcClient } from "./chain/arc.ts";
import type { Config } from "./config.ts";
import { connectDatabase } from "./db/mongo.ts";
import { formatUsdc } from "./db/money.ts";
import { DepositService } from "./deposits/deposits.ts";
import { Ledger } from "./deposits/ledger.ts";
import { DepositRegistry } from "./deposits/registry.ts";
import { DepositWatcher } from "./deposits/watcher.ts";
import { Bus } from "./events.ts";
import { createApp } from "./http/app.ts";
import type { Services } from "./services.ts";
import { Sessions } from "./sessions.ts";
import { attachSockets } from "./socket/sockets.ts";

export type RunningServer = {
    /** Where it's listening, e.g. http://127.0.0.1:4000. */
    url: string;
    services: Services;
    close(): Promise<void>;
};

type Overrides = {
    /** Stands in for Privy, for tests that don't run a fake Privy API. */
    identity?: IdentityProvider;
};

/** Connects everything, starts listening and starts the deposit scan. */
export async function startServer(config: Config, logger: Logger, overrides: Overrides = {}): Promise<RunningServer> {
    const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
    try {
        const client = createArcClient(config.ARC_RPC_URLS);
        await assertArc(client);

        const { collections } = database;
        const bus = new Bus();
        const registry = new DepositRegistry(collections.accounts);
        await registry.load();
        const ledger = new Ledger({
            client: database.client,
            collections,
            bus,
            logger,
            minDeposit: config.DEPOSIT_MIN_USDC,
        });
        const identity =
            overrides.identity ??
            new PrivyIdentity({
                appId: config.PRIVY_APP_ID,
                appSecret: config.PRIVY_APP_SECRET,
                verificationKey: config.PRIVY_VERIFICATION_KEY,
                apiUrl: config.PRIVY_API_URL,
                logger,
            });
        const accounts = new AccountService({
            collections,
            keyring: createKeyring(config.DEPOSIT_MNEMONIC),
            registry,
            headBlock: async () => Number(await client.getBlockNumber()),
        });
        const deposits = new DepositService({
            client,
            collections,
            ledger,
            confirmations: config.DEPOSIT_CONFIRMATIONS,
            receiptTimeoutMs: config.DEPOSIT_RECEIPT_TIMEOUT_MS,
        });
        const sessions = new Sessions({
            identity,
            accounts,
            deposits,
            rules: { chainId: ARC_CHAIN_ID, minDeposit: formatUsdc(config.DEPOSIT_MIN_USDC) },
        });
        const watcher = new DepositWatcher({
            client,
            collections,
            registry,
            ledger,
            logger: logger.child({ component: "deposit-scan" }),
            pollMs: config.DEPOSIT_POLL_MS,
            confirmations: config.DEPOSIT_CONFIRMATIONS,
            scanRange: config.DEPOSIT_SCAN_RANGE,
            startBlock: config.DEPOSIT_START_BLOCK,
        });
        const services: Services = { config, logger, database, bus, identity, accounts, deposits, sessions, watcher };

        const httpServer = createServer(createApp(services));
        httpServer.headersTimeout = 20_000;
        const io = attachSockets(httpServer, services);
        await listen(httpServer, config.PORT, config.HOST);
        watcher.start();

        const { address, port } = httpServer.address() as AddressInfo;
        const host = address.includes(":") ? `[${address}]` : address;
        return {
            url: `http://${host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host}:${port}`,
            services,
            async close() {
                await watcher.stop();
                // Closes the HTTP server too; idle keep-alive connections would hold it open.
                httpServer.closeIdleConnections();
                const forced = setTimeout(() => httpServer.closeAllConnections(), 5_000).unref();
                await io.close();
                clearTimeout(forced);
                await database.close();
            },
        };
    } catch (error) {
        await database.close();
        throw error;
    }
}

function listen(server: HttpServer, port: number, host: string) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
}
