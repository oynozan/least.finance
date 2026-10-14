import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { pino } from "pino";
import { parseUnits } from "viem";
import { inject } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import type { Config } from "../../src/config.ts";
import { connectDatabase, type AccountDoc, type Database, type PerpOrderDoc } from "../../src/db/mongo.ts";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import { Ledger } from "../../src/deposits/ledger.ts";
import { Bus } from "../../src/events.ts";
import { withPerpTimeouts, type HyperliquidClient } from "../../src/perps/client.ts";
import { PerpMarkets } from "../../src/perps/markets.ts";
import { createNktkasClient } from "../../src/perps/nktkas-client.ts";
import { PerpService } from "../../src/perps/perps.ts";
import { startFakeHyperliquid } from "./fake-hyperliquid.ts";

export const wei = (usdc: string) => parseUnits(usdc, 18);
export const e6 = (usdc: string) => parseUnits(usdc, 6);

type Method = keyof HyperliquidClient;
type Crash = { method: Method; nth: number; when: "before" | "after" };

const MNEMONIC = "test test test test test test test test test test test junk";
/** The SDK holds a signer's next call behind one whose reply is lost, so its own timeout is just above ours. */
const CALL_MS = 300;

/** The service over a fake Hyperliquid and a throwaway database; `crash` freezes the service that makes a chosen client call. */
export async function perpHarness(o: { trading?: "on" | "off"; feeBps?: number } = {}) {
    const database: Database = await connectDatabase(inject("mongoUri"), `test_${randomUUID().replaceAll("-", "")}`);
    const lines: Array<{ level: number; msg: string }> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const bus = new Bus();
    const ledger = new Ledger({
        client: database.client,
        collections: database.collections,
        bus,
        logger: pino({ level: "silent" }),
        minDeposit: 0n,
    });
    const fake = await startFakeHyperliquid();
    const keyring = createKeyring(MNEMONIC);
    const clock = { at: Date.now() };
    const now = () => clock.at;

    const calls = new Map<Method, number>();
    const failing = new Set<Method>();
    const crash: { next: Crash | null; hit: boolean } = { next: null, hit: false };
    const real = createNktkasClient({ url: fake.url, timeoutMs: CALL_MS + 100 });
    const guarded = Object.fromEntries(
        (Object.keys(real) as Method[]).map((method) => [
            method,
            (...args: unknown[]) => {
                if (failing.has(method)) return Promise.reject(new Error(`${method} is failing`));
                return (real[method] as (...a: unknown[]) => Promise<unknown>)(...args);
            },
        ]),
    ) as unknown as HyperliquidClient;
    const timed = withPerpTimeouts(guarded, CALL_MS);
    const client = Object.fromEntries(
        (Object.keys(timed) as Method[]).map((method) => [
            method,
            async (...args: unknown[]) => {
                const count = (calls.get(method) ?? 0) + 1;
                calls.set(method, count);
                const mine = crash.next && crash.next.method === method && crash.next.nth === count ? crash.next : null;
                if (mine) crash.hit = true;
                if (mine?.when === "before") return new Promise(() => undefined);
                const result = await (timed[method] as (...a: unknown[]) => Promise<unknown>)(...args);
                if (mine?.when === "after") return new Promise(() => undefined);
                return result;
            },
        ]),
    ) as unknown as HyperliquidClient;

    const config = {
        PERPS_TRADING: o.trading ?? "on",
        PERPS_FLOAT_USD: 200,
        PERPS_SLIPPAGE_BPS: 100,
        PERPS_CLOSE_SLIPPAGE_BPS: 300,
        PERPS_MAX_LEVERAGE: 20,
        PERPS_FEE_BPS: o.feeBps ?? 0,
    } as Config;
    const markets = new PerpMarkets({ client: timed, config, logger: pino({ level: "silent" }) });
    await markets.tick();

    const build = () =>
        new PerpService({
            collections: database.collections,
            ledger,
            markets,
            client,
            keyring,
            bus,
            logger,
            config,
            now,
        });
    const service = build();

    let nextIndex = 1;
    async function seedAccount(usdc: string): Promise<AccountDoc> {
        const _id = new ObjectId();
        const at = new Date();
        const index = nextIndex++;
        const account: AccountDoc = {
            _id,
            privyUserId: `did:privy:${randomUUID()}`,
            depositIndex: index,
            depositAddress: `0x${index.toString(16).padStart(40, "0")}`,
            balance: toDecimal(wei(usdc)),
            version: 1,
            openedAtBlock: 0,
            createdAt: at,
            updatedAt: at,
        };
        await database.collections.accounts.insertOne(account);
        await database.collections.ledger.insertOne({
            _id: new ObjectId(),
            accountId: _id,
            kind: "deposit",
            amount: toDecimal(wei(usdc)),
            balanceAfter: toDecimal(wei(usdc)),
            refId: new ObjectId(),
            createdAt: at,
        });
        return account;
    }

    async function state(accountId: ObjectId) {
        const account = await database.collections.accounts.findOne({ _id: accountId });
        const rows = await database.collections.ledger.find({ accountId }).sort({ _id: 1 }).toArray();
        const sum = rows.reduce((total, row) => total + fromDecimal(row.amount), 0n);
        return { balance: fromDecimal(account!.balance), rows, sum, kinds: rows.map((row) => row.kind) };
    }

    const master = keyring.perpAddressAt(0);
    /** Funds the master float on the fake and has the service read it. */
    async function fundMaster(usdc: string) {
        fake.fund(master, e6(usdc));
        await service.refreshFloat();
    }
    const masterFreeE6 = () => fake.account(master)?.freeE6 ?? 0n;
    const heldE6 = async () => {
        const doc = await database.collections.perpFloat.findOne({ _id: "hyperliquid" });
        return doc ? fromDecimal(doc.heldE6) : 0n;
    };
    const addressOf = async (accountId: ObjectId) => {
        const row = await database.collections.perpAccounts.findOne({ accountId });
        return row!.address;
    };
    const orderOf = (id: ObjectId) => database.collections.perpOrders.findOne({ _id: id }) as Promise<PerpOrderDoc>;
    const until = async (check: () => Promise<boolean>, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (await check()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("timed out");
    };
    const settled = async (id: ObjectId) => {
        await until(async () => ["filled", "rejected", "done"].includes((await orderOf(id)).state));
        return orderOf(id);
    };
    const place = (account: AccountDoc, request: Partial<Parameters<PerpService["place"]>[1]> = {}, svc = service) =>
        svc.place(account, {
            requestId: randomUUID(),
            asset: "BTC",
            side: "long",
            leverage: 5,
            collateralUSD: "100",
            ...request,
        });

    return {
        database,
        bus,
        ledger,
        fake,
        keyring,
        markets,
        service,
        build,
        client,
        config,
        clock,
        /** Freezes whichever service makes the nth call to `method` from now, before or after the call reaches Hyperliquid. */
        crashAt(method: Method, nth: number, when: "before" | "after") {
            calls.clear();
            crash.hit = false;
            crash.next = { method, nth, when };
        },
        /** Whether the service the last `crashAt` chose has made its call and been frozen. */
        crashed: () => crash.hit,
        failing,
        lines,
        master,
        seedAccount,
        state,
        fundMaster,
        masterFreeE6,
        heldE6,
        addressOf,
        orderOf,
        settled,
        until,
        place,
        async close() {
            await fake.stop();
            await database.close();
        },
    };
}

export type PerpHarness = Awaited<ReturnType<typeof perpHarness>>;
