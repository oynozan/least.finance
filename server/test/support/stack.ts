import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { pino } from "pino";
import { io as connectSocket, type Socket } from "socket.io-client";
import { createTestClient, http, parseUnits, publicActions, walletActions, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { EVM_COINS } from "../../src/crosschain/catalog.ts";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { fixedPrices } from "../../src/crosschain/prices.ts";
import { createCctp } from "../../src/crosschain/providers/cctp.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { loadConfig } from "../../src/config.ts";
import type { ClientToServerEvents, ServerToClientEvents } from "../../src/protocol.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { startArcEmulator, type ArcEmulator, type EmulatorOptions } from "./arc-emulator.ts";
import { fakePoolTrader, type FakeTrader } from "./fake-trader.ts";
import { FakeBridge } from "./fake-bridge.ts";
import { startFakeIris, type FakeIris } from "./fake-iris.ts";
import { startFakeHyperliquid, type FakeHyperliquid } from "./fake-hyperliquid.ts";
import { startFakeDefiLlama, type FakeDefiLlama } from "./fake-defillama.ts";
import { startFakeLifi, type FakeLifi } from "./fake-lifi.ts";
import { startFakePolymarket, type FakePolymarket } from "./fake-polymarket.ts";
import { startFakePrivy, type FakePrivy } from "./fake-privy.ts";
import { startFakeSolanaRpc, type FakeSolanaRpc } from "./fake-solana-rpc.ts";
import { TREASURY_GAS_RESERVE } from "../../src/withdrawals/withdrawals.ts";
import { installMulticall3, sourceChain } from "./source-chains.ts";

export const WEB_ORIGIN = "http://localhost:3000";

/** The swap coins' prices the fake LI.FI serves; they equal the web app's built-in ones. */
export const SWAP_PRICES = {
    ETH: 3210.4,
    SOL: 147.2,
    BTC: 97_300,
    USDC: 1,
    USDT: 1,
    BNB: 600,
    LINK: 18.45,
    DOGE: 0.182,
    AVAX: 32.1,
    ARB: 0.74,
    OP: 1.8,
};

/** Nothing listens here, so a network pointed at it refuses every request. */
const REFUSED_RPC = "http://127.0.0.1:9";

/** The swap holdings' RPC lists: the local Ethereum and BNB Chain, and a refusing URL for the five networks without a local chain. */
export const swapRpcEnv = (ethereumUrl: string, bnbUrl: string) => ({
    ETHEREUM_RPC_URLS: ethereumUrl,
    BNB_RPC_URLS: bnbUrl,
    ARBITRUM_RPC_URLS: REFUSED_RPC,
    BASE_RPC_URLS: REFUSED_RPC,
    OPTIMISM_RPC_URLS: REFUSED_RPC,
    POLYGON_RPC_URLS: REFUSED_RPC,
    AVALANCHE_RPC_URLS: REFUSED_RPC,
});

export type ChainHelpers = ReturnType<typeof chainHelpers>;

/** Talks to the emulated Arc chain the way a user's wallet would. */
export function chainHelpers(url: string) {
    const client = createTestClient({
        mode: "anvil",
        chain: arcChain([url]),
        transport: http(url),
        pollingInterval: 50,
    })
        .extend(publicActions)
        .extend(walletActions);

    return {
        client,
        /** Gives an address USDC to spend, and lets it send without a key. */
        async fund(address: Address, usdc = "1000") {
            await client.setBalance({ address, value: parseUnits(usdc, 18) });
            await client.impersonateAccount({ address });
        },
        /** A plain native USDC send, like a wallet's. Resolves once it's mined. */
        async send(from: Address, to: Address, usdc: string): Promise<Hash> {
            const hash = await client.sendTransaction({
                account: from,
                to,
                value: parseUnits(usdc, 18),
                chain: client.chain,
            });
            await client.waitForTransactionReceipt({ hash });
            return hash;
        },
    };
}

export type User = {
    userId: string;
    wallet: Address;
    token: string;
};

export type Stack = {
    server: RunningServer;
    url: string;
    privy: FakePrivy;
    emulator: ArcEmulator;
    /** The Solana RPC stand-in the server reads balances from. */
    solanaRpc: FakeSolanaRpc;
    /** The Circle Iris stand-in the server reads Solana withdrawal fees and messages from. */
    iris: FakeIris;
    /** The Polymarket stand-in the server reads markets from. */
    polymarket: FakePolymarket;
    /** The bridge the server quotes Ethereum and BNB Chain deposits from; a test steps its orders by hand. */
    bridge: FakeBridge;
    /** Stands in for Relay on Solana deposits, which the server asks by that name. */
    solanaBridge: FakeBridge;
    /** The pool's trader over the fake Polymarket's books; used only while a test turns PREDICTIONS_TRADING on. */
    trader: FakeTrader;
    /** The LI.FI stand-in the server reads swap coin prices from. */
    lifi: FakeLifi;
    /** The DefiLlama stand-in the server reads price history from. */
    llama: FakeDefiLlama;
    /** The Hyperliquid stand-in the server reads perp markets from. */
    hyperliquid: FakeHyperliquid;
    chain: ChainHelpers;
    /** The server's treasury address, where withdrawals are paid from. */
    treasury: Address;
    /** Sets the treasury's balance to `usdc` plus its gas reserve, so that much can be withdrawn. */
    fundTreasury(usdc: string): Promise<void>;
    /** A signed-in Privy user with one funded wallet. */
    user(options?: { usdc?: string }): Promise<User>;
    /** A socket signed in as `user`, already connected. */
    socket(user: User, options?: { origin?: string }): Promise<AppSocket>;
    stop(): Promise<void>;
};

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type StackOptions = {
    mongoUri: string;
    anvilUrl: string;
    /** The Ethereum and BNB Chain anvils; inside vitest they default to the global setup's. */
    ethereumUrl?: string;
    bnbUrl?: string;
    /** The clock the balance and holdings refresh limits run on. */
    now?: () => number;
    env?: Record<string, string>;
    emulator?: EmulatorOptions;
    /** Adds the real CCTP deposit provider, after the Relay stand-in, reading the fake Iris. */
    cctp?: boolean;
};

/** The real server, against a throwaway database, the emulated chain and the fake Privy. */
export async function startStack({
    mongoUri,
    anvilUrl,
    ethereumUrl,
    bnbUrl,
    now,
    env = {},
    emulator: emulatorOptions,
    cctp,
}: StackOptions): Promise<Stack> {
    if (!ethereumUrl || !bnbUrl) {
        const { inject } = await import("vitest");
        ethereumUrl ??= inject("ethereumUrl");
        bnbUrl ??= inject("bnbUrl");
    }
    // The anvils are fresh, not forks, so the stand-in tokens must exist for balances to read.
    for (const [url, id] of [
        [ethereumUrl, 1],
        [bnbUrl, 56],
    ] as const) {
        const chain = sourceChain(url, id);
        for (const { chain: key, token } of EVM_COINS) {
            if (token && key === (id === 1 ? "ethereum" : "bnb")) await chain.installToken(token);
        }
    }
    // The swap holdings read through Multicall3, which the fresh anvils lack.
    for (const url of [ethereumUrl, bnbUrl, anvilUrl]) await installMulticall3(url);
    const solanaRpc = await startFakeSolanaRpc();
    const iris = await startFakeIris();
    const polymarket = await startFakePolymarket();
    const lifi = await startFakeLifi({ prices: SWAP_PRICES });
    const llama = await startFakeDefiLlama({ prices: SWAP_PRICES });
    const hyperliquid = await startFakeHyperliquid();
    const privy = await startFakePrivy();
    const emulator = await startArcEmulator(anvilUrl, emulatorOptions);
    const config = loadConfig({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "0",
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
        CORS_ORIGINS: WEB_ORIGIN,
        MONGODB_URI: mongoUri,
        MONGODB_DB: `test_${randomUUID().replaceAll("-", "")}`,
        PRIVY_APP_ID: privy.appId,
        PRIVY_APP_SECRET: privy.appSecret,
        PRIVY_VERIFICATION_KEY: privy.verificationKey,
        PRIVY_API_URL: privy.url,
        ARC_RPC_URLS: emulator.url,
        ...swapRpcEnv(ethereumUrl, bnbUrl),
        DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
        DEPOSIT_POLL_MS: "100",
        // anvil mines only when sent a transaction, so the head would never get past a lag.
        DEPOSIT_SCAN_LAG_BLOCKS: "0",
        DEPOSIT_RECEIPT_TIMEOUT_MS: "3000",
        POLYMARKET_GAMMA_URL: polymarket.url,
        POLYMARKET_CLOB_URL: polymarket.url,
        LIFI_URL: lifi.url,
        DEFILLAMA_COINS_URL: llama.url,
        HYPERLIQUID_API_URL: hyperliquid.url,
        ...env,
    });
    const rates = { ETH: 3000, BNB: 600, SOL: 150, USDC: 1, USDT: 1 };
    const bridge = new FakeBridge({ arcRpcUrl: anvilUrl, rates, chains: ["ethereum", "bnb"] });
    const solanaBridge = new FakeBridge({ arcRpcUrl: anvilUrl, rates, name: "relay", chains: ["solana"] });
    const trader = fakePoolTrader(polymarket);
    const logger = pino({ level: config.LOG_LEVEL });
    const solana = createSolanaRpc([solanaRpc.url]);
    const server = await startServer(config, logger, {
        sources: createSourceClients({ ethereum: [ethereumUrl], bnb: [bnbUrl] }),
        solana,
        iris: createIris({ baseUrl: iris.url }),
        prices: fixedPrices({ ETH: 3000, BNB: 600, SOL: 150, USDC: 1, USDT: 1 }),
        bridges: [
            bridge,
            solanaBridge,
            ...(cctp
                ? [createCctp({ iris: createIris({ baseUrl: iris.url }), rpc: solana, arcDomain: 26, solanaDomain: 5 })]
                : []),
        ],
        trader,
        now,
    });
    // The first list is in before the first request, not a sync interval later.
    await server.services.markets.tick();
    await server.services.swapCatalog.tick();
    await server.services.priceHistory.tick();
    await server.services.perpMarkets.tick();
    await server.services.predictions.refreshFloat();
    const chain = chainHelpers(anvilUrl);
    const sockets: AppSocket[] = [];
    const treasury = createKeyring(config.DEPOSIT_MNEMONIC).operator().address;

    return {
        server,
        url: server.url,
        privy,
        emulator,
        solanaRpc,
        iris,
        polymarket,
        bridge,
        solanaBridge,
        trader,
        lifi,
        llama,
        hyperliquid,
        chain,
        treasury,
        async fundTreasury(usdc) {
            await chain.client.setBalance({ address: treasury, value: parseUnits(usdc, 18) + TREASURY_GAS_RESERVE });
        },
        async user({ usdc = "1000" } = {}) {
            const wallet = privateKeyToAddress(generatePrivateKey());
            const userId = `did:privy:${randomUUID().replaceAll("-", "")}`;
            privy.setUser(userId, [wallet]);
            await chain.fund(wallet, usdc);
            return { userId, wallet, token: await privy.token(userId) };
        },
        async socket(user, { origin = WEB_ORIGIN } = {}) {
            const socket: AppSocket = connectSocket(server.url, {
                auth: { token: user.token },
                transports: ["websocket"],
                extraHeaders: { origin },
                reconnection: false,
                forceNew: true,
            });
            sockets.push(socket);
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => resolve());
                socket.once("connect_error", reject);
            });
            return socket;
        },
        async stop() {
            for (const socket of sockets) socket.disconnect();
            const { db } = server.services.database;
            await db.dropDatabase().catch(() => undefined);
            await server.close();
            await emulator.stop();
            await solanaRpc.stop();
            await iris.stop();
            await polymarket.stop();
            await lifi.stop();
            await llama.stop();
            await hyperliquid.stop();
            await privy.stop();
        },
    };
}
