import { ObjectId } from "mongodb";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type PublicClient } from "viem";
import type { IdentityProvider, Identity } from "../auth/identity.ts";
import type { AccountDoc, Collections, SwapOrderDoc } from "../db/mongo.ts";
import { AppError } from "../errors.ts";
import type { Bus } from "../events.ts";
import type { SwapOrderRequest, SwapQuoteView, SwapRequest, SwapSide, SwapTxView } from "../protocol.ts";
import type { SwapCatalog } from "./catalog.ts";
import { checkQuote } from "./check.ts";
import type { EvmNetworkId } from "./clients.ts";
import { COINS, NATIVE_EVM, NETWORKS, type CoinEntry, type SwapNetwork } from "./coins.ts";
import type { SwapHoldings } from "./holdings.ts";
import { LifiError, MAX_QUOTE_SLIPPAGE, tooFarUnder, type Lifi, type LifiQuote } from "./lifi.ts";

type Deps = {
    collections: Collections;
    lifi: Lifi;
    catalog: Pick<SwapCatalog, "priceOf">;
    holdings: Pick<SwapHoldings, "last">;
    clients: Record<EvmNetworkId, PublicClient>;
    identity: IdentityProvider;
    bus: Bus;
    integrator: string;
    /** The share of each swap kept as our fee; 0 for none. */
    fee: number;
    now?: () => number;
};

/** The price moves this far below the reviewed amount before the person must look again. */
const DRIFT = 0.005;
const CACHE_MS = 10_000;
/** Orders an account may have waiting on its wallet or the networks at once. */
const UNSETTLED_LIMIT = 5;
const IP_KEEP_MS = 30 * 86_400_000;
const RECENT_MS = 7 * 86_400_000;
const RECENT_LIMIT = 50;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UNAVAILABLE = "Swaps aren't available right now.";

const networkOf = (id: SwapSide["network"]): SwapNetwork => NETWORKS.find((network) => network.id === id)!;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Units of a coin worth `amountUSD` at `price`, rounded down. */
function unitsOf(amountUSD: string, price: number, decimals: number): bigint {
    const [whole = "0", fraction = ""] = amountUSD.split(".");
    const micro = BigInt(whole + fraction.padEnd(6, "0").slice(0, 6));
    const priceE8 = BigInt(Math.round(price * 1e8));
    if (priceE8 === 0n) throw new AppError("unavailable", UNAVAILABLE);
    return (micro * 100n * 10n ** BigInt(decimals)) / priceE8;
}

type Plan = {
    from: CoinEntry;
    /** The paid coin's symbol. */
    symbol: string;
    to: CoinEntry;
    fromNetwork: SwapNetwork;
    toNetwork: SwapNetwork;
    wallet: string;
    receiver: string;
    fromUnits: bigint;
};

type Prepared = Plan & { quote: LifiQuote; diamond: string | null };

/** Swap orders: the person's own wallet pays, LI.FI routes, and the server checks every transaction it builds. */
export class SwapOrders {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #cache = new Map<string, { at: number; view: SwapQuoteView }>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** What LI.FI would pay for the swap, with no order opened; the same request is answered from the cache for 10 s. */
    async quote(account: AccountDoc, identity: Identity, req: SwapRequest): Promise<SwapQuoteView> {
        const plan = await this.#plan(account, identity, req);
        const key = this.#key(req, plan);
        const cached = this.#cache.get(key);
        if (cached && this.#now() - cached.at < CACHE_MS) return cached.view;
        const prepared = await this.#fetch(plan);
        const view = await this.#view(req, prepared);
        return this.#remember(key, view);
    }

    /**
     * Quotes again, checks the price against the reviewed one and opens an order; the wallet then signs `txs` and reports
     * their hashes. A `slippage` is the one the review showed, which LI.FI is asked for so that only a move in the price
     * changes the minimum; without it LI.FI picks again.
     */
    async create(
        account: AccountDoc,
        identity: Identity,
        req: SwapOrderRequest,
        ip: string,
    ): Promise<{ order: SwapOrderDoc; txs: SwapTxView[] }> {
        const { collections } = this.#deps;
        const unsettled = await collections.swapOrders.countDocuments({
            accountId: account._id,
            state: { $in: ["created", "sent"] },
        });
        if (unsettled >= UNSETTLED_LIMIT) {
            throw new AppError("rate_limited", "Too many swaps are still waiting. Try again in a few minutes.");
        }

        const { reviewedMin, slippage, ...request } = req;
        const prepared = await this.#fetch(await this.#plan(account, identity, request), slippage);
        const { quote, from, to } = prepared;
        // The fresh quote becomes the cached one, so a refused confirm shows the new price
        const approvals = await this.#approvals(prepared);
        this.#remember(this.#key(request, prepared), this.#build(request, prepared, approvals.length > 0));

        const floor = (parseUnits(reviewedMin, to.decimals) * BigInt(Math.round((1 - DRIFT) * 1000))) / 1000n;
        if (BigInt(quote.toAmountMin) < floor) {
            throw new AppError("price_moved", "The price moved. Check the new amount and confirm again.");
        }

        const now = new Date(this.#now());
        const order: SwapOrderDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            wallet: prepared.wallet,
            receiver: prepared.receiver,
            from: {
                token: request.from.token,
                network: request.from.network,
                units: quote.fromAmount,
                amount: formatUnits(BigInt(quote.fromAmount), from.decimals),
            },
            to: {
                token: request.to.token,
                network: request.to.network,
                units: quote.toAmount,
                minUnits: quote.toAmountMin,
                amount: formatUnits(BigInt(quote.toAmount), to.decimals),
                minAmount: formatUnits(BigInt(quote.toAmountMin), to.decimals),
            },
            tool: quote.tool,
            toolName: quote.toolName,
            fees: quote.fees.map((fee) => ({ name: fee.name, usd: fee.amountUSD })),
            gasUSD: quote.gasUSD,
            etaSeconds: quote.etaSeconds,
            state: "created",
            txHashes: [],
            received: null,
            receivedSymbol: null,
            createdAt: now,
            updatedAt: now,
        };
        await collections.swapOrders.insertOne(order);
        await collections.swapIps.insertOne({
            _id: new ObjectId(),
            orderId: order._id,
            ip,
            expiresAt: new Date(now.getTime() + IP_KEEP_MS),
        });
        this.#deps.bus.emit("swap:updated", { order });

        const swap: SwapTxView =
            quote.tx.kind === "solana"
                ? { kind: "solana", data: quote.tx.data }
                : {
                      kind: "evm",
                      purpose: "swap",
                      chainId: quote.tx.chainId,
                      to: getAddress(quote.tx.to),
                      data: quote.tx.data,
                      value: quote.tx.value,
                  };
        return { order, txs: [...approvals, swap] };
    }

    /** Moves a created order, or an expired one that has no hashes, to sent; a repeat changes nothing. */
    async reportSent(account: AccountDoc, orderId: string, hashes: string[]): Promise<SwapOrderDoc> {
        const { swapOrders } = this.#deps.collections;
        const _id = new ObjectId(orderId);
        const moved = await swapOrders.findOneAndUpdate(
            {
                _id,
                accountId: account._id,
                $or: [{ state: "created" }, { state: "expired", txHashes: { $size: 0 } }],
            },
            { $set: { state: "sent", txHashes: hashes, updatedAt: new Date(this.#now()) } },
            { returnDocument: "after" },
        );
        if (moved) {
            this.#deps.bus.emit("swap:updated", { order: moved });
            return moved;
        }
        const order = await swapOrders.findOne({ _id, accountId: account._id });
        if (!order) throw new AppError("not_found", "That swap isn't yours or doesn't exist.");
        return order;
    }

    /**
     * The orders the wallet sent that are still open or settled in the last 7 days, newest first. One
     * the wallet never sent (its prompt turned down) never started, so it isn't listed.
     */
    recent(accountId: ObjectId): Promise<SwapOrderDoc[]> {
        const since = new Date(this.#now() - RECENT_MS);
        return this.#deps.collections.swapOrders
            .find({
                accountId,
                "txHashes.0": { $exists: true },
                $or: [{ state: "sent" }, { updatedAt: { $gte: since } }],
            })
            .sort({ createdAt: -1, _id: -1 })
            .limit(RECENT_LIMIT)
            .toArray();
    }

    #key(req: SwapRequest, prepared: Plan) {
        const { from, to, amountUSD } = req;
        return JSON.stringify([from, to, amountUSD, prepared.wallet, prepared.receiver, prepared.fromUnits.toString()]);
    }

    #remember(key: string, view: SwapQuoteView) {
        const now = this.#now();
        for (const [other, { at }] of this.#cache) if (now - at >= CACHE_MS) this.#cache.delete(other);
        this.#cache.set(key, { at: now, view });
        return view;
    }

    async #view(req: SwapRequest, prepared: Prepared): Promise<SwapQuoteView> {
        return this.#build(req, prepared, (await this.#approvals(prepared)).length > 0);
    }

    #build(req: SwapRequest, { quote, from, to }: Prepared, needsApproval: boolean): SwapQuoteView {
        return {
            request: req,
            fromAmount: formatUnits(BigInt(quote.fromAmount), from.decimals),
            toAmount: formatUnits(BigInt(quote.toAmount), to.decimals),
            toAmountMin: formatUnits(BigInt(quote.toAmountMin), to.decimals),
            // Over the most an order may pin, as an intent route can report, there is none to send back
            ...(quote.slippage > 0 && quote.slippage <= MAX_QUOTE_SLIPPAGE && { slippage: quote.slippage }),
            fees: quote.fees.map((fee) => ({ name: fee.name, usd: fee.amountUSD })),
            gasUSD: quote.gasUSD,
            etaSeconds: quote.etaSeconds,
            tool: quote.toolName,
            needsApproval,
        };
    }

    /** The approvals the wallet signs before the swap: a reset for USDT on Ethereum, then an exact approval, each only when needed. */
    async #approvals({
        quote,
        from,
        symbol,
        fromNetwork,
        wallet,
        fromUnits,
        diamond,
    }: Prepared): Promise<SwapTxView[]> {
        if (fromNetwork.kind !== "evm" || from.address === NATIVE_EVM || quote.skipApproval) return [];
        const spender = quote.approvalAddress;
        // The approval goes to the contract the checked transaction calls, and nowhere else
        if (!spender || diamond === null || !sameAddress(spender, diamond)) throw unavailable();

        let allowance: bigint;
        try {
            allowance = await this.#deps.clients[fromNetwork.id as EvmNetworkId].readContract({
                address: getAddress(from.address),
                abi: erc20Abi,
                functionName: "allowance",
                args: [getAddress(wallet), getAddress(spender)],
            });
        } catch (error) {
            throw new AppError("unavailable", UNAVAILABLE, { cause: error });
        }
        if (allowance >= fromUnits) return [];

        const approve = (purpose: "reset" | "approve", amount: bigint): SwapTxView => ({
            kind: "evm",
            purpose,
            chainId: fromNetwork.chainId,
            to: getAddress(from.address),
            data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [getAddress(spender), amount],
            }),
            value: "0",
        });
        // USDT refuses a new allowance over a non-zero one
        const reset = fromNetwork.id === "ethereum" && symbol === "USDT" && allowance > 0n;
        return [...(reset ? [approve("reset", 0n)] : []), approve("approve", fromUnits)];
    }

    /** Checks the request against the account's wallets and holdings and works out the units to pay. */
    async #plan(account: AccountDoc, identity: Identity, req: SwapRequest): Promise<Plan> {
        const fromNetwork = networkOf(req.from.network);
        const toNetwork = networkOf(req.to.network);
        const from = this.#entry(req.from);
        const to = this.#entry(req.to);
        if (req.from.token === req.to.token && req.from.network === req.to.network) {
            throw new AppError("bad_request", "Pick two different coins to swap.");
        }

        if (kindOf(req.wallet) !== fromNetwork.kind) {
            throw new AppError("bad_request", `That wallet can't pay on ${fromNetwork.name}.`);
        }
        if (kindOf(req.receiver) !== toNetwork.kind) {
            const article = toNetwork.kind === "solana" ? "a Solana" : "an EVM";
            throw new AppError(
                "bad_request",
                `Connect ${article} wallet to receive ${req.to.token} on ${toNetwork.name}.`,
            );
        }
        const wallet = await this.#deps.identity.authorizeWallet(identity, req.wallet);
        const receiver = await this.#deps.identity.authorizeWallet(identity, req.receiver);

        const price = this.#deps.catalog.priceOf(req.from.token);
        if (price === null) throw unavailable();
        const fromUnits = this.#capped(account, req.from, wallet, from, unitsOf(req.amountUSD, price, from.decimals));
        if (fromUnits <= 0n) throw new AppError("bad_request", "That amount is too small to swap.");
        return { from, symbol: req.from.token, to, fromNetwork, toNetwork, wallet, receiver, fromUnits };
    }

    /** Asks LI.FI for the plan's swap, at `slippage` when given, and checks the transaction it built. */
    async #fetch(plan: Plan, slippage?: number): Promise<Prepared> {
        const { lifi, integrator, fee } = this.#deps;
        const { from, to, fromNetwork, toNetwork, wallet, receiver, fromUnits } = plan;
        const [quote, diamond] = await this.#lifi(async () => {
            const chains = fromNetwork.kind === "evm" ? await lifi.chains() : [];
            const quote = await lifi.quote({
                fromChain: fromNetwork.chainId,
                toChain: toNetwork.chainId,
                fromToken: from.address,
                toToken: to.address,
                fromAddress: wallet,
                toAddress: receiver,
                fromAmount: fromUnits.toString(),
                ...(slippage !== undefined && { slippage }),
                integrator,
                ...(fee > 0 && { fee }),
            });
            return [quote, chains.find((chain) => chain.id === fromNetwork.chainId)?.diamondAddress ?? null] as const;
        });
        checkQuote(quote, {
            fromNetwork: fromNetwork.id,
            from,
            toNetwork: toNetwork.id,
            to,
            fromAddress: wallet,
            toAddress: receiver,
            fromUnits,
            diamond,
        });
        // What the person is exposed to is how far the minimum sits under the amount, not the slippage LI.FI reports
        if (tooFarUnder(quote)) {
            throw new AppError("unavailable", "This swap's price is too unstable right now. Try again shortly.");
        }
        return { ...plan, quote, diamond };
    }

    /** `units`, but never over what the wallet held at its last read; a wallet not read yet is not capped. */
    #capped(account: AccountDoc, side: SwapSide, wallet: string, entry: CoinEntry, units: bigint): bigint {
        const view = this.#deps.holdings.last(account._id);
        if (!view) return units;
        const same = (other: string) => (isAddress(wallet) ? sameAddress(other, wallet) : other === wallet);
        if (!view.read.some((pair) => pair.network === side.network && same(pair.wallet))) return units;
        const row = view.rows.find((r) => r.network === side.network && r.symbol === side.token && same(r.wallet));
        const held = row ? parseUnits(row.amount, entry.decimals) : 0n;
        if (held === 0n) {
            throw new AppError(
                "insufficient_funds",
                `You don't hold any ${side.token} on ${networkOf(side.network).name}.`,
            );
        }
        return units < held ? units : held;
    }

    #entry(side: SwapSide): CoinEntry {
        const entry = COINS.find((coin) => coin.symbol === side.token)?.entries.find(
            (candidate) => candidate.network === side.network,
        );
        if (!entry)
            throw new AppError("bad_request", `${side.token} isn't swapped on ${networkOf(side.network).name}.`);
        return entry;
    }

    /** LI.FI's failures as the person sees them. */
    async #lifi<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (error instanceof LifiError && error.kind === "no_route") {
                throw new AppError("no_route", "There's no route for this swap right now.", { cause: error });
            }
            if (error instanceof LifiError) throw new AppError("unavailable", UNAVAILABLE, { cause: error });
            throw error;
        }
    }
}

const unavailable = () => new AppError("unavailable", UNAVAILABLE);

function kindOf(address: string): "evm" | "solana" | null {
    if (isAddress(address, { strict: false })) return "evm";
    return BASE58_ADDRESS.test(address) ? "solana" : null;
}
