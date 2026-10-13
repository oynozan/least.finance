# Predictions money safety: design

2026-10-13. These are the fixes for the money-safety issues the project audit found in the predictions server. Real trading stays off until they're built and the owner's live check passes.

## Rulings on the design's open questions

- **A post whose outcome is unknown.** findFill depends on Polymarket's trade records linking to the taker order id, which the live check confirms. Where a trade can't be linked, the order is never refunded blind: it goes to a needs-review state with an error log.
- **The reference buy price** is `markets.outcome.buyPrice`, the server's cached offered price. The same is done for sells with the best bid.
- **Timings:**
  - An unknown post is held for 15 minutes before any refund.
  - A pending redemption times out after 30 minutes.
  - A stuck redemption is retried every 6 hours.
  - These are module constants, to be tuned after the live check.
- **A late buy that loses** doesn't re-queue a redemption. Only positions holding winning tokens do.
- **Escalation** is an error log plus a state an operator can see. There's no alert service (owner's choice, 2026-10-13).


Scope: `server/src/predictions/*`, `server/src/db/mongo.ts`, `server/src/server.ts`. No code is written here. Line numbers are from `main` at fdce757. "pool" is the one pooled Polymarket account; "person" is a Least Finance account.

Verdict at a glance

| # | Issue | Status today |
|---|-------|--------------|
| 1 | Client-trusted price | Open. Confirmed. |
| 2 | Float check and hold not atomic | Open. Confirmed (race window is real, see below). |
| 3 | No SDK timeouts | Mostly fixed already (`withTimeouts`). Three real gaps remain: unknown-post refund is blind, nothing is aborted, and the loops are sequential. The audit text is stale. |
| 4 | Fills after redemption | Open. Plus a second, worse gap found: with trading off the trader may never connect, so redemptions never run. |
| 5 | Stuck redemptions | Open. Confirmed. |

Suggested build order: 1, 2 (small, independent), 5, 4 (share the redemption schema), 3 (largest, needs the owner live check for the trade lookup).

---

## 1. Client-trusted limit price

### Current behavior
- Both socket payloads only validate `quotedPrice` as a number in (0,1): `server/src/validation.ts:85,92`.
- Buy: `place()` stores `quotedPrice: input.quotedPrice ?? offered.outcome.buyPrice` (`predictions.ts:265`). `offered` is the server's own price (`markets.outcome`, at most 5 s old) but it is never compared with the client's number.
- `#send` derives the limit straight from the stored value: buy `limitBuyPrice(order.quotedPrice, tick)` (`predictions.ts:356`), sell `limitSellPrice(order.quotedPrice, tick)` (`:351`). `limitBuyPrice` adds 2 cents and clamps to `1 - tick` (`pricing.ts:84-89`); `limitSellPrice` subtracts 2 cents and clamps to one tick (`:91-96`).
- The only guard is `quoteBuy(book).worstPrice > limit` (`:358`) / `quoteSell(...).worstPrice < limit` (`:353`). With a hostile `quotedPrice` of 0.98 the limit is 0.99, so the guard passes for any book. A buy for $100 into a thin book walks every ask up to 99 cents. The person is charged the real fill cost, so the person is "protected" only in that they pay what they get, but the pool takes a bad trade the UI never offered. A sell with `quotedPrice` 0.01 sells to any bid down to one tick.
- `close()` never reads the book price for the order at all, only its size (`:169`).
- `quote()` and `quoteSell()` do compare with the server, but they are advisory calls whose result is not tied to the order.

### Fix
Rule: the stored reference price is the **less generous** of the client's quote and the server's price, and the order is refused when the market has moved against the person by more than the tolerance. "Less generous" means the one that gives the exchange the smaller allowance: lower for a buy, higher for a sell. The existing 2 cent slippage (`SLIPPAGE_E6 = 20_000n`, `pricing.ts:6`) is the tolerance and stays the only knob.

New pure functions in `pricing.ts` (exported, unit-testable):

```ts
export type PriceCheck = { ok: true; reference: number } | { ok: false };

/** Buy: the market must not have risen more than the slippage past the client's quote. */
export function referenceBuyPrice(quoted: number | undefined, offered: number): PriceCheck;
/** Sell: the best bid must not have fallen more than the slippage under the client's quote. */
export function referenceSellPrice(quoted: number | undefined, bestBid: number | null): PriceCheck;
```
- `referenceBuyPrice`: `quoted` undefined -> `{ok:true, reference: offered}`. If `scaled(offered) - scaled(quoted) > SLIPPAGE_E6` -> `{ok:false}` (market moved against the person). Else `reference = min(quoted, offered)`.
- `referenceSellPrice`: `bestBid` null -> `{ok:false}`. `quoted` undefined -> reference `bestBid`. If `scaled(quoted) - scaled(bestBid) > SLIPPAGE_E6` -> `{ok:false}`. Else `reference = max(quoted, bestBid)`.
- Compare in e6 integers (`scaled`) so 0.5 vs 0.52 is not decided by float noise. The boundary is inclusive: exactly 2 cents is allowed.

Result: the limit is `reference + 2c` (buy) or `reference - 2c` (sell). A client can only tighten it. Even a forged quote cannot make the limit exceed `offered + 2c` (buy) or go below `bestBid - 2c` (sell), where `offered` and `bestBid` are the server's reads.

Where it is applied:
1. `place()` (after `markets.outcome`, before `#checkFloat`/hold, around `:247`): `const check = referenceBuyPrice(input.quotedPrice, offered.outcome.buyPrice); if (!check.ok) throw new AppError("price_moved", PRICE_MOVED);` and store `quotedPrice: check.reference`. No money has moved at that point; the PRICE_MOVED text already ends with no spend (add `NOTHING_SPENT` to the sentence in both places for consistency).
2. `close()` (it already fetches `book` at `:169`, before the order is built): `const bestBid = book.bids[0]?.price ?? null` (book levels are best first, see `polymarket-trader.ts:192-199` and the loop in `quoteSell`). `referenceSellPrice(input.quotedPrice, bestBid)`; refuse with `price_moved` before `#record`, so the position never leaves `open`. Store `quotedPrice: check.reference` at `:186`.
3. `#send` (`:351,356`) is unchanged: it keeps deriving from `order.quotedPrice`, which is now the safe reference. The fresh-book walk check stays as the second guard against movement between place and post.
4. Keep the raw client number for audit: new optional field `PredictionOrderDoc.clientPrice?: number` (no migration; absent on old docs).

`quote()` / `quoteSell()` already hold the server price; no change beyond sharing the constant message.

### What the person sees
- Honest client, market moved up to 2 cents or less: nothing changes; the fill is at the real book price (the quote was never a promise).
- Market moved by more than 2 cents since the review: "The price moved, so your prediction didn't go through. Nothing was spent." (code `price_moved`), the optimistic UI takes the trade back as it does for any failure. This also covers a stale review left open: the app re-quotes every 10 s but the person may confirm in between.
- A hostile client gets the same message, or its trade is simply capped at the server's price plus 2 cents.

### Tests
File `server/test/integration/predictions.test.ts` (harness has `offered.current.outcome.buyPrice = 0.5`, book ask 0.5):
- `a buy quoted far above the server price keeps the server's limit`: place with `quotedPrice: 0.98`; wait for post; `h.trader.posts[0].signed.maxPrice` equals 0.52 (assert `order.limitPrice` 0.52 and `quotedPrice` stored 0.5).
- `a buy quoted lower than the server price by under 2 cents keeps the client's tighter limit`: quote 0.49, offered 0.5 -> limit 0.51.
- `a buy the market moved more than 2 cents past is price_moved before any hold`: set `offered.current.outcome.buyPrice = 0.53`, quote 0.5 -> rejects with code `price_moved`; no order doc, no ledger row beyond the deposit; `s.balance` unchanged.
- `exactly 2 cents of movement is still allowed` (boundary, 0.5 vs 0.52).
- `a requestId retry still returns the original order even if the price now differs` (the known-order early return at `:244` must stay before the price check).
File `server/test/integration/prediction-close.test.ts`:
- `a sell quoted far under the best bid keeps the bid-based floor`: quote 0.01 with bid 0.48 -> signed `minPrice` 0.46.
- `a sell the bid fell more than 2 cents under is price_moved and the position stays open` (position state `open`, no order doc).
- `a sell into an empty bid side is price_moved`.
File `server/test/unit/prediction-pricing.test.ts`: table tests for `referenceBuyPrice` / `referenceSellPrice` (undefined quote, boundary, inverted, tick rounding through `limitBuyPrice`).

### Risks / open questions
- `offered.buyPrice` for the second token is `1 - bid` of the first token (`markets/shape.ts:35-47`): a synthetic price, not the book's best ask. If the books diverge by more than 2 cents on thin markets the server would refuse honest orders. Alternative: in `place()` fetch the real book (`trader.book`) and use `book.asks[0].price` as the server price. That costs one CLOB read before the hold (the spec wants the person not to wait on Polymarket; the read is cached for seconds in practice). Recommendation: start with `offered.buyPrice` and watch the `price_moved` rate in the live check; switch to the book if it is high. Owner decision.
- Tolerance stays 2 cents everywhere. The review screen should not show a tighter promise than that.

---

## 2. Float check and hold not atomic

### Current behavior
- The float is two in-memory numbers: `#balanceE6` (last CLOB read) and `#heldE6` (sum of `placing`/`posted` buy amounts, recomputed from Mongo in `refreshFloat`, `predictions.ts:95-106`).
- `place()` runs `#checkFloat` (`:249`, body `:616-624`), then builds the order, then awaits `#record` (a Mongo transaction, `:279`), and only then does `this.#heldE6 += ...` (`:284`). Everything between the check and the `+=` is an `await`, so N concurrent orders all read the same `#heldE6`, all pass, and together exceed the pool's pUSD. A fill that finds no pUSD is rejected by the exchange (`unavailable`, refunded), so it is not an overspend of people's money, but it fails honest orders after taking the hold, and nothing stops the pool from being driven to zero.
- `refreshFloat` also races with the counter: it overwrites `#heldE6` from a Mongo read that can run before an in-flight `#record` commits, and `#afterSettle` subtracts (`:568`) on top of whatever the refresh wrote.
- After a fill the CLOB balance is stale until the next refresh (`#afterSettle` fires one without awaiting), while the hold is already released: for a moment free float = old balance, so the same pUSD is offered twice.
- The existing test `two concurrent orders can't overdraw` (`predictions.test.ts:121`) covers the person's balance only, not the float.
- The state is per process, so two server processes (rolling deploy) cannot see each other's holds.

### Fix
Move the float into one Mongo document and reserve with a guarded `findOneAndUpdate` **inside the same transaction that inserts the order and debits the person** (`#record`'s `take` callback). If the guard fails the whole transaction aborts: no order, no debit.

Collection `pool_float` (add to `Collections` in `mongo.ts:225-238`, `connectDatabase` `:258-271`; no index beyond `_id`). One document, `_id: "polygon"`:
```ts
type PoolFloatDoc = {
    _id: "polygon";
    balanceE6: Decimal128;      // last CLOB pUSD read
    balanceAt: Date;            // when that read finished
    heldE6: Decimal128;         // sum of reserved buy amounts not yet released
    unreadFillsE6: Decimal128;  // pUSD spent by fills since the last balance read that has seen them
    updatedAt: Date;
};
```
Add `PredictionOrderDoc.reservedE6?: Decimal128` (what this order reserved; absent on old docs, treated as 0).

New methods on `PredictionService` (private unless noted):
```ts
async #reserve(session: ClientSession, amountE6: bigint): Promise<PoolFloatDoc>
async #release(session: ClientSession, reservedE6: bigint, spentE6: bigint): Promise<void>
async refreshFloat(): Promise<void>   // rewritten
```
- `#reserve`: one `findOneAndUpdate` on `{_id:"polygon", balanceAt: {$gte: now - FLOAT_MAX_AGE_MS}, $expr: {$gte: [{$subtract: [{$subtract: ["$balanceE6","$heldE6"]},"$unreadFillsE6"]}, amountE6]}}` with `{$inc: {heldE6: amountE6}, $set: {updatedAt}}`, `{session, returnDocument: "after"}`. Decimal128 arithmetic in `$expr` works with `$subtract`/`$gte` on Decimal128; if the driver or test Mongo version balks, store the three fields as Long/NumberLong integers (e6 fits comfortably in 63 bits) instead of Decimal128. Null result -> `throw new AppError("float_short", "Predictions are limited to $X right now. Nothing was spent.")` with X from a follow-up read (`max(0, floor(free))`); the same text as today's `#checkFloat`.
- `FLOAT_MAX_AGE_MS = 180_000`. A stale balance (CLOB reads failing for 3 minutes) refuses orders instead of trusting an old number. Before reserving, if the cached doc is missing or older than that, `place()` awaits one `refreshFloat()` (bounded by the trader timeout) and, if it still fails, throws `float_short`.
- `place()` flow becomes: price check (issue 1), `#amount`, then build the order with `reservedE6: toDecimal(weiToE6(amount))`, then `#record(order, async (session) => { await debitInSession(...); await this.#reserve(session, weiToE6(amount)); })`. Delete the pre-check `#checkFloat(weiToE6(amount))` call at `:249` (keep an unlocked cheap pre-check only to avoid opening a transaction when obviously short; it is advisory). Delete `this.#heldE6 += ...` at `:284`.
- Order of writes in the transaction: the float document is the hot spot. Take the person's debit first, the reservation last, to keep the lock on the shared document short. Mongo retries transient write conflicts inside `withTransaction`; a conflicting reservation re-runs the guard against the new value, which is exactly the atomicity needed.
- A repeated `requestId` hits the unique index or the `known` check inside `#record` (`:300-305`) before `take` runs, so a retry never reserves twice.

Release, in the same transactions that already end a buy order:
- `settle()` buy transaction (`:408-461`): after `moved` is found, `await this.#release(session, reserved, spentE6)` where `reserved = fromDecimal(moved.reservedE6 ?? 0)` and `spentE6 = costOfFill(...)`. `#release` does `$inc: {heldE6: -reserved, unreadFillsE6: +spentE6}`. Cost: the fill already reduced the real pUSD, but `balanceE6` still shows the old read, so `unreadFillsE6` bridges the gap and free float stays correct (no double offer).
- `fail()` buy path (`:549-557`): `#release(session, reserved, 0n)`; nothing was spent.
- A fail from `from === "placing"` and from `"posted"` both release; guarded by the `findOneAndUpdate({state: from})` that already makes them run once.
- Sells reserve nothing (they add pUSD): `reservedE6` absent -> release is a no-op (`if (reserved === 0n && spent === 0n) return`).

`refreshFloat()` rewritten:
1. Read `doc = pool_float` (may be null) and remember `unread0 = doc.unreadFillsE6`.
2. `balance = await trader.balanceE6()` (30 s bound, issue 3).
3. `updateOne({_id:"polygon"}, {$set: {balanceE6: balance, balanceAt: now, updatedAt}, $inc: {unreadFillsE6: -unread0}}, {upsert: true})`. Fills that landed while the read was in flight stay counted (conservative, can only under-offer).
4. Held is **not** overwritten from orders on every refresh (that is what raced). Instead run a drift check: sum `reservedE6` over buy orders in `placing`/`posted`; if it differs from `heldE6`, `logger.error({heldE6, expected}, "The pool float's holds drifted")` and repair with a single guarded `updateOne` filtered on the held value just read. The check also runs once at startup (after `recover()`), so a crash between the order commit and anything else cannot leak (holds and the order commit atomically, so drift should be impossible; the check is a tripwire).
5. Update an in-memory mirror (`#mirror = {balanceE6, heldE6, unread}`) used only by `maxOrderUSD()` (sync, shown to clients, `:88-93`). `#reserve`/`#release` update the mirror from the returned document.

Migration/bootstrapping: no data migration. On first run the document does not exist; `refreshFloat` upserts it with `heldE6` computed from open orders (`reservedE6 ?? amount` for pre-existing orders, so old orders are counted). Old orders without `reservedE6` release 0 -> their hold would leak, so for those use `reservedE6 ?? amount` in `#release` callers (read `moved.amount` for buy orders when the field is absent). Trading is off in production today, so this is only a safety net.

`recover()` (`:576`) and `tracker.#sweepPlacing` go through `fail`, so they release. Nothing else mutates holds.

### What the person sees
- Same message as today when the float is short: "Predictions are limited to $X right now. Nothing was spent." Now it is also what the loser of a race gets, instead of a later `unavailable` refund after the exchange rejects for lack of pUSD.
- A person whose order was already accepted is never failed because another person's concurrent order took the float.
- If the pool balance is unreadable for more than 3 minutes, orders are refused with the same message.

### Tests
File `server/test/integration/predictions.test.ts` (use `predictionHarness`; set `h.trader.setBalance(50_000_000n)` and `await h.service.refreshFloat()`):
- `concurrent orders can't reserve more than the float`: 5 accounts seeded with 100, `Promise.allSettled` of five $20 `place()` calls, all with `h.trader.onNext(TOKEN,"delay")`. Assert exactly 2 fulfilled and 3 rejected with code `float_short`; `pool_float.heldE6 == 40_000_000`; the 3 losers have no order doc, balance 100, no `prediction_buy` row; the winners have balance 80.
- `a fail releases the reservation so the next order fits`: after the above, fail one winner (reject), then a third $20 succeeds; `heldE6` 40_000_000.
- `a fill releases the hold and counts as unread until the balance is read`: place $20, settle; assert `heldE6 == 0`, `unreadFillsE6 == 20_000_000` (or the real cost), `balanceE6 - held - unread` equals the pool balance minus the cost; then `refreshFloat()` -> `unreadFillsE6 == 0`.
- `a refresh racing a fill never offers the same pUSD twice`: trader whose `balanceE6` resolves after a held promise; fill lands mid-read; assert `unreadFillsE6` keeps the fill and free float is not above the true pool balance.
- `a retried requestId reserves once` (same requestId twice in parallel, as in `:80` test; `heldE6` equals one amount).
- `an order that fails after the guard (insufficient funds) reserves nothing` (person balance short: `debitInSession` throws, transaction aborts, `heldE6` unchanged). This pins the "reserve last/inside the transaction" property.
- `a stale balance refuses orders`: `now` injected via harness, balanceAt older than 3 min and `trader.balanceE6` rejecting -> `float_short`.
- `drift is reported`: manually bump `heldE6`, run refresh, expect the error log (use a pino test stream or spy on the logger passed to the harness).
- Update the existing `an amount over the free float is refused` test (`:106`) only if its message text changes (it should not).
- Mongo-level: `server/test/integration/prediction-ledger.test.ts` add `balance equals sum of rows after concurrent float-limited orders`.

### Risks / open questions
- Hot document: all buys serialize on one document. At the stated 10 orders/min/person rate this is fine; withTransaction's retry makes it correct, not fast. If it ever matters, shard by a per-token pool is not possible (the pool is one wallet), so accept it.
- `$expr` with Decimal128: verify on the project's Mongo version in the first test; fall back to `Long` fields if needed.
- Multi-instance: the design is correct across processes. The `#submitting` set (`:76`) and the trader connection are still per process; that is outside this issue.
- Open: `FLOAT_MAX_AGE_MS` of 3 minutes vs the 60 s refresh (`tracker.ts:13`). One failed refresh is tolerated, three are not.

---

## 3. SDK call timeouts and unknown posts

### Current behavior (partly fixed already)
- Already fixed: `withTimeouts(trader, ms)` bounds all ten methods (`book, meta, signBuy, signSell, post, lookup, balanceE6, redeem, transaction, holdings`) with `Promise.race` and clears the timer (`trader.ts:45-72`). It is applied once, when the trader connects: `server.ts:59` (`TRADER_CALL_MS = 30_000`) and `:318`. A timed-out `post` is mapped to `{kind: "unknown"}` (`trader.ts:62-67`). Tested in `server/test/unit/trader-timeout.test.ts`. The audit entry ("SDK calls have no per-call timeout beyond trader.ts withTimeouts") is therefore stale; the statement in the task is not accurate for the current tree.
- `#send` treats `unknown` correctly in one respect: the order is already `posted` before the post (`:371-386`), so a hung post is left for the tracker (`:388-396`, no branch for `unknown`).

Remaining gaps:
1. **Blind refund of an unknown post.** The tracker refunds a posted order when `lookup` says `missing` and `now - postedAt > 120 s` (`tracker.ts:8,122-123`). `missing` is a 404/400 from `fetchOrder` (`polymarket-trader.ts:261-262`), which also happens while the exchange has not indexed the order yet, and for any 400. A post that hangs past 120 s and then lands (the timeout abandons the promise but not the HTTP request: the SDK has no AbortSignal for `postOrder`, verified in `types-BGxCI8uu.d.ts`) fills at the exchange after the person was refunded. Result: the pool owns shares nobody paid for. Same for a sell: the position reopens and the sell may fill later.
2. **Nothing is aborted** when a call times out; the underlying request continues (harmless for reads, relevant for post and redeem).
3. **Loops are sequential and not stop-aware.** `tracker.tick` awaits each order in a loop (`tracker.ts:84-93`), `redeemer.tick` awaits each row (`redeemer.ts:65-74`). N slow rows take N x 30 s per pass, `refreshFloat` (60 s cadence, `tracker.ts:60`) waits behind it, and `stop()` awaits the running pass (`tracker.ts:46-51`), so shutdown can take minutes. `lookup` also loops `listAccountTrades` once per trade id inside one 30 s bound (`polymarket-trader.ts:170-185`).
4. A `redeem` that times out has an unknown outcome (the relayer may have accepted it). The redeemer treats it as failure and resubmits after 10 min. Safe because redeeming is idempotent on chain, but the timed-out transaction id is lost. Folded into issue 5.

### Fix
A. **Mark unknown posts.** New `PredictionOrderDoc` fields: `postUnknownAt: Date | null`, `watchUntil: Date | null`, `lateFill?: "settled" | "orphaned"`. In `#send`:
```ts
const result = await trader.post(signed).catch(() => ({ kind: "unknown" as const }));
if (result.kind === "unknown") await predictionOrders.updateOne({_id: order._id, state: "posted"}, {$set: {postUnknownAt: now, updatedAt: now}});
```
(the post call itself already never throws except for the wrapper's rethrow; the catch covers it.)

B. **Reconcile before refunding an unknown post.** New trader method on `PoolTrader` (`trader.ts`) and the SDK adapter (`polymarket-trader.ts`), added to `withTimeouts` and `FakeTrader`:
```ts
/** The fill the pool's trades show for this order, even when fetchOrder doesn't know it; null when none. */
findFill(o: { orderHash: string; tokenId: string; side: "buy" | "sell"; since: Date }): Promise<{ makingE6: bigint; takingE6: bigint } | null>;
```
Implementation: `listAccountTrades(client, { assetId: tokenId, after: since })`, keep trades whose taker order id equals `orderHash` (field name to be confirmed in the owner live check, see below), sum like `tradedDollars` (`polymarket-trader.ts:170-185`), return the same making/taking convention as `lookup` (`:274-278`). Page limit 5 pages; an unreadable page throws (never answers "none" on error).

Tracker rule change (`tracker.ts #step`, replacing `:122-123`):
- `missing` and `order.postUnknownAt == null`: unchanged, give up after 120 s (the post answered clearly, e.g. `delayed`, and the exchange says it has no such order... keep as is).
- `missing` and `postUnknownAt != null`:
  1. If `now - postUnknownAt < UNKNOWN_QUARANTINE_MS` (15 min, longer than any proxy or SDK retry): do nothing.
  2. Else call `trader.findFill(...)`. A throw leaves the order posted. A fill -> `settle(order, making, taking)`. `null` -> `fail(order, "unavailable", "posted")` **and** set `watchUntil = now + 24 h` in the same update.
- `open` and `filled` unchanged; `cancelled` unchanged.
So a timed-out post is never refunded without both the order lookup and the trade lookup agreeing, and not before 15 minutes.

C. **Late-fill safety net.** After such a refund the late HTTP request might still land. A small pass in the tracker (`#watchRefunded`, run each tick): `predictionOrders.find({state: "failed", reason: "unavailable", watchUntil: {$gt: now}})`; for each, `lookup` and `findFill`. If filled: `service.settleLate(order, making, taking)`:
```ts
async settleLate(order: PredictionOrderDoc, makingE6: bigint, takingE6: bigint): Promise<void>
```
One transaction:
- Buy: re-debit the person's cost with a guarded decrement (same `{balance: {$gte}}` guard as `debitInSession`, ledger kind `prediction_buy`, `refId` = a fresh ObjectId stored on the order as `lateRefId` because `(kind, refId)` is unique and the original debit already used `order._id`). If the guard fails (the person spent the refund) -> do not book anything: set `lateFill: "orphaned"`, `logger.error({order}, "A refunded prediction filled late and the person can't cover it; the pool holds the shares")`. If it passes: flip `failed -> filled` (filter `{state: "failed", watchUntil: {$gt: now}, lateFill: {$exists: false}}`), upsert the position exactly as `settle()` does, set `lateFill: "settled"`, emit `prediction:updated`.
- Sell: the position reopened at the refund. If it is still `open` with shares >= making, close it and credit proceeds like `#settleSell`; otherwise `orphaned` + error log.
The position and balance rules are the existing ones; share the position-upsert code with `settle()` by extracting `#bookBuyFill(session, moved, takingE6, spent)` so both paths use one body.

D. **Orphaned shares are visible.** The reconciler already logs `The pool's holdings don't match the positions` (`reconciler.ts:95`); add the `lateFill: "orphaned"` orders to its explanation so an operator can sell them.

E. **Bounded loops.**
- `PredictionTracker.tick(signal?: AbortSignal)`: break out of the order loop when `signal?.aborted`; `#run` passes its signal. Same for `PredictionRedeemer.tick`. Process orders with a small concurrency (`CONCURRENCY = 4` via a simple worker pool) so one slow order does not delay the rest; per-order state is independent (guarded `findOneAndUpdate`s).
- Run `#refreshFloat` independently of the tick (its own interval inside `#run`, `Promise.race`d with the tick) so a slow pass cannot starve it.
- `lookup` inside the SDK adapter: bound `tradedDollars` to 5 trades per call and fall back to the order's own price (existing behavior at `:273`) only for the cost, never for deciding fill vs not.
- Shutdown: `stop()` aborts the signal and waits at most `TRADER_CALL_MS` (the current in-flight call), not a whole pass.

F. **Aborting calls.** The SDK exposes no abort for these calls, so none is attempted. Document in the `withTimeouts` comment that a timed-out call may still complete; the design above never relies on it not completing.

G. Keep `TRADER_CALL_MS = 30_000` for reads/redeem; use 15 s for `book`/`meta`/`signBuy` (they gate the person's order and run before the `posted` write). Make the number a map in `withTimeouts(trader, ms | Partial<Record<keyof PoolTrader, number>>)`.

### What the person sees
- A hung exchange: the order shows as accepted (it already does; spec "A delayed or unclear order stays shown as accepted"). It is not refunded for at least 15 minutes if the post timed out, and then only when the trade history shows nothing. Previously it could flip to refunded after 2 minutes and then fill anyway.
- The rare late fill after a refund: the order flips from refunded back to filled, the position appears and the balance is debited again, pushed over the socket. If they cannot cover it they see nothing change; the shares stay with the pool for the operator.

### Tests
- `server/test/unit/trader-timeout.test.ts`: `findFill and redeem and holdings are bounded too`; `per-method timeouts apply` (book 15 s vs lookup 30 s using fake timers).
- `server/test/integration/prediction-tracker.test.ts` (fake trader gains `hangPost(tokenId)` returning `{kind:"unknown"}` and `setFill(orderHash, fill)` for `findFill`):
  - `an unknown post is not refunded inside the quarantine even when lookup says missing` (advance injected `now` to 3 min, 14 min: still `posted`; assert `findFill` not required yet).
  - `an unknown post past the quarantine with no trade is refunded and watched` (state `failed`, `watchUntil` ~24 h, balance refunded).
  - `an unknown post past the quarantine with a trade is settled, not refunded` (extends the existing test at `:207`).
  - `a findFill error leaves the order posted` (throwing fake).
  - `a clear post answer that turns up missing still gives up after 2 minutes` (keeps `:73` behavior for `postUnknownAt == null`).
  - `a refunded order that fills late is booked and the person re-debited` (balance back down by cost, position open, ledger has a second `prediction_buy` row with a different refId, `sum == balance`).
  - `a late fill the person can't cover is orphaned, not booked` (spend the refund first; `lateFill: "orphaned"`, error logged, no position).
  - `a late sell fill closes a still-open position, else orphans`.
  - `late settlement is exactly once` (`settleLate` twice in parallel; one position change).
  - `stop() returns promptly while a lookup is pending` (fake lookup waits on a promise; `tracker.stop()` resolves within `TRADER_CALL_MS`, with a hang of the next order skipped because `signal.aborted`).
  - `a slow order does not block the others` (3 orders, one hanging lookup with fake timers; the other two settle in the same pass).
- `server/test/integration/predictions.test.ts`: `a post that answers unknown records postUnknownAt`.
- `server/test/integration/polymarket-trader.test.ts` (uses `fake-polymarket.ts`): `findFill sums the taker's trades and ignores others`; `findFill throws on a failing page instead of answering null`.

### Risks / open questions (needs the owner)
- **Owner live check must confirm the trade record has a field linking a trade to the taker order id** (and what `after` accepts: a timestamp or a trade id). The existing unverified assumptions list already includes "order hash = order ID" and "fetchOrder status words" (`predictions.md` line 10). If no such field exists, `findFill` cannot be exact; fall back to: after quarantine, compare the pool's pUSD balance and token holdings against the ledger (reconciler data); if either moved by the order's amount, do not refund and alert an operator. This must be a conscious owner choice.
- 15 minutes of held money on an unknown post is long for the person but safe; shorten only after the live check shows how fast `fetchOrder` indexes.
- Late sell fills are the weakest case (the position may have been re-closed); orphaning is the intended safe outcome.

---

## 4. Fills after redemption (and redemptions that never start)

### Current behavior
- The redemption row is created by the resolver only when it finds an `open` position in a resolved market (`resolver.ts:103-109,129-148`): `updateOne({conditionId}, {$setOnInsert: {... state:"pending"}}, {upsert:true})`. If a row exists and is `confirmed`, the upsert does nothing, because `$setOnInsert` only applies on insert and `$set` only touches `updatedAt`.
- So: a buy order that fills after the redemption was confirmed (a delayed/unknown order that the tracker settles late; a position bought while the resolver was mid-pass) creates an `open` position (`predictions.ts:420-441`). The resolver pays the person (`resolver.ts:151-188`) and keeps the pool's side open forever: the pool holds winning tokens that no redemption row will redeem. People are paid; the pool's pUSD is stranded.
- The reconciler skips tokens whose condition has any non-confirmed redemption (`reconciler.ts:68-73`) but a `confirmed` one is trusted, so after confirmation extra pool holdings show up as "The pool's holdings don't match the positions" only when the open ledger doesn't explain them; once the resolver settles the position the ledger is zero and the pool holds shares, which does log the error but nothing acts on it.
- **Second gap, trading off.** The trader is created only at startup: `server.ts:370-373` calls `traderNeeded(config, posted + redeeming)` once, counting `posted` orders and unconfirmed redemptions. With `PREDICTIONS_TRADING=off`, if a position is open when the server starts and its market resolves afterwards, the resolver queues the redemption (`pending`) but `trader` stays null: `redeemer.tick` returns at `redeemer.ts:58-59` and the reconciler at `reconciler.ts:56-57`. The redemption waits for the next restart. The same applies to a posted order created before a trading-off switch if it was not counted. Also `connectTrader` has no in-flight guard (`server.ts:314-330`), so calling it twice would create two traders.

### Fix
A. **Requeue on a later holder.** `PredictionRedemptionDoc` (`mongo.ts:160-170`) gains:
```ts
confirmedAt: Date | null;
round: number;               // 1 for the first redemption, +1 per re-queue
```
(old rows: `confirmedAt ?? updatedAt`, `round ?? 1`.) `#confirmed` in the redeemer sets `confirmedAt`.

In the resolver, `#queueRedemption(conditionId, marketId)` becomes `#queueRedemption(conditionId, marketId, latestBuyAt: Date)`, called from `#resolve` before paying (`:108`). `latestBuyAt = max(position.updatedAt)` of the open positions. After the existing upsert:
```ts
await predictionRedemptions.updateOne(
  { conditionId, state: "confirmed", confirmedAt: { $lt: latestBuyAt } },
  { $set: { state: "pending", transactionId: null, attempts: 0, nextAt: now, lastError: "re-queued: shares bought after the last redemption", updatedAt: now }, $inc: { round: 1 } });
```
This is safe in both directions: `redeemPositions(conditionId)` redeems everything the pool holds for the condition (`polymarket-trader.ts:289-294`), so a second call is idempotent when there is nothing left, and the race with a rolling confirmation is covered by `confirmedAt < latestBuyAt`. Position `updatedAt` is already set on every grow (`predictions.ts:424`).

Only winning shares need redeeming, but requeueing for any open position is acceptable (a loser's redeem pays 0; the cost is one relayer call). To avoid noise, only requeue when some open position has `payouts[index] > 0`.

B. **Orphan sweep (find positions the resolver never sees).** Extend the reconciler (it already reads `holdings()` and the redemption rows, `reconciler.ts:59-66`). After the main comparison, for each pool-held token with `pool - ledger > TOLERANCE_E6`:
  - find its condition from any `positions`/`predictionOrders` doc with that `tokenId` (`conditionId` is stored on both);
  - if the redemption row for that condition is `confirmed` and the market is resolved, requeue it with the same update as above (`confirmedAt: {$lt: now}`), capped by `round <= 5`; beyond the cap, `logger.error` once per pass ("redemption leaves winning tokens behind").
  - tokens whose market is not resolved are left to the existing error log.
The reconciler must also deal with the pending positions in the other direction (ledger > pool): unchanged.
Holdings include `PositionStatus.Redeemable` rows (`polymarket-trader.ts:305`), so leftovers are visible before and after redemption.

C. **Positions left open with trading off.** Make the trader connect on demand:
  - `server.ts`: wrap `connectTrader` with an in-flight flag (`connectingNow`) and a function `ensureTrader = () => { if (!trader && !connectingNow && !closed) connectTrader(); }`.
  - Pass `ensureTrader` into `PredictionRedeemer` and `PredictionReconciler` deps (new optional dep `needTrader: () => void`). In `redeemer.tick`, when `trader` is null and `predictionRedemptions.countDocuments({state: {$ne: "confirmed"}}) > 0`, call `needTrader()` and return. The reconciler calls it when open/closing positions exist and `holdings` are needed (`PREDICTIONS_TRADING=off` should still reconcile; optional, cheap).
  - The resolver's `#queueRedemption` also calls `needTrader()` when it inserts or re-queues a row.
  Keep the `traderNeeded` startup check as is.

D. **Fills that settle after the market resolves.** Nothing special: `settle()` creates the open position, the next resolver pass pays it from the ledger exactly as for any open position (`resolver.ts:111-126`), and A requeues the redemption. A position bought *after* resolution is paid shares x payout, losing positions pay 0. If the buy filled at the market's final price the person simply wins what the market resolved to. No refund path is needed.

### What the person sees
- Nothing new: the late fill appears as a position, then as Won/Lost on the next resolver pass (within `PREDICTIONS_RESOLVE_MS`, 60 s default).
- The pool's float is restored by the re-run redemption instead of staying stranded.

### Tests
File `server/test/integration/prediction-resolver.test.ts` (has queue-redemption tests at `:175`):
- `shares that appear after a confirmed redemption re-queue it`: resolve market, confirm the redemption in the fake, then `settle()` a delayed buy for the same condition, run the resolver: the position is `won`/paid, the redemption row is `pending`, `round == 2`, `confirmedAt` older than the buy.
- `a confirmed redemption with nothing newer stays confirmed` (resolver pass after confirmation with no new position: state `confirmed`, `round == 1`).
- `a losing late position does not re-queue`.
- `requeue happens once per later buy` (two resolver passes, one requeue; parallel `Promise.all` of two ticks).
File `server/test/integration/prediction-redeemer.test.ts`:
- `a re-queued redemption submits a fresh transaction` (second `redeems` entry, new `transactionId`).
- `with no trader, an unconfirmed redemption asks for one` (trader null, `needTrader` spy called once, state unchanged).
File `server/test/integration/prediction-reconciler.test.ts` (new; fake `setHoldings`):
- `holdings left behind a confirmed redemption re-queue it` (holdings > tolerance for a token, ledger zero, resolved market -> row `pending`).
- `the re-queue is capped at 5 rounds, then logs an error`.
- `holdings under the 0.1 share tolerance are ignored`.
Server wiring: extend `server/test/integration/trader-needed.test.ts` (or `server/test/e2e`) with `ensureTrader connects once even when asked twice` (in-flight guard).

### Risks / open questions
- Condition id missing: `place()` writes `conditionId: ""` (`:260`) and fills it at post time from `meta` (`:378`); the resolver falls back to any position's condition (`resolver.ts:107`). The orphan sweep relies on the same fields. Fine, but an order failed before posting has no condition (and no tokens).
- The Data API hides holdings under 0.1 share (`reconciler.ts:7`), so tiny late fills are never found by B; A still covers them via the resolver path.
- Decision for the owner: should A requeue for losing positions? Recommended no.

---

## 5. Stuck redemptions

### Current behavior
- `redeemer.tick` (`redeemer.ts:57-75`) handles `submitted` rows with `#check` and `pending/failed` rows due by `nextAt` with `#submit`.
- `#check` (`:91-105`): `trader.transaction(id)`; `pending` -> `return` silently. There is no age limit, so a transaction the relayer never mines stays `submitted` forever. If `transaction()` throws (including the 30 s timeout), the `.catch` in `tick` (`:66-68`) only logs a warning on every pass; no counter, no escalation, no state change.
- `#fail` (`:107-125`): sets `failed`, `attempts+1`, `nextAt = now + 10 min`, error log only from attempt 6 (`ERROR_FROM_ATTEMPT = 6`). It retries forever at the same cadence with no distinct state. The log level is the only signal; an operator has no state to query.
- A `redeem()` that times out is indistinguishable from a rejected one, and a retried `redeem` can duplicate a transaction that the relayer did accept.

### Fix
Schema (`PredictionRedemptionDoc`, `mongo.ts:157-170`); all new fields optional for old rows:
```ts
type PredictionRedemptionState = "pending" | "submitted" | "confirmed" | "failed" | "stuck";
// new fields
submittedAt: Date | null;       // when the current transactionId was recorded
checkErrors: number;            // consecutive transaction() throws, reset on any answer
previousTransactions: string[]; // abandoned ids, capped at 10, for the operator
stuckAt: Date | null;
confirmedAt: Date | null;       // from issue 4
round: number;                  // from issue 4
```
Constants in `redeemer.ts`: `SUBMITTED_TIMEOUT_MS = 30 * 60_000`; `RETRY_MS = 600_000` (kept for attempts 1-5); `SLOW_RETRY_MS = 3_600_000` (attempts 6-9); `STUCK_RETRY_MS = 21_600_000` (6 h); `STUCK_FROM_ATTEMPT = 10`; `CHECK_ERRORS_LIMIT = 10`.

State machine:
```
pending --submit ok--> submitted --confirmed--> confirmed --(issue 4 requeue)--> pending
pending/failed --redeem throws--> failed (attempts+1, backoff)
submitted --tx failed--> failed
submitted --pending for >30 min, or checkErrors >= 10--> failed ("timed out", old id -> previousTransactions)
failed --attempts >= 10--> stuck
stuck --due every 6 h--> submitted (fresh tx) | stuck again
any retry that confirms --> confirmed (stuckAt cleared, info log "Redemption recovered")
```
Method changes:
- `#submit`: on success set `submittedAt: now`, `checkErrors: 0`. `trader.redeem` timing out (`TimedOut` message) is handled as a failure with `lastError: "redeem timed out"`; do not clear previous ids.
- `#check`:
  - `try { state = await trader.transaction(id) } catch { increment checkErrors via guarded update; if checkErrors >= CHECK_ERRORS_LIMIT -> #expire(row, "transaction lookups keep failing"); return; }` and reset `checkErrors` to 0 on any answer.
  - `pending`: if `now - submittedAt > SUBMITTED_TIMEOUT_MS` -> `#expire(row, "not confirmed after 30 minutes")`.
  - `failed` -> unchanged (`#fail`).
  - `confirmed` -> as now, plus `confirmedAt: now`.
- `#expire(row, reason)`: before sending a fresh transaction, ask `trader.holdings()` whether the pool still holds the condition's tokens (tokens = distinct `tokenId` of `positions` and `predictionOrders` with that `conditionId`). If the pool holds none above the 0.1 share tolerance, treat the old transaction as having landed: mark `confirmed` with `lastError: "confirmed by holdings: <reason>"` and info-log. Otherwise push the id to `previousTransactions`, set `failed` via `#fail` semantics but with `nextAt = now` so the next pass submits a fresh `redeem` (the first expiry resubmits at once; later ones back off). Redeeming is idempotent on chain, so an abandoned transaction that later lands is harmless.
- `#fail`: backoff `attempts < 6 ? RETRY_MS : attempts < STUCK_FROM_ATTEMPT ? SLOW_RETRY_MS : STUCK_RETRY_MS`; at `attempts >= STUCK_FROM_ATTEMPT` set `state: "stuck"` and `stuckAt` (first time only) and log at **error** with the stable message `"Redemption stuck: needs an operator"` including `{condition, round, attempts, lastError, previousTransactions}`. Every later failed retry of a stuck row logs the same error. Keep the existing warn/error levels below that.
- `tick`: the due query includes `stuck` (`state: {$in: ["pending","failed","stuck"]}`, `nextAt <= now`), so a stuck redemption is retried every 6 h forever (a relayer outage that heals recovers by itself). Before the query, one aggregate `countDocuments({state:"stuck"})`; if > 0 log `error({count}, "Redemptions are stuck")` once per tick (rate limited to once per 10 min by remembering the last log time).
- Reconciler: it already ignores tokens of non-confirmed redemptions (`reconciler.ts:64-73`, `$ne: "confirmed"` includes `stuck`). Add the stuck count to its pass log so the 10-minute reconciler error is a second signal.
- `traderNeeded` count (`server.ts:372`): `$ne: "confirmed"` already includes `stuck`.
- Operator reset: a script `server/scripts/reset-redemption.ts <conditionId>` doing `updateOne({conditionId,state:"stuck"}, {$set:{state:"pending", attempts:0, nextAt:now, checkErrors:0, stuckAt:null}})`. Simple, documented in `server/README`'s operations section. (Optional; the state and the logs are the required part.)
- People are unaffected: payouts come from the ledger and never wait for redemption (spec "it never delays a payout"). Only pool float is.

### What the person sees
Nothing. Stuck redemptions affect only the pool's pUSD (the float shrinks until redeemed, so `maxOrderUSD` can fall and new orders may see "Predictions are limited to $X right now").

### Tests
File `server/test/integration/prediction-redeemer.test.ts` (injected `now`, fake trader gains `failTransactionCheck()` making `transaction()` throw, and `transactionStays("pending")` is the default):
- `a submitted redemption pending for 30 minutes gets a fresh transaction`: advance `now` 31 min; row `failed`->resubmitted: second entry in `h.trader.redeems`, new `transactionId`, `previousTransactions` has the old id, `attempts == 1`.
- `an old transaction that lands after the abandon changes nothing` (confirm the old id; the new one is polled; row ends `confirmed` once, `redeems` length 2).
- `holdings showing the tokens gone confirm the redemption instead of resubmitting` (`setHoldings([])` at expiry -> `confirmed`, `lastError` begins "confirmed by holdings", `redeems` length unchanged).
- `ten failed lookups in a row expire the transaction` (throwing `transaction()`, `checkErrors` increments, reset by one good answer).
- `a redeem that keeps failing backs off 10 min, 1 h, then 6 h` (read `nextAt` after each failure at attempts 1, 6, 10).
- `the tenth failure moves the row to stuck and logs at error` (capture logger: message "Redemption stuck: needs an operator", `stuckAt` set).
- `a stuck redemption is retried every 6 hours and recovers to confirmed` (advance `now`, make `redeem` succeed and `confirm`, assert `stuckAt` cleared).
- `two redeemer ticks in parallel submit once` (parallel `tick()`; `redeems.length == 1`; the guarded `updateOne({state: row.state})` at `:86-87` is the lock; assert it still holds with the new fields).
- `a timed-out redeem is a failure, not a lost row` (fake `redeem` hangs under `withTimeouts`; row `failed` with `lastError` "redeem timed out").
File `server/test/integration/prediction-reconciler.test.ts`: `stuck redemptions are reported on each pass`.

### Risks / open questions
- Timeouts are guesses: Polygon relayer confirmation is normally under a minute; 30 min is deliberately generous. Confirm real latencies in the live check before tightening.
- `holdings()` lags (Data API): a redemption that landed minutes ago may still list the tokens, so the "confirmed by holdings" shortcut can miss and resubmit once. That duplicate is harmless (idempotent) but may cost relayer fees; a failed duplicate (nothing to redeem) arrives as `failed` and the next expiry's holdings check then confirms it.
- Owner decision: who looks at "stuck"? Proposal: error log line + the reconciler repeat is the whole alerting; add a health endpoint field only if the app already has an ops dashboard (none found in `server/src`).

---

## Cross-cutting notes
- Migrations: all new document fields are optional, so no backfill is needed. The only new collection is `pool_float` (issue 2).
- Commit order that keeps each commit green: (1) pricing + place/close guard; (2) `pool_float` + reserve/release; (3) redemption schema + stuck handling; (4) requeue + `needTrader`; (5) `postUnknownAt`, `findFill`, `settleLate`, tracker concurrency. Each ships with its tests.
- Needs the owner's live check before issue 3 is final: the trade-to-taker-order-id field, `listAccountTrades` `after` semantics, and `fetchOrder` 404 vs 400 behavior on a not-yet-indexed order.
- Remaining items from the audit that these fixes do not cover: geoblocking, 35-day PnL window, builder fee.
