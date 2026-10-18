import { toHex, type Address, type Hex } from "viem";
import { quoteBuy, quoteSell } from "../../src/predictions/pricing.ts";
import type { FakePolymarket } from "./fake-polymarket.ts";
import type {
    BatchSubmit,
    Book,
    FoundFill,
    LookupResult,
    MarketMeta,
    PoolTrader,
    PostResult,
    RelayerTransaction,
    SignedRecord,
} from "../../src/predictions/trader.ts";

type Outcome = "fill" | "reject:price_moved" | "reject:market_closed" | "reject:rejected";
export type Behavior = Outcome | "delay" | "unknown" | "unknown-filled" | "hold";

type Signed =
    | { side: "BUY"; tokenId: string; spendE6: string; maxPrice: number }
    | { side: "SELL"; tokenId: string; sharesE6: string; minPrice: number };

type Fill = { makingE6: bigint; takingE6: bigint; balanceDelta: bigint; tokenId: string; sharesDelta: bigint };

/** What the next wrap or unwrap-and-burn comes to: taken, refused, or answered `unknown` whether or not the relayer got it. */
export type BatchMode = "submit" | "refuse" | "unknown-executed" | "unknown-lost" | "partial";

/** A batch the relayer took; its effect on the balances lands when it is confirmed (or failed, for a partial one). */
export type FakeBatch = {
    id: string;
    kind: "wrap" | "unwrap-and-burn";
    amountE6: bigint;
    maxFeeE6: bigint | null;
    recipient: Address | null;
    /** The unwrap runs and the burn does not. */
    partial: boolean;
    hash: Hex;
    state: RelayerTransaction["state"];
};

const POOL_WALLET: Address = "0x1111111111111111111111111111111111111111";

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
    #refusals = new Map<string, Extract<PostResult, { kind: "rejected" }>>();
    #fills = new Map<string, Fill>();
    #lookups = new Map<string, LookupResult>();
    #transactions = new Map<string, RelayerTransaction>();
    #failRedeem = false;
    #failCheck = false;
    #hangRedeem = false;
    #holdings = new Map<string, bigint>();
    #found = new Map<string, FoundFill>();
    #failFind = false;
    #hungLookups = new Map<string, Promise<void>>();
    #unhang = new Map<string, () => void>();
    /** The order hashes findFill was asked about, in order. */
    findFills: string[] = [];
    /** The order hashes lookup was asked about, in order. */
    lookups: string[] = [];
    /** The wrap and unwrap-and-burn batches the relayer took, in order. */
    batches: FakeBatch[] = [];
    /** The pool wallet's burns on TokenMessengerV2, in order; burnEvents ignores its `since`. */
    burns: { txHash: Hex; amountE6: bigint }[] = [];
    #usdc = 0n;
    #nextBatch: BatchMode = "submit";
    #lagging = false;
    #shown = 0n;
    #hashes = 0;
    #derived = { configured: POOL_WALLET, derived: POOL_WALLET, hasCode: true };

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

    /** Sets the native USDC the pool's deposit wallet holds. */
    setUsdc(e6: bigint): void {
        this.#usdc = e6;
    }

    /** Sets how the next wrap or unwrap-and-burn comes out; it lasts one call. */
    onNextBatch(mode: BatchMode): void {
        this.#nextBatch = mode;
    }

    /** Confirms a batch and applies it: a wrap moves native USDC into pUSD, an unwrap-and-burn lowers pUSD and records a burn. */
    confirmBatch(id: string): void {
        const batch = this.#pendingBatch(id);
        this.#apply(batch);
        batch.state = "confirmed";
    }

    /** Fails a batch; only a partial one still ran its unwrap. */
    failBatch(id: string): void {
        const batch = this.#pendingBatch(id);
        if (batch.partial) this.#apply(batch);
        batch.state = "failed";
    }

    /** While on, balanceE6 shows the figure of the last syncBalance, as a CLOB that hasn't re-read the wallet does. */
    lagBalance(on: boolean): void {
        this.#lagging = on;
        this.#shown = this.#balance;
    }

    /** Replaces what derivedWallet answers, field by field. */
    setDerived(o: Partial<{ configured: Address; derived: Address; hasCode: boolean }>): void {
        this.#derived = { ...this.#derived, ...o };
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

    /** Sets what the pool's trade records show for an order: a fill, or a trade that can't be linked to it. */
    setFound(orderHash: string, found: FoundFill): void {
        this.#found.set(orderHash, found);
    }

    /** Makes every findFill throw (or work again). */
    failFindFill(on = true): void {
        this.#failFind = on;
    }

    /** Sets what lookup answers for an order. */
    setLookup(orderHash: string, result: LookupResult): void {
        this.#lookups.set(orderHash, result);
    }

    /** Makes lookups of an order wait until it is released. */
    hangLookup(orderHash: string): void {
        this.#hungLookups.set(orderHash, new Promise<void>((resolve) => this.#unhang.set(orderHash, resolve)));
    }

    releaseLookup(orderHash: string): void {
        this.#unhang.get(orderHash)?.();
        this.#hungLookups.delete(orderHash);
    }

    failNextRedeem(): void {
        this.#failRedeem = true;
    }

    /** Makes every transaction lookup throw (or work again). */
    failTransactionCheck(on = true): void {
        this.#failCheck = on;
    }

    /** Makes the next redeem never answer. */
    hangNextRedeem(): void {
        this.#hangRedeem = true;
    }

    confirm(transactionId: string): void {
        this.#transactions.set(transactionId, { state: "confirmed", hash: this.#nextHash(), errorMsg: null });
    }

    failTransaction(transactionId: string): void {
        this.#transactions.set(transactionId, {
            state: "failed",
            hash: null,
            errorMsg: "the relayer failed the transaction",
        });
    }

    /** Replaces what the pool holds, which otherwise follows its own fills. */
    setHoldings(rows: { tokenId: string; sharesE6: bigint }[]): void {
        this.#holdings = new Map(rows.map((row) => [row.tokenId, row.sharesE6]));
    }

    /** The next post on this token is refused with Polymarket's own code and message. */
    refuseNext(tokenId: string, refusal: Omit<Extract<PostResult, { kind: "rejected" }>, "kind">): void {
        this.#refusals.set(tokenId, { kind: "rejected", ...refusal });
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
        const refusal = this.#refusals.get(signed.tokenId);
        if (refusal) {
            this.#refusals.delete(signed.tokenId);
            this.#lookups.set(record.orderHash, { kind: "cancelled" });
            return refusal;
        }
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
        this.lookups.push(o.orderHash);
        await this.#hungLookups.get(o.orderHash);
        return this.#lookups.get(o.orderHash) ?? { kind: "missing" };
    }

    async findFill(o: { orderHash: string }): Promise<FoundFill | null> {
        this.findFills.push(o.orderHash);
        if (this.#failFind) throw new Error("the trade history is unreachable");
        return this.#found.get(o.orderHash) ?? null;
    }

    async balanceE6(): Promise<bigint> {
        return this.#lagging ? this.#shown : this.#balance;
    }

    async usdcBalanceE6(): Promise<bigint> {
        return this.#usdc;
    }

    async syncBalance(): Promise<void> {
        this.#shown = this.#balance;
    }

    async wrapUsdc(amountE6: bigint): Promise<BatchSubmit> {
        return this.#submit({ kind: "wrap", amountE6, maxFeeE6: null, recipient: null });
    }

    async unwrapAndBurn(o: { amountE6: bigint; maxFeeE6: bigint; recipient: Address }): Promise<BatchSubmit> {
        return this.#submit({
            kind: "unwrap-and-burn",
            amountE6: o.amountE6,
            maxFeeE6: o.maxFeeE6,
            recipient: o.recipient,
        });
    }

    burnEvents: PoolTrader["burnEvents"] = async () => this.burns.map((burn) => ({ ...burn }));

    async burnLog(transactionHash: Hex): Promise<{ amountE6: bigint } | null> {
        const burn = this.burns.find((b) => b.txHash.toLowerCase() === transactionHash.toLowerCase());
        return burn ? { amountE6: burn.amountE6 } : null;
    }

    async derivedWallet(): Promise<{ configured: Address; derived: Address; hasCode: boolean }> {
        return { ...this.#derived };
    }

    async redeem(conditionId: string): Promise<{ transactionId: string }> {
        if (this.#failRedeem) {
            this.#failRedeem = false;
            throw new Error("the relayer is busy");
        }
        if (this.#hangRedeem) {
            this.#hangRedeem = false;
            return new Promise(() => undefined);
        }
        this.redeems.push(conditionId);
        const transactionId = `tx-${this.redeems.length}-${conditionId}`;
        this.#transactions.set(transactionId, { state: "pending", hash: null, errorMsg: null });
        return { transactionId };
    }

    async transaction(transactionId: string): Promise<RelayerTransaction> {
        if (this.#failCheck) throw new Error("the relayer is unreachable");
        const batch = this.batches.find((b) => b.id === transactionId);
        if (batch) {
            if (batch.state === "confirmed") return { state: "confirmed", hash: batch.hash, errorMsg: null };
            if (batch.state === "failed") {
                return { state: "failed", hash: null, errorMsg: "the relayer failed the batch" };
            }
            return { state: "pending", hash: null, errorMsg: null };
        }
        return this.#transactions.get(transactionId) ?? { state: "pending", hash: null, errorMsg: null };
    }

    async holdings(): Promise<{ tokenId: string; sharesE6: bigint }[]> {
        return [...this.#holdings]
            .filter(([, sharesE6]) => sharesE6 > 0n)
            .map(([tokenId, sharesE6]) => ({ tokenId, sharesE6 }));
    }

    #nextHash(): Hex {
        this.#hashes += 1;
        return toHex(this.#hashes, { size: 32 });
    }

    #submit(batch: Pick<FakeBatch, "kind" | "amountE6" | "maxFeeE6" | "recipient">): BatchSubmit {
        const mode = this.#nextBatch;
        this.#nextBatch = "submit";
        if (mode === "refuse") return { kind: "refused", message: "the relayer refused the batch" };
        if (mode === "unknown-lost") return { kind: "unknown" };
        const id = `batch-${this.batches.length + 1}`;
        this.batches.push({
            ...batch,
            id,
            partial: mode === "partial" && batch.kind === "unwrap-and-burn",
            hash: this.#nextHash(),
            state: "pending",
        });
        return mode === "unknown-executed" ? { kind: "unknown" } : { kind: "submitted", transactionId: id };
    }

    #pendingBatch(id: string): FakeBatch {
        const batch = this.batches.find((b) => b.id === id);
        if (!batch) throw new Error(`no batch ${id}`);
        if (batch.state !== "pending") throw new Error(`batch ${id} is already ${batch.state}`);
        return batch;
    }

    #apply(batch: FakeBatch): void {
        if (batch.kind === "wrap") {
            if (this.#usdc < batch.amountE6) throw new Error("the wallet holds too little native USDC to wrap");
            this.#usdc -= batch.amountE6;
            this.#balance += batch.amountE6;
            return;
        }
        if (this.#balance < batch.amountE6) throw new Error("the pool holds too little pUSD to unwrap");
        this.#balance -= batch.amountE6;
        // The unwrap pays native USDC into the wallet and the burn takes it out again
        if (batch.partial) this.#usdc += batch.amountE6;
        else this.burns.push({ txHash: batch.hash, amountE6: batch.amountE6 });
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
