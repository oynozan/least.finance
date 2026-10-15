import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { ARC_CHAIN_ID } from "../chain/arc.ts";
import type { Collections } from "../db/mongo.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import { COINS, NETWORKS, type CoinEntry } from "../swaps/coins.ts";
import { LifiError, type Lifi } from "../swaps/lifi.ts";
import type { HedgeDoc, TradeDoc } from "./docs.ts";
import type { InventoryChain } from "./inventory-chain.ts";
import { alreadySent, refused } from "./send-errors.ts";
import { UNIT_DECIMALS, fromUnitsDecimal, toUnitsDecimal } from "./units.ts";

type Deps = {
    client: MongoClient;
    collections: Pick<Collections, "trades" | "hedges">;
    lifi: Pick<Lifi, "quote" | "status">;
    chain: InventoryChain;
    /** The inventory wallet's EVM address, which sells are sent from. */
    inventory: Address;
    /** The Arc treasury, which sells pay into. */
    treasury: Address;
    integrator: string;
    logger: Logger;
    intervalMs?: number;
    /** A coin's net must be worth more than this many dollars to be hedged. */
    minNetUsd?: number;
    slippage?: number;
    /** Called when a hedge is created or changes state. */
    onChange?: (hedge: HedgeDoc) => void;
    now?: () => number;
};

const TRADES_PER_PASS = 500;
/** How often a sent hedge that is still unmined is logged. */
const STUCK_LOG_MS = 60 * 60_000;

type Leg = { symbol: string; units: bigint; usd: bigint };
type Bucket = { units: bigint; usd: bigint; tradeIds: ObjectId[] };

/** The coin legs of a trade from our side: positive units are coins we owe the person's holding, negative are coins that came back to us. */
function legsOf(trade: TradeDoc): Leg[] {
    const usd = fromUnitsDecimal(trade.usd);
    const legs: Leg[] = [];
    if (trade.paidSymbol !== "USDC") {
        legs.push({ symbol: trade.paidSymbol, units: -fromUnitsDecimal(trade.paidUnits), usd: -usd });
    }
    if (trade.gotSymbol !== "USDC") {
        legs.push({ symbol: trade.gotSymbol, units: fromUnitsDecimal(trade.gotUnits), usd });
    }
    return legs;
}

const homeOf = (symbol: string): { entry: CoinEntry; network: (typeof NETWORKS)[number] } | null => {
    const coin = COINS.find((candidate) => candidate.symbol === symbol);
    const entry = coin?.entries.find((candidate) => candidate.network === coin.home);
    const network = NETWORKS.find((candidate) => candidate.id === coin?.home);
    return entry && network ? { entry, network } : null;
};

const arcUsdc = COINS.find((coin) => coin.symbol === "USDC")!.entries.find((entry) => entry.network === "arc")!;

/** Nets unhedged trades per coin and sells the surplus on the market through LI.FI into the Arc treasury; buys are left planned for the operator. */
export class TradeHedger {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #running: Promise<void> = Promise.resolve();
    readonly #logged = new Map<string, number>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            while (!signal.aborted) {
                await this.tick().catch((error: unknown) =>
                    this.#deps.logger.warn({ err: error }, "Hedge pass failed"),
                );
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, this.#deps.intervalMs ?? 30_000);
                    function done() {
                        clearTimeout(timer);
                        signal.removeEventListener("abort", done);
                        resolve();
                    }
                    signal.addEventListener("abort", done, { once: true });
                });
            }
        })();
    }

    async stop() {
        this.#stop?.abort();
        await this.#loop;
        this.#loop = null;
        this.#stop = null;
    }

    /** One pass: records hedges for the nets that are big enough, then drives every open hedge; passes never overlap. */
    tick(): Promise<void> {
        const run = this.#running.then(async () => {
            await this.#plan();
            await this.#drive();
        });
        this.#running = run.catch(() => undefined);
        return run;
    }

    /** A hedge is recorded and its trades marked hedged in one transaction, so a trade is never netted twice. */
    async #plan() {
        const { collections, client, logger } = this.#deps;
        const trades = await collections.trades
            .find({ hedged: false })
            .sort({ _id: 1 })
            .limit(TRADES_PER_PASS)
            .toArray();
        if (trades.length === 0) return;

        const covered = new Set<string>();
        const hedgesOfThese = await collections.hedges
            .find({ tradeIds: { $in: trades.map((trade) => trade._id) } })
            .toArray();
        for (const hedge of hedgesOfThese) for (const id of hedge.tradeIds) covered.add(`${id}:${hedge.symbol}`);

        // What each trade still needs hedged, and the net of those legs per coin
        const pending = new Map<string, Set<string>>();
        const buckets = new Map<string, Bucket>();
        for (const trade of trades) {
            const open = new Set<string>();
            for (const leg of legsOf(trade)) {
                if (covered.has(`${trade._id}:${leg.symbol}`)) continue;
                open.add(leg.symbol);
                const bucket = buckets.get(leg.symbol) ?? { units: 0n, usd: 0n, tradeIds: [] };
                bucket.units += leg.units;
                bucket.usd += leg.usd;
                bucket.tradeIds.push(trade._id);
                buckets.set(leg.symbol, bucket);
            }
            pending.set(trade._id.toString(), open);
        }

        const threshold = BigInt(Math.round((this.#deps.minNetUsd ?? 1) * 1e6)) * 10n ** 12n;
        const settled: HedgeDoc[] = [];
        for (const [symbol, bucket] of buckets) {
            const netUsd = bucket.usd < 0n ? -bucket.usd : bucket.usd;
            // Offsetting trades that net to nothing are closed without an order
            if (bucket.units !== 0n && netUsd <= threshold) continue;
            const side = bucket.units >= 0n ? "buy" : "sell";
            const home = homeOf(symbol);
            const at = new Date(this.#now());
            const hedge: HedgeDoc = {
                _id: new ObjectId(),
                symbol,
                side,
                units: toUnitsDecimal(bucket.units < 0n ? -bucket.units : bucket.units),
                usd: toUnitsDecimal(netUsd),
                tradeIds: bucket.tradeIds,
                state: bucket.units === 0n ? "done" : "planned",
                txHash: null,
                tool: null,
                reason: bucket.units === 0n ? "Trades netted to nothing" : this.#operatorNote(symbol, side, home),
                createdAt: at,
                updatedAt: at,
            };
            for (const id of bucket.tradeIds) pending.get(id.toString())?.delete(symbol);
            const done = bucket.tradeIds.filter((id) => pending.get(id.toString())?.size === 0);
            await client.withSession((session: ClientSession) =>
                session.withTransaction(async () => {
                    await collections.hedges.insertOne(hedge, { session });
                    if (done.length > 0) {
                        await collections.trades.updateMany(
                            { _id: { $in: done } },
                            { $set: { hedged: true } },
                            { session },
                        );
                    }
                }),
            );
            settled.push(hedge);
            logger.info({ symbol, side, hedge: hedge._id.toString() }, "Recorded a hedge");
        }
        // Trades whose legs were all covered earlier but never flagged
        const cleared = trades
            .filter((trade) => pending.get(trade._id.toString())?.size === 0)
            .map((trade) => trade._id);
        if (cleared.length > 0)
            await collections.trades.updateMany({ _id: { $in: cleared } }, { $set: { hedged: true } });
        for (const hedge of settled) this.#deps.onChange?.(hedge);
    }

    #operatorNote(symbol: string, side: "buy" | "sell", home: ReturnType<typeof homeOf>): string | null {
        if (side === "buy") return `Operator: buy ${symbol} into the inventory wallet`;
        if (home?.network.kind === "solana") return `Operator: sell ${symbol} from the Solana inventory wallet`;
        return null;
    }

    async #drive() {
        const open = await this.#deps.collections.hedges
            .find({ state: { $in: ["planned", "sending", "sent"] } })
            .sort({ createdAt: 1 })
            .toArray();
        for (const hedge of open) {
            try {
                if (hedge.state === "planned") await this.#execute(hedge);
                else await this.#follow(hedge);
            } catch (error) {
                this.#deps.logger.warn({ err: error, hedge: hedge._id.toString() }, "Couldn't move a hedge along");
            }
        }
    }

    /** Sells a planned hedge's coins from the inventory wallet for USDC on Arc. */
    async #execute(hedge: HedgeDoc) {
        const home = homeOf(hedge.symbol);
        if (!home) return this.#fail(hedge, `${hedge.symbol} can't be hedged`);
        // Buys and Solana sells wait for the operator
        if (hedge.side === "buy" || home.network.kind !== "evm") return;

        const { lifi, chain, inventory, treasury } = this.#deps;
        const network = home.network.id as EvmNetworkId;
        const fromAmount = fromUnitsDecimal(hedge.units) / 10n ** BigInt(UNIT_DECIMALS - home.entry.decimals);
        if (fromAmount <= 0n) return this.#fail(hedge, "Nothing to sell");

        let quote;
        try {
            quote = await lifi.quote({
                fromChain: home.network.chainId,
                toChain: ARC_CHAIN_ID,
                fromToken: home.entry.address,
                toToken: arcUsdc.address,
                fromAddress: inventory,
                toAddress: treasury,
                fromAmount: fromAmount.toString(),
                slippage: this.#deps.slippage ?? 0.01,
                integrator: this.#deps.integrator,
            });
        } catch (error) {
            if (error instanceof LifiError && error.kind === "no_route") return this.#fail(hedge, "LI.FI has no route");
            throw error;
        }
        if (quote.tx.kind !== "evm") return this.#fail(hedge, "LI.FI sent a transaction for another kind of chain");

        const native = home.entry.reserve !== undefined;
        if (!native && !quote.skipApproval && quote.approvalAddress) {
            const spender = quote.approvalAddress as Address;
            const token = home.entry.address as Address;
            if ((await chain.allowance(network, token, spender)) < fromAmount) {
                await chain.approve(network, token, spender, fromAmount);
            }
        }

        let prepared;
        try {
            prepared = await chain.prepare(network, {
                to: quote.tx.to as Address,
                data: quote.tx.data as Hex,
                value: BigInt(quote.tx.value),
            });
        } catch (error) {
            if (refused(error)) return this.#fail(hedge, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
        // The hash is recorded before the transaction goes out
        const claimed = await this.#deps.collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: "planned" },
            {
                $set: {
                    state: "sending",
                    txHash: prepared.hash,
                    tool: quote.tool,
                    reason: null,
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!claimed) return;
        this.#deps.onChange?.(claimed);

        try {
            await chain.broadcast(network, prepared);
        } catch (error) {
            if (alreadySent(error)) return;
            if (refused(error)) return this.#fail(claimed, `The network refused it: ${firstLine(error)}`);
            throw error;
        }
        await this.#move(claimed, "sending", { state: "sent" });
    }

    /** Follows a sent hedge's hash to done or failed: first the source transaction, then LI.FI's view of the crossing to Arc. */
    async #follow(hedge: HedgeDoc) {
        const home = homeOf(hedge.symbol);
        if (!hedge.txHash || !home || home.network.kind !== "evm") return;
        const network = home.network.id as EvmNetworkId;

        const receipt = await this.#deps.chain.receipt(network, hedge.txHash as Hex);
        if (receipt === null) {
            const last = this.#logged.get(hedge.txHash) ?? 0;
            if (this.#now() - hedge.updatedAt.getTime() > STUCK_LOG_MS && this.#now() - last > STUCK_LOG_MS) {
                this.#logged.set(hedge.txHash, this.#now());
                this.#deps.logger.error(
                    { hedge: hedge._id.toString(), txHash: hedge.txHash },
                    "A hedge is still unmined",
                );
            }
            return;
        }
        if (receipt === "reverted") return this.#fail(hedge, "The sell reverted on the network");

        let current = hedge;
        if (hedge.state === "sending") current = (await this.#move(hedge, "sending", { state: "sent" })) ?? hedge;

        const status = await this.#deps.lifi.status({
            txHash: hedge.txHash,
            fromChain: home.network.chainId,
            toChain: ARC_CHAIN_ID,
            ...(hedge.tool ? { bridge: hedge.tool } : {}),
        });
        if (status.status === "DONE") await this.#move(current, "sent", { state: "done" });
        else if (status.status === "FAILED")
            await this.#fail(
                current,
                `LI.FI reports the sell failed${status.substatus ? `: ${status.substatus}` : ""}`,
            );
    }

    async #move(hedge: HedgeDoc, from: HedgeDoc["state"], set: Partial<HedgeDoc>) {
        const updated = await this.#deps.collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: from },
            { $set: { ...set, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (updated) this.#deps.onChange?.(updated);
        return updated;
    }

    async #fail(hedge: HedgeDoc, reason: string) {
        this.#deps.logger.warn({ hedge: hedge._id.toString(), reason }, "A hedge failed");
        const updated = await this.#deps.collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: { $in: ["planned", "sending", "sent"] } },
            { $set: { state: "failed", reason, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (updated) this.#deps.onChange?.(updated);
    }
}

const firstLine = (error: unknown) =>
    String((error as Error)?.message ?? error)
        .split("\n")[0]!
        .slice(0, 200);
