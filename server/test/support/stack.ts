import { randomUUID } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { pino } from "pino";
import { io as connectSocket, type Socket } from "socket.io-client";
import { createTestClient, http, parseUnits, publicActions, walletActions, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { arcChain } from "../../src/chain/arc.ts";
import { loadConfig } from "../../src/config.ts";
import type { ClientToServerEvents, ServerToClientEvents } from "../../src/protocol.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { startArcEmulator, type ArcEmulator, type EmulatorOptions } from "./arc-emulator.ts";
import { startFakePrivy, type FakePrivy } from "./fake-privy.ts";

export const WEB_ORIGIN = "http://localhost:3000";

export type ChainHelpers = ReturnType<typeof chainHelpers>;

/** Talks to the emulated Arc chain the way a user's wallet would. */
export function chainHelpers(url: string) {
    const client = createTestClient({ mode: "anvil", chain: arcChain([url]), transport: http(url) })
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
    chain: ChainHelpers;
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
    env?: Record<string, string>;
    emulator?: EmulatorOptions;
};

/** The real server, against a throwaway database, the emulated chain and the fake Privy. */
export async function startStack({
    mongoUri,
    anvilUrl,
    env = {},
    emulator: emulatorOptions,
}: StackOptions): Promise<Stack> {
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
        DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
        DEPOSIT_POLL_MS: "100",
        DEPOSIT_RECEIPT_TIMEOUT_MS: "3000",
        ...env,
    });
    const logger = pino({ level: config.LOG_LEVEL });
    const server = await startServer(config, logger);
    const chain = chainHelpers(anvilUrl);
    const sockets: AppSocket[] = [];

    return {
        server,
        url: server.url,
        privy,
        emulator,
        chain,
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
            await privy.stop();
        },
    };
}
