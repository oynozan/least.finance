import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { ARC_CHAIN_ID } from "../chain/arc.ts";
import type { Collections } from "../db/mongo.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import { COINS, NETWORKS, type CoinEntry } from "../swaps/coins.ts";
import { QuoteRejected, broke, checkQuote } from "../swaps/check.ts";
import { LifiError, MAX_QUOTE_SLIPPAGE, tooFarUnder, type Lifi, type LifiQuote } from "../swaps/lifi.ts";
import { loopWatch } from "../loop-watch.ts";
import type { HedgeDoc, SendAttempt, TradeDoc } from "./docs.ts";
import {
    MAX_ATTEMPTS,
    attemptOf,
    attemptsOf,
    highestFees,
    minedAmong,
    type InventoryChain,
} from "./inventory-chain.ts";
import { RepeatGate, quoted, upstreamSaid } from "./failures.ts";
import { alreadySent, refused } from "./send-errors.ts";
import { UNIT_DECIMALS, fromUnitsDecimal, toUnitsDecimal } from "./units.ts";

type Deps = {
    client: MongoClient;
    collections: Pick<Collections, "trades" | "hedges">;
    /** Without `chains` the hedger can't tell LI.FI's diamond, so it signs no quote */
    lifi: Pick<Lifi, "quote" | "status"> & Partial<Pick<Lifi, "chains">>;
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
    /** Time without a receipt after which a stored sell is signed and sent again on its nonce */
    resendAfterMs?: number;
    /** Called when a hedge is created or changes state. */
    onChange?: (hedge: HedgeDoc) => void;
    now?: () => number;
};

const TRADES_PER_PASS = 500;
const DEFAULT_RESEND_MS = 120_000;
/** How often a sent hedge that is still unmined is logged. */
const STUCK_LOG_MS = 60 * 60_000;

type Leg = { symbol: string; units: bigint; usd: bigint };
type Bucket = { units: bigint; usd: bigint; tradeIds: ObjectId[] };

/**
 * The coin legs of a trade from our side: positive units are coins we owe the person's holding, negative are coins that came back to us.
 * Each leg is worth its coins at the market price, which is not the trade's dollars: a buy paid its spread on top, and a sale or swap was paid it off.
 */
function legsOf(trade: TradeDoc): Leg[] {
    const usd = fromUnitsDecimal(trade.usd);
    // Trades filled before the spread have none
    const spread = trade.spreadUSD ? fromUnitsDecimal(trade.spreadUSD) : 0n;
    const legs: Leg[] = [];
    if (trade.paidSymbol !== "USDC") {
        legs.push({ symbol: trade.paidSymbol, units: -fromUnitsDecimal(trade.paidUnits), usd: -(usd + spread) });
    }
    if (trade.gotSymbol !== "USDC") {
        // A buy's coins cost the spread more than they are worth; a swap's coins are bought at the market price
        legs.push({
            symbol: trade.gotSymbol,
            units: fromUnitsDecimal(trade.gotUnits),
            usd: trade.verb === "buy" ? usd - spread : usd,
        });
    }
    return legs;
}

const homeOf = (symbol: string): { entry: CoinEntry; network: (typeof NETWORKS)[number] } | null => {
    const coin = COINS.find((candidate) => candidate.symbol === symbol);
    const entry = coin?.entries.find((candidate) => candidate.network === coin.home);
    const network = NETWORKS.find((candidate) => candidate.id === coin?.home);
    return entry && network ? { entry, network } : null;
};

type Home = NonNullable<ReturnType<typeof homeOf>>;

const nameOf = (id: string) => NETWORKS.find((network) => network.id === id)?.name ?? id;

const arcUsdc = COINS.find((coin) => coin.symbol === "USDC")!.entries.find((entry) => entry.network === "arc")!;

/** Nets unhedged trades per coin and sells the surplus on the market through LI.FI into the Arc treasury; buys are left planned for the operator. */
export class TradeHedger {
    readonly #deps: Deps;
    readonly #now: () => number;
    #stop: AbortController | null = null;
    #loop: Promise<void> | null = null;
    #running: Promise<void> = Promise.resolve();
    readonly #logged = new Map<string, number>();
    /** The same failure of a pass or a hedge, logged once and then once every while. */
    readonly #repeats: RepeatGate;
    /** What the hedge in hand was doing when it failed, for the log line. */
    #step = "";
    #request: Record<string, unknown> = {};

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#repeats = new RepeatGate(STUCK_LOG_MS, this.#now);
    }

    /** What every log line about a hedge carries. */
    #fields(hedge: HedgeDoc) {
        const home = homeOf(hedge.symbol);
        return {
            hedge: hedge._id.toHexString(),
            state: hedge.state,
            symbol: hedge.symbol,
            side: hedge.side,
            units: hedge.units.toString(),
            usd: hedge.usd.toString(),
            network: home?.network.id ?? null,
            tool: hedge.tool,
            txHash: hedge.txHash,
            nonce: hedge.nonce ?? null,
            trades: hedge.tradeIds.length,
        };
    }

    start() {
        if (this.#loop) return;
        this.#stop = new AbortController();
        const signal = this.#stop.signal;
        this.#loop = (async () => {
            const watch = loopWatch(this.#deps.logger, "hedge");
            const usualMs = this.#deps.intervalMs ?? 30_000;
            while (!signal.aborted) {
                let waitMs = usualMs;
                try {
                    await this.tick();
                    watch.ok();
                } catch (error) {
                    waitMs = watch.failed(error, usualMs);
                }
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, waitMs);
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
                nonce: null,
                tx: null,
                attempts: [],
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
            this.#step = hedge.state === "planned" ? "start" : "follow";
            this.#request = {};
            try {
                if (hedge.state === "planned") await this.#execute(hedge);
                else await this.#follow(hedge);
                this.#repeats.clear(hedge._id.toHexString());
            } catch (error) {
                await this.#stuck(hedge, error);
            }
        }
    }

    /** An error that doesn't fail the hedge leaves it where it is: logged once with the step it was on, and a planned hedge says what it waits for. */
    async #stuck(hedge: HedgeDoc, error: unknown) {
        const said = upstreamSaid(error);
        const again = this.#repeats.note(hedge._id.toHexString(), `${this.#step}:${said}`);
        if (!again) return;
        this.#deps.logger.warn(
            {
                event: "hedge:stuck",
                ...this.#fields(hedge),
                step: this.#step,
                ...this.#request,
                upstream: error instanceof LifiError ? error.said : undefined,
                repeatsLeftOut: again.skipped,
                err: error,
            },
            `Couldn't move a hedge along at its ${this.#step} step: ${said}`,
        );
        if (hedge.state === "planned") await this.#note(hedge, `Retrying (${this.#step}): ${said}`, said);
    }

    /** Says on a planned hedge why it isn't moving, without changing its state. */
    async #note(hedge: HedgeDoc, reason: string, detail: string) {
        if (hedge.reason === reason) return;
        await this.#deps.collections.hedges.updateOne(
            { _id: hedge._id, state: "planned" },
            { $set: { reason, detail } },
        );
        hedge.reason = reason;
    }

    /** Sells a planned hedge's coins from the inventory wallet for USDC on Arc. */
    async #execute(hedge: HedgeDoc) {
        const home = homeOf(hedge.symbol);
        if (!home)
            return this.#fail(
                hedge,
                `${hedge.symbol} has no home network entry, so it can't be hedged`,
                undefined,
                "error",
            );
        // Buys and Solana sells wait for the operator
        if (hedge.side === "buy" || home.network.kind !== "evm") return;

        const { lifi, chain, inventory, treasury } = this.#deps;
        const network = home.network.id as EvmNetworkId;
        const fromAmount = fromUnitsDecimal(hedge.units) / 10n ** BigInt(UNIT_DECIMALS - home.entry.decimals);
        if (fromAmount <= 0n)
            return this.#fail(
                hedge,
                `Nothing to sell: ${hedge.units.toString()} ${hedge.symbol} rounds to 0 at ${home.entry.decimals} decimals`,
            );

        const request = {
            fromChain: home.network.chainId,
            toChain: ARC_CHAIN_ID,
            fromToken: home.entry.address,
            toToken: arcUsdc.address,
            fromAddress: inventory,
            toAddress: treasury,
            fromAmount: fromAmount.toString(),
            slippage: this.#deps.slippage ?? 0.01,
            integrator: this.#deps.integrator,
        };
        this.#step = "quote";
        this.#request = { request };
        let quote;
        try {
            quote = await lifi.quote(request);
        } catch (error) {
            if (error instanceof LifiError && error.kind === "no_route")
                return this.#fail(
                    hedge,
                    `LI.FI found no route for ${hedge.units.toString()} ${hedge.symbol} on ${nameOf(network)} to USDC on Arc`,
                    `LI.FI answered ${error.said.status}${error.said.code !== undefined ? ` (code ${error.said.code})` : ""}${error.said.upstream ? `: "${error.said.upstream}"` : ""}`,
                );
            throw error;
        }
        // A route whose minimum sits further under the amount than this is left planned, and asked for again on the next pass
        if (tooFarUnder(quote)) {
            const percent = Math.round(quote.shortfall * 1000) / 10;
            const reason = `Waiting: LI.FI's minimum is ${percent}% under the amount (limit ${MAX_QUOTE_SLIPPAGE * 100}%), retrying`;
            if (this.#repeats.note(`${hedge._id.toHexString()}:far`, reason))
                this.#deps.logger.warn(
                    {
                        event: "hedge:too-far-under",
                        ...this.#fields(hedge),
                        shortfall: quote.shortfall,
                        slippage: quote.slippage,
                        limit: MAX_QUOTE_SLIPPAGE,
                        toAmount: quote.toAmount,
                        toAmountMin: quote.toAmountMin,
                        tool: quote.tool,
                    },
                    "A hedge's minimum is too far under its amount, leaving it planned",
                );
            return this.#note(
                hedge,
                reason,
                `toAmount ${quote.toAmount}, toAmountMin ${quote.toAmountMin}, tool ${quote.tool}`,
            );
        }
        if (quote.tx.kind !== "evm")
            return this.#fail(
                hedge,
                `LI.FI sent a ${quote.tx.kind} transaction for a sell on ${nameOf(network)} (quote ${quote.id}, tool ${quote.tool})`,
            );

        this.#step = "check";
        try {
            await this.#check(quote, home, network, fromAmount, hedge);
        } catch (error) {
            // The quote was logged with both sides when it was refused; the hedge says why it waits
            if (error instanceof QuoteRejected)
                return this.#note(hedge, error.message, `${error.rule}: expected ${error.expected}, got ${error.got}`);
            throw error;
        }
        this.#step = "approve";

        const native = home.entry.reserve !== undefined;
        if (!native && !quote.skipApproval && quote.approvalAddress) {
            const spender = quote.approvalAddress as Address;
            const token = home.entry.address as Address;
            if ((await chain.allowance(network, token, spender)) < fromAmount) {
                await chain.approve(network, token, spender, fromAmount);
            }
        }

        const tx = { to: quote.tx.to, data: quote.tx.data, value: BigInt(quote.tx.value).toString() };
        this.#step = "prepare";
        let prepared;
        try {
            prepared = await chain.prepare(network, {
                to: tx.to as Address,
                data: tx.data as Hex,
                value: BigInt(tx.value),
            });
        } catch (error) {
            if (refused(error))
                return this.#fail(
                    hedge,
                    `The ${nameOf(network)} network refused the sell: ${quoted(upstreamSaid(error))}`,
                    upstreamSaid(error),
                    "warn",
                    error,
                );
            throw error;
        }
        // The hash and nonce are recorded before the transaction goes out
        const claimed = await this.#deps.collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: "planned" },
            {
                $set: {
                    state: "sending",
                    txHash: prepared.hash,
                    nonce: prepared.nonce,
                    tx,
                    attempts: [attemptOf(prepared)],
                    tool: quote.tool,
                    reason: null,
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!claimed) return chain.release(network, prepared.nonce);
        this.#deps.onChange?.(claimed);

        this.#step = "broadcast";
        try {
            await chain.broadcast(network, prepared);
        } catch (error) {
            return this.#answered(claimed, error, network, prepared.nonce, false);
        }
        await this.#move(claimed, "sending", { state: "sent" });
    }

    /** A refused first attempt fails and frees its nonce, but a refused replacement leaves the earlier attempts to the receipts */
    async #answered(hedge: HedgeDoc, error: unknown, network: EvmNetworkId, nonce: number, replacing: boolean) {
        if (alreadySent(error) || (replacing && refused(error))) {
            if (this.#repeats.note(`${hedge._id.toHexString()}:nonce:${nonce}`, upstreamSaid(error)))
                this.#deps.logger.warn(
                    {
                        event: "hedge:nonce-in-use",
                        ...this.#fields(hedge),
                        network,
                        nonce,
                        attempts: attemptsOf(hedge).length,
                        replacing,
                        upstream: upstreamSaid(error),
                    },
                    "The nonce is already in use, the receipts decide",
                );
            return;
        }
        if (!refused(error)) throw error;
        await this.#fail(
            hedge,
            `The ${nameOf(network)} network refused the sell: ${quoted(upstreamSaid(error))}`,
            upstreamSaid(error),
            "warn",
            error,
        );
        this.#deps.chain.release(network, nonce);
    }

    /** Throws unless the quote is the sell that was asked for, with any approval going to LI.FI's diamond */
    async #check(quote: LifiQuote, home: Home, network: EvmNetworkId, fromAmount: bigint, hedge: HedgeDoc) {
        const { lifi, inventory, treasury, logger } = this.#deps;
        if (!lifi.chains) throw new Error("The hedger can't read LI.FI's chains, so it can't check a quote");
        // A quote that fails the same way every pass is logged once, not every half minute
        const gated = {
            warn: (context: object, message: string) => {
                if (this.#repeats.note(`${hedge._id.toHexString()}:check`, message))
                    logger.warn({ ...this.#fields(hedge), ...context }, message);
            },
        };
        const chains = await lifi.chains();
        const diamond = chains.find((chain) => chain.id === home.network.chainId)?.diamondAddress ?? null;
        checkQuote(
            quote,
            {
                fromNetwork: network,
                from: home.entry,
                toNetwork: "arc",
                to: arcUsdc,
                fromAddress: inventory,
                toAddress: treasury,
                fromUnits: fromAmount,
                diamond,
            },
            gated,
        );
        // An approval goes to the contract the checked transaction calls, and nowhere else
        const approves = home.entry.reserve === undefined && !quote.skipApproval;
        if (approves && quote.approvalAddress?.toLowerCase() !== diamond?.toLowerCase()) {
            gated.warn(
                {
                    event: "quote:rejected",
                    rule: "approval address",
                    expected: diamond,
                    got: quote.approvalAddress,
                    quote: quote.id,
                    tool: quote.tool,
                },
                "Refused a swap quote: its approval address doesn't match",
            );
            throw new QuoteRejected(
                broke("approval address", diamond ?? "none listed by LI.FI", quote.approvalAddress),
            );
        }
    }

    /** Follows a sent hedge's hash to done or failed: first the source transaction, then LI.FI's view of the crossing to Arc. */
    async #follow(hedge: HedgeDoc) {
        const home = homeOf(hedge.symbol);
        if (!hedge.txHash || !home || home.network.kind !== "evm") return;
        const network = home.network.id as EvmNetworkId;
        const { chain } = this.#deps;

        // A recorded nonce is held back from new sells even while its resend window runs
        if (hedge.nonce != null) chain.reserve(network, hedge.nonce);
        const attempts = attemptsOf(hedge);
        const mined = await minedAmong(chain, network, attempts);
        if (mined === null) {
            if (this.#due(hedge, attempts)) return this.#resend(hedge, network, attempts);
            const last = this.#logged.get(hedge.txHash) ?? 0;
            if (this.#now() - hedge.updatedAt.getTime() > STUCK_LOG_MS && this.#now() - last > STUCK_LOG_MS) {
                this.#logged.set(hedge.txHash, this.#now());
                this.#deps.logger.error(
                    {
                        event: "hedge:unmined",
                        ...this.#fields(hedge),
                        attempts: attempts.length,
                        ageMs: this.#now() - hedge.updatedAt.getTime(),
                        fees: attempts.at(-1),
                    },
                    "A hedge is still unmined",
                );
            }
            return;
        }
        if (mined.status === "reverted")
            return this.#fail(hedge, `The sell reverted on ${nameOf(network)} (tx ${mined.hash})`, `tx ${mined.hash} reverted`);

        // Whichever attempt mined is the sell to follow
        let current = hedge;
        if (hedge.state === "sending")
            current = (await this.#move(hedge, "sending", { state: "sent", txHash: mined.hash })) ?? hedge;
        else if (hedge.txHash !== mined.hash)
            current = (await this.#move(hedge, "sent", { txHash: mined.hash })) ?? hedge;

        const status = await this.#deps.lifi.status({
            txHash: mined.hash,
            fromChain: home.network.chainId,
            toChain: ARC_CHAIN_ID,
            ...(hedge.tool ? { bridge: hedge.tool } : {}),
        });
        if (status.status === "DONE") await this.#move(current, "sent", { state: "done" });
        else if (status.status === "FAILED")
            await this.#fail(
                current,
                `LI.FI reports the sell failed${status.substatus ? `: ${status.substatus}` : ""}${status.substatusMessage ? ` (${status.substatusMessage})` : ""}`,
                `LI.FI status FAILED, substatus ${status.substatus ?? "none"}, ${status.substatusMessage ?? "no message"}`,
            );
    }

    /** True once a stored sell has gone a window without a receipt and has replacements left */
    #due(hedge: HedgeDoc, attempts: SendAttempt[]): boolean {
        if (hedge.nonce == null || !hedge.tx || attempts.length >= MAX_ATTEMPTS) return false;
        return this.#now() - hedge.updatedAt.getTime() >= (this.#deps.resendAfterMs ?? DEFAULT_RESEND_MS);
    }

    /** Signs the stored sell again on its nonce paying more than the attempts so far, and sends it */
    async #resend(hedge: HedgeDoc, network: EvmNetworkId, attempts: SendAttempt[]) {
        const { chain, collections } = this.#deps;
        const nonce = hedge.nonce!;
        const tx = hedge.tx!;
        let prepared;
        try {
            prepared = await chain.prepare(
                network,
                { to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value) },
                nonce,
                highestFees(attempts),
            );
        } catch (error) {
            return this.#answered(hedge, error, network, nonce, true);
        }
        const resent = await collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: hedge.state },
            {
                $set: {
                    txHash: prepared.hash,
                    attempts: [...attempts, attemptOf(prepared)],
                    updatedAt: new Date(this.#now()),
                },
            },
            { returnDocument: "after" },
        );
        if (!resent) return;
        if (attempts.length + 1 === MAX_ATTEMPTS) {
            this.#deps.logger.error(
                {
                    event: "hedge:unmined",
                    ...this.#fields(resent),
                    network,
                    attempts: attempts.length + 1,
                    ageMs: this.#now() - hedge.updatedAt.getTime(),
                    fees: attemptOf(prepared),
                },
                "A hedge is still unmined after its last resend",
            );
        }

        try {
            await chain.broadcast(network, prepared);
        } catch (error) {
            return this.#answered(resent, error, network, nonce, true);
        }
        if (resent.state === "sending") await this.#move(resent, "sending", { state: "sent" });
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

    /** Fails the hedge: `reason` is what it says is wrong, `detail` the upstream's own words behind it. */
    async #fail(hedge: HedgeDoc, reason: string, detail?: string, level: "warn" | "error" = "warn", error?: unknown) {
        const updated = await this.#deps.collections.hedges.findOneAndUpdate(
            { _id: hedge._id, state: { $in: ["planned", "sending", "sent"] } },
            { $set: { state: "failed", reason, detail: detail ?? reason, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (updated) {
            this.#deps.logger[level](
                {
                    event: "hedge:failed",
                    ...this.#fields(hedge),
                    step: this.#step,
                    ...this.#request,
                    reason,
                    upstream: detail,
                    ...(error !== undefined && { err: error }),
                },
                `A hedge failed: ${reason}`,
            );
            this.#deps.onChange?.(updated);
        }
    }
}
