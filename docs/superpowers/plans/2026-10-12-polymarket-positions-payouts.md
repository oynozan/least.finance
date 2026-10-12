# Polymarket Positions, Closing and Payouts Implementation Plan (phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can sell a prediction early from the sidebar, and winners are paid into their balance when the market resolves. Both happen exactly once, optimistically in the app. The pool redeems winning shares and reconciles its holdings in the background.

**Architecture:** This builds on phase 2's `PredictionService`, `PredictionTracker`, `PoolTrader` and the client's optimistic list.
- **Closing** is a fill-or-kill sell order through the same state machine. While it's in flight, its position is `closing`.
- **Payouts.** A `PredictionResolver` reads Gamma's market by ID for markets with open positions, and pays from Gamma's final prices.
- **Redemption.** A `PredictionRedeemer` redeems resolved conditions through the relayer and retries failures.
- **Reconciliation.** A `PredictionReconciler` compares ledger shares with the pool's Data API holdings.
- **Client.** It shows live values, Close, and Won/Lost rows, and turns real predictions into PnL activity.

**Tech Stack:** As in phase 2: Node 24, MongoDB transactions, `@polymarket/client` 0.13.0, Next.js 16, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-polymarket-predictions-design.md`, section 3, the Errors table and Testing. Phase 2's plan is `docs/superpowers/plans/2026-10-12-polymarket-orders.md`. Its Global Constraints all apply here and are not repeated. Research notes are in `.superpowers/sdd/polymarket-phase-2-3-research/` (`polymarket-api.md` §4–6 for resolution, redemption and the Data API).

## Global Constraints

- **Inherited.** Everything in phase 2's Global Constraints, including the peer invariants and money rules.
- **Resolution.**
    - A market is resolved when Gamma `GET /markets/{id}` shows `closed: true` and `umaResolutionStatus: "resolved"`.
    - The payout per share is that token's entry in `outcomePrices`, a JSON string of decimals: 1, 0, or 0.5 for a 50/50.
    - Pay from Gamma, never from the CLOB's `winner` flag, which lags.
    - Batch `/markets?id=` hides closed markets, so read by ID.
- **Payout math.**
    - `payoutE6 = floor(sharesE6 × priceE6 / 1_000_000)`, where `priceE6` is the decimal price parsed exactly into e6.
    - A win credits `e6ToWei(payoutE6)` as `prediction_payout` with `refId = position._id`.
    - A loss writes no ledger row.
- **Closing.**
    - The sell amount is the position's shares floored to 0.01 share (`sharesE6 − sharesE6 % 10_000n`), because the SDK quantizes to 2 decimals.
    - The remainder (under 0.01 share) stays with the pool once the position is `closed`.
    - A sell under the book's `minOrderSize` is refused with exactly "Too small to sell. It pays out when the market resolves.".
    - `minPrice = limitSellPrice(quotedPrice, tick)`.
    - Proceeds are net of the fee (phase 2's `quoteSell` and `feeE6`).
- **Timing.**

  | Process | Interval |
  | --- | --- |
  | Resolver | every `PREDICTIONS_RESOLVE_MS`, default 60 000, at most 100 markets per pass |
  | Redemption retry | every 10 minutes after a failure; logged at warn, and at error from the 6th attempt |
  | Reconciliation | every 10 minutes |
  | Settled positions shown | 7 days |

    - Reconciliation tolerates differences of 0.1 share (100 000 e6), the Data API's dust floor.
    - It skips tokens with an unsettled order and markets whose redemption isn't confirmed.
- **Copy, verbatim:**
    - A failed close: "Couldn't sell right now. Your position is back."
    - A busy position: "This position is already being sold."
    - Too small: as above.
    - Settled rows: `Won ${formatUsd(payout)}` and "Lost".
- **Error codes.** New: `position_busy` (409). `protocol.ts` and `errors.ts` both list it, and `errors.test.ts` covers it.

## Review Focus

1. **A market resolves while a sale is in flight.** The person gets either the sale proceeds or the payout, never both. A `closing` position is skipped by the resolver. A sell that then fails returns the position to `open`, and the next pass pays it. Test in Task 2.
2. **Two Close clicks, or two tabs, on one position.** There is one sell. A different `requestId` gets `position_busy`; the same one gets the same order back. Test in Task 1.
3. **The resolver runs twice, or the server dies mid-pass.** Each position is paid at most once, through the conditional move `open → won` inside the payout transaction. Test in Task 2.
4. **A 50/50 resolution pays half. A loss writes no ledger row but still shows "Lost".** Test in Task 2 (server) and Task 4 (sidebar).
5. **A position whose shares aren't a multiple of 0.01.** Close sells the floor, the position is closed, and the remainder doesn't trip reconciliation. Test in Task 1 and Task 3.

---

### Task 1: Closing a position on the server

**Files:**
- Modify:
    - `server/src/predictions/predictions.ts`
    - `server/src/predictions/tracker.ts`
    - `server/src/predictions/views.ts`
    - `server/src/protocol.ts`
    - `server/src/errors.ts`
    - `server/src/validation.ts`
    - `server/src/socket/sockets.ts`
    - `server/test/support/fake-trader.ts`, if sells need controls beyond `onNext`
    - `server/test/e2e/serve.ts` and `e2e/backend.ts`, only if a new control is needed
- Test: `server/test/integration/prediction-close.test.ts`

**Interfaces:**
- **Sell quote.** `prediction:quote` also accepts `{ positionId }` and answers `SellQuoteView = { positionId: string; side: "sell"; shares: string; proceedsUSD: UsdcAmount; avgPrice: number; worstPrice: number; feeUSD: UsdcAmount; minShares: number }`. It uses `quoteSell` over the sellable shares.
- **`prediction:close {requestId, positionId, quotedPrice}`** → `PredictionOrderView`, using the `prediction` limiter. `PredictionService.close(account, input)` does these steps in order:
    1. Trading is off → `trading_off`.
    2. The position isn't the person's → `not_found`.
    3. The position is `closing` under another request → `position_busy`. The same `requestId` returns the existing order.
    4. The position isn't `open` → `not_found`.
    5. The sellable shares are under `minOrderSize` → `below_minimum` with the "Too small to sell" copy.
    6. One transaction inserts the sell order in `placing` (`side: "sell"`, `shares`, `positionId`, `amount: 0`) and moves the position `open → closing` conditionally.
    7. Ack, then submit (`signSell`, then `posted`, then `post`).
- **A filled sell**, in one transaction:
    1. The order moves `posted → filled`.
    2. The proceeds are `e6ToWei(takingE6 − feeE6(makingE6, takingE6/makingE6))`, credited as `prediction_sell`.
    3. The position moves `closing → closed` with `proceeds` and `settledAt`.
    4. After commit, emit `prediction:updated`.
- **A failed sell**, in one transaction: the order goes to `failed`, and the position goes `closing → open`. No money moves.
- **Recovery and the tracker** handle sells exactly as they handle buys: a `placing` sell is failed and its position reopened.

- [ ] **Step 1: Write the failing tests.** Assert the ledger sum equals the balance in each:
    - `"a filled close credits the proceeds and closes the position"`
    - `"a rejected close reopens the position and moves no money"`
    - `"a second close with another requestId is position_busy; the same requestId returns the same order"`
    - `"a position below the minimum size can't be closed"`
    - `"shares are sold floored to 0.01 and the position closes"`
    - `"a placing sell is failed and its position reopened by recover"`
    - `"a delayed sell is settled by the tracker"`
    - Over the socket: `"prediction:quote {positionId} answers a sell quote"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with "Sell predictions early, exactly once".

### Task 2: Paying winners at resolution

**Files:**
- Create: `server/src/predictions/resolver.ts`
- Modify:
    - `server/src/markets/gamma.ts`: optional `umaResolutionStatus` and `conditionId` on markets
    - `server/src/markets/polymarket-data.ts`: `market(id): Promise<GammaMarket | null>` via `GET /markets/{id}`
    - `server/test/support/fake-polymarket.ts`: serves `GET /markets/:id`, plus a `resolve(marketId, outcomePrices: string[])` control that marks the market closed and resolved
    - `server/src/events.ts`: `"position:settled"`
    - `server/src/protocol.ts`: push `position:settled {position: PositionView, account: AccountView}`
    - `server/src/socket/sockets.ts`: push through the per-account chain
    - `server/src/server.ts`
    - `server/test/e2e/serve.ts`: control `/polymarket/resolve {marketId, prices}`
    - `e2e/backend.ts`: `resolveMarket`
- Test: `server/test/integration/prediction-resolver.test.ts`

**Interfaces:**
- **`PredictionResolver`:**
    - **Constructor:** `{ collections, ledger, data: PolymarketData, bus, logger, resolveMs, now? }`. It has `start`, `stop` and a public `tick`, like the tracker.
    - **Each `tick`:**
        1. Find the distinct `marketId`s of `open` positions, up to 100.
        2. For each, call `data.market(id)`. On a resolution, settle every `open` position on that market.
        3. When a market's positions are settled, upsert a `predictionRedemptions` row `{conditionId, marketId, state: "pending", nextAt: now}`, unique on `conditionId`, for Task 3.
    - **One position's settlement** is one transaction: the conditional move `{_id, state: "open"} → won|lost`, setting `payout` and `settledAt`, plus the payout credit when there is one. After commit, emit `position:settled`.
- **Collection** `predictionRedemptions` (`prediction_redemptions`): `{ _id, conditionId (unique), marketId, state: "pending"|"submitted"|"confirmed"|"failed", transactionId: string|null, attempts: number, nextAt: Date, lastError: string|null, createdAt, updatedAt }`.

- [ ] **Step 1: Write the failing tests:**
    - `"a win is paid shares × 1 and the position is won"`
    - `"a loss writes no ledger row and the position is lost"`
    - `"a 50/50 pays half"`
    - `"two resolver passes pay once"`
    - `"a closing position is skipped, and paid on the next pass after its sale fails"`
    - `"an unresolved or merely closed market pays nothing"`
    - `"position:settled is pushed with the new balance"`
    - `"settling queues one redemption per condition"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with "Pay winning predictions when their market resolves".

### Task 3: Redemption and reconciliation

**Files:**
- Create:
    - `server/src/predictions/redeemer.ts`
    - `server/src/predictions/reconciler.ts`
- Modify:
    - `server/src/predictions/trader.ts`: three methods
    - `server/src/predictions/polymarket-trader.ts`
    - `server/test/support/fake-trader.ts`
    - `server/test/support/fake-clob.ts`
    - `server/src/server.ts`
- Test:
    - `server/test/integration/prediction-redeemer.test.ts`
    - `server/test/integration/polymarket-trader.test.ts`

**Interfaces:**
- **`PoolTrader` gains:**
    - `redeem(conditionId): Promise<{ transactionId: string }>`: the adapter calls `client.redeemPositions({conditionId})` and returns `handle.transactionId`, without awaiting `wait()`.
    - `transaction(transactionId): Promise<"pending" | "confirmed" | "failed">`: the adapter calls `fetchTransaction`, where `STATE_CONFIRMED` means confirmed and `STATE_FAILED` or `STATE_INVALID` mean failed.
    - `holdings(): Promise<Array<{ tokenId: string; sharesE6: bigint }>>`: the adapter calls `client.listPositions()` over every page, for `OPEN` and `REDEEMABLE`.
- **The fakes:**
    - `FakeTrader` gets controls: `failNextRedeem()`, `confirm(transactionId)`, `setHoldings(...)`. By default its holdings follow its own fills and sells.
    - `fake-clob` serves:
        - relayer `POST /submit`
        - `GET /v1/account/transactions/:id`
        - `GET /v1/account/transactions/params`
        - Gamma `GET /markets/keyset`
        - Data `GET /v2/positions`
        - the JSON-RPC that `redeemPositions` needs (an `eth_call` for v2 balances only; the v1 path needs none)
- **`PredictionRedeemer`:** a loop every 60 s.
    - A `pending` row whose `nextAt` has passed → call `redeem`, and the row becomes `submitted` with its `transactionId`.
    - A `submitted` row → check `transaction`:
        - `confirmed` → mark it `confirmed` and refresh the float
        - `failed` → mark it `failed`, add one to `attempts`, and set `nextAt` 10 minutes later
    - A `failed` row is retried as `pending` when `nextAt` passes.
    - Errors are logged as the Global Constraints say.
- **`PredictionReconciler`:** a loop every 10 minutes that compares, per token, the sum of `shares` over `open` and `closing` positions with `holdings()`. Within the tolerance and exclusions it does nothing; otherwise it logs at error `{ tokenId, ledgerE6, poolE6 }`. People's money is never touched.

- [ ] **Step 1: Write the failing tests:**
    - `"a pending redemption is submitted, then confirmed"`
    - `"a failed redemption is retried after 10 minutes, then logged at error from the 6th attempt"`
    - `"reconciliation logs a mismatch and stays quiet within 0.1 share"`
    - `"reconciliation skips tokens with an in-flight order or an unconfirmed redemption"`
    - Adapter, against `fake-clob`: `"redeem returns the relayer transaction id and transaction maps its states"`, `"holdings reads /v2/positions across pages"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with "Redeem resolved conditions and reconcile the pool's holdings".

### Task 4: Close, live value and settled rows in the sidebar

**Files:**
- Modify:
    - `server/src/protocol.ts` and `server/src/markets/shape.ts`: `MarketOutcomeView` gains `sellPrice: number` (side A is `bestBid`; side B is `1 − bestAsk`; 4 decimals) and `minShares: number` (the market's `orderMinSize`)
    - `lib/trade/markets.ts`: `isMarketView` accepts both, and stays tolerant of cached views that don't have them
    - `components/trade/markets-store.ts`: `hold(eventIds: string[])`, refreshing those questions every 60 s while visible, at most 20, into `known`
    - `lib/account/state.ts`, `components/account-client.ts`, `components/account-provider.tsx`
    - `components/wallet-data.ts`
    - `components/position-row.tsx` and its CSS module
    - `components/wallet-sidebar.tsx`: the positions block only
- Test:
    - `server/test/unit/markets-shape.test.ts`
    - `e2e/markets.logic.spec.ts`
    - `e2e/account.logic.spec.ts` or `e2e/predictions.logic.spec.ts`
    - `e2e/predictions.spec.ts`

**Interfaces:**
- **The account client:**
    - `closePosition(position: PositionView, sellPrice: number | null): void` is synchronous.
        - If offline: set `tradeNotice` to the offline line and return.
        - Otherwise: dispatch an `OptimisticTrade` with `side: "sell"`, `positionId` and `proceedsWei = floor2(shares) × sellPrice` (0 when the price is unknown).
        - Emit `prediction:close` with `quotedPrice: sellPrice ?? 0.01`, without awaiting.
        - An `ok:false` ack rolls back with the server's message. A failed `prediction:update` for a sell rolls back with "Couldn't sell right now. Your position is back.".
    - A new listener `position:settled` dispatches `position-settled`, which applies `withAccount` and upserts the position.
- **The reducer:**
    - `optimisticBalance` adds `proceedsWei` for pending sells the server doesn't know about yet.
    - A pending sell hides its position from the open list, and it reappears on rollback.
- **The sidebar's live prediction rows:**
    - **Value:** `shares × sellPrice` from the store's `known` view of that token. PnL = value − cost. With no price, show the cost and no PnL.
    - **Close:**
        - It is enabled when the floored shares are at least `minShares`.
        - Otherwise it is `aria-disabled`, keyboard reachable, with the "Too small to sell" reason.
        - It calls `closePosition`.
    - **Settled rows:** `won` and `lost` positions settled in the last 7 days show `Won $X` or "Lost" in place of the PnL, with no Close.
    - **Held questions:** the provider calls `hold` with the `eventId`s of the open positions.

- [ ] **Step 1: Write the failing tests.**
    - Unit: shape gives `sellPrice` and `minShares`.
    - Logic:
        - `"a pending sell raises the balance and hides the position; a failure restores both"`
        - `"position:settled applies the payout balance once"`
    - Browser, with the same setup as phase 2's `predictions.spec.ts`:
        - `"closing a position credits the balance at once and the row goes"`: a filled sell.
        - `"a rejected close puts the position back with the message"`: `nextOrder(token, "reject:price_moved")` before Close.
        - `"a tiny position's Close is disabled with the reason"`
        - `"a resolved win shows Won and raises the balance"`: `resolveMarket(marketId, ["1","0"])`, then advance the server's resolver. The test needs a control to run one resolver pass at once: add `/predictions/resolve-now`, which calls the resolver's `tick`.
        - `"a resolved loss shows Lost"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server suite, the logic project, the full browser suite from the isolated copy, `tsc`, `eslint` and Prettier. Expected: all pass, including `wallet-sidebar.spec`'s mock-perp tests.
- [ ] **Step 5: Commit** with "Close predictions from the sidebar and show their outcome".

### Task 5: Real predictions on the PnL page

**Files:**
- Modify:
    - `lib/trade/activity.ts`: `predictionActivity(position: PositionView, optimistic?)`
    - `components/pnl/use-activity.ts`
    - `components/pnl/activity-card.tsx`, only if a title or tone needs it
- Test:
    - `e2e/trade.logic.spec.ts` ("balance history")
    - `e2e/pnl.spec.ts`

**Interfaces:**
- **`predictionActivity`** turns a position into rows:

  | Row | Kind | `change` | Title | ID |
  | --- | --- | --- | --- | --- |
  | Opening | `predict` | 0 | `${outcome} on ${question}` | `prediction:${id}:open` |
  | Sold (`closed`) | `close` | `proceeds − cost` | `Sold ${outcome} on ${question}` | `prediction:${id}:settle` |
  | Won | `close` | `payout − cost` | `Won ${outcome} on ${question}` | `prediction:${id}:settle` |
  | Lost | `close` | `−cost` | `Lost ${outcome} on ${question}` | `prediction:${id}:settle` |

    - The opening row's `amountUSD` is the cost.
    - Every row's `symbols` is `[QUOTE]`.
    - An optimistic buy is an opening row with `pending: true`.
- **`use-activity`:** for a signed-in person, the real prediction rows replace the mock `predict` rows (`mockTrades(now).filter(t => t.kind !== "predict")`). Demo is unchanged. `ActivityState` keeps its shape.
- **Balance math** stays: deposits + realized (`kind === "close"`) + fees. Real payouts count as realized, so winning days are coloured.

- [ ] **Step 1: Write the failing tests:**
    - Logic:
        - `"a won position adds its realized gain to the day it settled, and the bar is a gain"`
        - `"a lost position is a realized loss"`
        - `"a buy changes nothing until it settles"`
    - Browser (`pnl.spec.ts`): seed $500, buy (fill), close (fill), then open PnL. The rows read the question, the close row's Result shows the realized change, and the mock predict rows are gone. The existing pnl tests keep passing.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the logic project, the full browser suite from the isolated copy, `tsc`, `eslint` and Prettier. Expected: pass.
- [ ] **Step 5: Commit** with "Show real predictions on the PnL page".

### Task 6: The owner's runbook and live check

**Files:**
- Create: `server/scripts/polymarket-live-check.ts`
- Modify:
    - `README.md`: a "Prediction trading" section
    - `server/.env.example`, if a note is missing

**Interfaces:**
- **`polymarket-live-check.ts`** uses `createPolymarketTrader` with the real config and no database. It runs these steps in order:
    1. Pick the most liquid trending question from `GET {gamma}/events?...` (top by 24-hour volume, an offered YES under 0.9).
    2. Quote a $1 buy.
    3. `signBuy`.
    4. `post`.
    5. Print whether the post's `orderId` equals the computed `orderHash`, and what `makingAmount`/`takingAmount` look like (raw, and as parsed e6).
    6. `lookup` the order.
    7. Sell all its shares at the bid with `signSell`, then `post`.
    8. Print the proceeds against the computed fee.
    9. Print `balanceE6` before and after.

    It refuses to run unless `--yes-spend-real-money` is passed, and it prints a pass/fail line for each assumption the plan marked UNCONFIRMED:
    - `orderId == hash`
    - the units of the post amounts
    - the sell fee being netted
    - the fetchOrder status words
- **The README section covers, in plain steps:**
    - the builder profile and its keys
    - a fresh pool key
    - running `polymarket-setup.ts`
    - funding the printed wallet with pUSD, through Polymarket's bridge deposit or by wrapping USDC.e via the Collateral Onramp (native USDC isn't accepted by the Onramp)
    - hosting outside Polymarket's restricted regions, calling Polymarket directly with no proxies
    - running the live check
    - setting `PREDICTIONS_TRADING=on`
    - setting `TRUST_PROXY`
    - watching the float warnings and reconciliation errors in the logs
    - that a location check on users is still a launch blocker (spec "Not included")

- [ ] **Step 1: Write the failing test.** `server/test/unit/live-check.test.ts`: `"the live check refuses to run without --yes-spend-real-money"`. Spawn the script with no flags and assert a non-zero exit and the refusal text.
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement** the script and the docs.
- [ ] **Step 4: Run** the unit test, `tsc` and Prettier. Expected: pass.
- [ ] **Step 5: Commit** with "Document prediction trading for the owner, with a live check".
