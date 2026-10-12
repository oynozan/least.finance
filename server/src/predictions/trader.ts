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
}
