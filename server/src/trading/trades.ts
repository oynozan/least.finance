import { ObjectId, type ClientSession } from "mongodb";
import { AppError } from "../errors.ts";
import { isDuplicateKey, type AccountDoc, type Collections } from "../db/mongo.ts";
import { formatUsdc, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { SwapCatalog } from "../swaps/catalog.ts";
import { COINS, NETWORKS, type SwapCoin } from "../swaps/coins.ts";
import type { CoinWithdrawalDoc, TradeDoc } from "./docs.ts";
import { listHoldings } from "./holdings.ts";
import type {
    CoinWithdrawalView,
    CoinWithdrawRequest,
    HoldingView,
    TradeOrderRequest,
    TradeResult,
    TradingErrorCode,
} from "./types.ts";
import { UNIT_DECIMALS, floorToDecimals, formatUnits18, parseUnits18, toUnitsDecimal } from "./units.ts";
import { coinWithdrawalView, tradeView } from "./views.ts";

/** An error with the code the trading acks carry. */
export class TradeError extends Error {
    readonly code: TradingErrorCode;

    constructor(code: TradingErrorCode, message: string) {
        super(message);
        this.name = "TradeError";
        this.code = code;
    }
}

export const isTradeError = (error: unknown): error is TradeError => error instanceof TradeError;

/** $0.10 in the 18-decimal scale dollars and units share. */
const MIN_TRADE = 10n ** 17n;
/** The share of the quoted price the server's own may be worse by, in basis points. */
const PRICE_TOLERANCE_BPS = 100n;
/** The least a fill may come to: a $0.10 trade still fills once its coin amount is rounded down and the price moves within tolerance. */
const MIN_FILL = MIN_TRADE - (MIN_TRADE * PRICE_TOLERANCE_BPS) / 10_000n;
const SCALE = 10n ** BigInt(UNIT_DECIMALS);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    catalog: Pick<SwapCatalog, "priceOf">;
    /** Whether held coins may be sent out. */
    coinWithdrawals: boolean;
    now?: () => number;
};

/** A coin we can trade: its catalog entry, home network, decimals and the server's current price. */
type Priced = { coin: SwapCoin; network: string; decimals: number; price: bigint };

/** Buy, Sell and Swap from the account balance against our inventory, and sending held coins out. */
export class TradeService {
    readonly #deps: Deps;
    readonly #now: () => number;

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** Fills a trade in one transaction at the server's own price; a repeat of the request answers the first fill. */
    async order(account: AccountDoc, request: TradeOrderRequest): Promise<TradeResult> {
        const known = await this.#known(account, request.requestId);
        if (known) return this.#result(account, known);

        const plan = this.#plan(request);
        const trade: TradeDoc = {
            _id: new ObjectId(),
            accountId: account._id,
            requestId: request.requestId,
            verb: request.verb,
            symbol: request.symbol,
            toSymbol: request.verb === "swap" ? (request.toSymbol ?? null) : null,
            paidSymbol: plan.paidSymbol,
            paidUnits: toUnitsDecimal(plan.paid),
            gotSymbol: plan.gotSymbol,
            gotUnits: toUnitsDecimal(plan.got),
            usd: toUnitsDecimal(plan.usd),
            priceUSD: formatUnits18(plan.price),
            toPriceUSD: plan.toPrice === null ? null : formatUnits18(plan.toPrice),
            hedged: false,
            createdAt: new Date(this.#now()),
        };

        try {
            await this.#deps.ledger.runInTransaction(async (session) => {
                if (
                    await this.#deps.collections.trades.findOne(
                        { accountId: account._id, requestId: request.requestId },
                        { session },
                    )
                )
                    return;
                await this.#fill(session, trade, plan);
            });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
        }
        const stored = await this.#known(account, request.requestId);
        if (!stored) throw new Error("A trade vanished after it filled");
        return this.#result(account, stored);
    }

    /** Refuses with `unavailable` while sending coins out is off. */
    assertWithdrawalsOpen(): void {
        if (!this.#deps.coinWithdrawals) throw new TradeError("unavailable", "Sending coins out isn't open yet.");
    }

    /** Takes held units off the account and queues their sending; refused while sending is off. */
    async withdraw(
        account: AccountDoc,
        request: CoinWithdrawRequest,
    ): Promise<{ withdrawal: CoinWithdrawalView; holdings: HoldingView[] }> {
        const { collections } = this.#deps;
        const key = { accountId: account._id, requestId: request.requestId };
        const known = await collections.coinWithdrawals.findOne(key);
        if (known) return this.#withdrawn(known);
        this.assertWithdrawalsOpen();

        const coin = COINS.find((candidate) => candidate.symbol === request.symbol);
        if (!coin) throw new TradeError("unknown_coin", "That coin can't be sent.");
        const network = NETWORKS.find((candidate) => candidate.id === coin.home);
        const entry = coin.entries.find((candidate) => candidate.network === coin.home);
        if (!network || !entry) throw new TradeError("unknown_coin", "That coin can't be sent.");
        const valid = network.kind === "evm" ? EVM_ADDRESS.test(request.to) : SOLANA_ADDRESS.test(request.to);
        if (!valid) throw new TradeError("bad_request", "That isn't a wallet address on the coin's network.");
        const parsed = parseUnits18(request.units);
        const units = parsed === null ? 0n : floorToDecimals(parsed, entry.decimals);
        if (units <= 0n) throw new TradeError("bad_request", "Enter an amount to send.");

        const now = new Date(this.#now());
        const doc: CoinWithdrawalDoc = {
            _id: new ObjectId(),
            ...key,
            symbol: coin.symbol,
            units: toUnitsDecimal(units),
            network: coin.home,
            to: network.kind === "evm" ? request.to.toLowerCase() : request.to,
            state: "sending",
            txHash: null,
            nonce: null,
            reason: null,
            createdAt: now,
            updatedAt: now,
        };
        try {
            await this.#deps.ledger.runInTransaction(async (session) => {
                if (await collections.coinWithdrawals.findOne(key, { session })) return;
                await this.#subtract(session, account._id, coin.symbol, units);
                await collections.coinWithdrawals.insertOne(doc, { session });
            });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
        }
        const stored = await collections.coinWithdrawals.findOne(key);
        if (!stored) throw new Error("A coin withdrawal vanished after it was created");
        return this.#withdrawn(stored);
    }

    async #withdrawn(doc: CoinWithdrawalDoc) {
        return {
            withdrawal: coinWithdrawalView(doc),
            holdings: await listHoldings(this.#deps.collections, doc.accountId),
        };
    }

    #known(account: AccountDoc, requestId: string) {
        return this.#deps.collections.trades.findOne({ accountId: account._id, requestId });
    }

    async #result(account: AccountDoc, trade: TradeDoc): Promise<TradeResult> {
        const { collections } = this.#deps;
        const current = await collections.accounts.findOne({ _id: account._id });
        return {
            trade: tradeView(trade),
            balance: formatUsdc(fromDecimal((current ?? account).balance)),
            holdings: await listHoldings(collections, account._id),
        };
    }

    /** The coin as traded now, or the refusal; `quoted` is the price the app showed. */
    #priced(symbol: string): Priced {
        const coin = COINS.find((candidate) => candidate.symbol === symbol);
        if (!coin) throw new TradeError("unknown_coin", "That coin isn't available to trade.");
        const entry = coin.entries.find((candidate) => candidate.network === coin.home);
        const price = this.#deps.catalog.priceOf(symbol);
        if (!entry || price === null || !(price > 0) || !Number.isFinite(price))
            throw new TradeError("unavailable", `${symbol} has no price right now. Try again shortly.`);
        const scaled = parseUnits18(price.toFixed(12));
        if (scaled === null || scaled <= 0n) throw new TradeError("unavailable", `${symbol} has no price right now.`);
        return { coin, network: coin.home, decimals: entry.decimals, price: scaled };
    }

    /** Everything a fill needs, worked out from the request and the server's prices before any write. */
    #plan(request: TradeOrderRequest): Plan {
        const quoted = parseUnits18(request.quotedPriceUSD);
        if (quoted === null || quoted <= 0n) throw new TradeError("bad_request", "The quoted price isn't a number.");
        const from = this.#priced(request.symbol);

        if (request.verb === "buy") {
            const amount = parseUnits18(request.amountUSD ?? "");
            if (amount === null || amount <= 0n) throw new TradeError("bad_request", "Enter an amount to spend.");
            // Dearer than the app showed by more than the tolerance
            if (from.price * 10_000n > quoted * (10_000n + PRICE_TOLERANCE_BPS)) throw movedError();
            const units = floorToDecimals((amount * SCALE) / from.price, from.decimals);
            const cost = ceilDiv(units * from.price, SCALE);
            if (units <= 0n || cost < MIN_FILL) throw belowMinimum();
            return {
                verb: "buy",
                from,
                to: null,
                paidSymbol: "USDC",
                paid: cost,
                gotSymbol: from.coin.symbol,
                got: units,
                usd: cost,
                price: from.price,
                toPrice: null,
            };
        }

        const sold = parseUnits18(request.units ?? "");
        const units = sold === null ? 0n : floorToDecimals(sold, from.decimals);
        if (units <= 0n) throw new TradeError("bad_request", "Enter an amount to sell.");

        if (request.verb === "sell") {
            // Cheaper than the app showed by more than the tolerance
            if (from.price * 10_000n < quoted * (10_000n - PRICE_TOLERANCE_BPS)) throw movedError();
            const usd = (units * from.price) / SCALE;
            if (usd < MIN_FILL) throw belowMinimum();
            return {
                verb: "sell",
                from,
                to: null,
                paidSymbol: from.coin.symbol,
                paid: units,
                gotSymbol: "USDC",
                got: usd,
                usd,
                price: from.price,
                toPrice: null,
            };
        }

        if (!request.toSymbol || request.toSymbol === request.symbol)
            throw new TradeError("bad_request", "Pick a different coin to swap into.");
        const quotedTo = parseUnits18(request.quotedToPriceUSD ?? "");
        if (quotedTo === null || quotedTo <= 0n)
            throw new TradeError("bad_request", "The quoted price isn't a number.");
        const to = this.#priced(request.toSymbol);
        // The rate (from price over to price) is worse than the app's by more than the tolerance
        if (from.price * quotedTo * 10_000n < quoted * to.price * (10_000n - PRICE_TOLERANCE_BPS)) throw movedError();
        const usd = (units * from.price) / SCALE;
        const got = floorToDecimals((usd * SCALE) / to.price, to.decimals);
        if (usd < MIN_FILL || got <= 0n) throw belowMinimum();
        return {
            verb: "swap",
            from,
            to,
            paidSymbol: from.coin.symbol,
            paid: units,
            gotSymbol: to.coin.symbol,
            got,
            usd,
            price: from.price,
            toPrice: to.price,
        };
    }

    /** The money moves of one fill, inside the caller's transaction. */
    async #fill(session: ClientSession, trade: TradeDoc, plan: Plan): Promise<void> {
        const { collections, ledger } = this.#deps;
        await collections.trades.insertOne(trade, { session });
        if (plan.verb === "buy") {
            try {
                await ledger.debitInSession(session, trade.accountId, plan.paid, "trade_buy", trade._id);
            } catch (error) {
                if (error instanceof AppError && error.code === "insufficient_funds")
                    throw new TradeError(
                        "insufficient_balance",
                        "You don't have enough USDC for this. Nothing was spent.",
                    );
                throw error;
            }
            await this.#add(session, trade.accountId, plan.from, plan.got);
        } else if (plan.verb === "sell") {
            await this.#subtract(session, trade.accountId, plan.from.coin.symbol, plan.paid);
            await ledger.creditInSession(session, trade.accountId, plan.got, "trade_sell", trade._id);
        } else {
            await this.#subtract(session, trade.accountId, plan.from.coin.symbol, plan.paid);
            await this.#add(session, trade.accountId, plan.to!, plan.got);
            const account = await collections.accounts.findOne({ _id: trade.accountId }, { session });
            if (!account) throw new Error("The account vanished");
            await collections.ledger.insertOne(
                {
                    _id: new ObjectId(),
                    accountId: trade.accountId,
                    kind: "trade_swap",
                    amount: toDecimal(0n),
                    balanceAfter: account.balance,
                    refId: trade._id,
                    createdAt: trade.createdAt,
                },
                { session },
            );
        }
    }

    async #add(session: ClientSession, accountId: ObjectId, coin: Priced, units: bigint) {
        await this.#deps.collections.holdings.updateOne(
            { accountId, symbol: coin.coin.symbol },
            {
                $inc: { units: toUnitsDecimal(units) },
                $set: { network: coin.network, updatedAt: new Date(this.#now()) },
                $setOnInsert: { _id: new ObjectId() },
            },
            { session, upsert: true },
        );
    }

    /** Takes units off a holding if it has them. */
    async #subtract(session: ClientSession, accountId: ObjectId, symbol: string, units: bigint) {
        const { matchedCount } = await this.#deps.collections.holdings.updateOne(
            { accountId, symbol, units: { $gte: toUnitsDecimal(units) } },
            { $inc: { units: toUnitsDecimal(-units) }, $set: { updatedAt: new Date(this.#now()) } },
            { session },
        );
        if (matchedCount === 0)
            throw new TradeError(
                "insufficient_holdings",
                `You don't hold enough ${symbol} for this. Nothing was sold.`,
            );
    }
}

type Plan = {
    verb: "buy" | "sell" | "swap";
    from: Priced;
    to: Priced | null;
    paidSymbol: string;
    paid: bigint;
    gotSymbol: string;
    got: bigint;
    usd: bigint;
    price: bigint;
    toPrice: bigint | null;
};

const ceilDiv = (numerator: bigint, divisor: bigint) => (numerator + divisor - 1n) / divisor;
const movedError = () => new TradeError("price_moved", "The price moved. Review it and try again.");
const belowMinimum = () => new TradeError("below_minimum", "The smallest trade is $0.10.");
