export type Level = { price: number; size: number };
export type Book = { bids: Level[]; asks: Level[]; tickSize: number; minOrderSize: number; negRisk: boolean };
export type MarketMeta = {
    conditionId: string;
    negRisk: boolean;
    tickSize: number;
    feeRate: number;
    feeExponent: number;
};
export type SignedRecord = { orderHash: string; signed: unknown };

export type PostResult =
    | { kind: "filled"; orderId: string; makingE6: bigint; takingE6: bigint }
    | { kind: "delayed"; orderId: string }
    | { kind: "rejected"; reason: "price_moved" | "market_closed" | "unavailable" | "rejected"; message: string }
    | { kind: "unknown" };

export type LookupResult =
    | { kind: "filled"; makingE6: bigint; takingE6: bigint }
    | { kind: "open" }
    | { kind: "cancelled" }
    | { kind: "missing" };

export interface PoolTrader {
    book(tokenId: string): Promise<Book>;
    meta(tokenId: string): Promise<MarketMeta>;
    signBuy(o: { tokenId: string; spendE6: bigint; maxPrice: number }): Promise<SignedRecord>;
    signSell(o: { tokenId: string; sharesE6: bigint; minPrice: number }): Promise<SignedRecord>;
    post(record: SignedRecord): Promise<PostResult>;
    lookup(o: { orderHash: string; clobOrderId: string | null; tokenId: string }): Promise<LookupResult>;
    balanceE6(): Promise<bigint>;
    /** Submits the relayer transaction that redeems the pool's tokens of a resolved condition, without waiting for it. */
    redeem(conditionId: string): Promise<{ transactionId: string }>;
    transaction(transactionId: string): Promise<TransactionState>;
    /** What the pool holds on Polymarket, per token; the Data API leaves out anything under 0.1 share. */
    holdings(): Promise<Array<{ tokenId: string; sharesE6: bigint }>>;
}

export type TransactionState = "pending" | "confirmed" | "failed";

/** Whether the pool's Polymarket connection is needed: trading is on, or posted orders or redemptions still wait to be settled. */
export const traderNeeded = (config: { PREDICTIONS_TRADING: "on" | "off" }, posted: number): boolean =>
    config.PREDICTIONS_TRADING === "on" || posted > 0;

class TimedOut extends Error {}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimedOut(`${what} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The trader with every call bounded; a post that doesn't answer in time is `unknown`, which leaves the order posted for the tracker. */
export function withTimeouts(trader: PoolTrader, ms: number): PoolTrader {
    return {
        book: (tokenId) => bounded(trader.book(tokenId), ms, "book"),
        meta: (tokenId) => bounded(trader.meta(tokenId), ms, "meta"),
        signBuy: (o) => bounded(trader.signBuy(o), ms, "signBuy"),
        signSell: (o) => bounded(trader.signSell(o), ms, "signSell"),
        post: (record) =>
            bounded(trader.post(record), ms, "post").catch((error: unknown) => {
                if (error instanceof TimedOut) return { kind: "unknown" } as const;
                throw error;
            }),
        lookup: (o) => bounded(trader.lookup(o), ms, "lookup"),
        balanceE6: () => bounded(trader.balanceE6(), ms, "balanceE6"),
        redeem: (conditionId) => bounded(trader.redeem(conditionId), ms, "redeem"),
        transaction: (transactionId) => bounded(trader.transaction(transactionId), ms, "transaction"),
        holdings: () => bounded(trader.holdings(), ms, "holdings"),
    };
}

/** Starts `run` unless a run is still in flight; reports whether it started one. */
export function inFlight(run: () => Promise<void>): () => boolean {
    let busy = false;
    return () => {
        if (busy) return false;
        busy = true;
        void run().finally(() => (busy = false));
        return true;
    };
}
