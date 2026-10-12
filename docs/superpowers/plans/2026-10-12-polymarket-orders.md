# Polymarket Orders Implementation Plan (phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirming a prediction places a real fill-or-kill order on Polymarket from the pooled account. The app accepts it at once, the server settles it exactly once against the person's Arc balance, and a failure rolls back in the app with one message.

**Architecture:**

- **Trader seam.** A `PoolTrader` interface hides Polymarket's SDK (`@polymarket/client` 0.13.0). Production uses an SDK adapter. Tests use an in-process `FakeTrader`, injected through `Overrides.trader` the way bridges are.
- **Server order flow.** `PredictionService`:
    - holds the money (an order row plus a guarded debit, in one transaction)
    - acks
    - then signs, saves the order hash, posts, and settles each order by one conditional state move in a transaction
- **Tracker.** `PredictionTracker` settles posted orders whose outcome is late or unclear.
- **Client.** The client keeps a requestId-keyed optimistic list on top of the server balance. Server pushes replace entries; failures drop them and show one line in the sidebar's status.

**Tech Stack:** Node 24 + Express 5 + socket.io 4.8 + MongoDB 7 transactions + zod 4 + viem 2.56 (server), `@polymarket/client` 0.13.0 pinned exactly, vitest; Next.js 16 + React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-polymarket-predictions-design.md`, section 2, plus the parts of Errors and Testing about orders. Research notes are in `.superpowers/sdd/polymarket-phase-2-3-research/`: `sdk.md`, `polymarket-api.md`, `server-map.md` and `client-map.md`. Read the one your task points to.

## Global Constraints

- **Commits and test runs:**
    - Commit by path (`git commit -- <paths>`), with no `Co-Authored-By` trailer. Never `git add -A`, stash, or reset other files.
    - Leave `.impeccable/hook.cache.json` alone.
    - Don't touch `server/src/crosschain/*` or the deposit UI pieces of `components/wallet-sidebar.tsx` (`WalletSection`, `DepositButton`, `DepositForm`, `DepositCoins`, `DepositProgress`). Task 7's one-line status-line edit is the only exception.
    - Run browser tests only from an isolated copy (`git archive HEAD | tar -x -C <dir>`, then `cp -cR node_modules` and `server/node_modules`) with `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641`. Server tests run with `cd server && npm test`. Logic tests run with `LOGIC_ONLY=1 npx playwright test --project=logic`.
    - Comments: only a non-obvious why, one line each, no change narration. Formatting: `npx prettier --check` must pass on every changed file.
- **Peer invariants (other sessions depend on these):**
    - **Deposit credits:** they stay keyed once per `(chainId, txHash, logIndex)`, and the Arc watcher and report path stay the only deposit-credit path. Prediction money uses new ledger methods, never `Ledger.credit`.
    - **Account merge:** `migrations.ts` keeps re-pointing `depositOrders`.
    - **Account client:** `account-client.ts` keeps the order reducer's stale-update guard and `#dropBalance` after a send. `useAccount().history` stays deposits only, keeping its shape plus `origin`.
    - **Push order:** pushes for one account go through `sockets.ts`'s per-account chain (`pushing`), in bus order. Prediction pushes use the same chain.
    - **Imports:** `protocol.ts` stays import-free.
    - **Review panel:** `review-panel.tsx` must not call `confirmedTrades.add` for a real prediction order. The simulated path, with its copy "Trading isn't live yet, so nothing was sent." and the JSON `pre`, stays exactly as it is for other verbs and while trading is off.
    - **Positions list:** keep `PREDICTION_MARKETS` mock IDs and `MOCK_POSITIONS`. The sidebar list keeps `aria-label="Open positions"` and the close label `Close <name>`.
- **Money:**
    - The ledger counts Arc USDC in 18-decimal wei. Polymarket pUSD and shares are 6-decimal integers ("e6"), as bigint, never floats.
    - wei = e6 × 10¹². Converting wei to e6 floors.
    - The fee is rounded up to the next e6 unit, and a refund is floored, so the pool never loses money to rounding. Nobody is ever off by more than one e6 unit.
    - Every balance change writes exactly one ledger row in the same transaction. `account.version` bumps on every change. Bus events are emitted only after commit.
- **Order rules from the spec:**
    - **Order type:** fill-or-kill. Pass `orderType: OrderType.FOK` explicitly; the SDK defaults to FAK.
    - **Buy:** `amount = maxSpend = the person's amount`, so fees are included.
    - **Price limit:** `maxPrice = quotedPrice + 0.02`, clamped to `1 − tickSize` and rounded **up** to the tick. Rounding up can only widen the limit by less than one tick.
    - **Minimum:** the amount must be at least the outcome's `minUSD`.
    - **Rate limits:** orders 10 per minute per person (limiter key prefix `prediction`), quotes 60 per minute (`prediction-quote`).
    - **Request ID:** a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). A repeated `(accountId, requestId)` is the same order.
    - **Float:** free float = the pool's pUSD balance − the amounts of unsettled buy orders. `maxOrderUSD = floor(free float in USD)` while trading is live and the trader is ready, else `null`. Warnings are logged under 25% and over 200% of `POLYMARKET_FLOAT_USD` (default 100).
    - **Trading switch:** `PREDICTIONS_TRADING` is `on|off`, default `off`. While off (or while the trader isn't ready), `maxOrderUSD` is `null`, the client keeps the simulated Review, and `prediction:order` answers `trading_off`.
- **Copy, verbatim** (server `AppError` messages and the client's rollback lines):
    - insufficient balance: "You don't have enough USDC for this. Nothing was spent."
    - market closed: "This market just closed. Nothing was spent."
    - float short: `Predictions are limited to ${X} right now. Nothing was spent.`, where `X` is `formatUsdShort(maxOrderUSD)`
    - trading off: "Predictions aren't live yet. Nothing was spent."
    - below minimum: `The minimum for this prediction is ${X}.`
    - **Push failure reasons:**
        - `price_moved`: "The price moved, so your prediction didn't go through. Nothing was spent."
        - `market_closed`: the market-closed line
        - `unavailable`: "Polymarket isn't answering. Nothing was spent."
        - `rejected`: "Your prediction didn't go through. Nothing was spent."
    - Client offline at confirm: "You're offline. Nothing was spent."
    - Amount bound over the limit: message `Predictions are limited to ${X} right now.`, button text "Over the limit".
    - Review done line for a live prediction: "Prediction placed." No JSON.

## Review Focus

1. **Two orders from one person, sent at once, that together exceed their balance.** One is refused with the insufficient-balance line. The balance never goes negative, and the ledger sum still equals the balance. Test in Task 1 (concurrent debits) and Task 5 (concurrent socket orders).
2. **The server dies between the debit and the post, or between the post and the settle.** A `placing` order is refunded once at startup. A `posted` order is settled by the tracker. Nothing is refunded twice, and nothing is both filled and refunded. Test in Task 4.
3. **A retried `prediction:order` with the same `requestId`** (a network retry). One order, one debit, and the same view back. Test in Task 4.
4. **A fill that costs less than the amount** (fees, 2-decimal quantization). The unspent part is refunded; the refund is never above the amount, and the ledger sum still equals the balance. Test in Task 4.
5. **A reload or reconnect while an order is in flight.** The order stays shown from the `positions` push. The balance drops once, never twice. Test in Task 6 (reducer) and Task 7 (browser).

---

### Task 1: Prediction money in the ledger

**Files:**

- Modify:
    - `server/src/db/money.ts`
    - `server/src/db/mongo.ts`
    - `server/src/db/migrations.ts`
    - `server/src/deposits/ledger.ts`
- Test:
    - `server/test/unit/money.test.ts`
    - `server/test/integration/prediction-ledger.test.ts` (new)
    - `server/test/integration/migration.test.ts`

**Interfaces:**

- Produces, in `money.ts`:
    - `E6_TO_WEI = 10n ** 12n`
    - `e6ToWei(e6: bigint): bigint`
    - `weiToE6(wei: bigint): bigint`, which floors
    - `formatE6(e6: bigint): string`, a decimal with up to 6 places and no trailing zeros
- Produces, in `mongo.ts`:
    - `LedgerEntryDoc.kind` gains `"prediction_buy" | "prediction_refund" | "prediction_sell" | "prediction_payout"`.
    - New types:
        ```ts
        type PredictionOrderState = "placing" | "posted" | "filled" | "failed";
        type PredictionFailure = "price_moved" | "market_closed" | "unavailable" | "rejected";
        type PredictionOrderDoc = {
            _id: ObjectId;
            accountId: ObjectId;
            requestId: string;
            side: "buy" | "sell";
            eventId: string;
            marketId: string;
            tokenId: string;
            conditionId: string;
            question: string;
            outcome: string;
            amount: Decimal128 /* wei held, buy */;
            shares: Decimal128 | null /* e6, sell */;
            quotedPrice: number;
            limitPrice: number;
            positionId: ObjectId | null;
            orderHash: string | null;
            clobOrderId: string | null;
            signed: unknown | null;
            state: PredictionOrderState;
            reason: PredictionFailure | null;
            filledShares: Decimal128 | null /* e6 */;
            cost: Decimal128 | null /* wei */;
            postedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
        };
        type PositionState = "open" | "closing" | "closed" | "won" | "lost";
        type PositionDoc = {
            _id: ObjectId;
            accountId: ObjectId;
            eventId: string;
            marketId: string;
            tokenId: string;
            conditionId: string;
            question: string;
            outcome: string;
            shares: Decimal128 /* e6 */;
            cost: Decimal128 /* wei */;
            state: PositionState;
            proceeds: Decimal128 | null;
            payout: Decimal128 | null;
            openedAt: Date;
            settledAt: Date | null;
            updatedAt: Date;
        };
        ```
    - `Collections` gains `predictionOrders` (collection `prediction_orders`) and `positions` (collection `positions`).
    - Indexes:
        - `prediction_orders.request_unique {accountId:1, requestId:1}`, unique
        - `prediction_orders.state_updated {state:1, updatedAt:1}`
        - `prediction_orders.account_orders {accountId:1, _id:-1}`
        - `positions.open_unique {accountId:1, tokenId:1}`, unique with `partialFilterExpression: { state: { $in: ["open", "closing"] } }`
        - `positions.account_positions {accountId:1, _id:-1}`
        - `positions.state_market {state:1, marketId:1}`
- Produces, in `ledger.ts` (new methods on `Ledger`; `credit` is unchanged). Each runs inside a caller-provided `session`, so the caller owns the transaction and the conditional state move:
    - `debitInSession(session, accountId, wei, kind: "prediction_buy", refId): Promise<AccountDoc>`. It throws `AppError("insufficient_funds", <copy>)` when `balance < wei`, using `findOneAndUpdate({_id, balance: {$gte: toDecimal(wei)}}, {$inc: {balance: toDecimal(-wei), version: 1}, $set: {updatedAt}})`.
    - `creditInSession(session, accountId, wei, kind: "prediction_refund" | "prediction_sell" | "prediction_payout", refId): Promise<AccountDoc>`
    - `runInTransaction<T>(work: (session) => Promise<T>): Promise<T>`, using the existing `client.withSession(... withTransaction)` pattern
- `mergeInto` also moves `predictionOrders` and `positions` to the surviving account inside its transaction. When both accounts hold an open position on the same token, it sums `shares` and `cost` into the survivor's position and marks the other `closed` with `proceeds: 0`. The merge must never throw on that collision.
- `protocol.ts` and `errors.ts` gain these error codes and their statuses:
    - `insufficient_funds` (409)
    - `market_closed` (409)
    - `float_short` (409)
    - `trading_off` (503)

    `test/unit/errors.test.ts` covers them.

- [ ] **Step 1: Write the failing tests.**
    - Unit:
        - `e6ToWei(1_500_000n) === 1_500_000n * 10n**12n`
        - `weiToE6` floors (`weiToE6(1_999_999_999_999n) === 1n`)
        - `formatE6(1_234_500n) === "1.2345"`
    - Integration (Mongo harness; seed an account like `server/test/e2e/serve.ts` `/seed` does):
        - `"a debit takes the balance down and writes one prediction_buy row"`
        - `"a debit larger than the balance throws insufficient_funds and changes nothing"`
        - `"two concurrent debits that together exceed the balance: exactly one succeeds"`: `Promise.allSettled` of two transactions. The balance is never negative, and the ledger sum equals the balance.
        - `"a second credit of the same kind and refId is rejected by ref_unique"`
    - Migration:
        - `"merging moves prediction orders and positions"`
        - `"merging two open positions on one token sums them instead of failing"`
- [ ] **Step 2: Run and confirm they fail.** Run: `cd server && npx vitest run test/unit/money.test.ts test/integration/prediction-ledger.test.ts test/integration/migration.test.ts`. Expected: FAIL (missing exports and kinds).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the three files, then `cd server && npm test` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with "Hold and return prediction money in the ledger".

### Task 2: The trader seam, quote math and the fake trader

**Files:**

- Create:
    - `server/src/predictions/trader.ts`: the interface and types only
    - `server/src/predictions/pricing.ts`: pure math
    - `server/test/support/fake-trader.ts`
- Test: `server/test/unit/prediction-pricing.test.ts`

**Interfaces:**

- Produces, in `trader.ts`:
    ```ts
    export type Level = { price: number; size: number }; // size in shares
    export type Book = { bids: Level[]; asks: Level[]; tickSize: number; minOrderSize: number; negRisk: boolean }; // best first
    export type MarketMeta = {
        conditionId: string;
        negRisk: boolean;
        tickSize: number;
        feeRate: number;
        feeExponent: number;
    };
    export type SignedRecord = { orderHash: string; signed: unknown }; // signed = the SDK SignedOrder as plain JSON
    export type PostResult =
        | { kind: "filled"; orderId: string; makingE6: bigint; takingE6: bigint } // buy: making = pUSD, taking = shares
        | { kind: "delayed"; orderId: string }
        | { kind: "rejected"; reason: "price_moved" | "market_closed" | "unavailable" | "rejected"; message: string }
        | { kind: "unknown" }; // timeout or transport error after sending
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
    ```
- Produces, in `pricing.ts` (all pure, no I/O):
    - `feeE6(sharesE6: bigint, price: number, meta: Pick<MarketMeta,"feeRate"|"feeExponent">): bigint`. It computes `shares × rate × (p(1−p))^exp` and rounds **up** to e6.
    - `quoteBuy(book: Book, meta, spendE6: bigint): { sharesE6: bigint; costE6: bigint; feeE6: bigint; avgPrice: number; worstPrice: number } | null`. It walks the asks best-first until `cost + fee` reaches `spendE6`, and returns `null` when the book can't fill it.
    - `quoteSell(book, meta, sharesE6): { proceedsE6: bigint; feeE6: bigint; avgPrice: number; worstPrice: number } | null`. It walks the bids, and proceeds are net of fee.
    - `limitBuyPrice(quotedPrice: number, tickSize: number): number` and `limitSellPrice(quotedPrice: number, tickSize: number): number`. These are ±0.02, clamped to `[tick, 1 − tick]`, rounded away from the quote onto the tick grid, with integer math on 1e6-scaled values.
    - `costOfFill(makingE6: bigint, takingE6: bigint, meta): bigint`: `making + feeE6(taking, making/taking, meta)`.
- Produces, in `fake-trader.ts`, a class `FakeTrader implements PoolTrader`:
    - `constructor({ bookOf: (tokenId) => Book, balanceE6?: bigint })`
    - Default behavior: fill a buy at the book (via `quoteBuy`) and lower `balanceE6`; fill a sell via `quoteSell` and raise it.
    - Controls: `setBalance(e6)`, `onNext(tokenId, behavior)` where `behavior` is `"fill" | "reject:price_moved" | "reject:market_closed" | "reject:rejected" | "delay" | "unknown" | "hold"`. `hold` keeps the post pending until `release(tokenId, "fill"|"reject:price_moved"|...)`.
    - `settleDelayed(orderHash, "fill"|"cancel")` decides what a later `lookup` returns.
    - `posts`, a log of what was posted.
    - `failSign(tokenId)`, which makes the next sign throw.
    - The order hash is `0x` + a counter.

- [ ] **Step 1: Write the failing unit tests:**
    - `feeE6` matches the spec's example: 100 shares at 0.5, rate 0.07, exponent 1 gives 1.75 pUSD.
    - `quoteBuy` across two levels gives the right average and worst price; a thin book gives `null`.
    - `quoteSell` is net of fee.
    - Limit prices: 0.55 + 0.02 on tick 0.01 → 0.57; 0.985 + 0.02 → 0.99 (`1 − tick`); tick 0.001 rounds up correctly; the sell side mirrors it, with a floor at `tick`.
    - `costOfFill` never exceeds `making + fee`, and is exact on a cent fill.
- [ ] **Step 2: Run and confirm they fail.** Run: `cd server && npx vitest run test/unit/prediction-pricing.test.ts`.
- [ ] **Step 3: Implement** `trader.ts`, `pricing.ts` and `FakeTrader`.
- [ ] **Step 4: Run** the file, then `npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit** with "Price prediction orders and fake the pool's trader".

### Task 3: The Polymarket adapter, config and setup script

**Files:**

- Modify:
    - `server/package.json` and lockfile: add `@polymarket/client` at exactly `0.13.0`
    - `server/src/config.ts`
    - `server/.env.example`
- Create:
    - `server/src/predictions/polymarket-trader.ts`
    - `server/scripts/polymarket-setup.ts`
    - `server/test/support/fake-clob.ts`
- Test:
    - `server/test/integration/polymarket-trader.test.ts`
    - `server/test/unit/config.test.ts`

**Interfaces:**

- Consumes `PoolTrader` and its types (Task 2). Read `.superpowers/sdd/polymarket-phase-2-3-research/sdk.md`, sections 1–4, 7, 9 and 10.
- Config (zod, following the file's conventions):

    | Variable                                               | Type                       | Default                             |
    | ------------------------------------------------------ | -------------------------- | ----------------------------------- |
    | `PREDICTIONS_TRADING`                                  | `on` / `off`               | `off`                               |
    | `POLYMARKET_POOL_KEY`                                  | `optionalKey`, 0x + 64 hex |                                     |
    | `POLYMARKET_BUILDER_API_KEY`, `_SECRET`, `_PASSPHRASE` | `optionalKey`              |                                     |
    | `POLYMARKET_BUILDER_CODE`                              | optional, 0x + 64 hex      |                                     |
    | `POLYMARKET_DEPOSIT_WALLET`                            | optional address           |                                     |
    | `POLYGON_RPC_URL`                                      | url                        | `https://polygon.drpc.org`          |
    | `POLYMARKET_RELAYER_URL`                               | url                        | `https://relayer-v2.polymarket.com` |
    | `POLYMARKET_DATA_URL`                                  | url                        | `https://data-api.polymarket.com`   |
    | `POLYMARKET_FLOAT_USD`                                 | positive number            | 100                                 |
    | `PREDICTIONS_POLL_MS`                                  | int                        | 2000                                |
    - With `PREDICTIONS_TRADING=on`, `loadConfig` requires the pool key and all three builder secrets, and names each one missing.
    - `.env.example` gets a "Prediction trading" section, one comment line per variable. Its notes:
        - fund the printed wallet with pUSD
        - Polymarket's Collateral Onramp wraps USDC.e, not native USDC
        - host the server outside Polymarket's restricted regions
        - call Polymarket directly, with no proxies

- Produces `createPolymarketTrader(config, logger): Promise<PoolTrader & { wallet: string }>`:
    - **Client.** `createSecureClient({ signer: hashingSigner(privateKey signer), wallet?, apiKey: builderApiKey(...), environment: forkEnvironmentConfig({ name: "app", rpc: POLYGON_RPC_URL, clob: {rest: POLYMARKET_CLOB_URL}, relayer: {rest: POLYMARKET_RELAYER_URL}, gamma: {rest: POLYMARKET_GAMMA_URL}, data: {rest: POLYMARKET_DATA_URL} }) })`.
    - **Hashing signer.** `hashingSigner` wraps the signer. When `signTypedData` sees `primaryType === "TypedDataSign"`, it computes `hashTypedData({ domain: payload.domain, types: { Order: payload.types.Order }, primaryType: "Order", message: payload.message.contents })` into an `AsyncLocalStorage` capture set by `signBuy`/`signSell`.
    - **`signBuy`.** It calls `createMarketOrder({ assetId, side: BUY, orderType: OrderType.FOK, amount, maxSpend: amount, maxPrice, builderCode? })` with `amount` as a 2-decimal USD string, and returns `{ orderHash, signed }`. `signSell` is the same with `shares` and `minPrice`.
    - **`post`.** It calls `postOrder`. It maps `{ok:true,status:"matched"}` to `filled`, with `making` and `taking` parsed from decimal strings to e6. `delayed` maps to `delayed`.
    - **Rejections.** Both `{ok:false, code}` and a thrown `RequestRejectedError` whose message matches the same texts map to `rejected`:
        - `fok_not_filled` or `fak_not_filled` gives `price_moved`
        - `market_not_ready` gives `market_closed`
        - `insufficient_balance_or_allowance` gives `unavailable`
        - anything else gives `rejected`
    - **Unknown outcome.** A `TransportError`, `TimeoutError` or 5xx gives `unknown`.
    - **`lookup`.** It calls `fetchOrder({orderId: clobOrderId ?? orderHash})`, comparing case-insensitively:
        - status `MATCHED`, or `sizeMatched === originalSize`, gives `filled`, with amounts from `sizeMatched × price`
        - `LIVE` or `DELAYED` gives `open`
        - `CANCELED*` or `INVALID` gives `cancelled`
        - a 404 or 400 gives `missing`
    - **`balanceE6`.** It calls `fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL })` and parses with `BigInt(balance)`.
    - **`book` and `meta`.** These come from `fetchOrderBook` (reversed to best-first) and `fetchMarketInfo(resolveConditionByToken)`.
- `server/test/support/fake-clob.ts` is a `node:http` server covering the endpoints in `sdk.md` §9 that these calls hit:
    - auth: api-key, derive and validate
    - relayer `/deployed`
    - `/book`
    - `/markets-by-token`
    - `/clob-markets`
    - `/balance-allowance`
    - `POST /order`
    - `/data/order/:id`

    Its controls set the next post's response, either as a JSON body or as an HTTP status with a body.

- `scripts/polymarket-setup.ts` loads the config and runs `createSecureClient` (which deploys the deposit wallet), `setupTradingApprovals()`, and `updateBalanceAllowance(COLLATERAL)`. It prints the wallet address and its pUSD balance, and never prints secrets.

- [ ] **Step 1: Write the failing tests.**
    - Config:
        - `"trading defaults to off"`
        - `"trading on without the pool key or builder secrets names each missing one"`
    - Adapter, against `fake-clob` (pool key = a fresh `generatePrivateKey()`):
        - `"signBuy returns the order hash the signer saw, and posting a matched answer gives filled with e6 amounts"`
        - `"an ok:false fok_not_filled and an HTTP 400 with the FOK text both give price_moved"`
        - `"a post that times out gives unknown"`: the fake holds the response past a short ky timeout. If you can't make ky time out quickly, stop the fake mid-request.
        - `"lookup maps MATCHED, LIVE, CANCELED and 404"`
        - `"balanceE6 parses the e6 balance"`
        - `"the order's maxPrice is on the tick and orderType is FOK"`: inspect the posted body.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** If the SDK needs an endpoint the fake lacks, add it to the fake rather than working around the SDK.
- [ ] **Step 4: Run** the files, then `cd server && npm test` and `npx tsc --noEmit`. Expected: pass, with no test reaching a public host.
- [ ] **Step 5: Commit** with "Trade on Polymarket through its SDK, behind the pool trader".

### Task 4: Placing and settling an order

**Files:**

- Create:
    - `server/src/predictions/predictions.ts` (`PredictionService`)
    - `server/src/predictions/tracker.ts` (`PredictionTracker`)
    - `server/src/predictions/views.ts`
- Modify:
    - `server/src/markets/markets.ts`: an `outcome(eventId, tokenId)` accessor, and `maxOrderUSD` from a dependency
    - `server/src/events.ts`: `"prediction:updated"`
    - `server/src/protocol.ts`: the views below
- Test:
    - `server/test/integration/predictions.test.ts`
    - `server/test/integration/prediction-tracker.test.ts`

**Interfaces:**

- Consumes the ledger methods (Task 1) and `PoolTrader`, the pricing functions and `FakeTrader` (Task 2).
- `MarketService` changes:
    - New: `outcome(eventId: string, tokenId: string): Promise<{ outcome: MarketOutcomeView; marketId: string; question: string } | null>`. It goes through `event(eventId)`, so it's at most 5 s fresh, and finds the raw market whose `clobTokenIds` contains `tokenId`. The `question` is the event title.
    - Its constructor takes an optional `maxOrderUSD: () => number | null`, which `trending()` uses (default `() => null`).
- Types added to `protocol.ts` (strings for money; `UsdcAmount` is the existing decimal string):
    ```ts
    export type PredictionFailure = "price_moved" | "market_closed" | "unavailable" | "rejected";
    export type PredictionOrderView = {
        id: string;
        requestId: string;
        side: "buy" | "sell";
        state: "placing" | "posted" | "filled" | "failed";
        reason: PredictionFailure | null;
        eventId: string;
        tokenId: string;
        question: string;
        outcome: string;
        amountUSD: UsdcAmount | null;
        shares: string | null;
        positionId: string | null;
        createdAt: string;
        updatedAt: string;
    };
    export type PositionView = {
        id: string;
        eventId: string;
        marketId: string;
        tokenId: string;
        question: string;
        outcome: string;
        shares: string;
        costUSD: UsdcAmount;
        state: "open" | "closing" | "closed" | "won" | "lost";
        proceedsUSD: UsdcAmount | null;
        payoutUSD: UsdcAmount | null;
        openedAt: string;
        settledAt: string | null;
        updatedAt: string;
    };
    export type PositionsView = { positions: PositionView[]; orders: PredictionOrderView[] };
    export type QuoteView = {
        eventId: string;
        tokenId: string;
        side: "buy";
        amountUSD: UsdcAmount;
        shares: string;
        avgPrice: number;
        worstPrice: number;
        feeUSD: UsdcAmount;
        payoutUSD: UsdcAmount;
        minUSD: number;
    };
    export type PredictionUpdate = {
        requestId: string;
        order: PredictionOrderView;
        position: PositionView | null;
        account: AccountView;
    };
    ```
- `PredictionService`:
    - **Constructor:** `{ collections, ledger, markets: MarketService, trader: () => PoolTrader | null, bus, logger, config, now? }`.
    - **`quote({eventId, tokenId, amountUSD})`:**
        - The outcome is missing → `market_closed`.
        - The amount is under `minUSD` → `below_minimum`.
        - The book can't fill → `price_moved`, with the price-moved copy minus "Nothing was spent".
        - Otherwise it returns a `QuoteView` with `payoutUSD = shares`.
    - **`place(account, input)`**, step by step:
        1. Trading off, or no trader → `trading_off`.
        2. The outcome isn't offered → `market_closed`.
        3. The amount is under `minUSD` → `below_minimum`.
        4. The amount is over the free float → `float_short`.
        5. **Hold.** One transaction inserts the `placing` order (a duplicate `(accountId, requestId)` returns the existing order's view and does nothing else) and debits `prediction_buy`. Insufficient funds abort the transaction.
        6. **Ack.** Return the `placing` view.
        7. **Submit, without awaiting:** `void this.#submit(order)`, and log anything it throws.
    - **`#submit`**, step by step:
        1. Get `meta` and `book`.
        2. Compute `limitPrice = limitBuyPrice(quotedPrice, tick)`.
        3. Call `trader.signBuy`.
        4. Move the order `placing → posted`, setting `orderHash`, `signed` and `postedAt`.
        5. Call `trader.post`.
        6. **Settle by the answer:**
            - `filled` → `#settleFilled`
            - `rejected` → `#settleFailed(reason)`
            - `delayed` or `unknown` → leave it `posted` (the tracker takes over)
    - **A failure before the post** (meta, book or sign throws) → `#settleFailed("unavailable")` from `placing`.
    - **`#settleFilled(order, makingE6, takingE6)`**, in one transaction:
        1. Do the conditional move `{state: "posted"} → "filled"`. Return if nothing moved.
        2. Compute `cost = e6ToWei(costOfFill)`, capped at the held amount.
        3. Compute `refund = held − cost`. If it's above 0, credit it as `prediction_refund`.
        4. Upsert the open position: `$inc` shares by `takingE6` and cost by `cost`, and set its fields on insert.
        5. Set the order's `filledShares`, `cost` and `positionId`.
        6. After commit, emit `prediction:updated {order, position, account}`.
    - **`#settleFailed(order, reason, from: "placing" | "posted")`**, in one transaction: the conditional move to `failed` with `reason`, plus a `prediction_refund` of the full held amount. Then emit after commit.
    - **`recover()`**, called once at startup before listening: every `placing` order → `#settleFailed("unavailable", "placing")`.
    - **`positions(account): Promise<PositionsView>`**: positions in `open` or `closing`, or settled in the last 7 days, plus orders in `placing` or `posted`.
    - **Float:** `maxOrderUSD(): number | null` and `refreshFloat()`. `refreshFloat` sets the cached `balanceE6`, then logs the threshold warnings. It runs every 60 s and after each settle.
- `PredictionTracker`:
    - **Pattern:** the same as `crosschain/tracker.ts` (`start`/`stop`/`tick`, catch everything, injectable `now`). Its loop also refreshes the float every 60 s.
    - **`tick()`** looks up every `posted` order with `trader.lookup`:
        - `filled` → `#settleFilled`, through a public `settle` method on the service
        - `cancelled` → `#settleFailed("price_moved", "posted")`
        - `missing` for more than 2 minutes after `postedAt` → `#settleFailed("unavailable", "posted")`
        - `open` → wait
    - **Backoff:** each order is polled no more often than `PREDICTIONS_POLL_MS`, and once it's older than 10 minutes, every 60 s.

- [ ] **Step 1: Write the failing tests.** These are service-level integration tests with a `FakeTrader` and the Mongo harness; construct the service directly or through `startStack` with `Overrides.trader` (Task 5 wires it, so construct directly here). Assert the ledger sum equals the balance in every test:
    - `"a filled buy debits, records the shares, and refunds the unspent part"`
    - `"an unfilled buy refunds in full and fails with price_moved"`
    - `"the same requestId twice is one order and one debit"`
    - `"a balance that's too low is refused and nothing is written"`
    - `"an amount over the free float is refused with float_short"`
    - `"two concurrent orders can't overdraw"`
    - `"a sign failure fails with unavailable and refunds"`
    - `"recover refunds placing orders once"`: run `recover()` twice; one refund.
    - `"a delayed order is settled by the tracker when it fills"`
    - `"an unknown post that turns up missing after 2 minutes is refunded"`
    - `"filled and refunded never both happen"`: the tracker's tick and the post's answer race on one order, and exactly one settle wins.
    - `"maxOrderUSD is null while trading is off and the free float when on"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files, the server suite and `tsc`. Expected: pass.
- [ ] **Step 5: Commit** with "Place, settle and recover prediction orders exactly once".

### Task 5: Prediction events on the socket, wired into the server

**Files:**

- Modify:
    - `server/src/socket/sockets.ts`
    - `server/src/validation.ts`
    - `server/src/services.ts`
    - `server/src/server.ts` (`Overrides.trader?: PoolTrader`; construct the service and tracker; `recover()` before listen; start the tracker after listen and stop it in `close()`; feed `markets` its `maxOrderUSD`)
    - `server/src/http/app.ts`: `/ready` reports `predictions: "off" | "ready" | "unavailable"`
    - `server/test/support/stack.ts` (a `FakeTrader` over the fake Polymarket's books, exposed as `stack.trader`)
    - `server/test/e2e/serve.ts`
    - `e2e/backend.ts`
- Test: `server/test/integration/prediction-socket.test.ts`

**Interfaces:**

- Consumes `PredictionService` and its types (Task 4).
- **Socket events**, which also go into `protocol.ts`'s event maps:
    - `prediction:quote {eventId, tokenId, amountUSD}` → `QuoteView`, using limiter `prediction-quote` (60/min)
    - `prediction:order {requestId, eventId, tokenId, amountUSD, quotedPrice}` → `PredictionOrderView`, using limiter `prediction` (10/min)
    - Server pushes:
        - `prediction:update` (a `PredictionUpdate`), from the bus event through the existing per-account `pushing` chain, with the same owner check
        - `positions` (a `PositionsView`), sent fire-and-forget after `account:open` succeeds, next to the balances refresh; a failure is only logged
- **Validation** (zod):
    - `requestId`: UUID regex
    - `eventId`: `/^\d{1,12}$/`
    - `tokenId`: `/^\d{1,80}$/`
    - `amountUSD`: decimal with ≤2 places, > 0
    - `quotedPrice`: number in (0, 1)
- **Real trader at startup:**
    - With trading on and no `Overrides.trader`, `startServer` calls `createPolymarketTrader` in the background.
    - Until it resolves, `trader()` returns `null`, `maxOrderUSD` is `null`, and `/ready` says `unavailable`. A failure is retried every 60 s and logged at error level.
- **Test stack** (`stack.ts`) defaults to `PREDICTIONS_TRADING=off`. A test passes `env: { PREDICTIONS_TRADING: "on", POLYMARKET_POOL_KEY, POLYMARKET_BUILDER_API_KEY, … }`, using dummy values, plus the `FakeTrader` override.
- **`serve.ts`** runs with trading **on** and the `FakeTrader`, with a 1 000 000 pUSD balance. New control routes, all POST:
    - `/polymarket/next {tokenId, behavior}`
    - `/polymarket/release {tokenId, behavior}`
    - `/polymarket/balance {usd}`
    - `/polymarket/settle-delayed {tokenId, outcome}`

    `e2e/backend.ts` gains matching wrappers: `nextOrder`, `releaseOrder`, `setPoolBalance` and `settleDelayed`.
    - The e2e tests that need the simulated Review keep working: they use the Swap verb, which stays simulated.
    - Any existing e2e test that confirms a **prediction** and expects "Trading isn't live yet" must switch to the live expectations in Task 7, or use Swap.

- [ ] **Step 1: Write the failing tests** (`stack.socket(user)` and `emitWithAck`):
    - `"prediction:order acks placing and pushes a filled update with the lower balance"`
    - `"a rejected order pushes failed with price_moved and the balance comes back"`
    - `"prediction:order is refused with trading_off when trading is off"`
    - `"bad payloads answer bad_request naming the field"`
    - `"the 11th order in a minute is rate_limited"`
    - `"account:open pushes positions with an in-flight order"`
    - `"pushes for one account arrive in bus order"`: two quick orders; their updates arrive in settle order.
    - `"GET /markets/trending carries maxOrderUSD when trading is on"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server suite, `tsc`, and `node server/test/e2e/serve.ts` from the isolated copy on 4640/4641. Check that `curl -s localhost:4640/markets/trending` shows a numeric `maxOrderUSD`.
- [ ] **Step 5: Commit** with "Take prediction orders over the socket and push their outcome".

### Task 6: Optimistic predictions in the account client

**Files:**

- Modify:
    - `lib/account/state.ts`
    - `components/account-client.ts`
    - `components/account-provider.tsx`
- Test: `e2e/account.logic.spec.ts`, which may also be split into a new `e2e/predictions.logic.spec.ts`

**Interfaces:**

- Consumes the protocol types (Tasks 4–5). Read `.superpowers/sdd/polymarket-phase-2-3-research/client-map.md`, sections 1–2 and 7.
- **The `ready` state** gains:
    - `predictions: { positions: PositionView[]; orders: PredictionOrderView[] }`, from the server
    - `optimistic: OptimisticTrade[]`, client-only, where:

        ```ts
        type OptimisticTrade = {
            requestId: string;
            side: "buy";
            eventId: string;
            tokenId: string;
            question: string;
            outcome: string;
            amountWei: bigint;
            shares: string /* the quote's estimate */;
            at: number;
        };
        ```

- **Actions:**
    - `predict` adds an `OptimisticTrade`.
    - `prediction` (a push) runs `withAccount(update.account)`, upserts the order by `id` (skipping an older `updatedAt`) and the position by `id`, and drops the optimistic entry with that `requestId`.
    - `predict-failed {requestId}` drops the entry.
    - `positions` (on bind) replaces `predictions` and drops optimistic entries whose `requestId` now appears among the server's orders.
    - `session` keeps `optimistic`.
- **`optimisticBalance(state)`** also subtracts `amountWei` for each optimistic buy whose `requestId` isn't among the server's orders. Once the server has the order, its debit is already in `account.balance`, so it isn't subtracted twice.
- **`AccountSnapshot`** gains `tradeNotice: { message: string } | null`. It clears automatically after 8 s, and when the next trade starts.
- **`AccountClient`:**
    - `quote(input): Promise<QuoteView | ApiError>`.
    - `placePrediction(input: { eventId; tokenId; amountUSD; quotedPrice; question; outcome; shares }): { requestId }` is synchronous. It runs these steps in order:
        1. If not `ready` or not connected: set `tradeNotice` to the offline line and return.
        2. Dispatch `predict` with `crypto.randomUUID()`.
        3. Emit `prediction:order` without awaiting, then handle the answer:
            - an `ok:false` ack (any code) → `predict-failed`, with `tradeNotice` set to the server's message
            - a `null` (timeout) → nothing (it stays accepted)
            - `ok` → nothing (the push decides)
    - New listeners:
        - `prediction:update`: dispatch `prediction`. If the order is `failed`, set `tradeNotice` from its `reason` using the Global Constraints copy.
        - `positions`: dispatch `positions`.
    - `disconnect()` clears everything new.
- **`Account`** (`useAccount()`) gains:
    - `predictions`
    - `optimisticTrades`
    - `tradeNotice`
    - `quote`
    - `placePrediction`
    - `dismissTradeNotice`

    Demo and signed-out get safe defaults: empty lists, a `quote` that answers unavailable, and a `placePrediction` that does nothing.

- [ ] **Step 1: Write the failing logic tests** for the reducer and `optimisticBalance`:
    - `"an accepted prediction lowers the balance at once"`
    - `"the server's filled update replaces it without lowering twice"`: the push's account balance already includes the debit.
    - `"a failed update restores the balance"`
    - `"a positions push after a reload keeps the in-flight order and doesn't double-count"`
    - `"an older order update is ignored"`
    - `"session keeps optimistic trades"`
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the logic project, `tsc` and `eslint`. Expected: pass.
- [ ] **Step 5: Commit** with "Hold predictions optimistically in the account client".

### Task 7: Live predictions in the review and the sidebar

**Files:**

- Modify:
    - `components/trade/markets-store.ts`: `maxOrderUSD` in the snapshot, from trending and the cache
    - `components/trade/trade-provider.tsx` and `components/trade/use-trade-sentence.ts`: `ctx.maxOrderUSD`
    - `lib/trade/context.ts`: an optional `maxOrderUSD?: number | null`
    - `lib/trade/operations/prediction.ts`: the bound
    - `lib/trade/prediction-quote.ts` (new): pure quote → preview rows
    - `components/trade/review-panel.tsx`
    - `components/wallet-data.ts`
    - `components/position-row.tsx` (+ its CSS module)
    - `components/wallet-sidebar.tsx`: the positions block, plus the one-line status-line precedence
- Test:
    - `e2e/predictions.spec.ts` (new)
    - `e2e/trade.logic.spec.ts`
    - `e2e/markets.logic.spec.ts`

**Interfaces:**

- Consumes `useAccount()`'s new members (Task 6) and the e2e controls (Task 5).
- **Trading is live** when `ctx.maxOrderUSD` is a number, which means signed in with Privy and the server has trading on. Otherwise everything stays simulated.
- **The amount bound:** `max` = the smaller of `spendCap(ctx)` and a new `predictionCap(ctx)` bound (value `maxOrderUSD`, with the Global Constraints message and button text) when live.
- **`lib/trade/prediction-quote.ts`:** `quoteRows(quote: QuoteView, outcomeLabel: string, binaryOther?: string): PreviewRow[]` returns these rows, in this order:

    | Row                                        | Value                                                           |
    | ------------------------------------------ | --------------------------------------------------------------- |
    | `shares` "You buy" (primary)               | `${shares} shares at ${formatCents(avgPrice)}`                  |
    | `win` `If ${label}` (primary, gain)        | `you get ${formatUsd(payout)} (+${formatUsd(payout − amount)})` |
    | `lose` `If ${other}` or "Otherwise" (loss) | `you lose ${formatUsd(amount)}`                                 |
    | `fee` "Polymarket's fee"                   | `formatUsd(fee)`                                                |
    | `odds` "Market odds"                       | from the outcome's chance, as today                             |

- **Review panel**, for a live prediction (signed in):
    - It asks `account.quote` when it opens, again 300 ms after the amount changes, and every 10 s while open. The quote's rows replace the preview rows while a quote is present.
    - Confirm calls `account.placePrediction({ ..., quotedPrice: quote?.worstPrice ?? outcome.price, shares: quote?.shares ?? estimate })`. It shows the done block with "Prediction placed." at once: no `sending` state, no JSON, no `confirmedTrades.add`.
    - Every other path is unchanged.
- **Sidebar:**
    - **Rows.** Signed-in people see real prediction rows, followed by the mock perps (perps stay mock and their close stays local).
    - **Row types.** `wallet-data.ts` gains a `LivePredictionPosition` (`kind: "prediction-live"`, an arbitrary outcome label, a `pending` flag, `closable: false` and `reason`).
        - A row comes from each optimistic trade, each in-flight order and each `open` position.
        - Its key is the `requestId` while in flight and the position `id` after.
        - Rows for one token merge into the position's row.
        - Pending rows show the quote's shares and `Pending` in place of PnL.
    - **Close.** In this phase it's `aria-disabled` with the reason "Selling opens soon.", tabbable, with the label `Close <outcome> on <question>`. Phase 3 makes it real.
    - **Status line.** The `role="status"` div shows `tradeNotice.message` when it's set, ahead of the deposit text. This is the single coordinated edit inside `WalletSection`: one expression, with a `data-tone="loss"` branch.

- [ ] **Step 1: Write the failing tests.**
    - Logic:
        - `"quoteRows reads the quote"`
        - `"the amount is capped by maxOrderUSD with the limit message when live"`
        - `"maxOrderUSD survives the trending cache"`
    - Browser, in `predictions.spec.ts`:
        - Setup for every test:
            - `mockPrivy`
            - `installWallet`
            - `seedDeposits(address, [{amount:"500", daysAgo:0}])`
            - a different trending question per test, by index from `trendingView()`, so parallel tests never share a token's fake behavior
        - `"a prediction lowers the balance and adds a position at once, while the fake holds the order"`: `nextOrder(token, "hold")`, confirm, and assert at once the balance and the pending row. Then `releaseOrder(token, "fill")` and the row shows the real shares.
        - `"a rejected prediction rolls back with the price-moved line"`: `nextOrder(token, "reject:price_moved")`. The row goes, the balance comes back, and the status line shows the exact copy.
        - `"a prediction in flight survives a reload"`: hold, confirm, reload. The row is still there, the balance dropped once, and releasing fills it.
        - `"offline at confirm says so and spends nothing"`: `page.context().setOffline(true)` after the page has loaded and the socket is up.
        - `"the amount can't exceed the pool's limit"`: `setPoolBalance(20)` before load. Typing 50 shows "Predictions are limited to $20 right now.".
        - `"other verbs stay simulated"`: the existing swap confirm still shows "Trading isn't live yet…".
    - Update any existing spec whose prediction confirm expected the simulated copy.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the logic project, the full browser suite from the isolated copy, `tsc`, `eslint` and Prettier on the changed files. Expected: all pass, including `wallet-sidebar.spec`, `pnl.spec`, `sentence.spec` and `highlights.spec`.
- [ ] **Step 5: Commit** with "Place real predictions from the review, optimistically".
