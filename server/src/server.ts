import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { Hex } from "viem";
import { AccountService } from "./accounts/accounts.ts";
import { WalletBalances } from "./balances/wallet-balances.ts";
import { createKeyring } from "./accounts/keyring.ts";
import { PrivyIdentity, type IdentityProvider } from "./auth/identity.ts";
import { ARC_CHAIN_ID, assertArc, createArcClient } from "./chain/arc.ts";
import type { Config } from "./config.ts";
import { DepositOrders } from "./crosschain/orders.ts";
import { OrderTracker } from "./crosschain/tracker.ts";
import { createAcross } from "./crosschain/providers/across.ts";
import { createCctp } from "./crosschain/providers/cctp.ts";
import { createRelay } from "./crosschain/providers/relay.ts";
import type { BridgeProvider } from "./crosschain/providers/types.ts";
import { readBalances } from "./crosschain/balances.ts";
import { createSourceClients, type SourceClients } from "./crosschain/chains.ts";
import { lifiPrices, type PriceFeed } from "./crosschain/prices.ts";
import { ARC_DOMAIN, createIris, SOLANA_DOMAIN, type Iris } from "./crosschain/iris.ts";
import { IrisLimiter } from "./crosschain/iris-limiter.ts";
import { createSolanaRpc, readSolanaBalances, type SolanaRpc } from "./crosschain/solana.ts";
import { connectDatabase } from "./db/mongo.ts";
import { formatUsdc } from "./db/money.ts";
import { DepositService } from "./deposits/deposits.ts";
import { Ledger } from "./deposits/ledger.ts";
import { DepositRegistry } from "./deposits/registry.ts";
import { DepositWatcher } from "./deposits/watcher.ts";
import { Bus } from "./events.ts";
import { MarketHistory } from "./markets/history.ts";
import { MarketService } from "./markets/markets.ts";
import { withPerpTimeouts, type HyperliquidClient } from "./perps/client.ts";
import { PerpMarkets } from "./perps/markets.ts";
import { PerpService } from "./perps/perps.ts";
import { PerpTracker } from "./perps/tracker.ts";
import { PerpReconciler, arcHoldings } from "./perps/reconciler.ts";
import { createNktkasClient } from "./perps/nktkas-client.ts";
import { ActivityFeed } from "./pnl/feed.ts";
import { PnlService } from "./pnl/pnl.ts";
import { PredictionService } from "./predictions/predictions.ts";
import { createPolymarketTrader } from "./predictions/polymarket-trader.ts";
import { PredictionReconciler } from "./predictions/reconciler.ts";
import { PredictionRedeemer } from "./predictions/redeemer.ts";
import { PoolRebalancer, poolRowsOpen } from "./predictions/rebalancer.ts";
import { RelayerGate } from "./predictions/relayer-gate.ts";
import { PredictionResolver } from "./predictions/resolver.ts";
import { PredictionTracker } from "./predictions/tracker.ts";
import { inFlight, traderNeeded, withTimeouts, type PoolTrader } from "./predictions/trader.ts";
import { createPolymarketData } from "./markets/polymarket-data.ts";
import { createDefiLlama } from "./prices/defillama.ts";
import { PriceHistory } from "./prices/history.ts";
import { createApp } from "./http/app.ts";
import type { Services } from "./services.ts";
import { Sessions } from "./sessions.ts";
import { SwapCatalog } from "./swaps/catalog.ts";
import { createTradingExecution } from "./trading/execution.ts";
import { TradeService } from "./trading/trades.ts";
import { createSwapClients } from "./swaps/clients.ts";
import { SwapHoldings, multicallReader, solanaReader } from "./swaps/holdings.ts";
import { createLifi } from "./swaps/lifi.ts";
import { SwapOrders } from "./swaps/orders.ts";
import { createSolanaSignatureStatus } from "./swaps/solana-status.ts";
import { SwapTracker } from "./swaps/tracker.ts";
import { attachSockets } from "./socket/sockets.ts";
import { Payouts } from "./withdrawals/payouts.ts";
import { Sweeper } from "./withdrawals/sweeper.ts";
import { Withdrawals } from "./withdrawals/withdrawals.ts";

const TRADER_RETRY_MS = 60_000;
const REDEEM_MS = 60_000;
const RECONCILE_MS = 600_000;

/** Short of the tracker giving up on a missing post, so a hung post is still followed up. */
const TRADER_CALL_MS = 30_000;

/** Bounds each Hyperliquid call; an order that outlasts it is left for the tracker. */
const PERP_CALL_MS = 10_000;

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
    /** Stands in for Circle's Iris. */
    iris?: Iris;
    /** The bridges that quote deposits; Relay and Across by default. */
    bridges?: BridgeProvider[];
    /** Stands in for the pool's Polymarket trader. */
    trader?: PoolTrader;
    /** Stands in for Hyperliquid. */
    hyperliquid?: HyperliquidClient;
    /** Sends the signed payout transactions; tests wrap it to cut a broadcast short. */
    payoutBroadcast?: (rawTx: Hex) => Promise<Hex>;
    /** The clock the balance and holdings refresh limits run on. */
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
        const keyring = createKeyring(config.DEPOSIT_MNEMONIC);
        const accounts = new AccountService({
            collections,
            keyring,
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
        const solana = overrides.solana ?? createSolanaRpc(config.SOLANA_RPC_URLS);
        const iris = overrides.iris ?? createIris({ baseUrl: config.CIRCLE_IRIS_URL });
        const irisLimiter = new IrisLimiter();
        const bridges = overrides.bridges ?? [
            createRelay({ apiKey: config.RELAY_API_KEY }),
            createCctp({
                iris,
                rpc: solana,
                arcDomain: ARC_DOMAIN,
                solanaDomain: SOLANA_DOMAIN,
                logger: logger.child({ component: "cctp" }),
            }),
            createAcross({ apiKey: config.ACROSS_API_KEY, integratorId: config.ACROSS_INTEGRATOR_ID }),
        ];
        const prices = overrides.prices ?? lifiPrices();
        const orders = new DepositOrders({
            collections,
            bus,
            providers: bridges,
            solana,
            prices,
            switches: config,
            minSolanaUsd: config.SOLANA_DEPOSIT_MIN_USD,
            allowedPrograms: config.SOLANA_ALLOWED_PROGRAMS,
            logger: logger.child({ component: "deposit-orders" }),
        });
        const withdrawals = new Withdrawals({
            collections,
            ledger,
            client,
            treasury: keyring.operator().address,
            bus,
            logger: logger.child({ component: "withdrawals" }),
            minWithdraw: config.WITHDRAW_MIN_USDC,
            solana: {
                rpc: solana,
                iris,
                switches: config,
                min: config.SOLANA_WITHDRAW_MIN_USDC,
                tolerance: config.SOLANA_WITHDRAW_FEE_TOLERANCE,
            },
        });
        const payouts = new Payouts({
            collections,
            ledger,
            client,
            signer: keyring.operator(),
            bus,
            logger: logger.child({ component: "payouts" }),
            broadcast: overrides.payoutBroadcast,
            iris,
            irisLimiter,
        });
        const sessions = new Sessions({
            accounts,
            deposits,
            orders,
            withdrawals,
            collections,
            rules: { chainId: ARC_CHAIN_ID, minDeposit: formatUsdc(config.DEPOSIT_MIN_USDC) },
            solana: { deposits: config.SOLANA_DEPOSITS === "on", withdrawals: config.SOLANA_WITHDRAWALS === "on" },
        });
        const pnl = new PnlService({ collections, logger: logger.child({ component: "pnl" }), now: overrides.now });
        const feed = new ActivityFeed({ collections, logger: logger.child({ component: "pnl" }), now: overrides.now });
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
            solana,
            bus,
            logger: logger.child({ component: "order-tracker" }),
            pollMs: config.ORDER_POLL_MS,
            announced: (orderId) => orders.announced(orderId),
        });
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
            // Read through Date so a test's fake clock moves the cache
            now: () => Date.now(),
            // Read lazily: the service below needs the markets, so it's built after them
            maxOrderUSD: (): number | null => service.maxOrderUSD(),
        });
        const marketHistory = new MarketHistory({
            data: polymarket,
            markets,
            logger: marketLogger,
            now: () => Date.now(),
        });
        const lifi = createLifi({ url: config.LIFI_URL, apiKey: config.LIFI_API_KEY });
        const swapClients = createSwapClients({
            ethereum: config.ETHEREUM_RPC_URLS,
            arbitrum: config.ARBITRUM_RPC_URLS,
            base: config.BASE_RPC_URLS,
            optimism: config.OPTIMISM_RPC_URLS,
            polygon: config.POLYGON_RPC_URLS,
            bnb: config.BNB_RPC_URLS,
            avalanche: config.AVALANCHE_RPC_URLS,
            arc: config.ARC_RPC_URLS,
        });
        const swapCatalog = new SwapCatalog({
            lifi,
            logger: logger.child({ component: "swaps" }),
            syncMs: config.SWAPS_CATALOG_SYNC_MS,
        });
        const swapHoldings = new SwapHoldings({
            identity,
            bus,
            logger: logger.child({ component: "swap-holdings" }),
            catalog: swapCatalog,
            readEvm: multicallReader(swapClients),
            readSolana: solanaReader(solana),
            now: overrides.now,
        });
        const swapOrders = new SwapOrders({
            collections,
            lifi,
            catalog: swapCatalog,
            holdings: swapHoldings,
            clients: swapClients,
            identity,
            bus,
            integrator: config.LIFI_INTEGRATOR,
            fee: config.LIFI_FEE,
        });
        const swapTracker = new SwapTracker({
            collections,
            lifi,
            clients: swapClients,
            bus,
            holdings: swapHoldings,
            solanaStatus: createSolanaSignatureStatus(config.SOLANA_RPC_URLS),
            accounts,
            logger: logger.child({ component: "swap-tracker" }),
            pollMs: config.SWAPS_POLL_MS,
            now: overrides.now,
        });
        const priceHistory = new PriceHistory({
            llama: createDefiLlama({ url: config.DEFILLAMA_COINS_URL }),
            logger: logger.child({ component: "prices" }),
        });
        const perpClient =
            overrides.hyperliquid ??
            withPerpTimeouts(createNktkasClient({ url: config.HYPERLIQUID_API_URL }), PERP_CALL_MS);
        const perpMarkets = new PerpMarkets({
            client: perpClient,
            config,
            logger: logger.child({ component: "perps" }),
        });
        const perps = new PerpService({
            collections,
            ledger,
            markets: perpMarkets,
            client: perpClient,
            keyring,
            bus,
            logger: logger.child({ component: "perps" }),
            config,
        });
        perpMarkets.setMaxOrderUSD(() => perps.maxOrderUSD());
        const perpTracker = new PerpTracker({
            service: perps,
            client: perpClient,
            collections,
            config,
            logger: logger.child({ component: "perp-tracker" }),
            bus,
        });
        const perpReconciler = new PerpReconciler({
            collections,
            client: perpClient,
            keyring,
            config,
            logger: logger.child({ component: "perp-reconciler" }),
            withIndexLock: (index, fn) => perps.withIndexLock(index, fn),
            arcAssets: arcHoldings({ client, treasury: keyring.operator().address, collections }),
        });
        const sweeper = new Sweeper({
            client,
            keyring,
            collections,
            bus,
            logger: logger.child({ component: "sweeper" }),
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
            needTrader: () => ensureTrader(),
        });
        const relayerGate = new RelayerGate({ collections });
        const predictionRedeemer = new PredictionRedeemer({
            collections,
            service,
            trader: () => trader,
            logger: predictionLogger,
            intervalMs: REDEEM_MS,
            needTrader: () => ensureTrader(),
            gate: relayerGate,
        });
        // The worker exists only with its switch on; off, a queued row is never decided
        const poolRebalancer =
            config.POOL_REBALANCE === "on"
                ? new PoolRebalancer({
                      collections,
                      ledger,
                      withdrawals,
                      service,
                      trader: () => trader,
                      needTrader: () => ensureTrader(),
                      treasury: keyring.operator().address,
                      iris,
                      limiter: irisLimiter,
                      gate: relayerGate,
                      bus,
                      logger: logger.child({ component: "pool-rebalancer" }),
                      config,
                  })
                : null;
        const predictionReconciler = new PredictionReconciler({
            collections,
            trader: () => trader,
            logger: predictionLogger,
            intervalMs: RECONCILE_MS,
            needTrader: () => ensureTrader(),
        });
        // Orders a restart left placing never reached Polymarket; refund them before anyone can order
        await service.recover();
        let connecting: NodeJS.Timeout | null = null;
        let closed = false;
        const connectTrader = inFlight(async () => {
            connecting = null;
            try {
                trader = withTimeouts(await createPolymarketTrader(config, predictionLogger), TRADER_CALL_MS);
            } catch (error) {
                predictionLogger.error({ err: error }, "Couldn't connect to Polymarket, retrying in a minute");
                if (!closed) connecting = setTimeout(connectTrader, TRADER_RETRY_MS);
                return;
            }
            void service.refreshFloat().catch((error: unknown) => {
                predictionLogger.warn({ err: error }, "Couldn't read the pool's float");
            });
        });
        const trades = new TradeService({
            collections,
            ledger,
            catalog: swapCatalog,
            coinWithdrawals: config.COIN_WITHDRAWALS === "on",
        });
        const execution = createTradingExecution({
            config,
            keyring,
            database,
            lifi,
            clients: swapClients,
            solana,
            logger: logger.child({ component: "trading" }),
            onWithdrawal: (withdrawal, refunded) => bus.emit("coin-withdrawal:updated", { withdrawal, refunded }),
        });
        // Connects the trader when a redemption or position needs it, once, and not while a retry is waiting
        const ensureTrader = () => {
            if (!trader && !connecting && !closed) connectTrader();
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
            pnl,
            feed,
            watcher,
            balances,
            orders,
            solana,
            markets,
            marketHistory,
            perpMarkets,
            perps,
            predictions: service,
            priceHistory,
            swapCatalog,
            swapHoldings,
            swapOrders,
            sweeper,
            trades,
            withdrawals,
        };

        const httpServer = createServer(createApp(services));
        httpServer.headersTimeout = 20_000;
        const io = attachSockets(httpServer, services);
        await listen(httpServer, config.PORT, config.HOST);
        // Perp orders a restart interrupted are settled in the background; each step is guarded by its state change
        void perps
            .recover()
            .catch((error: unknown) => logger.error({ err: error, component: "perps" }, "Perp recovery failed"));
        watcher.start();
        sweeper.start();
        payouts.start();
        tracker.start();
        markets.start();
        swapCatalog.start();
        priceHistory.start();
        perpMarkets.start();
        perps.start();
        perpTracker.start();
        perpReconciler.start();
        swapTracker.start();
        predictionTracker.start();
        predictionResolver.start();
        predictionRedeemer.start();
        predictionReconciler.start();
        poolRebalancer?.start();
        execution.start();
        // Posted orders, unconfirmed redemptions and open pool moves need the trader even once trading is switched off
        const [posted, redeeming, moving] = await Promise.all([
            collections.predictionOrders.countDocuments({ state: "posted" }),
            collections.predictionRedemptions.countDocuments({ state: { $ne: "confirmed" } }),
            poolRebalancer ? poolRowsOpen(collections) : 0,
        ]);
        if (traderNeeded(config, posted + redeeming + moving)) ensureTrader();
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
                service.stopOrders();
                perps.stopOrders();
                if (connecting) clearTimeout(connecting);
                await execution.stop();
                await poolRebalancer?.stop();
                await predictionReconciler.stop();
                await predictionRedeemer.stop();
                await predictionResolver.stop();
                await predictionTracker.stop();
                await swapTracker.stop();
                await swapCatalog.stop();
                await priceHistory.stop();
                await perpReconciler.stop();
                await perpTracker.stop();
                await perps.stop();
                await perpMarkets.stop();
                await markets.stop();
                await tracker.stop();
                await watcher.stop();
                await payouts.stop();
                await sweeper.stop();
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
