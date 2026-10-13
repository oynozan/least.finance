# Hyperliquid Perps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Long and Short sentences open and close real isolated-margin perpetual positions on Hyperliquid from each person's Arc balance, with live PnL, optimistic state and server-side recovery.

**Architecture:** A new `server/src/perps/` module mirrors `server/src/predictions/`: a `PerpService` (checks, hold, order states, float), a `PerpTracker` (REST polling, fills, liquidation), and a `HyperliquidClient` interface (the `PoolTrader` equivalent, wrapped by a timeout helper) with one real implementation over `@nktkas/hyperliquid` and one in-process fake. Each person signs from their own derived Hyperliquid address; a master float account (index 0) funds them. The client gets a `perps` slice in the account state, a live branch in the review panel, perp rows in the sidebar and the PnL feed.

**Tech Stack:** Node 24 + Express 5 + socket.io + zod + viem + MongoDB replica set (server), `@nktkas/hyperliquid` (exact pin, behind our interface), vitest, Next.js 16 + React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-hyperliquid-perps-design.md`. Research: `.superpowers/research/2026-10-14/`. Spec sections 1 to 9 map to Tasks 1 to 9. Spec section 10 phase 5 (testnet and mainnet checks, launch blockers) is the owner's, after Task 9.

## Global Constraints

- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -- <paths>`), with only your own hunks.
- **Comments** are one line each and describe the code as it is.
- Never read or print any `.env` file.
- **No real external service and no real transaction in any test.** Use the fakes in `server/test/support/` (`fake-hyperliquid.ts` is new). The owner runs the real-money live checks.
- **Browser tests** run only from an isolated copy of the repo, on ports 3650/4650/4651. Never 3000, 4500 or 27018.
- **Checks:** server `cd server && npm test && npx tsc --noEmit`; logic `npm run test:logic`; app types `npx tsc --noEmit -p .`.
- **Feature switches default off:** `PERPS_TRADING=off`. Off: markets and quotes stay live, Review stays blocked, existing positions can still be closed and are still tracked.
- **The browser never calls Hyperliquid.** Only `HyperliquidClient` implementations import `@nktkas/hyperliquid`.
- **Spec values, verbatim:**
    - Path `m/44'/60'/1'/0/index` (viem `accountIndex: 1`, `addressIndex: index`); deposits stay on `m/44'/60'/0'/0/index`. Index 0 is the master. Counter `perpIndex`, starting at 1.
    - `PERPS_SLIPPAGE_BPS` 100, `PERPS_CLOSE_SLIPPAGE_BPS` 300, `PERPS_MAX_LEVERAGE` 20, `PERPS_FEE_BPS` 0, `PERPS_FLOAT_USD` 200, `PERPS_RECONCILE_TOLERANCE_USD` 5, `HYPERLIQUID_API_URL` mainnet default, testnet `https://api.hyperliquid-testnet.xyz`.
    - Minimum: collateral at least $10 and collateral x leverage at least $11. Default taker fee rate 0.00045.
    - Tick rule: at most 5 significant figures and at most `6 - szDecimals` decimals; integers always allowed; trailing zeros stripped before signing. Order `t: { limit: { tif: "Ioc" } }`, `r: false`, no builder; close is `r: true`.
    - Money: wei (18 decimals) to E6 with `e6ToWei` and `weiToE6` from `server/src/db/money.ts`.
    - Rate limits: 10 orders a minute per user. Market sync every 5 s. Reconciliation every 10 min. Float read every 60 s. Float warnings under 25% and over 200% of `PERPS_FLOAT_USD`.
    - Ledger kinds `perp_open` (debit), `perp_refund` (credit), `perp_close` (credit), each unique per `(kind, refId)` through `ref_unique`.
- **Messages, verbatim** (spec sections 3, 7, 8):
    - "Long and short aren't available right now."
    - "Positions start at $10." and "A position starts at $11. Raise the collateral or the leverage."
    - "You already hold a BTC position. Close it first."
    - "BTC allows up to 20x."
    - "Long and short are limited to $X right now. Nothing was spent."
    - "The price moved, so your position didn't open. Nothing was spent."
    - "This position couldn't be opened right now. Nothing was spent."
    - "Hyperliquid isn't answering. Nothing was spent."
    - "Opened $X of your $Y. The rest is back in your balance."
    - "Couldn't close right now. Your position is still open."
    - "Your BTC long was liquidated."
    - "Too small to close right now."
    - "Position opened."
    - "You're offline. Nothing was spent."

## Review Focus

1. **The order is posted and the reply is lost.** The order stays `posted` and the person's collateral stays held; the tracker finds the fill by `cloid` and settles it once. A restart in the middle must not refund an order that filled. (Task 4, Task 5 tests.)
2. **A duplicate `usdSend` after a restart in `funding` or `sweeping`.** The stored nonce is reused, so the fake rejects the second one and no extra float reaches a person. (Task 4 test.)
3. **Two opens at once for the same person, same asset, or together overdrawing the float.** Exactly one wins; the hold and the balance each move once. (Task 4 test.)
4. **A sweep that fails after a close or liquidation.** The ledger is not credited until the master has the money; the order stays `sweeping` and the tracker retries. (Task 5 test.)
5. **A tiny collateral at 50x, or a leverage the asset or its size tier doesn't allow.** The check refuses before any money moves, with the spec's messages. (Task 1 and Task 4 tests.)
6. **Collateral typed with many decimals or an amount that rounds the size to zero.** The check refuses it as below the minimum, never places a zero-size order. (Task 1 test.)

---

### Task 1: Foundation: keyring, config, data, ledger kinds, trading math (spec §1, §3 Sizing, §3 liquidation estimate)

**Files:**
- Modify: `server/src/accounts/keyring.ts`, `server/src/config.ts`, `server/src/db/mongo.ts` (types, `Collections`, `connectDatabase`, indexes), `server/src/deposits/ledger.ts` (widen `debitInSession` and `creditInSession` kind unions), `server/src/db/migrations.ts` (`mergeInto` re-points the three perp collections)
- Create: `server/src/perps/math.ts`
- Test: `server/test/unit/keyring.test.ts`, `server/test/unit/config.test.ts`, `server/test/unit/perp-math.test.ts`, `server/test/integration/migration.test.ts`, `server/test/integration/prediction-ledger.test.ts` (or a new `perp-ledger.test.ts` beside it)

**Interfaces:**
- Produces, `Keyring`: `perpSignerAt(index: number): HDAccount` and `perpAddressAt(index: number): Address` (lowercase). Index 0 is allowed here (the master); a negative or non-integer index throws.
- Produces, config fields as in Global Constraints. `PERPS_TRADING: "on" | "off"`; `PERPS_FLOAT_USD` positive number; the bps fields integers with `PERPS_FEE_BPS` 0 to 999; `PERPS_MAX_LEVERAGE` 1 to 50. No new required secrets with trading on.
- Produces, types in `mongo.ts`: `PerpAccountDoc`, `PerpOrderDoc`, `PerpPositionDoc`, `PerpFloatDoc` (shaped like `PoolFloatDoc`, `_id: "hyperliquid"`), `PerpRebalanceDoc`, exactly the fields of spec §1; `Collections` gains `perpAccounts`, `perpOrders`, `perpPositions`, `perpFloat`, `perpRebalances`. `LedgerEntryDoc["kind"]` gains `perp_open | perp_refund | perp_close`.
- Indexes: `perpAccounts` unique `index` and unique `address`, non-unique `accountId`; `perpOrders` unique `(accountId, requestId)` and `(state, updatedAt)`; `perpPositions` `(accountId, openedAt)`, `(state, updatedAt)`, and unique `(index, asset)` as a partial index on a boolean `active: true` that is set while the position is `open` or `closing` (a partial filter on a state list is not relied on).
- Produces, `perps/math.ts` (pure, no I/O):
    - `roundPrice(px: number, szDecimals: number): string` and `roundSize(size: number, szDecimals: number): string` per the tick rule.
    - `limitPrice(mark: number, side: "long" | "short", action: "open" | "close", bps: number, szDecimals: number): string`. Open: long above mark, short below. Close reverses (selling a long goes below).
    - `sizeFor(o: { collateralE6: bigint; leverage: number; feeRate: number; ourFeeRate: number; price: number; szDecimals: number }): { sizeCoin: string; notionalE6: bigint; marginE6: bigint; entryFeeE6: bigint; ourFeeE6: bigint } | null` (null when the size rounds to zero).
    - `leverageBound(o: { maxLeverage: number; marginTables: Array<{ lowerBound: string; maxLeverage: number }>; notionalUSD: number; configMax: number }): number`.
    - `liquidationPrice(o: { side: "long" | "short"; entry: number; sizeCoin: number; marginUSD: number; notionalUSD: number; maxLeverage: number }): number`, spec §3's formula with `mmr = 1 / (2 * maxLeverage)`.
    - `meetsMinimum(collateralUSD: number, leverage: number): "collateral" | "position" | null`.

- [ ] **Step 1: Write the failing tests.**
    - `keyring.test.ts`: `"a perp address never equals a deposit address"` (indexes 0 to 50 on both paths); `"perpAddressAt(0) is the master and differs from operator()"`; `"perpSignerAt rejects -1 and 1.5"`.
    - `config.test.ts`: `"perps defaults"` asserts `PERPS_TRADING` "off", 200, 100, 300, 20, 0, 5 and the mainnet URL; `"PERPS_TRADING=on needs no extra secret"`; `"PERPS_FEE_BPS=1000 is refused"`.
    - `perp-math.test.ts`: `"roundPrice keeps 5 significant figures"` (`roundPrice(65432.19, 5)` is "65432", `roundPrice(0.123456, 0)` is "0.12346"); `"decimals are capped at 6 - szDecimals"` (szDecimals 4 and px 1.234567 gives "1.23"); `"trailing zeros are stripped"` ("65000" stays, "1.50" becomes "1.5"); `"limitPrice open long is mark x 1.01, short x 0.99, close long x 0.97, close short x 1.03"`; `"sizeFor makes margin plus fees equal the collateral"` ($100, 5x, f 0.00045: notional `100 x 5 / (1 + 5 x 0.00045)` = 498.876...; asserts `marginE6 + entryFeeE6 + ourFeeE6 <= collateralE6` and the gap is under one coin step); `"sizeFor rounds the size down"`; `"sizeFor returns null when the size rounds to zero"`; `"meetsMinimum: 9.99 is collateral, $10 at 1x is position, $10 at 2x passes"`; `"leverageBound is the smallest of maxLeverage, the tier at the size, and 20"` (a 50x asset with a tier capping 10x at $500k notional gives 10 at $600k, 20 at $1k); `"liquidationPrice long and short"` with two hand-computed cases from the formula (e.g. long, entry 65000, 5x, size 0.0076923 coin, max leverage 50: liqPx = 65000 - (100 - 0.01 x 500)/0.0076923/(1 - 0.01) rounded to 2 decimals in the assertion).
    - `migration.test.ts`: `"merging accounts re-points perp orders, positions and accounts to the survivor"`; `"a merge never collides two open positions"` (two accounts with BTC positions at different indexes merge cleanly).
    - ledger: `"perp_open debits once and a repeated (kind, refId) is refused"`, and the same for `perp_refund` and `perp_close` credits.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd server && npx vitest run test/unit/keyring.test.ts test/unit/config.test.ts test/unit/perp-math.test.ts test/integration/migration.test.ts test/integration/prediction-ledger.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the keyring methods, config fields, types and indexes, the ledger unions, the merge re-pointing, and `math.ts`. `perpIndex` is allocated by a new `PerpService`-owned helper in Task 4, not here.
- [ ] **Step 4: Run** the same files, then `cd server && npm test && npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit.** Message: `Add the Hyperliquid perps data, ledger kinds, key path and trading math`.

### Task 2: HyperliquidClient, the real adapter and the fake (spec §3 intro, §9 Fake Hyperliquid)

**Files:**
- Create: `server/src/perps/client.ts`, `server/src/perps/nktkas-client.ts`, `server/test/support/fake-hyperliquid.ts`, `server/scripts/record-hyperliquid-fixtures.ts`, `server/test/fixtures/hyperliquid/meta.json`, `server/test/fixtures/hyperliquid/clearinghouse.json`, `server/test/fixtures/hyperliquid/fills.json`
- Modify: `server/package.json` and `server/package-lock.json` (add `@nktkas/hyperliquid` at an exact version, `0.33.3` unless the recorder run shows a newer one is needed)
- Test: `server/test/unit/perp-client.test.ts`, `server/test/unit/perp-timeout.test.ts`

**Interfaces:**
- Produces, `client.ts` (no SDK import):
    - `PerpMeta = { assets: Array<{ asset: string; index: number; szDecimals: number; maxLeverage: number; marginTables: Array<{ lowerBound: string; maxLeverage: number }>; onlyIsolated: boolean; markPx: number; oraclePx: number; funding: number }> }`
    - `AccountState = { withdrawableE6: bigint; accountValueE6: bigint; positions: Array<{ asset: string; sizeCoin: string; side: "long" | "short"; entryPx: string; leverage: number; liquidationPx: string | null; unrealizedPnlE6: bigint; cumFundingE6: bigint; marginUsedE6: bigint }> }`
    - `Fill = { tid: number; oid: number; cloid: string | null; asset: string; sizeCoin: string; px: string; feeE6: bigint; dir: string; liquidation: boolean; time: number }`
    - `OrderResult = { kind: "filled"; totalSz: string; avgPx: string } | { kind: "resting"; oid: number } | { kind: "rejected"; message: string } | { kind: "unknown" }`
    - `OrderStatus = { kind: "filled"; totalSz: string; avgPx: string } | { kind: "open" } | { kind: "canceled" } | { kind: "rejected"; message: string } | { kind: "missing" }`
    - `interface HyperliquidClient { meta(): Promise<PerpMeta>; book(asset: string): Promise<{ bids: Level[]; asks: Level[] }>; state(address: string): Promise<AccountState | null> (null: the account doesn't exist); userFees(address: string): Promise<{ takerRate: number }>; fills(address: string, sinceMs: number): Promise<Fill[]>; orderStatus(address: string, cloid: string): Promise<OrderStatus>; usdSend(from: HDAccount, to: string, amountE6: bigint, nonce: number): Promise<{ kind: "ok" } | { kind: "duplicate" } | { kind: "rejected"; message: string }>; updateLeverage(signer: HDAccount, asset: string, leverage: number): Promise<void>; order(signer: HDAccount, o: { asset: string; isBuy: boolean; px: string; sz: string; reduceOnly: boolean; cloid: string }): Promise<OrderResult> }`, with `Level` reused from `server/src/predictions/trader.ts`.
    - `withPerpTimeouts(client: HyperliquidClient, ms: number): HyperliquidClient`: every call bounded; an `order` that does not answer becomes `{ kind: "unknown" }`.
    - `nextNonce(signer: string): number`: `max(Date.now(), last + 1)` per signer, in process.
- Produces, `createNktkasClient(o: { url: string }): HyperliquidClient`. The order status is read from the per-order result (`filled`, `resting`, `error`), never the top-level `ok`.
- Produces, fake: `startFakeHyperliquid(): Promise<FakeHyperliquid>` serving `/info` and `/exchange`, with `url`, `setMark(asset, px)`, `setBook(asset, book)`, `fund(address, usdE6)`, `nextOrder("fill" | { partial: string } | { reject: string } | "hold" | "drop")`, `liquidate(address, asset)`, `failUsdSend(on: boolean)`, `account(address)`, `requests: string[]`, `usdSends`, and `orders`. It rejects a repeated `usdSend` nonce, takes the 1 USDC activation out of a new address's first transfer on top of the amount (open question 1's assumed answer, switchable with `activationFrom("sender" | "amount")`), and a taker fee of 0.045%.

- [ ] **Step 1: Record fixtures.** The recorder script reads the public `meta`, a sample `clearinghouseState` and `userFills` from `HYPERLIQUID_API_URL` (mainnet default) and writes the three fixtures; it never signs. Run it once; commit the files.
- [ ] **Step 2: Write the failing tests.**
    - `perp-client.test.ts` against the fake: `"meta lists the five catalog assets with szDecimals and marginTables"`; `"a filled order parses totalSz and avgPx"`; `"an error status is rejected, even when the top-level status is ok"`; `"a repeated usdSend nonce is duplicate"`; `"state of an unknown address is null"`; `"orderStatus by cloid finds a filled order"`; `"nextNonce is strictly increasing within one millisecond"`; `"a dropped reply from order is unknown through withPerpTimeouts"`.
    - `perp-timeout.test.ts`: `"each call is bounded by ms"`.
- [ ] **Step 3: Run and watch them fail.** Run: `cd server && npx vitest run test/unit/perp-client.test.ts test/unit/perp-timeout.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `client.ts`, the adapter, the fake and `withPerpTimeouts`. The adapter is the only file importing the SDK; the fake speaks the same wire format the SDK sends, so the real adapter runs against it unchanged.
- [ ] **Step 5: Run** both files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 6: Commit.** Message: `Add the HyperliquidClient interface, its SDK adapter and a fake Hyperliquid`.

### Task 3: Markets sync and `GET /perps/markets`, with the client reading them (spec §2 Sync and Public route, §8 The sentence)

**Files:**
- Create: `server/src/perps/markets.ts`, `lib/trade/perp-markets-store.ts`
- Modify: `server/src/http/app.ts`, `server/src/server.ts`, `server/src/services.ts`, `server/src/protocol.ts` (the `PerpMarketView` and `PerpMarketsView` types), `lib/trade/operations/perp.ts`, `lib/trade/catalog.ts` (keep `PERP_MARKETS` as the fallback, comment it), `lib/api.ts` if it holds the fetch helpers
- Test: `server/test/integration/perp-markets.test.ts`, `e2e/perp-sentence.logic.spec.ts`

**Interfaces:**
- Consumes: Task 2's `HyperliquidClient.meta`.
- Produces, `PerpMarkets` class: `constructor({ client, config, logger, now })`; `start(): void` and `stop(): void` (sync every 5 s; a failed sync keeps the last good list and logs a warning); `list(): PerpMeta["assets"]`; `byAsset(asset: string)`; `view(): PerpMarketsView`; `maxOrderUSD` is provided by `PerpService` in Task 4 through a setter `setMaxOrderUSD(fn: () => number | null)`; until then it is `null`.
- Produces, protocol: `PerpMarketView = { asset: string; markPx: string; maxLeverage: number; fundingRate: string }` and `PerpMarketsView = { markets: PerpMarketView[]; maxOrderUSD: string | null }`. `maxLeverage` is `min(HL maxLeverage, PERPS_MAX_LEVERAGE)`.
- A catalog asset is kept only while `meta` lists it and `onlyIsolated` or isolated margin is allowed; otherwise it is dropped from the view.
- Route: `GET /perps/markets`, outside `/v1`, `noStore`, `limit(120, 60_000)`, no token.
- Produces, client: `perp-markets-store.ts` with `loadPerpMarkets(): Promise<void>`, `getPerpMarkets(): PerpMarketsView | null`, a subscribe function in the style of `components/trade/markets-store.ts`; the store replaces `catalog.perps` and holds `maxOrderUSD`. `TradeCtx` exposes `perpTrading: { maxOrderUSD: number | null; loaded: boolean }`.
- `perp.ts` `check`: returns the "Long and short aren't available right now." blocker (code `unavailable`, cta "Not available right now") only when `maxOrderUSD` is null (trading off) or the client is offline; the minimum-position check and the one-position-per-asset check are added in Task 6, which owns the account state.

- [ ] **Step 1: Write the failing tests.**
    - `perp-markets.test.ts`: `"GET /perps/markets lists BTC, ETH, SOL, LINK and DOGE with markPx and maxLeverage"`; `"maxLeverage is capped at PERPS_MAX_LEVERAGE"` (20 for BTC); `"an asset Hyperliquid no longer lists is dropped"`; `"a failed sync keeps the last list"`; `"maxOrderUSD is null while trading is off"`; `"the route needs no token"`.
    - `perp-sentence.logic.spec.ts`: `"the leverage picker follows the server's cap"` (a market capped at 10 hides 20x and pulls a chosen 20 down to 10); `"Review stays blocked with 'Long and short aren't available right now.' while maxOrderUSD is null"`; `"the fallback list is used before the first load"`.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/perp-markets.test.ts`; `npm run test:logic -- e2e/perp-sentence.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the sync class, the route and its wiring in `startServer` (started always, so quotes work with trading off), the client store and the `perp.ts` changes.
- [ ] **Step 4: Run** both, then `cd server && npm test && npx tsc --noEmit`, `npm run test:logic` and `npx tsc --noEmit -p .`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Serve Hyperliquid perp markets from the server and size the leverage picker from them`.

### Task 4: Quote and open: `PerpService`, the float, the sockets (spec §2 quote, §3 Opening and Recovery, §4, §6 The float, §7 open rows)

**Files:**
- Create: `server/src/perps/perps.ts`, `server/src/perps/float.ts`, `server/src/perps/views.ts`, `server/test/support/perp-harness.ts`
- Modify: `server/src/protocol.ts` (events and views, see below), `server/src/validation.ts` (`perpQuote`, `perpOrder`, `perpClose` zod schemas), `server/src/events.ts` (`perp:updated`), `server/src/errors.ts` (codes if new ones are needed), `server/src/services.ts`, `server/src/server.ts`, `server/src/socket/sockets.ts`
- Test: `server/test/integration/perp-open.test.ts`, `server/test/integration/perp-float.test.ts`, `server/test/integration/perp-recovery.test.ts`, `server/test/integration/perp-socket.test.ts`

**Interfaces:**
- Consumes: Task 1 math and types; Task 2 `HyperliquidClient` and the fake; Task 3 `PerpMarkets`; `Ledger.debitInSession` and `creditInSession`; `weiToE6` and `e6ToWei`.
- Produces, protocol (stays import-free of the app; the app imports it as `@/server/src/protocol`):
    - `PerpQuoteRequest = { asset: string; side: "long" | "short"; leverage: number; collateralUSD: string }`
    - `PerpQuoteView = { entryPx: string; sizeCoin: string; notionalUSD: UsdcAmount; takerFeeUSD: UsdcAmount; ourFeeUSD: UsdcAmount; liquidationPx: string; fundingPerHour: string; marginUSD: UsdcAmount }`
    - `PerpOrderRequest = PerpQuoteRequest & { requestId: string }`; `PerpCloseRequest = { requestId: string; positionId: string }`
    - `PerpPositionView` exactly as spec §8; `PerpOrderView = { id: string; requestId: string; kind: "open" | "close"; state: string; reason: string | null; positionId: string | null; filledSizeCoin: string | null; requestedSizeCoin: string; collateralUSD: UsdcAmount; creditedUSD: UsdcAmount | null; createdAt: string; updatedAt: string }`
    - `ClientToServerEvents`: `"perp:quote": (req, ack: (r: Ack<PerpQuoteView>) => void)`, `"perp:order": (req, ack: (r: Ack<{ order: PerpOrderView; account: AccountView }>) => void)`, `"perp:close": (req, ack: (r: Ack<{ order: PerpOrderView }>) => void)`. `ServerToClientEvents`: `"perp:update": { order: PerpOrderView; position: PerpPositionView | null; account: AccountView }` and `"perps": { positions: PerpPositionView[]; orders: PerpOrderView[] }` on bind, beside `"positions"`.
- Produces, `PerpService`:
    - `quote(req: PerpQuoteRequest): Promise<PerpQuoteView>`: price from `l2Book` walked for the size, worst case the slippage cap; fee from `userFees` of the master, floor 0.00045.
    - `place(account: AccountDoc, req: PerpOrderRequest): Promise<{ order: PerpOrderDoc; account: AccountDoc }>`: steps 1 to 6 of spec §3. Step 2 is one transaction: insert the order `placing`, `debitInSession(..., "perp_open", order._id)`, add C (+1 USDC when the person has no activated account) to `perpFloat.heldE6`, guarded like `#reserve` in `predictions.ts`.
    - `recover(): Promise<void>`: spec §3 Recovery; called at startup.
    - `positions(account): Promise<{ positions: PerpPositionView[]; orders: PerpOrderView[] }>`.
    - `maxOrderUSD(): number | null`: free float minus the activation and slack, null while `PERPS_TRADING` is off. (The spec names a "person-independent cap" but defines none, so there is none.)
- Produces, `float.ts`: `PerpFloat` with `refresh(): Promise<void>` (master `withdrawable` after each order and every 60 s), `reserve(session, amountE6)`, `release(session, reservedE6, spentE6)` (same shape as `#reserve` and `#release` in `PredictionService`, `unreadFillsE6` counting what moved until the next read), and the 25% and 200% warnings.
- Order states as spec §4. The nonce is stored on the order before `usdSend`; the `cloid` is derived from `_id` and saved before `order`.
- Ack errors use the spec's messages and codes; the open-time failures table (spec §7) decides which one.
- Handlers sit beside the prediction ones in `sockets.ts`, rate-limited at 10 a minute per user (`RateLimiterMemory`, `keyPrefix: "perp"`), and a quote limit of 60 a minute. The bus event `perp:updated` pushes `perp:update` through the account's ordered push chain like `prediction:update`.

- [ ] **Step 1: Write the failing tests** (Mongo stack plus the fake; `perp-harness.ts` mirrors `prediction-harness.ts` and exposes the service, the fake, the ledger and a clock).
    - `perp-open.test.ts`: `"a fill debits, funds, records the real size and credits back the unused collateral"` ($100, 5x BTC, mark 65000: ledger shows `perp_open` -100 then `perp_refund` of the unused part; the position has the fake's real `sizeCoin` and `avgPx`); `"a partial fill books the smaller size and returns the rest"`; `"nothing filled is a full refund and the order is rejected with a reason"`; `"an error status refunds in full"`; `"the first open for a person creates the perpAccounts row and pays the 1 USDC activation from the master; the second doesn't"`; `"a short balance after activation is topped up once, at most 1 USDC"` (with `activationFrom("amount")`); `"limit price is the server's mark x 1.01, never the client's quote"` (asserts the posted order's `p` from the fake); `"leverage is set isolated before the order"`; `"a duplicate requestId is one order"`; `"two concurrent opens cannot overdraw the balance"` and `"cannot overdraw the float"` (`Promise.all`); `"a second position on the same asset is refused with 'You already hold a BTC position. Close it first.'"`; `"BTC at 25x is refused with 'BTC allows up to 20x.'"`; `"collateral 9.99 and $10 at 1x are refused with the two minimum messages"`; `"trading off refuses with 'Long and short aren't available right now.' and moves nothing"`; `"the quote's liquidation price matches liquidationPrice() for the same inputs"`.
    - `perp-float.test.ts`: `"short float refuses before any money moves, with 'Long and short are limited to $X right now. Nothing was spent.'"`; `"the hold is released exactly once on fill, on reject and on recovery"`; `"a stale float read refuses"`; `"low and high float levels log a warning"`.
    - `perp-recovery.test.ts` (kill the service object at each point, build a new one over the same database and call `recover()`): `"after the debit"`, `"after the transfer"`, `"after posting with no reply"` (the fake fills it; the tracker-path lookup by cloid settles it once), `"during the sweep"` (the stored nonce is reused and the fake's duplicate answer counts as done); each ends with exactly one `perp_open`, at most one `perp_refund`, and the hold released once. `"Hyperliquid not answering to the transfer refunds with 'Hyperliquid isn't answering. Nothing was spent.'"`.
    - `perp-socket.test.ts`: `"perp:quote returns the quote rows"`; `"perp:order acks the order and pushes perp:update on fill"`; `"11 orders in a minute hits the rate limit"`; `"bind emits perps"`.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/perp-open.test.ts test/integration/perp-float.test.ts test/integration/perp-recovery.test.ts test/integration/perp-socket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the float, then `PerpService` (`quote`, `place`, `recover`, `positions`), the views, the validation, the bus event, the socket handlers and the wiring. Settlement credits happen in one transaction with the order's state move, as `PredictionService` does for fills.
- [ ] **Step 4: Run** the four files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Open real Hyperliquid positions from the Arc balance, with a float, recovery and sockets`.

### Task 5: Tracking, close and liquidation (spec §3 Closing and Liquidation, §5, §6 Reconciliation per position)

**Files:**
- Create: `server/src/perps/tracker.ts`
- Modify: `server/src/perps/perps.ts` (`close`, `settleClose`, `settleOutside`), `server/src/server.ts` (start and stop the tracker; it runs while any position or order is unsettled even with trading off), `server/src/socket/sockets.ts` (`perp:close`)
- Test: `server/test/integration/perp-close.test.ts`, `server/test/integration/perp-tracker.test.ts`, `server/test/integration/perp-socket.test.ts` (extended)

**Interfaces:**
- Consumes: Task 4 `PerpService`, `PerpFloat`, order and position docs.
- Produces, `PerpService.close(account: AccountDoc, req: PerpCloseRequest): Promise<{ order: PerpOrderDoc }>` (spec §3 Closing 1 to 5) and `PerpService.settleOutside(position: PerpPositionDoc, fills: Fill[], state: AccountState | null): Promise<void>` for a position gone or smaller with no close of ours in flight.
- Produces, `PerpTracker`: `constructor({ service, client, collections, config, logger, bus })`; `start()`, `stop()` (abort-aware, finishing within one timeout); `viewing(accountId: ObjectId, on: boolean)` so a viewer's address is polled every 5 s while their sidebar is open.
    - Position polling: viewers every 5 s, others in a rotation capped at 600 weight a minute (`clearinghouseState` weighs 2).
    - Fills: `fills(address, sinceMs)` only when a position appears, shrinks or vanishes, and in a slow lap every 10 minutes; keyed by `tid`.
    - Orders in doubt: `orderStatus` by cloid, then fills, for `posted` orders; retries `sweeping` ones.
    - Every poll writes the snapshot (`markPx`, `unrealizedPnlE6`, `liquidationPx`, `cumFundingE6`, `at`) on the position and emits `perp:updated` only when something other than the mark changed.
- A close that is partly filled leaves the position `open` at the smaller size, no credit. A rejected close restores `open` and returns "Couldn't close right now. Your position is still open." A position under $10 refused by the venue stays `open`, logs an error, and its view carries "Too small to close right now.". A fill with `liquidation: true` makes the position `liquidated`, any other outside close `closed`.

- [ ] **Step 1: Write the failing tests.**
    - `perp-close.test.ts`: `"a close sweeps then credits the swept amount once (perp_close), proceeds and realizedPnl = proceeds - collateral"`; `"the close limit is mark x 0.97 for a long and x 1.03 for a short and reduce-only"`; `"a partial close leaves the position open and credits nothing"`; `"a rejected close restores open"`; `"a failed sweep credits nothing and leaves the order sweeping"` (fake `failUsdSend(true)`, then the tracker retries after it is cleared and credits once); `"closing twice at once is one close"`; `"trading off still closes"`; `"an account with an open position merges and the survivor can close it from the position's own index"`; `"a position under $10 the fake refuses stays open with the too-small message and an error log"`.
    - `perp-tracker.test.ts`: `"a liquidation settles: credits what is left (often none), marks liquidated, pushes 'Your BTC long was liquidated.'"`; `"a position that vanishes with no liquidation fill is closed"`; `"an order posted with a lost reply is settled from orderStatus by cloid"`; `"fills are idempotent by tid"`; `"the snapshot is written and only a non-mark change pushes"`; `"a viewer's address is polled at 5 s and others stay inside the weight budget"` (counts fake `/info` requests over simulated minutes); `"stop() finishes within one timeout when a lookup hangs"`.
    - socket: `"perp:close acks and pushes perp:update with the settled position"`.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/perp-close.test.ts test/integration/perp-tracker.test.ts test/integration/perp-socket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** close, outside-close settlement, the tracker and its wiring. A close of ours in flight is detected by an order in `placing` or `posted` of kind `close` for that position.
- [ ] **Step 4: Run** the files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Close, track and settle liquidations of Hyperliquid positions`.

### Task 6: App state, review panel live path and optimistic accept (spec §8 The sentence, Review, Optimistic, state)

**Files:**
- Create: `lib/trade/perp-quote.ts`
- Modify: `lib/account/state.ts` (`perps` slice, actions, optimistic balance), `components/account-client.ts`, `components/account-provider.tsx` (`quotePerp`, `placePerp`, `closePerp` on `useAccount()`), `lib/trade/operations/perp.ts` (minimum-position and one-position-per-asset checks; `preview` rows when a quote is held), `lib/trade/context.ts` (the account's open perps in `TradeCtx`), `components/trade/review-panel.tsx` (the live branch for `intent.type === "perp"`), `lib/trade/execute.ts`
- Test: `e2e/perp-trade.logic.spec.ts`, `e2e/perp-sentence.logic.spec.ts` (extended), `e2e/account.logic.spec.ts` (extended)

**Interfaces:**
- Consumes: Task 4 and 5 protocol types.
- Produces, `AccountState` ready branch gains `perps: { positions: PerpPositionView[]; orders: PerpOrderView[] }`; actions `{ type: "perp"; update: PerpUpdate }`, `{ type: "perpsSnapshot"; ... }`, `{ type: "perpAccepted"; requestId; position: PerpPositionView; collateralWei: bigint }`, `{ type: "perpFailed"; requestId }`; upserts by id, ignores older `updatedAt`, merges by `requestId`, as the prediction branch does. `optimisticBalance` subtracts a pending perp open's collateral and adds a pending close's expected proceeds only after the server confirms.
- Produces, `quoteRows(quote: PerpQuoteView, ctx: { side; asset; leverage; collateralUSD: string }): PreviewRow[]` in `perp-quote.ts`: "Position", "Entry price (about)", "Liquidation price (about)" (with the note that it excludes funding), "Fees" (Hyperliquid's taker fee and ours), "Funding" (per hour), "Most you can lose" (the collateral). Without a quote `perp.ts` keeps today's two rows.
- Produces, `useAccount()`: `quotePerp(req: PerpQuoteRequest): Promise<PerpQuoteView>`, `placePerp(req: PerpOrderRequest): Promise<void>`, `closePerp(positionId: string): Promise<void>`.
- Review: a perp intent follows the prediction path (`live` when connected and `maxOrderUSD !== null`): quote on open, on input change, every 10 s while open; Confirm closes the review, drops the shown balance, adds the pending position with the quote's size and entry; a fill replaces them in place; a failure removes the position, restores the balance and shows the server's message in the sidebar status line. Confirmation text: "Position opened.". Offline at confirm shows "You're offline. Nothing was spent.". Other verbs stay simulated.

- [ ] **Step 1: Write the failing tests** (logic project, stubbed socket as `predictions.logic.spec.ts` does).
    - `perp-sentence.logic.spec.ts`: `"collateral 9.99 shows 'Positions start at $10.'"`; `"$10 at 1x shows 'A position starts at $11. Raise the collateral or the leverage.'"`; `"a held BTC position blocks a second BTC Long with 'You already hold a BTC position. Close it first.'"`; `"a different asset is not blocked"`.
    - `perp-trade.logic.spec.ts`: `"the review shows Position, Entry price (about), Liquidation price (about), Fees, Funding and Most you can lose from the quote"`; `"confirm lowers the balance by the collateral and adds a pending position at once, while the order is held"`; `"the fill replaces the numbers in place"`; `"a rejection removes the position, restores the balance and shows 'The price moved, so your position didn't open. Nothing was spent.'"`; `"a reload while held keeps the pending position from the server's perps snapshot"`; `"an older perp:update is ignored"`; `"offline at confirm shows the offline message and changes nothing"`; `"a partial fill shows 'Opened $X of your $Y. The rest is back in your balance.'"`.
    - `account.logic.spec.ts`: `"optimisticBalance counts a pending perp open once, and not again after the server's account arrives"`.
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/perp-sentence.logic.spec.ts e2e/perp-trade.logic.spec.ts e2e/account.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the reducer slice, the provider methods, the checks, the preview rows and the review branch. `protocol.ts` stays import-free.
- [ ] **Step 4: Run** the three files, then `npm run test:logic` and `npx tsc --noEmit -p .`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Review and confirm Long and Short against the server, accepted at once and taken back on failure`.

### Task 7: Sidebar rows and PnL page (spec §8 Positions in the sidebar, PnL page)

**Files:**
- Modify: `components/wallet-data.ts` (`Position` becomes `LivePredictionPosition | LivePerpPosition`, helpers `positionTitle`, `positionDetail`, `liveValue`, status text), `components/position-row.tsx`, `components/position-row.module.css`, `components/wallet-sidebar.tsx`, `components/pnl/use-activity.ts`, `components/pnl/balance-card.tsx`, `components/history-entries.ts`, `lib/trade/activity.ts` (the `perp_open` and `perp_close` kinds count as trades, not deposits)
- Test: `e2e/perp-positions.logic.spec.ts`, `e2e/pnl.spec.ts` (the browser project; extended in Task 8)

**Interfaces:**
- Consumes: Task 6 `perps` state; `useAccount().closePerp`.
- Produces, `LivePerpPosition` view helpers: title "Long BTC at 5x"; detail "$500 position, entry $65,000, liquidates near $52,400" (the liquidation price is Hyperliquid's own `liquidationPx`, omitted when null); worth = collateral + unrealized PnL from the live mark including `cumFunding`; PnL tone gain or loss as for predictions; states pending, open, closing, "Closed", "Liquidated"; settled rows stay 7 days. The hover close button is disabled with the reason while the open is pending or a close is in flight.
- The PnL feed: real rows for open, close with realized PnL and liquidation, replacing the mock Long/Short rows for a signed-in person; the balance chart treats money in an open position as part of the balance until it closes.

- [ ] **Step 1: Write the failing tests.**
    - `perp-positions.logic.spec.ts`: `"a long shows 'Long BTC at 5x' and the entry and liquidation detail"`; `"worth is collateral plus unrealized PnL and flips tone at zero"`; `"a null liquidationPx is left out of the detail"`; `"a pending position's close button is disabled"`; `"closing shows the closing state, then Closed, and the row leaves after 7 days"`; `"a liquidated position shows Liquidated"`; `"a too-small position shows 'Too small to close right now.'"`.
    - PnL: `"opening a position does not show as a drop in the balance chart"`; `"perp_open and perp_close ledger rows are trades, not deposits"`; `"a liquidation appears in the feed"`.
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/perp-positions.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the union, the row rendering, the close wiring and the activity rows.
- [ ] **Step 4: Run** the file, then `npm run test:logic` and `npx tsc --noEmit -p .`. Expected: pass. The browser `pnl.spec.ts` additions run in Task 8.
- [ ] **Step 5: Commit.** Message: `Show Hyperliquid positions in the sidebar and the PnL feed`.

### Task 8: Browser tests against the fake (spec §9 Browser)

**Files:**
- Modify: `server/test/e2e/serve.ts` (start `startFakeHyperliquid()`, set `HYPERLIQUID_API_URL`, `PERPS_TRADING`, and add control routes: `perp/mark`, `perp/next-order`, `perp/liquidate`, `perp/fail-usdsend`), `e2e/backend.ts` (client helpers for those controls), `playwright.config.ts` only if the isolated ports need a pass-through (3650/4650/4651 come from the existing env)
- Create: `e2e/perps.spec.ts`, `e2e/perps.ts` (helpers in the style of `e2e/polymarket.ts`)
- Test: the new spec, plus the additions to `e2e/pnl.spec.ts` from Task 7

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces: no new code API; test helpers `openPerp(page, o)`, `perpControl.holdNext()`, `perpControl.rejectNext(msg)`, `perpControl.liquidate(asset)`.

- [ ] **Step 1: Write the tests** (all against the fake, in an isolated copy on 3650/4650/4651).
    - `"Long and Short review shows the quote rows and a liquidation price"`.
    - `"confirm lowers the balance and adds the position at once while the fake holds the order"`.
    - `"the real fill replaces the numbers in place"`.
    - `"a rejection removes the position and shows the message"`.
    - `"a reload while held keeps the position"`.
    - `"close raises the balance at once and restores the position when the fake rejects it"`.
    - `"a liquidation shows Liquidated in the sidebar and the PnL feed"`.
    - `"Review is blocked with trading off, and with a position already open on that asset"`.
- [ ] **Step 2: Run and watch them fail** (isolated copy only): `npx playwright test e2e/perps.spec.ts` with `E2E_PORT=3650 E2E_API_PORT=4650 E2E_CONTROL_PORT=4651`. Expected: FAIL (no controls).
- [ ] **Step 3: Add** the backend wiring and helpers until the specs pass.
- [ ] **Step 4: Run** the spec, `e2e/pnl.spec.ts`, `e2e/predictions.spec.ts` (no regression) from the isolated copy, then `npm run test:logic`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Test Long and Short end to end against a fake Hyperliquid`.

### Task 9: Reconciliation, the rebalancing script and the testnet check script (spec §6, §9 Testnet)

**Files:**
- Create: `server/src/perps/reconciler.ts`, `server/scripts/perps-rebalance.ts`, `server/scripts/perps-check.ts`
- Modify: `server/src/server.ts` (start the reconciler every 10 minutes), `server/README.md` (the operator steps, one short section)
- Test: `server/test/integration/perp-reconciler.test.ts`, `server/test/unit/perps-rebalance.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5; `keyring.operator()`; the withdrawals' free-balance rule from `server/src/withdrawals/withdrawals.ts`.
- Produces, `PerpReconciler.run(): Promise<ReconcileReport>` with `ReconcileReport = { mismatches: number; swept: number; shortfallE6: bigint; activationE6: bigint; ourFeeE6: bigint }`; logs errors only, never changes a position or a ledger:
    - per position, the address's real size and side must match the open record;
    - per person, an address with no open position and more than $1 free is swept to the master, logged, not credited;
    - solvency: assets (Arc treasury + unswept deposit addresses + master account value + each person's account value + in-flight `perpRebalances`) against liabilities (ledger balances + `heldE6`); a shortfall over `PERPS_RECONCILE_TOLERANCE_USD` is an error log, a surplus is not;
    - one log line sums activation cost and our fee.
- Produces, `perps-rebalance.ts`: `arc-to-hl <amount>` (approve, then `depositForBurnWithHook` on Arc's `TokenMessengerV2` to domain 19 with `hookData` naming the master's HyperCore address and perps dex; writes a `perpRebalances` row `sent`; forwarding fee fetched from Circle's fee API at run time) and `hl-to-arc <amount>` (signed `sendAsset` from the master to the USDC system address with forwarding data for domain 26; the HyperEVM burn route is documented as the fallback, not built). Pure helpers exported for tests: `planRebalance(o: { direction; amountE6: bigint; treasuryFreeE6: bigint; withdrawalNeedE6: bigint }): { ok: true } | { ok: false; reason: string }` (refuses to leave the treasury below the withdrawals' free-balance need) and `buildHookData(master: string): Hex`.
- Produces, `perps-check.ts`: runs the full path (fund, open, close, sweep) on testnet with a throwaway mnemonic through the real adapter; refuses to run unless `HYPERLIQUID_API_URL` is the testnet URL (via `server/scripts/live-check-guards.ts`'s pattern) and prints each open question's observed answer (activation payer, `usdSend` fee, account mode, reduce-only minimum, margin basis, liquidation formula against `liquidationPx`, REST `liquidation` field, duplicate nonce). It is never run by the tests or by this plan.

- [ ] **Step 1: Write the failing tests.**
    - `perp-reconciler.test.ts`: `"a size mismatch is logged and nothing changes"`; `"a stuck balance over $1 on an idle address is swept to the master and not credited"`; `"a solvency shortfall over the tolerance logs an error, one under it doesn't"`; `"a surplus logs nothing"`; `"in-flight rebalances count as assets"`; `"the activation and fee totals are in the summary line"`.
    - `perps-rebalance.test.ts`: `"planRebalance refuses to leave the treasury below the withdrawal need"`; `"buildHookData names the master address"`; `"the script refuses a mainnet URL for perps-check"` (guard only).
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/perp-reconciler.test.ts test/unit/perps-rebalance.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the reconciler, the two scripts (neither is imported by the server) and the README section.
- [ ] **Step 4: Run** both files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Reconcile the Hyperliquid float, and add the operator's rebalance and testnet check scripts`.

---

## After Task 9 (the owner's, not tasks)

Spec §9 Testnet and live check, in order: `PERPS_TRADING=off` ships first; `perps-check.ts` on testnet; mainnet with a $20 float (open and close $10 BTC, one $5 rebalance each way, liquidation formula comparison); then `PERPS_TRADING=on`. The terms and US-person question is a launch blocker.

## Self-review notes

- Spec coverage: §1 Task 1; §2 Tasks 3 and 4; §3 Tasks 1, 4, 5; §4 Tasks 4 and 5; §5 Task 5; §6 Tasks 4 and 9; §7 Tasks 4, 5, 6; §8 Tasks 3, 6, 7; §9 Tasks 2, 8 and each task's tests; §10 phases 1 to 4 are Tasks 1 to 9, phase 5 is the owner's. Spec open questions 1 to 15 are carried, not resolved; the fake has a switch for question 1 and `perps-check.ts` reports 1 to 10.
- Rate check: `l2Book` for each quote weighs 2; the 10 s quote refresh across viewers stays inside the 1200 a minute budget only with the market sync shared; the plan keeps one sync (Task 3) and quotes read the book per request.
