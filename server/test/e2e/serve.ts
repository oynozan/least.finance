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
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { ARC_CHAIN_ID } from "../../src/chain/arc.ts";
import { coinByKey, EVM_COINS, parseCoinAmount } from "../../src/crosschain/catalog.ts";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { fixedPrices } from "../../src/crosschain/prices.ts";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { loadConfig } from "../../src/config.ts";
import type { DepositDoc } from "../../src/db/mongo.ts";
import { formatUsdc, fromDecimal, toDecimal } from "../../src/db/money.ts";
import { startServer } from "../../src/server.ts";
import { startAnvil } from "../support/anvil.ts";
import { startArcEmulator } from "../support/arc-emulator.ts";
import { FakeBridge } from "../support/fake-bridge.ts";
import { fakePoolTrader, type Behavior } from "../support/fake-trader.ts";
import { startFakePolymarket } from "../support/fake-polymarket.ts";
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
const polymarket = await startFakePolymarket();
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
    POLYMARKET_GAMMA_URL: polymarket.url,
    POLYMARKET_CLOB_URL: polymarket.url,
    PREDICTIONS_TRADING: "on",
    PREDICTIONS_RESOLVE_MS: "300",
    POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_BUILDER_API_KEY: "e2e",
    POLYMARKET_BUILDER_API_SECRET: "e2e",
    POLYMARKET_BUILDER_API_PASSPHRASE: "e2e",
});
const trader = fakePoolTrader(polymarket, 1_000_000n * 1_000_000n);
const bridge = new FakeBridge({ arcRpcUrl: emulator.url, rates: { ETH: 3000, BNB: 600, USDC: 1, USDT: 1 } });
const server = await startServer(config, pino({ level: config.LOG_LEVEL }), {
    sources: createSourceClients({ ethereum: [ethereum.url], bnb: [bnb.url] }),
    solana: createSolanaRpc([solanaRpc.url]),
    prices: fixedPrices({ ETH: 3000, BNB: 600, SOL: 150, USDC: 1, USDT: 1 }),
    bridges: [bridge],
    trader,
});
const { services } = server;
await services.markets.tick();
await services.predictions.refreshFloat();
const chain = chainHelpers(anvil.url);
const sources = { 1: sourceChain(ethereum.url, 1), 56: sourceChain(bnb.url, 56) };
const rpcUrls: Record<number, string> = { 1: ethereum.url, 56: bnb.url, [ARC_CHAIN_ID]: emulator.url };

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
            await sources[1].fund(wallet as Address, "1");
            await sources[56].fund(wallet as Address, "1");
        }
        return { userId, token: await privy.token(userId) };
    },
    "/seed": async ({ address, deposits }) => seed(normalize(address), deposits as Seeded[]),
    /** The browser wallet's way onto the chain; anvil signs for funded test wallets. */
    "/rpc": async ({ method, params, chainId = ARC_CHAIN_ID }) => {
        const url = rpcUrls[Number(chainId)];
        if (!url) throw new Error(`No test chain ${String(chainId)}`);
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
        });
        return response.json();
    },
    /** Gives a wallet `amount` of a catalog coin on its own network, replacing what it held. */
    "/source/fund": async ({ address, coin, amount }) => {
        const owner = normalize(address);
        const { chain: network, chainId, token, mint, decimals } = coinByKey(String(coin));
        const units = parseCoinAmount(coinByKey(String(coin)), String(amount));
        if (network === "solana") {
            if (mint) solanaRpc.setTokenBalance(owner, mint, units);
            else solanaRpc.setBalance(owner, units);
        } else if (chainId === 1 || chainId === 56) {
            const source = sources[chainId];
            if (token) await source.setTokenBalance(token, owner as Address, units);
            else await source.fund(owner as Address, formatUnits(units, decimals));
        } else {
            throw new Error(`Can't fund ${String(coin)}`);
        }
        return {};
    },
    /** Steps the newest bridge order of a person's account. */
    "/bridge/advance": async ({ address, stage }) => {
        if (!["pending", "filled", "refunded", "failed"].includes(String(stage))) throw new Error("Bad stage");
        const account = await services.accounts.find(userIdOf(normalize(address)));
        if (!account) throw new Error("No account");
        const order = await services.database.collections.depositOrders.findOne(
            { accountId: account._id },
            { sort: { _id: -1 } },
        );
        if (!order) throw new Error("No order");
        await bridge.advance(order.ref, stage as "pending" | "filled" | "refunded" | "failed");
        return {};
    },
    /** A deposit sent from somewhere other than the app, like an exchange withdrawal. */
    "/send": async ({ to, usdc }) => {
        const from = privateKeyToAddress(generatePrivateKey());
        await chain.fund(from, String(Number(usdc) + 1));
        return { txHash: await chain.send(from, getAddress(String(to)), String(usdc)) };
    },
    /** The next order on a token behaves this way; "hold" keeps the exchange from answering until released. */
    "/polymarket/next": async ({ tokenId, behavior }) => {
        trader.onNext(String(tokenId), behavior as Behavior);
        return {};
    },
    /** Answers the order held on a token: "fill" or "reject:price_moved", "reject:market_closed", "reject:rejected". */
    "/polymarket/release": async ({ tokenId, behavior }) => {
        trader.release(String(tokenId), behavior as Parameters<typeof trader.release>[1]);
        return {};
    },
    /** The pool's pUSD, in whole dollars. */
    "/polymarket/balance": async ({ usd }) => {
        trader.setBalance(BigInt(Math.floor(Number(usd))) * 1_000_000n);
        await services.predictions.refreshFloat();
        return {};
    },
    /** Resolves the newest delayed order on a token: "fill" or "cancel". */
    "/polymarket/settle-delayed": async ({ tokenId, outcome }) => {
        const order = await services.database.collections.predictionOrders.findOne(
            { tokenId: String(tokenId), state: "posted" },
            { sort: { _id: -1 } },
        );
        if (!order?.orderHash) throw new Error("No posted order");
        trader.settleDelayed(order.orderHash, outcome as "fill" | "cancel");
        return {};
    },
    /** Closes a market with its result: `prices` such as ["1", "0"], or ["0.5", "0.5"] for a 50/50. */
    "/polymarket/resolve": async ({ marketId, prices }) => {
        polymarket.resolve(String(marketId), prices as string[]);
        return {};
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
        polymarket.stop(),
        mongo.stop(),
    ]);
    process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
