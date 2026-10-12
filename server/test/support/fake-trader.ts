import { quoteBuy, quoteSell } from "../../src/predictions/pricing.ts";
import type { FakePolymarket } from "./fake-polymarket.ts";
import type {
    Book,
    LookupResult,
    MarketMeta,
    PoolTrader,
    PostResult,
    SignedRecord,
} from "../../src/predictions/trader.ts";

type Outcome = "fill" | "reject:price_moved" | "reject:market_closed" | "reject:rejected";
export type Behavior = Outcome | "delay" | "unknown" | "unknown-filled" | "hold";

type Signed =
    | { side: "BUY"; tokenId: string; spendE6: string; maxPrice: number }
    | { side: "SELL"; tokenId: string; sharesE6: string; minPrice: number };

type Fill = { makingE6: bigint; takingE6: bigint; balanceDelta: bigint; tokenId: string; sharesDelta: bigint };
type Transaction = "pending" | "confirmed" | "failed";

const REJECTS = {
    price_moved: "price moved",
    market_closed: "market closed",
    rejected: "rejected",
} as const;

export class FakeTrader implements PoolTrader {
    posts: SignedRecord[] = [];
    /** The conditions redeemed, in order. */
    redeems: string[] = [];
    #bookOf: (tokenId: string) => Book;
    #metaOf: (tokenId: string, book: Book) => MarketMeta;
    #balance: bigint;
    #counter = 0;
    #next = new Map<string, Behavior>();
    #held = new Map<string, (outcome: Outcome) => void>();
    // A release can beat the post to the hold, so it waits here for the next held order on its token
    #released = new Map<string, Outcome>();
    #failSign = new Set<string>();
    #fills = new Map<string, Fill>();
    #lookups = new Map<string, LookupResult>();
    #transactions = new Map<string, Transaction>();
    #failRedeem = false;
    #holdings = new Map<string, bigint>();

    constructor(o: {
        bookOf: (tokenId: string) => Book;
        metaOf?: (tokenId: string, book: Book) => MarketMeta;
        balanceE6?: bigint;
    }) {
        this.#bookOf = o.bookOf;
        this.#metaOf =
            o.metaOf ??
            ((_t, book) => ({
                conditionId: "0xcondition",
                negRisk: book.negRisk,
                tickSize: book.tickSize,
                feeRate: 0,
                feeExponent: 1,
            }));
        this.#balance = o.balanceE6 ?? 0n;
    }

    setBalance(e6: bigint): void {
        this.#balance = e6;
    }

    onNext(tokenId: string, behavior: Behavior): void {
        this.#next.set(tokenId, behavior);
    }

    release(tokenId: string, outcome: Outcome): void {
        const resolve = this.#held.get(tokenId);
        if (!resolve) {
            this.#released.set(tokenId, outcome);
            return;
        }
        this.#held.delete(tokenId);
        resolve(outcome);
    }

    settleDelayed(orderHash: string, outcome: "fill" | "cancel"): void {
        const fill = this.#fills.get(orderHash);
        if (outcome === "fill") {
            if (!fill) throw new Error(`no fill to settle for ${orderHash}`);
            this.#balance += fill.balanceDelta;
            this.#hold(fill);
            this.#lookups.set(orderHash, { kind: "filled", makingE6: fill.makingE6, takingE6: fill.takingE6 });
        } else {
            this.#lookups.set(orderHash, { kind: "cancelled" });
        }
    }

    failNextRedeem(): void {
        this.#failRedeem = true;
    }

    confirm(transactionId: string): void {
        this.#transactions.set(transactionId, "confirmed");
    }

    failTransaction(transactionId: string): void {
        this.#transactions.set(transactionId, "failed");
    }

    /** Replaces what the pool holds, which otherwise follows its own fills. */
    setHoldings(rows: { tokenId: string; sharesE6: bigint }[]): void {
        this.#holdings = new Map(rows.map((row) => [row.tokenId, row.sharesE6]));
    }

    failSign(tokenId: string): void {
        this.#failSign.add(tokenId);
    }

    async book(tokenId: string): Promise<Book> {
        return this.#bookOf(tokenId);
    }

    async meta(tokenId: string): Promise<MarketMeta> {
        return this.#metaOf(tokenId, this.#bookOf(tokenId));
    }

    async signBuy(o: { tokenId: string; spendE6: bigint; maxPrice: number }): Promise<SignedRecord> {
        return this.#sign(o.tokenId, {
            side: "BUY",
            tokenId: o.tokenId,
            spendE6: o.spendE6.toString(),
            maxPrice: o.maxPrice,
        });
    }

    async signSell(o: { tokenId: string; sharesE6: bigint; minPrice: number }): Promise<SignedRecord> {
        return this.#sign(o.tokenId, {
            side: "SELL",
            tokenId: o.tokenId,
            sharesE6: o.sharesE6.toString(),
            minPrice: o.minPrice,
        });
    }

    async post(record: SignedRecord): Promise<PostResult> {
        this.posts.push(record);
        const signed = record.signed as Signed;
        const behavior = this.#next.get(signed.tokenId) ?? "fill";
        this.#next.delete(signed.tokenId);
        if (behavior === "hold") {
            const early = this.#released.get(signed.tokenId);
            this.#released.delete(signed.tokenId);
            const outcome = early ?? (await new Promise<Outcome>((resolve) => this.#held.set(signed.tokenId, resolve)));
            return this.#decide(record, signed, outcome);
        }
        if (behavior === "unknown") return { kind: "unknown" };
        if (behavior === "unknown-filled") {
            // The exchange filled it but the answer never came back
            this.#decide(record, signed, "fill");
            return { kind: "unknown" };
        }
        if (behavior === "delay") {
            this.#lookups.set(record.orderHash, { kind: "open" });
            this.#plan(record, signed);
            return { kind: "delayed", orderId: record.orderHash };
        }
        return this.#decide(record, signed, behavior);
    }

    async lookup(o: { orderHash: string }): Promise<LookupResult> {
        return this.#lookups.get(o.orderHash) ?? { kind: "missing" };
    }

    async balanceE6(): Promise<bigint> {
        return this.#balance;
    }

    async redeem(conditionId: string): Promise<{ transactionId: string }> {
        if (this.#failRedeem) {
            this.#failRedeem = false;
            throw new Error("the relayer is busy");
        }
        this.redeems.push(conditionId);
        const transactionId = `tx-${this.redeems.length}-${conditionId}`;
        this.#transactions.set(transactionId, "pending");
        return { transactionId };
    }

    async transaction(transactionId: string): Promise<Transaction> {
        return this.#transactions.get(transactionId) ?? "pending";
    }

    async holdings(): Promise<{ tokenId: string; sharesE6: bigint }[]> {
        return [...this.#holdings]
            .filter(([, sharesE6]) => sharesE6 > 0n)
            .map(([tokenId, sharesE6]) => ({ tokenId, sharesE6 }));
    }

    #hold(fill: Fill): void {
        this.#holdings.set(fill.tokenId, (this.#holdings.get(fill.tokenId) ?? 0n) + fill.sharesDelta);
    }

    #sign(tokenId: string, signed: Signed): SignedRecord {
        if (this.#failSign.delete(tokenId)) throw new Error("signing failed");
        this.#counter += 1;
        return { orderHash: `0x${this.#counter}`, signed };
    }

    #plan(record: SignedRecord, signed: Signed): Fill | null {
        const book = this.#bookOf(signed.tokenId);
        const meta = this.#metaOf(signed.tokenId, book);
        let fill: Fill | null = null;
        if (signed.side === "BUY") {
            const spend = BigInt(signed.spendE6);
            const q = quoteBuy(book, meta, spend);
            if (q && q.worstPrice <= signed.maxPrice) {
                fill = {
                    makingE6: q.costE6,
                    takingE6: q.sharesE6,
                    balanceDelta: -(q.costE6 + q.feeE6),
                    tokenId: signed.tokenId,
                    sharesDelta: q.sharesE6,
                };
            }
        } else {
            const shares = BigInt(signed.sharesE6);
            const q = quoteSell(book, meta, shares);
            if (q && q.worstPrice >= signed.minPrice) {
                // taking is gross pUSD, as the exchange reports it; the pool's balance rises by the net
                fill = {
                    makingE6: shares,
                    takingE6: q.proceedsE6 + q.feeE6,
                    balanceDelta: q.proceedsE6,
                    tokenId: signed.tokenId,
                    sharesDelta: -shares,
                };
            }
        }
        if (fill) this.#fills.set(record.orderHash, fill);
        else this.#lookups.set(record.orderHash, { kind: "cancelled" });
        return fill;
    }

    #decide(record: SignedRecord, signed: Signed, outcome: Outcome): PostResult {
        if (outcome !== "fill") {
            const reason = outcome.slice("reject:".length) as keyof typeof REJECTS;
            return { kind: "rejected", reason, message: REJECTS[reason] };
        }
        const fill = this.#plan(record, signed);
        if (!fill) return { kind: "rejected", reason: "price_moved", message: REJECTS.price_moved };
        this.#balance += fill.balanceDelta;
        this.#hold(fill);
        this.#lookups.set(record.orderHash, { kind: "filled", makingE6: fill.makingE6, takingE6: fill.takingE6 });
        return { kind: "filled", orderId: record.orderHash, makingE6: fill.makingE6, takingE6: fill.takingE6 };
    }
}

/** A deep book with the best prices of one the fake Polymarket serves. */
export function bookFromFake(raw: ReturnType<FakePolymarket["book"]>): Book {
    if (!raw) throw new Error("unknown token");
    const levels = (side: { price: string }[]) => side.map((l) => ({ price: Number(l.price), size: 1_000_000 }));
    return {
        bids: levels(raw.bids),
        asks: levels(raw.asks),
        tickSize: Number(raw.tick_size),
        minOrderSize: Number(raw.min_order_size),
        negRisk: false,
    };
}

/** The pool's trader over the fake Polymarket's books, holding a deep float. */
export const fakePoolTrader = (polymarket: FakePolymarket, balanceE6 = 1_000_000_000_000n) =>
    new FakeTrader({ bookOf: (tokenId) => bookFromFake(polymarket.book(tokenId)), balanceE6 });
