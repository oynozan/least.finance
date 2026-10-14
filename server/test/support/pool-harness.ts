import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import type { ObjectId } from "mongodb";
import { pino } from "pino";
import { createTestClient, http, parseUnits, publicActions, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { inject } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { arcChain } from "../../src/chain/arc.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import { IrisLimiter } from "../../src/crosschain/iris-limiter.ts";
import type { PoolDirection, PoolRebalanceDoc, PoolRebalanceState } from "../../src/db/mongo.ts";
import { newPoolRebalance, type PoolConfig } from "../../src/predictions/pool-inputs.ts";
import { PoolRebalancer } from "../../src/predictions/rebalancer.ts";
import { RelayerGate } from "../../src/predictions/relayer-gate.ts";
import { Payouts } from "../../src/withdrawals/payouts.ts";
import { Withdrawals } from "../../src/withdrawals/withdrawals.ts";
import { startFakeIris } from "./fake-iris.ts";
import { predictionHarness } from "./prediction-harness.ts";
import { installStub } from "./stub-token-messenger.ts";

const randomAddress = (): Address => privateKeyToAddress(generatePrivateKey());
const usdc6 = (usdc: string) => parseUnits(usdc, 6);

const ACTIVE: PoolRebalanceState[] = ["queued", "sending", "submitting", "forwarding", "wrapping"];

export type PoolHarness = Awaited<ReturnType<typeof poolHarness>>;

/** What `queue` and `seed` write: a row for `usdc` dollars, queued by the operator unless told otherwise. */
export type QueueOptions = {
    kind?: PoolRebalanceDoc["kind"];
    direction?: PoolDirection | null;
    usdc?: string;
    source?: PoolRebalanceDoc["source"];
    reason?: PoolRebalanceDoc["reason"];
    state?: PoolRebalanceState;
    /** When the row was created; the harness clock by default. */
    at?: Date;
    /** Fields written over the row after it is built. */
    patch?: Partial<PoolRebalanceDoc>;
};

/**
 * The pool rebalancer over real Mongo and anvil: real Withdrawals and Payouts signing from a fresh mnemonic,
 * stub messenger and USDC view at fresh addresses, a fake Iris, the fake trader, one limiter and one gate, and a clock the test moves.
 */
export async function poolHarness(
    o: {
        trading?: "on" | "off";
        /** What the treasury holds on Arc, in USDC; 1000 by default. */
        treasuryUsdc?: string;
        floatUsd?: number;
        /** The pUSD the pool holds, in USDC; the float target by default. */
        poolUsdc?: string;
        /** Overrides of the rebalancer's limits. */
        config?: Partial<PoolConfig>;
    } = {},
) {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
        { level: "debug" },
        {
            write(chunk: string) {
                lines.push(JSON.parse(chunk) as Record<string, unknown>);
            },
        },
    );
    const clock = { t: Date.now() };
    const now = () => clock.t;
    const floatUsd = o.floatUsd ?? 100;
    const base = await predictionHarness({ trading: o.trading ?? "on", now, logger, floatUsd });
    const { database, bus, ledger, service, trader } = base;
    const { collections } = database;
    trader.setBalance(usdc6(o.poolUsdc ?? String(floatUsd)));
    await service.refreshFloat();

    const url = inject("anvilUrl");
    const signer = createKeyring(generateMnemonic(wordlist)).operator();
    const chain = createTestClient({
        chain: arcChain([url]),
        mode: "anvil",
        transport: http(url),
        pollingInterval: 50,
    }).extend(publicActions);
    await chain.setBalance({ address: signer.address, value: parseUnits(o.treasuryUsdc ?? "1000", 18) });
    const messenger = await installStub(url, randomAddress());
    const usdcView = await installStub(url, randomAddress());

    const fakeIris = await startFakeIris();
    const iris = createIris({ baseUrl: fakeIris.url });
    const limiter = new IrisLimiter();
    const gate = new RelayerGate({ collections, now });
    const withdrawals = new Withdrawals({
        collections,
        ledger,
        client: chain,
        treasury: signer.address,
        bus,
        logger,
        minWithdraw: 0n,
    });
    const payouts = new Payouts({
        collections,
        ledger,
        client: chain,
        signer,
        bus,
        logger,
        pollMs: 100,
        iris,
        irisLimiter: limiter,
        tokenMessenger: messenger.address,
        usdc: usdcView.address,
        now,
    });
    const config: PoolConfig = {
        PREDICTIONS_TRADING: o.trading ?? "on",
        POLYMARKET_FLOAT_USD: floatUsd,
        POOL_REBALANCE_MAX_MOVE_USD: 100,
        POOL_REBALANCE_MAX_DAY_USD: 300,
        POOL_REBALANCE_ARC_RESERVE_USD: 100,
        POOL_REBALANCE_MIN_MOVE_USD: 10,
        POOL_REBALANCE_PAUSE_MIN: 5,
        ...o.config,
    };
    const connection = { on: true };
    const needs = { count: 0 };
    const build = () =>
        new PoolRebalancer({
            collections,
            ledger,
            withdrawals,
            service,
            trader: () => (connection.on ? trader : null),
            needTrader: () => void (needs.count += 1),
            treasury: signer.address,
            iris,
            limiter,
            gate,
            bus,
            logger,
            config,
            now,
        });
    let rebalancer = build();

    /** Inserts a row for `usdc` dollars: `queued` and active unless `state` says otherwise, and `wrap_idle` rows carry no amount. */
    async function seed(options: QueueOptions = {}): Promise<PoolRebalanceDoc> {
        const kind = options.kind ?? "move";
        const row = newPoolRebalance({
            kind,
            direction: kind === "wrap_idle" ? null : (options.direction ?? "arc_to_polygon"),
            source: options.source ?? "operator",
            reason: options.reason ?? "operator",
            amountE6: usdc6(options.usdc ?? "50"),
            now: options.at ?? new Date(clock.t),
        });
        const state = options.state ?? "queued";
        const doc: PoolRebalanceDoc = { ...row, ...options.patch, state };
        if (!ACTIVE.includes(state)) delete doc.active;
        await collections.poolRebalances.insertOne(doc);
        return doc;
    }

    return {
        ...base,
        config,
        /** The current rebalancer; `restart` replaces it. */
        get rebalancer() {
            return rebalancer;
        },
        /** Replaces the rebalancer with a new one over the same database, as a restarted process would be. */
        restart() {
            rebalancer = build();
            return rebalancer;
        },
        payouts,
        withdrawals,
        limiter,
        gate,
        iris: fakeIris,
        irisClient: iris,
        signer,
        chain,
        messenger,
        usdcView,
        clock,
        /** Moves the harness clock on, for the rebalancer, Payouts, the gate and the service. */
        advance(ms: number) {
            clock.t += ms;
        },
        /** Whether the pool's trader is connected; off makes the rebalancer see none. */
        connect(on: boolean) {
            connection.on = on;
        },
        /** How many times the rebalancer asked for the trader. */
        needs,
        /** Every log line so far, parsed. */
        lines,
        /** The log lines with this message. */
        logged: (message: string) => lines.filter((line) => line.msg === message),
        queue: seed,
        seed,
        async rowOf(id: ObjectId): Promise<PoolRebalanceDoc> {
            const row = await collections.poolRebalances.findOne({ _id: id });
            if (!row) throw new Error(`no pool rebalance ${id}`);
            return row;
        },
        /** Sets the treasury's USDC balance on Arc; what withdrawals may take is that less the gas reserve and what is owed. */
        async setTreasury(usdc: string) {
            await chain.setBalance({ address: signer.address, value: parseUnits(usdc, 18) });
        },
        /** The rebalancer, then Payouts, then the rebalancer again. */
        async pass() {
            await rebalancer.tick();
            await payouts.tick();
            await rebalancer.tick();
        },
        async stop() {
            await fakeIris.stop();
            await database.db.dropDatabase().catch(() => undefined);
            await database.close();
        },
    };
}
