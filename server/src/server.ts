import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { AccountService } from "./accounts/accounts.ts";
import { WalletBalances } from "./balances/wallet-balances.ts";
import { createKeyring } from "./accounts/keyring.ts";
import { PrivyIdentity, type IdentityProvider } from "./auth/identity.ts";
import { ARC_CHAIN_ID, assertArc, createArcClient } from "./chain/arc.ts";
import type { Config } from "./config.ts";
import { DepositOrders } from "./crosschain/orders.ts";
import { OrderTracker } from "./crosschain/tracker.ts";
import { createAcross } from "./crosschain/providers/across.ts";
import { createRelay } from "./crosschain/providers/relay.ts";
import type { BridgeProvider } from "./crosschain/providers/types.ts";
import { readBalances } from "./crosschain/balances.ts";
import { createSourceClients, type SourceClients } from "./crosschain/chains.ts";
import { lifiPrices, type PriceFeed } from "./crosschain/prices.ts";
import { createSolanaRpc, readSolanaBalances, type SolanaRpc } from "./crosschain/solana.ts";
import { connectDatabase } from "./db/mongo.ts";
import { formatUsdc } from "./db/money.ts";
import { DepositService } from "./deposits/deposits.ts";
import { Ledger } from "./deposits/ledger.ts";
import { DepositRegistry } from "./deposits/registry.ts";
import { DepositWatcher } from "./deposits/watcher.ts";
import { Bus } from "./events.ts";
import { MarketService } from "./markets/markets.ts";
import { PredictionService } from "./predictions/predictions.ts";
import { createPolymarketTrader } from "./predictions/polymarket-trader.ts";
import { PredictionReconciler } from "./predictions/reconciler.ts";
import { PredictionRedeemer } from "./predictions/redeemer.ts";
import { PredictionResolver } from "./predictions/resolver.ts";
import { PredictionTracker } from "./predictions/tracker.ts";
import { traderNeeded, withTimeouts, type PoolTrader } from "./predictions/trader.ts";
import { createPolymarketData } from "./markets/polymarket-data.ts";
import { createApp } from "./http/app.ts";
import type { Services } from "./services.ts";
import { Sessions } from "./sessions.ts";
import { attachSockets } from "./socket/sockets.ts";

const TRADER_RETRY_MS = 60_000;
const REDEEM_MS = 60_000;
const RECONCILE_MS = 600_000;

/** Short of the tracker giving up on a missing post, so a hung post is still followed up. */
const TRADER_CALL_MS = 30_000;

export type RunningServer = {
    /** Where it's listening, e.g. http://127.0.0.1:4000. */
    url: string;
    services: Services;
    /** Runs one resolver pass at once; for tests. */
    resolveNow(): Promise<void>;
    close(): Promise<void>;
};

type Overrides = {
    /** Stands in for Privy, for tests that don't run a fake Privy API. */
    identity?: IdentityProvider;
    /** Stand-ins for the Ethereum and BNB Chain RPCs, the Solana RPC and the price feed. */
    sources?: SourceClients;
    solana?: SolanaRpc;
    prices?: PriceFeed;
    /** The bridges that quote deposits; Relay and Across by default. */
    bridges?: BridgeProvider[];
    /** Stands in for the pool's Polymarket trader. */
    trader?: PoolTrader;
    /** The clock the balance refresh limit runs on. */
    now?: () => number;
};

/** Connects everything, starts listening and starts the deposit scan. */
export async function startServer(config: Config, logger: Logger, overrides: Overrides = {}): Promise<RunningServer> {
    const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
    logger.info(database.migration, "Account migration done");
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
            (await PrivyIdentity.create({
                appId: config.PRIVY_APP_ID,
                appSecret: config.PRIVY_APP_SECRET,
                verificationKey: config.PRIVY_VERIFICATION_KEY,
                apiUrl: config.PRIVY_API_URL,
                logger,
            }));
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
        const bridges = overrides.bridges ?? [
            createRelay({ apiKey: config.RELAY_API_KEY }),
            createAcross({ apiKey: config.ACROSS_API_KEY, integratorId: config.ACROSS_INTEGRATOR_ID }),
        ];
        const orders = new DepositOrders({ collections, bus, providers: bridges });
        const sessions = new Sessions({
            accounts,
            deposits,
            orders,
            rules: { chainId: ARC_CHAIN_ID, minDeposit: formatUsdc(config.DEPOSIT_MIN_USDC) },
        });
        const watcher = new DepositWatcher({
            clients: config.ARC_RPC_URLS.map((url) => createArcClient([url])),
            collections,
            registry,
            ledger,
            logger: logger.child({ component: "deposit-scan" }),
            pollMs: config.DEPOSIT_POLL_MS,
            confirmations: config.DEPOSIT_CONFIRMATIONS,
            lagBlocks: config.DEPOSIT_SCAN_LAG_BLOCKS,
            scanRange: config.DEPOSIT_SCAN_RANGE,
            startBlock: config.DEPOSIT_START_BLOCK,
        });
        const sources =
            overrides.sources ?? createSourceClients({ ethereum: config.ETHEREUM_RPC_URLS, bnb: config.BNB_RPC_URLS });
        const tracker = new OrderTracker({
            collections,
            providers: bridges,
            sources,
            bus,
            logger: logger.child({ component: "order-tracker" }),
            pollMs: config.ORDER_POLL_MS,
            announced: (orderId) => orders.announced(orderId),
        });
        const solana = overrides.solana ?? createSolanaRpc(config.SOLANA_RPC_URLS);
        const prices = overrides.prices ?? lifiPrices();
        const balances = new WalletBalances({
            identity,
            bus,
            logger: logger.child({ component: "balances" }),
            readEvm: (owner) => readBalances({ sources, arc: client, prices }, owner),
            readSolana: (owner) => readSolanaBalances({ solana, prices }, owner),
            now: overrides.now,
        });
        const marketLogger = logger.child({ component: "markets" });
        const predictionLogger = logger.child({ component: "predictions" });
        let trader: PoolTrader | null = overrides.trader ?? null;
        const polymarket = createPolymarketData({
            gammaUrl: config.POLYMARKET_GAMMA_URL,
            clobUrl: config.POLYMARKET_CLOB_URL,
            logger: marketLogger,
        });
        const markets = new MarketService({
            data: polymarket,
            logger: marketLogger,
            syncMs: config.MARKETS_SYNC_MS,
            // Read lazily: the service below needs the markets, so it's built after them
            maxOrderUSD: (): number | null => service.maxOrderUSD(),
        });
        const service = new PredictionService({
            collections,
            ledger,
            markets,
            trader: () => trader,
            bus,
            logger: predictionLogger,
            config,
        });
        const predictionTracker = new PredictionTracker({
            collections,
            service,
            trader: () => trader,
            logger: predictionLogger,
            pollMs: config.PREDICTIONS_POLL_MS,
        });
        const predictionResolver = new PredictionResolver({
            collections,
            ledger,
            data: polymarket,
            bus,
            logger: predictionLogger,
            resolveMs: config.PREDICTIONS_RESOLVE_MS,
        });
        const predictionRedeemer = new PredictionRedeemer({
            collections,
            service,
            trader: () => trader,
            logger: predictionLogger,
            intervalMs: REDEEM_MS,
        });
        const predictionReconciler = new PredictionReconciler({
            collections,
            trader: () => trader,
            logger: predictionLogger,
            intervalMs: RECONCILE_MS,
        });
        // Orders a restart left placing never reached Polymarket; refund them before anyone can order
        await service.recover();
        let connecting: NodeJS.Timeout | null = null;
        let closed = false;
        const connectTrader = () => {
            createPolymarketTrader(config, predictionLogger).then(
                (created) => {
                    trader = withTimeouts(created, TRADER_CALL_MS);
                    void service.refreshFloat().catch((error: unknown) => {
                        predictionLogger.warn({ err: error }, "Couldn't read the pool's float");
                    });
                },
                (error: unknown) => {
                    predictionLogger.error({ err: error }, "Couldn't connect to Polymarket, retrying in a minute");
                    if (!closed) connecting = setTimeout(connectTrader, TRADER_RETRY_MS);
                },
            );
        };
        const services: Services = {
            config,
            logger,
            database,
            bus,
            identity,
            accounts,
            deposits,
            sessions,
            watcher,
            balances,
            orders,
            markets,
            predictions: service,
        };

        const httpServer = createServer(createApp(services));
        httpServer.headersTimeout = 20_000;
        const io = attachSockets(httpServer, services);
        await listen(httpServer, config.PORT, config.HOST);
        watcher.start();
        tracker.start();
        markets.start();
        predictionTracker.start();
        predictionResolver.start();
        predictionRedeemer.start();
        predictionReconciler.start();
        // Posted orders and unconfirmed redemptions need the trader even once trading is switched off
        const [posted, redeeming] = await Promise.all([
            collections.predictionOrders.countDocuments({ state: "posted" }),
            collections.predictionRedemptions.countDocuments({ state: { $ne: "confirmed" } }),
        ]);
        if (traderNeeded(config, posted + redeeming) && !trader) connectTrader();
        // A bad secret is logged loudly, but the server keeps serving: wallets already connected carry on.
        void identity.checkApi();

        const { address, port } = httpServer.address() as AddressInfo;
        const host = address.includes(":") ? `[${address}]` : address;
        return {
            url: `http://${host === "0.0.0.0" || host === "[::]" ? "127.0.0.1" : host}:${port}`,
            services,
            resolveNow: () => predictionResolver.tick(),
            async close() {
                closed = true;
                if (connecting) clearTimeout(connecting);
                await predictionReconciler.stop();
                await predictionRedeemer.stop();
                await predictionResolver.stop();
                await predictionTracker.stop();
                await markets.stop();
                await tracker.stop();
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

function listen(server: HttpServer, port: number, host: string | undefined) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
}
