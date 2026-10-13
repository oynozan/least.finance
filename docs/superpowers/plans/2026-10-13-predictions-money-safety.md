# Predictions Money Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five money-safety gaps in the pooled Polymarket predictions server before real trading is switched on.

**Architecture:** Every task implements one section of the spec. Each section already gives the file:line evidence, the exact functions, the data changes, the states and the tests. This plan fixes the order, the files each task owns, and how each is verified. The spec's "Rulings" block settles its open questions.

**Tech Stack:** Node 26 + TypeScript, Express/socket.io, MongoDB replica set (transactions), vitest, the Polymarket CLOB client in `server/src/predictions/polymarket-trader.ts`.

**Spec:** `docs/superpowers/specs/2026-10-13-predictions-money-safety-design.md`

## Global Constraints

- **The spec's rulings bind.** Never refund a post whose outcome is unknown unless both `fetchOrder` and `findFill` show nothing after 15 minutes. Where a trade can't be linked, the order goes to needs-review with an error log. The reference buy price is `markets.outcome.buyPrice`. A late buy that loses doesn't re-queue a redemption.
- **Constants live in their modules, not in `server/src/config.ts`.** A parallel deployment plan owns `config.ts`. This plan must not edit it.
- **Every money move stays inside the existing ledger transactions** (`server/src/deposits/ledger.ts` patterns). A person is never debited or credited twice. Every new state transition is guarded (`findOneAndUpdate` with the expected prior state).
- **Tests that pin money behavior run against the real Mongo stack** (`server/test/support/stack.ts`), the same as `predictions.test.ts`. Concurrency tests fire the requests together with `Promise.all`.
- `PREDICTIONS_TRADING` stays off by default. Nothing here calls real Polymarket.
- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -- <paths>`), with only your own hunks.
- **Comments** are one line each and describe the code as it is.
- Never read or print any `.env` file.
- **Server checks:** `cd server && npx vitest run <file>` while iterating; `cd server && npm test && npx tsc --noEmit` before each commit.

## Review Focus

1. **A reservation leaks.** An order that fails, is refunded or expires must release its pool reservation exactly once, including after a restart in the middle of an order.
2. **A late fill on an order that was already refunded.** The person must be re-debited exactly once, or marked orphaned with an error log. It must never be booked twice.
3. **A redemption retry after the first transaction landed late.** It mustn't double-credit or re-pay anyone. Payouts come from the ledger, and redemption only moves pool tokens.
4. **Shutdown during a tracker pass with a hung lookup.** It must finish within one timeout, not N × 30 s.
5. **A forged `quotedPrice` on a close (sell).** It must never lower the sell limit below the best bid minus 2 cents.

---

### Task 1: Server-side price reference (spec §1)

**Files:**
- Modify: `server/src/predictions/pricing.ts`, `server/src/predictions/predictions.ts`
- Test: `server/test/unit/prediction-pricing.test.ts`, `server/test/integration/predictions.test.ts`, `server/test/integration/prediction-close.test.ts`

**Interfaces:**
- Produces `referenceBuyPrice(quoted, offered)` and `referenceSellPrice(quoted, bestBid)`, as spec §1 defines them.
- `place()` and `close()` fail with `price_moved` before any state changes.

- [ ] Write spec §1's tests. They include a forged buy quote of 0.98 against an offered price of 0.50, which must get a limit of no more than 0.52, and a forged sell quote. Watch them fail.
- [ ] Implement spec §1. Run the three test files, then the full server suite and tsc.
- [ ] Commit: "Price prediction orders from the server's own offered price, never a more generous client quote"

### Task 2: Atomic pool float reservation (spec §2)

**Files:**
- Modify: `server/src/predictions/predictions.ts`, `server/src/db/mongo.ts` (the `pool_float` collection and its indexes), the float refresh path, and the settle and fail transactions
- Test: `server/test/integration/predictions.test.ts`, or a new `server/test/integration/prediction-float.test.ts`

**Interfaces:** the `pool_float` single document (balance, held, `unreadFillsE6`), with a guarded reservation inside the `#record` transaction, as spec §2 defines.

- [ ] Write spec §2's tests, including the 5-way concurrent race, which must never let the reservations exceed the balance. Watch them fail.
- [ ] Implement spec §2, including refusing orders when the balance read is older than 3 minutes. Run the tests, the full suite and tsc.
- [ ] Commit: "Reserve the pool's pUSD atomically with each order, and release it exactly once"

### Task 3: Stuck redemptions (spec §5)

**Files:**
- Modify: `server/src/predictions/redeemer.ts`, and the redemption document type in `server/src/db/mongo.ts`
- Test: `server/test/integration/prediction-redeemer.test.ts`

**Interfaces:**
- **New fields and state:** the `stuck` state, plus `submittedAt`, `checkErrors`, `previousTransactions` and `stuckAt`.
- **Behavior:** a 30-minute pending timeout, a fresh transaction after a holdings check, backoff of 10 min, then 1 h, then 6 h, and `stuck` from the 10th attempt with an error log.

- [ ] Write spec §5's tests with a fake clock. Watch them fail. Implement. Run the tests, the full suite and tsc.
- [ ] Commit: "Time out a redemption that never confirms, retry it with a fresh transaction, and mark it stuck for an operator"

### Task 4: Fills after redemption, and starting the trader on demand (spec §4)

**Files:**
- Modify: `server/src/predictions/resolver.ts`, `redeemer.ts`, `reconciler.ts`, and `server/src/server.ts` (only the `ensureTrader` hook and its wiring)
- Test: `server/test/integration/prediction-resolver.test.ts`, `prediction-redeemer.test.ts`

**Interfaces:**
- `confirmedAt` and `round` on the redemption row.
- A confirmed row is re-queued for a winning position bought after `confirmedAt`.
- The reconciler re-queues leftover resolved tokens, up to 5 rounds.
- `ensureTrader()` has an in-flight guard and is used by the resolver, redeemer and reconciler.

- [ ] Write spec §4's tests. They include a redemption queued while trading is off with no trader connected, which must be redeemed without a restart. Watch them fail. Implement. Run the tests, the full suite and tsc.
- [ ] Commit: "Redeem winning tokens bought after a market's redemption, and connect the trader when a redemption needs it"

### Task 5: Unknown posts and abort-aware tracking (spec §3)

**Files:**
- Modify: `server/src/predictions/trader.ts` (`findFill` on `PoolTrader`, kept inside `withTimeouts`), `polymarket-trader.ts`, `tracker.ts`, the fakes in `server/test/support/fake-trader.ts` and `fake-clob.ts`, and `server/scripts/polymarket-live-check.ts`
- Test: `server/test/integration/prediction-tracker.test.ts`, `server/test/unit/trader-timeout.test.ts`

**Interfaces:**
- `postUnknownAt` on the order.
- `PoolTrader.findFill(order)`.
- A 15-minute hold before any refund, after which both lookups must show nothing.
- After such a refund, the order is watched for 24 h, with `settleLate` re-debiting the person, or the order marked `orphaned` with an error log.
- Tracker passes become abort-aware and run with a concurrency of 4.

- [ ] Write spec §3's tests. They include a late fill after the refund (re-debited exactly once), an unlinkable trade (needs review, never a refund), and shutdown during a hung lookup (done within one timeout). Watch them fail.
- [ ] Implement spec §3. The live-check script also reports whether a trade record names the taker order id, so the owner's run settles the `findFill` question.
- [ ] Run the tests, the full suite and tsc.
- [ ] Commit: "Never refund a prediction whose post timed out until two lookups agree it never filled, and book a late fill exactly once"
