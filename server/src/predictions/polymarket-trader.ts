import "../polymarket-proxy.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
    AssetType,
    createSecureClient,
    forkEnvironmentConfig,
    OrderSide,
    OrderType,
    PositionStatus,
    RateLimitError,
    RequestRejectedError,
    UserInputError,
    type OrderResponse,
    type SignedOrder,
    type Signer,
} from "@polymarket/client";
import {
    fetchBalanceAllowance,
    fetchMarketInfo,
    fetchTransaction,
    listAccountTrades,
    prepareGaslessTransaction,
    resolveConditionByToken,
    updateBalanceAllowance,
} from "@polymarket/client/actions";
import { builderApiKey } from "@polymarket/client/node";
import { signerFrom } from "@polymarket/client/viem";
import type { Logger } from "pino";
import { createPublicClient, createWalletClient, hashTypedData, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Config } from "../config.ts";
import { createPolygonReader, type PolygonReader } from "./polygon-reader.ts";
import { unwrapAndBurnCalls, wrapCalls, type Call } from "./pool-moves.ts";
import type {
    BatchSubmit,
    Book,
    FoundFill,
    LookupResult,
    MarketMeta,
    PoolTrader,
    PostResult,
    SignedRecord,
} from "./trader.ts";

type TraderConfig = Pick<
    Config,
    | "POLYMARKET_POOL_KEY"
    | "POLYMARKET_BUILDER_API_KEY"
    | "POLYMARKET_BUILDER_API_SECRET"
    | "POLYMARKET_BUILDER_API_PASSPHRASE"
    | "POLYMARKET_BUILDER_CODE"
    | "POLYMARKET_DEPOSIT_WALLET"
    | "POLYGON_RPC_URL"
    | "POLYMARKET_CLOB_URL"
    | "POLYMARKET_GAMMA_URL"
    | "POLYMARKET_RELAYER_URL"
    | "POLYMARKET_DATA_URL"
>;

type Capture = { hash?: string };

/** Wraps a signer so the hash of the inner order, which the CLOB uses as its order ID, is known before posting. */
function hashingSigner(inner: Signer, captures: AsyncLocalStorage<Capture>): Signer {
    return {
        getAddress: () => inner.getAddress(),
        signMessage: (message) => inner.signMessage(message),
        sendTransaction: (request) => inner.sendTransaction(request),
        signTypedData: (payload) => {
            const capture = captures.getStore();
            if (capture && payload.primaryType === "TypedDataSign") {
                capture.hash = hashTypedData({
                    domain: payload.domain,
                    types: { Order: payload.types.Order },
                    primaryType: "Order",
                    message: (payload.message as { contents: Record<string, unknown> }).contents,
                } as Parameters<typeof hashTypedData>[0]);
            }
            return inner.signTypedData(payload);
        },
    };
}

const E6 = 1_000_000n;
/** How far before the asked-for time findFill starts reading, so clock skew or an exclusive bound can't hide the order's own trade. */
const FIND_FILL_MARGIN_MS = 600_000;
/** Pages of the pool's trades findFill reads before it gives up rather than answer "none". */
const FIND_FILL_PAGES = 5;
/** Trades priced per lookup, so one order can't hold the call for long. */
const LOOKUP_TRADES = 5;

/** A decimal string such as "4.5" as an e6 integer, truncating past six places. */
function decimalToE6(value: string): bigint {
    const [whole = "0", fraction = ""] = value.trim().split(".");
    return BigInt(whole || "0") * E6 + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}

/** e6 as a decimal string floored to two places, which is all the SDK signs. */
function e6ToCents(value: bigint): string {
    const cents = value / 10_000n;
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** How long after a batch call began the owner key may still sign it, so a signed batch's 600 s deadline ends inside the caller's 11-minute window. */
const SIGN_WINDOW_MS = 30_000;

const priceText = (price: number) => String(Number(price.toFixed(4)));

const REJECT_TEXTS: [RegExp, Extract<PostResult, { kind: "rejected" }>["reason"]][] = [
    [
        /fully filled or killed|FOK orders are filled or killed|no orders found to match|no matching orders/i,
        "price_moved",
    ],
    [/not yet ready to process new orders/i, "market_closed"],
    [/not enough balance|allowance is not enough/i, "unavailable"],
];

const rejection = (message: string, code?: string, status?: number): PostResult => ({
    kind: "rejected",
    reason: REJECT_TEXTS.find(([pattern]) => pattern.test(message))?.[1] ?? "rejected",
    message,
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
});

const CODE_REASONS = {
    fok_not_filled: "price_moved",
    fak_not_filled: "price_moved",
    unmatched: "price_moved",
    market_not_ready: "market_closed",
    insufficient_balance_or_allowance: "unavailable",
} as const;

/** The pool owner key as an SDK signer; the batch driver and the client sign with the same key. */
export function createPoolSigner(config: TraderConfig, captures: AsyncLocalStorage<Capture>): Signer {
    const account = privateKeyToAccount(config.POLYMARKET_POOL_KEY as Hex);
    return hashingSigner(
        signerFrom(createWalletClient({ account, chain: polygon, transport: http(config.POLYGON_RPC_URL) })),
        captures,
    );
}

/** The SDK client for the pool's deposit wallet; creating it deploys the wallet when it doesn't exist yet. */
export async function createPolymarketClient(
    config: TraderConfig,
    captures = new AsyncLocalStorage<Capture>(),
    options: { ignorePinnedWallet?: boolean } = {},
) {
    return createSecureClient({
        signer: createPoolSigner(config, captures),
        ...(options.ignorePinnedWallet ? {} : { wallet: config.POLYMARKET_DEPOSIT_WALLET }),
        apiKey: builderApiKey({
            key: config.POLYMARKET_BUILDER_API_KEY!,
            secret: config.POLYMARKET_BUILDER_API_SECRET!,
            passphrase: config.POLYMARKET_BUILDER_API_PASSPHRASE!,
        }),
        environment: forkEnvironmentConfig({
            name: "app",
            rpc: config.POLYGON_RPC_URL,
            clob: { rest: config.POLYMARKET_CLOB_URL },
            relayer: { rest: config.POLYMARKET_RELAYER_URL },
            gamma: { rest: config.POLYMARKET_GAMMA_URL },
            data: { rest: config.POLYMARKET_DATA_URL },
        }),
    });
}

/** Trades from the pool's Polymarket deposit wallet through the official SDK. */
export async function createPolymarketTrader(
    config: TraderConfig,
    logger: Logger,
    options: { polygon?: PolygonReader } = {},
): Promise<PoolTrader & { wallet: string }> {
    const captures = new AsyncLocalStorage<Capture>();
    const client = await createPolymarketClient(config, captures);
    const builderCode = config.POLYMARKET_BUILDER_CODE;
    const wallet = client.account.wallet as Address;
    const owner = createPoolSigner(config, captures);
    const polygonReader =
        options.polygon ??
        createPolygonReader(createPublicClient({ chain: polygon, transport: http(config.POLYGON_RPC_URL) }));

    const sign = async (request: Parameters<typeof client.createMarketOrder>[0]): Promise<SignedRecord> => {
        const capture: Capture = {};
        const signed = await captures.run(capture, () => client.createMarketOrder(request));
        if (!capture.hash) throw new Error("the order was signed without an order hash");
        return { orderHash: capture.hash, signed };
    };

    const fromResponse = (response: OrderResponse): PostResult => {
        if (!response.ok) {
            return {
                kind: "rejected",
                reason: CODE_REASONS[response.code as keyof typeof CODE_REASONS] ?? "rejected",
                message: response.message,
                code: response.code,
            };
        }
        if (response.status === "matched") {
            return {
                kind: "filled",
                orderId: response.orderId,
                makingE6: decimalToE6(response.makingAmount),
                takingE6: decimalToE6(response.takingAmount),
            };
        }
        if (response.status === "delayed") return { kind: "delayed", orderId: response.orderId };
        // A live FOK order can't happen; the tracker finds out what became of it
        return { kind: "unknown" };
    };

    // Dollars x 1e6 (shares e6 x price e6) paid across the order's trades, or null when they don't cover the fill
    const tradedDollars = async (tradeIds: string[], matchedE6: bigint): Promise<bigint | null> => {
        let shares = 0n;
        let dollars = 0n;
        for (const id of tradeIds.slice(0, LOOKUP_TRADES)) {
            const page = await listAccountTrades(client, { id }).firstPage();
            for (const trade of page.items) {
                if (trade.id !== id) continue;
                for (const maker of trade.makerOrders) {
                    const matched = decimalToE6(maker.matchedAmount);
                    shares += matched;
                    dollars += matched * decimalToE6(maker.price);
                }
            }
        }
        return shares === matchedE6 ? dollars : null;
    };

    // Drives the SDK's batch workflow with the owner key; a clear refusal sent nothing, any other failure may have
    const submitBatch = async (build: () => Call[], metadata: string): Promise<BatchSubmit> => {
        let calls: Call[];
        try {
            calls = build();
        } catch (error) {
            return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
        }
        const began = Date.now();
        try {
            const workflow = await prepareGaslessTransaction(client, { calls, metadata });
            let step = await workflow.next();
            while (!step.done) {
                const request = step.value;
                if (request.kind === "requestAddress") step = await workflow.next(await owner.getAddress());
                else if (request.kind === "signGaslessTypedData") {
                    // The SDK signs again after a busy relayer; a late signature would outlive the caller's window
                    if (Date.now() - began > SIGN_WINDOW_MS)
                        throw new Error("the relayer stayed busy past the signing window");
                    step = await workflow.next(await owner.signTypedData(request.payload));
                } else throw new Error(`the relayer workflow asked for ${request.kind}`);
            }
            if (!step.value.transactionId) {
                logger.warn("the relayer took a pool batch but returned no transaction id");
                return { kind: "unknown" };
            }
            return { kind: "submitted", transactionId: step.value.transactionId };
        } catch (error) {
            // A 5xx may have reached the relayer, so only a rejection below it is clearly a refusal
            const refused =
                error instanceof RateLimitError ||
                error instanceof UserInputError ||
                (error instanceof RequestRejectedError && error.status < 500);
            if (refused) {
                logger.warn({ err: error }, "the relayer refused a pool batch");
                return { kind: "refused", message: error.message };
            }
            logger.warn({ err: error }, "submitting a pool batch got no clear answer");
            return { kind: "unknown" };
        }
    };

    // The second client, from the same signer without the pinned wallet, is built once per trader
    let derived: Promise<Address> | undefined;

    return {
        wallet,

        async book(tokenId): Promise<Book> {
            const book = await client.fetchOrderBook({ assetId: tokenId });
            const levels = (side: { price: string; size: string }[]) =>
                side.map((level) => ({ price: Number(level.price), size: Number(level.size) })).reverse();
            return {
                bids: levels(book.bids),
                asks: levels(book.asks),
                tickSize: book.tickSize,
                minOrderSize: Number(book.minOrderSize),
                negRisk: book.negRisk,
            };
        },

        async meta(tokenId): Promise<MarketMeta> {
            const conditionId = await resolveConditionByToken(client, { assetId: tokenId });
            const info = await fetchMarketInfo(client, { conditionId });
            return {
                conditionId,
                negRisk: info.negRisk,
                tickSize: info.tickSize,
                feeRate: info.feeInfo.rate,
                feeExponent: info.feeInfo.exponent,
            };
        },

        signBuy({ tokenId, spendE6, maxPrice }) {
            const amount = e6ToCents(spendE6);
            return sign({
                assetId: tokenId,
                side: OrderSide.BUY,
                orderType: OrderType.FOK,
                amount,
                maxSpend: amount,
                maxPrice: priceText(maxPrice),
                ...(builderCode ? { builderCode } : {}),
            });
        },

        signSell({ tokenId, sharesE6, minPrice }) {
            return sign({
                assetId: tokenId,
                side: OrderSide.SELL,
                orderType: OrderType.FOK,
                shares: e6ToCents(sharesE6),
                minPrice: priceText(minPrice),
                ...(builderCode ? { builderCode } : {}),
            });
        },

        async post(record): Promise<PostResult> {
            try {
                return fromResponse(await client.postOrder(record.signed as SignedOrder));
            } catch (error) {
                if (error instanceof RequestRejectedError) {
                    // A 5xx may have reached the matching engine, so the outcome is unknown
                    if (error.status >= 500 && !REJECT_TEXTS.some(([pattern]) => pattern.test(error.message))) {
                        logger.warn(
                            { status: error.status, code: error.code ?? null, polymarketMessage: error.message },
                            "Polymarket answered an order with a server error, so its outcome is unknown",
                        );
                        return { kind: "unknown" };
                    }
                    return rejection(error.message, error.code, error.status);
                }
                logger.warn(
                    { err: error },
                    "Posting a Polymarket order got no clear answer, so its outcome is unknown",
                );
                return { kind: "unknown" };
            }
        },

        async lookup({ orderHash, clobOrderId }): Promise<LookupResult> {
            let order;
            try {
                order = await client.fetchOrder({ orderId: clobOrderId ?? orderHash });
            } catch (error) {
                if (error instanceof RequestRejectedError && (error.status === 404 || error.status === 400)) {
                    // A 400 is how the exchange can answer for an id it doesn't know, but it is also what a systemic
                    // fault would look like, so the words are kept where they can be seen
                    if (error.status === 400)
                        logger.warn(
                            {
                                orderHash,
                                clobOrderId,
                                status: error.status,
                                code: error.code ?? null,
                                polymarketMessage: error.message,
                            },
                            "Polymarket answered an order lookup with 400, so the order is taken as unknown to it",
                        );
                    return { kind: "missing" };
                }
                throw error;
            }
            const status = order.status.toUpperCase();
            const matchedE6 = decimalToE6(order.sizeMatched);
            const originalE6 = decimalToE6(order.originalSize);
            // MATCHED can show before any size has matched
            if (matchedE6 > 0n && (status === "MATCHED" || matchedE6 === originalE6)) {
                // The order's own price is its limit, so the real cost comes from the trades when they add up
                const dollars =
                    (await tradedDollars(order.associateTrades, matchedE6)) ?? matchedE6 * decimalToE6(order.price);
                if (order.side.toUpperCase() === "SELL") {
                    return { kind: "filled", makingE6: matchedE6, takingE6: dollars / E6 };
                }
                // The spend rounds up and the proceeds round down, so the pool never loses to rounding
                return { kind: "filled", makingE6: (dollars + E6 - 1n) / E6, takingE6: matchedE6 };
            }
            if (status.startsWith("CANCELED") || status === "INVALID") return { kind: "cancelled", status };
            return { kind: "open" };
        },

        async findFill({ orderHash, tokenId, side, since }): Promise<FoundFill | null> {
            const pages = listAccountTrades(client, {
                assetId: tokenId,
                after: String(Math.floor((since.getTime() - FIND_FILL_MARGIN_MS) / 1000)),
            })[Symbol.asyncIterator]();
            const wanted = orderHash.toLowerCase();
            let shares = 0n;
            let dollars = 0n;
            let linked = false;
            let unlinked = false;
            for (let read = 0; ; read++) {
                const next = await pages.next();
                if (next.done) break;
                for (const trade of next.value.items) {
                    if (!trade.takerOrderId) unlinked = true;
                    if (trade.takerOrderId.toLowerCase() !== wanted) continue;
                    linked = true;
                    for (const maker of trade.makerOrders) {
                        const matched = decimalToE6(maker.matchedAmount);
                        shares += matched;
                        dollars += matched * decimalToE6(maker.price);
                    }
                }
                // An unread page could hold more of the fill, so no answer comes from a partial read
                if (read + 1 === FIND_FILL_PAGES) {
                    if (!(await pages.next()).done)
                        throw new Error(
                            `The trade history for token ${tokenId} has more than ${FIND_FILL_PAGES} pages, so the fill of order ${orderHash} can't be read`,
                        );
                    break;
                }
            }
            if (!linked) return unlinked ? "unlinked" : null;
            if (side === "sell") return { makingE6: shares, takingE6: dollars / E6 };
            return { makingE6: (dollars + E6 - 1n) / E6, takingE6: shares };
        },

        async balanceE6() {
            const { balance } = await fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
            return BigInt(balance);
        },

        async redeem(conditionId) {
            // wait() would hold the call for minutes; the redeemer polls the transaction instead
            const handle = await client.redeemPositions({ conditionId: conditionId });
            if (!handle.transactionId) throw new Error("the relayer returned no transaction id");
            return { transactionId: handle.transactionId };
        },

        async transaction(transactionId) {
            const found = await fetchTransaction(client, { transactionId: transactionId });
            const state =
                found.state === "STATE_CONFIRMED"
                    ? "confirmed"
                    : found.state === "STATE_FAILED" || found.state === "STATE_INVALID"
                      ? "failed"
                      : "pending";
            return { state, hash: found.transactionHash || null, errorMsg: found.errorMsg || null };
        },

        usdcBalanceE6: () => polygonReader.usdcBalanceE6(wallet),

        async syncBalance() {
            await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
        },

        wrapUsdc: (amountE6) => submitBatch(() => wrapCalls({ amountE6, wallet }), "Wrap native USDC into pUSD"),

        unwrapAndBurn: (o) => submitBatch(() => unwrapAndBurnCalls({ ...o, wallet }), "Unwrap pUSD and burn to Arc"),

        burnEvents: ({ since }) => polygonReader.burnEvents({ wallet, since, now: new Date() }),

        burnLog: (hash) => polygonReader.burnLog({ wallet, hash }),

        async derivedWallet() {
            const second = (derived ??= createPolymarketClient(config, new AsyncLocalStorage<Capture>(), {
                ignorePinnedWallet: true,
            }).then((other) => other.account.wallet as Address));
            let address: Address;
            try {
                address = await second;
            } catch (error) {
                if (derived === second) derived = undefined;
                throw error;
            }
            return { configured: wallet, derived: address, hasCode: await polygonReader.hasCode(address) };
        },

        async holdings() {
            const held = new Map<string, bigint>();
            for (const status of [PositionStatus.Open, PositionStatus.Redeemable]) {
                for await (const page of client.listPositions({ status, pageSize: 500 })) {
                    for (const row of page.items) {
                        held.set(row.tokenId, (held.get(row.tokenId) ?? 0n) + decimalToE6(row.currentSize));
                    }
                }
            }
            return [...held].map(([tokenId, sharesE6]) => ({ tokenId, sharesE6 }));
        },
    };
}
