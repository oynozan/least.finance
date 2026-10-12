import { AsyncLocalStorage } from "node:async_hooks";
import {
    AssetType,
    createSecureClient,
    forkEnvironmentConfig,
    OrderSide,
    OrderType,
    PositionStatus,
    RequestRejectedError,
    type OrderResponse,
    type SignedOrder,
    type Signer,
} from "@polymarket/client";
import {
    fetchBalanceAllowance,
    fetchMarketInfo,
    fetchTransaction,
    listAccountTrades,
    resolveConditionByToken,
} from "@polymarket/client/actions";
import { builderApiKey } from "@polymarket/client/node";
import { signerFrom } from "@polymarket/client/viem";
import type { Logger } from "pino";
import { createWalletClient, hashTypedData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { Config } from "../config.ts";
import type { Book, LookupResult, MarketMeta, PoolTrader, PostResult, SignedRecord } from "./trader.ts";

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

const priceText = (price: number) => String(Number(price.toFixed(4)));

const REJECT_TEXTS: [RegExp, Extract<PostResult, { kind: "rejected" }>["reason"]][] = [
    [
        /fully filled or killed|FOK orders are filled or killed|no orders found to match|no matching orders/i,
        "price_moved",
    ],
    [/not yet ready to process new orders/i, "market_closed"],
    [/not enough balance|allowance is not enough/i, "unavailable"],
];

const rejection = (message: string): PostResult => ({
    kind: "rejected",
    reason: REJECT_TEXTS.find(([pattern]) => pattern.test(message))?.[1] ?? "rejected",
    message,
});

const CODE_REASONS = {
    fok_not_filled: "price_moved",
    fak_not_filled: "price_moved",
    market_not_ready: "market_closed",
    insufficient_balance_or_allowance: "unavailable",
} as const;

/** The SDK client for the pool's deposit wallet; creating it deploys the wallet when it doesn't exist yet. */
export async function createPolymarketClient(config: TraderConfig, captures = new AsyncLocalStorage<Capture>()) {
    const account = privateKeyToAccount(config.POLYMARKET_POOL_KEY as Hex);
    const signer = hashingSigner(
        signerFrom(createWalletClient({ account, chain: polygon, transport: http(config.POLYGON_RPC_URL) })),
        captures,
    );
    return createSecureClient({
        signer,
        wallet: config.POLYMARKET_DEPOSIT_WALLET,
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
): Promise<PoolTrader & { wallet: string }> {
    const captures = new AsyncLocalStorage<Capture>();
    const client = await createPolymarketClient(config, captures);
    const builderCode = config.POLYMARKET_BUILDER_CODE;

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
        for (const id of tradeIds) {
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

    return {
        wallet: client.account.wallet,

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
                        logger.warn({ status: error.status }, "Polymarket answered an order with a server error");
                        return { kind: "unknown" };
                    }
                    return rejection(error.message);
                }
                logger.warn({ err: error }, "posting a Polymarket order got no clear answer");
                return { kind: "unknown" };
            }
        },

        async lookup({ orderHash, clobOrderId }): Promise<LookupResult> {
            let order;
            try {
                order = await client.fetchOrder({ orderId: clobOrderId ?? orderHash });
            } catch (error) {
                if (error instanceof RequestRejectedError && (error.status === 404 || error.status === 400)) {
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
            if (status.startsWith("CANCELED") || status === "INVALID") return { kind: "cancelled" };
            return { kind: "open" };
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
            if (found.state === "STATE_CONFIRMED") return "confirmed";
            if (found.state === "STATE_FAILED" || found.state === "STATE_INVALID") return "failed";
            return "pending";
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
