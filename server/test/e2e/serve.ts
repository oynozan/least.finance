/**
 * The backend for the web app's Playwright tests: the real server on a
 * throwaway database, an anvil chain behind the Arc emulator, and the fake
 * Privy. A control API beside it lets tests sign users in, seed deposit
 * history, and act on the chain. Run by playwright.config.ts; never deployed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { ARC_CHAIN_ID } from "../../src/chain/arc.ts";
import { EVM_COINS } from "../../src/crosschain/catalog.ts";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { fixedPrices } from "../../src/crosschain/prices.ts";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { loadConfig } from "../../src/config.ts";
import type { DepositDoc } from "../../src/db/mongo.ts";
import { formatUsdc, fromDecimal, toDecimal } from "../../src/db/money.ts";
import { startServer } from "../../src/server.ts";
import { startAnvil } from "../support/anvil.ts";
import { startArcEmulator } from "../support/arc-emulator.ts";
import { startFakePrivy } from "../support/fake-privy.ts";
import { startFakeSolanaRpc } from "../support/fake-solana-rpc.ts";
import { startMongo } from "../support/mongo.ts";
import { sourceChain } from "../support/source-chains.ts";
import { chainHelpers } from "../support/stack.ts";

const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4101);
/** The web app's origins; the app the tests drive must be one of them. */
const WEB_ORIGINS = process.env.E2E_WEB_ORIGINS ?? "http://localhost:3100";
/** e2e/privy-mock.ts builds the app with this app ID. */
const PRIVY_APP_ID = process.env.E2E_PRIVY_APP_ID ?? "cmtestapp0000000000000000";

const [mongo, anvil, ethereum, bnb] = await Promise.all([
    startMongo(),
    startAnvil(),
    startAnvil(undefined, { chainId: 1 }),
    startAnvil(undefined, { chainId: 56 }),
]);
// Fresh anvils aren't forks, so the stand-in tokens must exist for balances to read.
for (const { chain, token } of EVM_COINS) {
    if (token && chain === "ethereum") await sourceChain(ethereum.url, 1).installToken(token);
    if (token && chain === "bnb") await sourceChain(bnb.url, 56).installToken(token);
}
const solanaRpc = await startFakeSolanaRpc();
const emulator = await startArcEmulator(anvil.url);
const privy = await startFakePrivy(PRIVY_APP_ID);
const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
    CORS_ORIGINS: WEB_ORIGINS,
    MONGODB_URI: mongo.uri,
    MONGODB_DB: "TradeEverythingE2E",
    PRIVY_APP_ID,
    PRIVY_APP_SECRET: privy.appSecret,
    PRIVY_VERIFICATION_KEY: privy.verificationKey,
    PRIVY_API_URL: privy.url,
    ARC_RPC_URLS: emulator.url,
    DEPOSIT_MNEMONIC: generateMnemonic(wordlist),
    DEPOSIT_POLL_MS: "200",
    // anvil mines only when sent a transaction, so the head would never get past a lag.
    DEPOSIT_SCAN_LAG_BLOCKS: "0",
    // Every browser in the suite connects from this machine.
    SOCKET_HANDSHAKES_PER_MINUTE: "100000",
    DEPOSIT_RECEIPT_TIMEOUT_MS: "4000",
});
const server = await startServer(config, pino({ level: config.LOG_LEVEL }), {
    sources: createSourceClients({ ethereum: [ethereum.url], bnb: [bnb.url] }),
    solana: createSolanaRpc([solanaRpc.url]),
    prices: fixedPrices({ ETH: 3000, BNB: 600, SOL: 150, USDC: 1, USDT: 1 }),
});
const { services } = server;
const chain = chainHelpers(anvil.url);

/** The Privy DID the mock gives a wallet, so one address is always one user. */
const userIdOf = (address: string) =>
    `did:privy:e2e${isSolanaAddress(address) ? address : address.slice(2).toLowerCase()}`;

/** Base58 and case-sensitive, unlike an Ethereum address. */
function isSolanaAddress(address: string) {
    return !address.startsWith("0x") && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

/** An Ethereum address checksummed, a Solana one as it came. */
const normalize = (address: unknown) =>
    isSolanaAddress(String(address)) ? String(address) : getAddress(String(address));

type Seeded = { amount: string; daysAgo: number };

/** An id dated `at`, since ids are what order the history; the random tail keeps tests seeding the same day apart. */
function objectIdAt(at: Date) {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, Math.floor(at.getTime() / 1000));
    bytes.set(crypto.getRandomValues(new Uint8Array(8)), 4);
    return new ObjectId(bytes);
}

/** Writes deposit history straight to the database, as if it had been credited over time. */
async function seed(address: string, deposits: Seeded[]) {
    const account = await services.accounts.open(userIdOf(address));
    const { client, collections } = services.database;
    const now = Date.now();
    await client.withSession((session) =>
        session.withTransaction(async () => {
            // Oldest first, so ids (which order the history) follow the dates.
            const ordered = [...deposits].sort((a, b) => b.daysAgo - a.daysAgo);
            for (const [i, { amount, daysAgo }] of ordered.entries()) {
                const at = new Date(now - daysAgo * 86_400_000 - (ordered.length - i) * 1000);
                const wei = parseUnits(amount, 18);
                const deposit: DepositDoc = {
                    _id: objectIdAt(at),
                    accountId: account._id,
                    chainId: ARC_CHAIN_ID,
                    txHash: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`,
                    logIndex: 0,
                    blockNumber: 0,
                    blockHash: `0x${"0".repeat(64)}`,
                    from: address.toLowerCase(),
                    to: account.depositAddress,
                    amount: toDecimal(wei),
                    source: "scan",
                    creditedAt: at,
                };
                await collections.deposits.insertOne(deposit, { session });
                const updated = await collections.accounts.findOneAndUpdate(
                    { _id: account._id },
                    { $inc: { balance: toDecimal(wei), version: 1 } },
                    { session, returnDocument: "after" },
                );
                await collections.ledger.insertOne(
                    {
                        _id: new ObjectId(),
                        accountId: account._id,
                        kind: "deposit",
                        amount: toDecimal(wei),
                        balanceAfter: updated!.balance,
                        refId: deposit._id,
                        createdAt: at,
                    },
                    { session },
                );
            }
        }),
    );
    const current = await services.accounts.findById(account._id);
    return { depositAddress: getAddress(account.depositAddress), balance: formatUsdc(fromDecimal(current!.balance)) };
}

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    /** Signs a wallet in: a Privy user that owns it, a real access token, and USDC to deposit. */
    "/users": async ({ address, usdc = "20000", also = [] }) => {
        const wallet = normalize(address);
        const userId = userIdOf(wallet);
        if (isSolanaAddress(wallet)) {
            privy.setUser(userId, [{ address: wallet, chain: "solana" }]);
        } else {
            privy.setUser(userId, [wallet, ...(also as string[]).map((other) => normalize(other) as Address)]);
            await chain.fund(wallet as Address, String(usdc));
        }
        return { userId, token: await privy.token(userId) };
    },
    "/seed": async ({ address, deposits }) => seed(normalize(address), deposits as Seeded[]),
    /** The browser wallet's way onto the chain; anvil signs for funded test wallets. */
    "/rpc": async ({ method, params }) => {
        const response = await fetch(emulator.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
        });
        return response.json();
    },
    /** A deposit sent from somewhere other than the app, like an exchange withdrawal. */
    "/send": async ({ to, usdc }) => {
        const from = privateKeyToAddress(generatePrivateKey());
        await chain.fund(from, String(Number(usdc) + 1));
        return { txHash: await chain.send(from, getAddress(String(to)), String(usdc)) };
    },
    "/account": async ({ address }) => {
        const account = await services.accounts.find(userIdOf(normalize(address)));
        if (!account) return null;
        return {
            depositAddress: getAddress(account.depositAddress),
            balance: formatUsdc(fromDecimal(account.balance)),
        };
    },
};

const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });

const send = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const control = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") return send(res, 200, { api: server.url });
    const route = routes[path];
    if (req.method !== "POST" || !route) return send(res, 404, { error: "Not found" });
    try {
        const body = await readJson(req);
        if (
            "address" in body &&
            !isAddress(String(body.address), { strict: false }) &&
            !isSolanaAddress(String(body.address))
        ) {
            return send(res, 400, { error: "Bad address" });
        }
        send(res, 200, await route(body));
    } catch (error) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
});
await new Promise<void>((resolve) => control.listen(CONTROL_PORT, "127.0.0.1", resolve));
console.log(`e2e backend: api ${server.url}, control http://127.0.0.1:${CONTROL_PORT}, web ${WEB_ORIGINS}`);

let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    control.close();
    await server.close().catch(() => undefined);
    await Promise.allSettled([
        emulator.stop(),
        privy.stop(),
        anvil.stop(),
        ethereum.stop(),
        bnb.stop(),
        solanaRpc.stop(),
        mongo.stop(),
    ]);
    process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
