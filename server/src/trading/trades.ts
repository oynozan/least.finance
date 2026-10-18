import { ObjectId, type ClientSession } from "mongodb";
import type { Logger } from "pino";
import { AppError, newRef, wentWrong } from "../errors.ts";
import { isDuplicateKey, type AccountDoc, type Collections } from "../db/mongo.ts";
import { formatUsdc, fromDecimal, toDecimal } from "../db/money.ts";
import type { Ledger } from "../deposits/ledger.ts";
import type { SwapCatalog } from "../swaps/catalog.ts";
import { COINS, NETWORKS, type SwapCoin } from "../swaps/coins.ts";
import type { CoinWithdrawalDoc, TradeDoc } from "./docs.ts";
import { KEPT, ago, amountOf, dollars, echoed, type Action } from "./failures.ts";
import { listHoldings } from "./holdings.ts";
import { TRADE_SPREAD_BPS } from "./spread.ts";
import type {
    CoinWithdrawalView,
    CoinWithdrawRequest,
    HoldingView,
    TradeOrderRequest,
    TradeResult,
    TradingErrorCode,
} from "./types.ts";
import {
    UNIT_DECIMALS,
    floorToDecimals,
    formatUnits18,
    fromUnitsDecimal,
    parseUnits18,
    toUnitsDecimal,
} from "./units.ts";
import { coinWithdrawalView, tradeView } from "./views.ts";

/** An error with the code the trading acks carry; `message` is what the person reads. */
export class TradeError extends Error {
    readonly code: TradingErrorCode;
    /** Our explanation with the numbers, for the log. */
    readonly detail: string | undefined;
    /** More for the log line: the prices, amounts and limits the refusal was made on. */
    readonly fields: Record<string, unknown>;
    /** `error` for a bug on our side, `warn` for a refusal. */
    readonly level: "warn" | "error";
    /** Set once the trade service has logged it, so the socket layer doesn't log it again. */
    logged = false;

    constructor(
        code: TradingErrorCode,
        message: string,
        options: {
            detail?: string;
            fields?: Record<string, unknown>;
            level?: "warn" | "error";
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = "TradeError";
        this.code = code;
        this.detail = options.detail;
        this.fields = options.fields ?? {};
        this.level = options.level ?? "warn";
    }
}

export const isTradeError = (error: unknown): error is TradeError => error instanceof TradeError;

/** The cash every trade is paid in and credited in; it is the balance, not a coin to hold. */
const CASH = "USDC";
/** $0.10 in the 18-decimal scale dollars and units share. */
const MIN_TRADE = 10n ** 17n;
/** $1, the least a coin send may be worth. */
const MIN_SEND = 10n ** 18n;
/** The share of the quoted price the server's own may be worse by, in basis points. */
const PRICE_TOLERANCE_BPS = 100n;
/** The least a fill may come to: a $0.10 trade still fills once its coin amount is rounded down and the price moves within tolerance. */
const MIN_FILL = MIN_TRADE - (MIN_TRADE * PRICE_TOLERANCE_BPS) / 10_000n;
const SPREAD_BPS = BigInt(TRADE_SPREAD_BPS);
/** The least a sale may net: the least fill with the spread already taken off it, as a sale is paid at the bid. */
const MIN_SALE = MIN_FILL - (MIN_FILL * SPREAD_BPS) / 10_000n;
const SCALE = 10n ** BigInt(UNIT_DECIMALS);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Deps = {
    collections: Collections;
    ledger: Ledger;
    catalog: Pick<SwapCatalog, "priceStatus">;
    logger: Logger;
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
        try {
            return await this.#order(account, request);
        } catch (error) {
            throw this.#report(
                "trade:order",
                `Refused a ${request.verb}`,
                {
                    account: account._id.toHexString(),
                    requestId: request.requestId,
                    verb: request.verb,
                    symbol: request.symbol,
                    toSymbol: request.toSymbol,
                },
                error,
            );
        }
    }

    /** Logs a refusal once, with the numbers it was made on, and marks it so the socket layer leaves it alone. Anything else is the caller's to log. */
    #report(event: string, label: string, context: Record<string, unknown>, error: unknown): unknown {
        if (!(error instanceof TradeError)) return error;
        error.logged = true;
        this.#deps.logger[error.level](
            {
                event,
                ...context,
                code: error.code,
                detail: error.detail,
                ...error.fields,
                ...(error.cause !== undefined && { err: error.cause }),
            },
            `${label}: ${error.message}`,
        );
        return error;
    }

    /** A duplicate key on the request id is a repeat of the request; any other is a clash that was swallowed, so it is logged. */
    #duplicate(error: unknown, context: Record<string, unknown>) {
        const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
        if (pattern && "requestId" in pattern) return;
        this.#deps.logger.warn(
            { ...context, keyPattern: pattern, err: error },
            "A duplicate key other than the request id stopped a write",
        );
    }

    async #order(account: AccountDoc, request: TradeOrderRequest): Promise<TradeResult> {
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
            spreadUSD: toUnitsDecimal(plan.spread),
            hedged: false,
            createdAt: new Date(this.#now()),
        };

        let duplicate: unknown;
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
            duplicate = error;
            this.#duplicate(error, {
                event: "trade:order",
                account: account._id.toHexString(),
                requestId: request.requestId,
            });
        }
        const stored = await this.#known(account, request.requestId);
        if (!stored)
            throw new Error(
                `Trade ${request.requestId} for account ${account._id.toHexString()} vanished after it filled`,
                {
                    cause: duplicate,
                },
            );
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
        try {
            return await this.#withdraw(account, request);
        } catch (error) {
            throw this.#report(
                "holding:withdraw",
                "Refused a coin send",
                {
                    account: account._id.toHexString(),
                    requestId: request.requestId,
                    symbol: request.symbol,
                    units: request.units,
                    to: request.to,
                },
                error,
            );
        }
    }

    async #withdraw(
        account: AccountDoc,
        request: CoinWithdrawRequest,
    ): Promise<{ withdrawal: CoinWithdrawalView; holdings: HoldingView[] }> {
        const { collections } = this.#deps;
        const key = { accountId: account._id, requestId: request.requestId };
        const known = await collections.coinWithdrawals.findOne(key);
        if (known) return this.#withdrawn(known);
        this.assertWithdrawalsOpen();

        const coin = COINS.find((candidate) => candidate.symbol === request.symbol);
        if (coin?.symbol === CASH)
            throw new TradeError("unknown_coin", "USDC is sent from Withdraw, not from your coins.");
        if (!coin) throw new TradeError("unknown_coin", `${request.symbol} isn't a coin we can send.`);
        const network = NETWORKS.find((candidate) => candidate.id === coin.home);
        const entry = coin.entries.find((candidate) => candidate.network === coin.home);
        if (!network || !entry) throw this.#brokenCoin(coin.symbol, "Coin has no home network entry");
        const valid = network.kind === "evm" ? EVM_ADDRESS.test(request.to) : SOLANA_ADDRESS.test(request.to);
        if (!valid)
            throw new TradeError(
                "bad_request",
                `That isn't a valid ${network.name} address (${
                    network.kind === "evm" ? "0x followed by 40 hex characters" : "32 to 44 letters and numbers"
                }).`,
                { fields: { network: network.id } },
            );
        const parsed = parseUnits18(request.units);
        if (parsed === null)
            throw new TradeError("bad_request", `${echoed(request.units)} isn't an amount of ${coin.symbol} to send.`);
        const units = floorToDecimals(parsed, entry.decimals);
        if (units <= 0n)
            throw new TradeError(
                "bad_request",
                parsed === 0n
                    ? "Enter an amount to send."
                    : `${amountOf(parsed)} ${coin.symbol} rounds to nothing at ${coin.symbol}'s ${entry.decimals} decimals. Send more.`,
                { fields: { decimals: entry.decimals } },
            );
        // Each send costs us network fees, so a dust send isn't worth making
        const worth = (units * this.#priced(coin.symbol).price) / SCALE;
        if (worth < MIN_SEND)
            throw new TradeError(
                "bad_request",
                `This send is worth ${dollars(worth)}; the smallest send is $1 because each one costs us network fees.`,
                { fields: { usd: formatUnits18(worth), units: formatUnits18(units), network: network.id } },
            );

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
        let duplicate: unknown;
        try {
            await this.#deps.ledger.runInTransaction(async (session) => {
                if (await collections.coinWithdrawals.findOne(key, { session })) return;
                await this.#subtract(session, account._id, coin.symbol, units, "send");
                await collections.coinWithdrawals.insertOne(doc, { session });
            });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            duplicate = error;
            this.#duplicate(error, {
                event: "holding:withdraw",
                account: account._id.toHexString(),
                requestId: request.requestId,
            });
        }
        const stored = await collections.coinWithdrawals.findOne(key);
        if (!stored)
            throw new Error(
                `Coin withdrawal ${request.requestId} for account ${account._id.toHexString()} vanished after it was created`,
                { cause: duplicate },
            );
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
        if (coin?.symbol === CASH)
            throw new TradeError(
                "unknown_coin",
                "USDC is your cash balance, so it can't be bought or sold. Pick another coin.",
            );
        if (!coin) throw new TradeError("unknown_coin", `${symbol} isn't a coin we trade.`);
        const entry = coin.entries.find((candidate) => candidate.network === coin.home);
        if (!entry) throw this.#brokenCoin(symbol, "Coin has no home network entry");
        const status = this.#deps.catalog.priceStatus(symbol);
        if (status.reason !== null) throw noPrice(symbol, status);
        const price = status.price;
        const scaled = !(price > 0) || !Number.isFinite(price) ? null : parseUnits18(price.toFixed(12));
        if (scaled === null || scaled <= 0n)
            throw new TradeError(
                "unavailable",
                `LI.FI lists no usable price for ${symbol} right now. Try again shortly.`,
                {
                    fields: { reason: "no_price", priceUSD: price },
                },
            );
        return { coin, network: coin.home, decimals: entry.decimals, price: scaled };
    }

    /** A coin the table lists wrongly is our bug: the person gets a reference and the log carries it. */
    #brokenCoin(symbol: string, what: string) {
        const ref = newRef();
        return new TradeError("unavailable", `${wentWrong(ref)}`, {
            detail: what,
            fields: { symbol, ref },
            level: "error",
        });
    }

    /** Everything a fill needs, worked out from the request and the server's prices before any write. */
    #plan(request: TradeOrderRequest): Plan {
        const quoted = parseUnits18(request.quotedPriceUSD);
        if (quoted === null || quoted <= 0n)
            throw new TradeError(
                "bad_request",
                `The quoted price ${echoed(request.quotedPriceUSD)} isn't a usable price.`,
                {
                    fields: { field: "quotedPriceUSD" },
                },
            );
        const from = this.#priced(request.symbol);

        if (request.verb === "buy") {
            const amount = parseUnits18(request.amountUSD ?? "");
            if (amount === null || amount <= 0n)
                throw new TradeError(
                    "bad_request",
                    request.amountUSD
                        ? `${echoed(request.amountUSD)} isn't an amount to spend.`
                        : "Enter an amount to spend.",
                );
            // Dearer than the app showed by more than the tolerance
            if (from.price * 10_000n > quoted * (10_000n + PRICE_TOLERANCE_BPS))
                throw movedError("buy", request.symbol, quoted, from.price);
            // The person spends their amount at the ask and gets the fewer coins it buys
            const ask = askOf(from.price);
            const units = floorToDecimals((amount * SCALE) / ask, from.decimals);
            const cost = ceilDiv(units * ask, SCALE);
            if (units <= 0n)
                throw new TradeError(
                    "below_minimum",
                    `${dollars(amount)} buys less than the smallest ${request.symbol} amount we can fill (${request.symbol} has ${from.decimals} decimals and sells at ${dollars(ask)}). Try a larger amount.`,
                    {
                        fields: {
                            amountUSD: formatUnits18(amount),
                            askUSD: formatUnits18(ask),
                            decimals: from.decimals,
                        },
                    },
                );
            if (cost < MIN_FILL)
                throw new TradeError(
                    "below_minimum",
                    `${dollars(amount)} buys ${amountOf(units)} ${request.symbol}, worth ${dollars(cost)}, which is under the smallest trade of $0.10. Try a larger amount.`,
                    {
                        fields: {
                            amountUSD: formatUnits18(amount),
                            costUSD: formatUnits18(cost),
                            units: formatUnits18(units),
                        },
                    },
                );
            return {
                verb: "buy",
                from,
                to: null,
                paidSymbol: CASH,
                paid: cost,
                gotSymbol: from.coin.symbol,
                got: units,
                usd: cost,
                price: ask,
                toPrice: null,
                spread: cost - (units * from.price) / SCALE,
                wholeOnly: false,
            };
        }

        const sold = parseUnits18(request.units ?? "");
        const units = sold === null ? 0n : floorToDecimals(sold, from.decimals);
        if (units <= 0n)
            throw new TradeError(
                "bad_request",
                sold === null && request.units
                    ? `${echoed(request.units)} isn't an amount of ${request.symbol}.`
                    : sold
                      ? `${amountOf(sold)} ${request.symbol} rounds to nothing at ${request.symbol}'s ${from.decimals} decimals. Use more.`
                      : `Enter an amount of ${request.symbol} to ${request.verb === "sell" ? "sell" : "swap"}.`,
            );

        if (request.verb === "sell") {
            // Cheaper than the app showed by more than the tolerance
            if (from.price * 10_000n < quoted * (10_000n - PRICE_TOLERANCE_BPS))
                throw movedError("sell", request.symbol, quoted, from.price);
            const bid = bidOf(from.price);
            const usd = (units * bid) / SCALE;
            if (usd <= 0n)
                throw new TradeError(
                    "below_minimum",
                    `${amountOf(units)} ${request.symbol} comes to $0 at ${dollars(bid)} each, under the smallest trade of $0.10. Sell more.`,
                    { fields: { units: formatUnits18(units), bidUSD: formatUnits18(bid) } },
                );
            return {
                verb: "sell",
                from,
                to: null,
                paidSymbol: from.coin.symbol,
                paid: units,
                gotSymbol: CASH,
                got: usd,
                usd,
                price: bid,
                toPrice: null,
                spread: spreadOf(units, from.price, usd),
                wholeOnly: usd < MIN_SALE,
            };
        }

        if (!request.toSymbol) throw new TradeError("bad_request", "Pick a coin to swap into.");
        if (request.toSymbol === request.symbol)
            throw new TradeError("bad_request", `You can't swap ${request.symbol} into itself. Pick a different coin.`);
        const quotedTo = parseUnits18(request.quotedToPriceUSD ?? "");
        if (quotedTo === null || quotedTo <= 0n)
            throw new TradeError(
                "bad_request",
                `The quoted price ${echoed(request.quotedToPriceUSD)} isn't a usable price.`,
                {
                    fields: { field: "quotedToPriceUSD" },
                },
            );
        const to = this.#priced(request.toSymbol);
        // The rate (from price over to price) is worse than the app's by more than the tolerance
        if (from.price * quotedTo * 10_000n < quoted * to.price * (10_000n - PRICE_TOLERANCE_BPS))
            throw movedError("swap", request.symbol, quoted, from.price, {
                symbol: request.toSymbol,
                quoted: quotedTo,
                now: to.price,
            });
        // The one spread of a swap comes off the coin given up, which is valued at its bid; the coin got is bought at its market price
        const bid = bidOf(from.price);
        const usd = (units * bid) / SCALE;
        const got = floorToDecimals((usd * SCALE) / to.price, to.decimals);
        if (got <= 0n)
            throw new TradeError(
                "below_minimum",
                `${amountOf(units)} ${request.symbol} (${dollars(usd)}) comes to less than the smallest ${request.toSymbol} amount we can credit. Swap more.`,
                { fields: { units: formatUnits18(units), usd: formatUnits18(usd), toDecimals: to.decimals } },
            );
        return {
            verb: "swap",
            from,
            to,
            paidSymbol: from.coin.symbol,
            paid: units,
            gotSymbol: to.coin.symbol,
            got,
            usd,
            price: bid,
            toPrice: to.price,
            spread: spreadOf(units, from.price, usd),
            wholeOnly: usd < MIN_SALE,
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
                if (error instanceof AppError && error.code === "insufficient_funds") {
                    const current = await collections.accounts.findOne({ _id: trade.accountId }, { session });
                    const balance = current ? fromDecimal(current.balance) : 0n;
                    throw new TradeError(
                        "insufficient_balance",
                        `You have ${dollars(balance)} and this costs ${dollars(plan.paid)}. ${KEPT.buy}`,
                        {
                            fields: { balanceUSD: formatUnits18(balance), costUSD: formatUnits18(plan.paid) },
                            cause: error,
                        },
                    );
                }
                throw error;
            }
            await this.#add(session, trade.accountId, plan.from, plan.got);
        } else if (plan.verb === "sell") {
            await this.#subtract(session, trade.accountId, plan.from.coin.symbol, plan.paid, "sell", plan.wholeOnly);
            await ledger.creditInSession(session, trade.accountId, plan.got, "trade_sell", trade._id);
        } else {
            await this.#subtract(session, trade.accountId, plan.from.coin.symbol, plan.paid, "swap", plan.wholeOnly);
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

    /** Takes units off a holding if it has them; with `whole`, only if they are all it has. */
    async #subtract(
        session: ClientSession,
        accountId: ObjectId,
        symbol: string,
        units: bigint,
        action: Exclude<Action, "buy">,
        whole = false,
    ) {
        const { matchedCount } = await this.#deps.collections.holdings.updateOne(
            { accountId, symbol, units: whole ? toUnitsDecimal(units) : { $gte: toUnitsDecimal(units) } },
            { $inc: { units: toUnitsDecimal(-units) }, $set: { updatedAt: new Date(this.#now()) } },
            { session },
        );
        if (matchedCount > 0) return;
        // The real holding, so the refusal says what the person has against what this asks of it
        const row = await this.#deps.collections.holdings.findOne({ accountId, symbol }, { session });
        const held = row ? fromUnitsDecimal(row.units) : 0n;
        const fields = { units: formatUnits18(units), held: formatUnits18(held) };
        if (whole && held >= units)
            throw new TradeError(
                "below_minimum",
                `A sale under $0.10 has to be all of your ${symbol} (you hold ${amountOf(held)}). Sell everything or at least $0.10.`,
                { fields },
            );
        const verb = { sell: "sells", swap: "swaps", send: "sends" }[action];
        throw new TradeError(
            "insufficient_holdings",
            `${
                held === 0n ? `You don't hold any ${symbol}` : `You hold ${amountOf(held)} ${symbol}`
            } but this ${verb} ${amountOf(units)}. ${KEPT[action]}`,
            { fields },
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
    /** The price the person got: the ask for a buy, the bid of the coin sold for a sell or swap. */
    price: bigint;
    /** The swap's second coin at its market price. */
    toPrice: bigint | null;
    /** The dollars the spread came to: the trade at the market price less the trade at the fill price. */
    spread: bigint;
    /** The sale is under the smallest sale, so it only goes through when it sells the account's whole holding. */
    wholeOnly: boolean;
};

const ceilDiv = (numerator: bigint, divisor: bigint) => (numerator + divisor - 1n) / divisor;
/** What a buyer pays for a coin at this market price: the price plus the spread, rounded up. */
const askOf = (price: bigint) => ceilDiv(price * (10_000n + SPREAD_BPS), 10_000n);
/** What a seller gets for a coin at this market price: the price less the spread, rounded down. */
const bidOf = (price: bigint) => (price * (10_000n - SPREAD_BPS)) / 10_000n;
/** The dollars a sale of `units` at this market price gave up, given what it fetched. */
const spreadOf = (units: bigint, price: bigint, fetched: bigint) => (units * price) / SCALE - fetched;

/** The price (or, for a swap, the rate) moved past the tolerance between what the app showed and what the server has now. */
function movedError(
    verb: "buy" | "sell" | "swap",
    symbol: string,
    quoted: bigint,
    now: bigint,
    to?: { symbol: string; quoted: bigint; now: bigint },
) {
    const percent = Number(PRICE_TOLERANCE_BPS) / 100;
    if (to) {
        // The rate is how many of the second coin one of the first buys
        const rate = (price: bigint, toPrice: bigint) => amountOf((price * SCALE) / toPrice);
        const was = rate(quoted, to.quoted);
        const is = rate(now, to.now);
        return new TradeError(
            "price_moved",
            `The ${symbol} to ${to.symbol} rate moved from ${was} to ${is} ${to.symbol} per ${symbol}, more than the ${percent}% allowed. Review the new rate and try again. ${KEPT.swap}`,
            {
                detail: `${symbol} quoted ${formatUnits18(quoted)}, now ${formatUnits18(now)}; ${to.symbol} quoted ${formatUnits18(to.quoted)}, now ${formatUnits18(to.now)}`,
                fields: {
                    quotedPriceUSD: formatUnits18(quoted),
                    serverPriceUSD: formatUnits18(now),
                    toQuotedPriceUSD: formatUnits18(to.quoted),
                    toServerPriceUSD: formatUnits18(to.now),
                    rateWas: was,
                    rateIs: is,
                    toleranceBps: Number(PRICE_TOLERANCE_BPS),
                },
            },
        );
    }
    const bps = ((now - quoted) * 10_000n) / quoted;
    return new TradeError(
        "price_moved",
        `${symbol} moved from ${dollars(quoted)} to ${dollars(now)}, more than the ${percent}% allowed. Review the new price and try again. ${KEPT[verb]}`,
        {
            detail: `quoted ${formatUnits18(quoted)}, now ${formatUnits18(now)}, ${bps} bps`,
            fields: {
                quotedPriceUSD: formatUnits18(quoted),
                serverPriceUSD: formatUnits18(now),
                movedBps: Number(bps),
                toleranceBps: Number(PRICE_TOLERANCE_BPS),
            },
        },
    );
}

/** Why a coin can't be priced, in words the person can act on. */
function noPrice(
    symbol: string,
    status: Exclude<ReturnType<Pick<SwapCatalog, "priceStatus">["priceStatus"]>, { reason: null }>,
) {
    const fields = { reason: status.reason, ageMs: status.ageMs };
    if (status.reason === "never_read")
        return new TradeError("unavailable", "Prices are still loading. Try again in a moment.", { fields });
    if (status.reason === "stale")
        return new TradeError(
            "unavailable",
            `Prices for ${symbol} are out of date (last updated ${ago(status.ageMs)} ago, LI.FI isn't answering). Try again shortly.`,
            { fields },
        );
    if (status.reason === "not_listed")
        return new TradeError("unavailable", `${symbol} isn't a coin we trade.`, { fields });
    return new TradeError("unavailable", `LI.FI lists no price for ${symbol} right now. Try again shortly.`, {
        fields,
    });
}
