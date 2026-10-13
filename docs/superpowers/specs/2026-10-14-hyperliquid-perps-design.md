# Hyperliquid perps: design

2026-10-14. Written from the owner's decisions and the research in `.superpowers/research/2026-10-14/` (`hl-accounts.md`, `hl-trading.md`, `arc-hl-funding.md`); this is the written version for review.

## Goal

The Long and Short sentences ("I want to Long 10 USD of BTC with 5x") open and close real perpetual positions on Hyperliquid with the person's Arc balance, from inside the app:

- **Real positions.** Confirming opens a real Hyperliquid position. The person sees its live PnL, closes it when they like, and gets what is left back in their balance.
- **Isolated per person.** Each person trades from their own Hyperliquid account, so one person's liquidation can't touch anyone else's money.

Today `perp` in `lib/trade/operations/perp.ts` builds the sentence and a preview, but `check` returns the `UNAVAILABLE` blocker ("Long and short aren't available yet"), so Review can't confirm.

## Decisions

| Topic                | Decision                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue                | Hyperliquid, the default perp dex only (not HIP-3 dexes).                                                                                                                                      |
| Custody              | One Hyperliquid account per person: an EVM address from our mnemonic on its own derivation path, signed directly by the server. Sub-accounts are out (50 cap, $100k volume gate).              |
| Float                | A USDC float in a master Hyperliquid account (index 0 of the same path). Opening debits the Arc ledger and moves margin master to person inside Hyperliquid. Closing moves what's left back.   |
| Rebalancing          | Arc treasury and master float are balanced in bulk by CCTP with Circle's forwarding (Arc domain 26 and HyperCore via domain 19). An operator script runs it in v1.                              |
| Short float          | New positions are refused up front, like the predictions pool float.                                                                                                                           |
| Margin mode          | Isolated, so the most a person can lose is their collateral. The preview says so.                                                                                                              |
| Positions            | One open position per person and asset. A second Long or Short on the same asset is refused until the first is closed. No adding, no flipping, no partial close.                               |
| Order type           | Immediate-or-cancel limit order at the server's own mark price, plus or minus a slippage cap. Never the client's quote.                                                                        |
| Slippage cap         | `PERPS_SLIPPAGE_BPS` = 100 (1%) to open; `PERPS_CLOSE_SLIPPAGE_BPS` = 300 to close, because a close that fails is worse than a close that fills a little worse.                               |
| Partial fills        | Accepted. The position is what filled; the unused collateral is returned to the balance. Nothing filled is a full refund.                                                                     |
| Minimum              | Collateral at least $10 and position (collateral x leverage) at least $11, so the entry fee and rounding still clear Hyperliquid's $10 order minimum.                                          |
| Leverage bounds      | Per asset: the smaller of Hyperliquid's `maxLeverage` for that asset (from `meta`), the tier allowed by its `marginTables` for the position's size, and `PERPS_MAX_LEVERAGE` (default 20).     |
| Assets               | The catalog's five (BTC, ETH, SOL, LINK, DOGE), kept only while Hyperliquid lists them and allows isolated margin. Their leverage caps now come from the server, not `PERP_MARKETS`.          |
| Activation fee       | The platform absorbs Hyperliquid's 1 USDC for a new account, paid from the master. The person's collateral is not reduced.                                                                    |
| Our fee              | 0 in v1. `PERPS_FEE_BPS` (default 0) is the hook: a share of the position's notional kept from the collateral. People still pay Hyperliquid's own fee, shown in the review.                  |
| Take profit, stop    | None in v1.                                                                                                                                                                                    |
| Tracking             | REST polling plus `userFills` reconciliation. Not websockets: Hyperliquid allows 10 unique users of user-specific subscriptions per IP.                                                        |
| Trades are optimistic | Like predictions: confirming accepts the trade in the app at once, and only a server failure takes it back, with a message.                                                                  |
| Trading switch       | `PERPS_TRADING` = `on` or `off`, off by default. Off: markets and quotes stay live, Review stays blocked.                                                                                      |
| Escalation           | Error logs. No alerting service.                                                                                                                                                               |
| Signing library      | `@nktkas/hyperliquid`, pinned to an exact version, behind our own `HyperliquidClient` interface. It is community-made and pre-1.0 (the only official SDK is Python), so nothing else imports it. |

## Money, in one picture

- **The ledger** counts Arc USDC in 18-decimal wei. Hyperliquid counts USD in 6 decimals. Converting is exact (x 10^12), as with Polymarket's units (`e6ToWei`, `weiToE6` in `server/src/db/money.ts`).
- **Open:** ledger debit, then master to person's address, then the order. The collateral is the amount.
- **Close or liquidation:** whatever is free in the person's Hyperliquid account goes back to the master, and only then is the same amount credited to the ledger. The ledger never credits money the master hasn't received.
- **Fees on the way:** Hyperliquid's taker fee (base tier 0.045%) comes out of the person's collateral. The position is sized so margin plus entry fee equals the collateral (section 3).

## 1. Data

**The person's Hyperliquid address.**

- `Keyring` in `server/src/accounts/keyring.ts` gains `perpSignerAt(index)`: the same mnemonic, path `m/44'/60'/1'/0/index` (viem's `hdKeyToAccount` takes `accountIndex`). The deposit addresses use `m/44'/60'/0'/0/index`, so no perp key can equal a deposit key. Index 0 is the master float account, as index 0 is the Arc treasury.
- Perp indexes come from a new `perpIndex` counter in `counters`, as `#nextIndex` in `server/src/accounts/accounts.ts` does for deposits. Starting at 1.

**New collections** (types in `server/src/db/mongo.ts`):

- `perpAccounts`: `{ _id, accountId, index, address, activatedAt: Date | null, createdAt }`. Unique on `index` and on `address`; non-unique on `accountId`. Created lazily at a person's first order.
- `perpOrders`: one per open or close request.
    - Fields: `{ _id, accountId, requestId, kind: "open" | "close", index, asset, side, leverage, collateral (wei), notionalE6, sizeCoin, cloid, limitPx, state, steps, fill: { sizeCoin, avgPx, feeE6 } | null, credited (wei) | null, reason, createdAt, updatedAt }`.
    - Unique on `(accountId, requestId)`, so a retried request is the same order.
- `perpPositions`: `{ _id, accountId, index, asset, side, leverage, sizeCoin, entryPx, collateral (wei), openedFee, state, proceeds (wei) | null, realizedPnl, closeReason, openedAt, settledAt, updatedAt }`.
    - States: `open`, `closing`, `closed`, `liquidated`.
    - Unique while open on `(index, asset)`.
    - A snapshot of the last poll (`markPx`, `unrealizedPnlE6`, `liquidationPx`, `cumFundingE6`, `at`) is kept on the document for the sidebar.
- `perpFloat`: a single document `_id: "hyperliquid"` shaped like `PoolFloatDoc` (`balanceE6`, `balanceAt`, `heldE6`, `unreadFillsE6`, `updatedAt`). The balance is the master's `withdrawable`. `heldE6` is reserved by orders that haven't moved their margin; it is released exactly once, as in commit d156f8b.
- `perpRebalances`: `{ _id, direction: "arc_to_hl" | "hl_to_arc", amountE6, state: "sent" | "arrived", txHash, createdAt }`. Written by the operator script so in-flight money counts as ours in the solvency check (section 6).

**Ledger kinds** (`LedgerEntryDoc` in `server/src/db/mongo.ts`; `debitInSession` and `creditInSession` in `server/src/deposits/ledger.ts` widen their `kind` unions):

| Kind          | Direction | `refId`        |
| ------------- | --------- | -------------- |
| `perp_open`   | -         | the open order |
| `perp_refund` | +         | the open order |
| `perp_close`  | +         | the close order |

The existing unique `(kind, refId)` index (`ref_unique`) keeps each to exactly once. A liquidation settles through a `close`-kind order made by the tracker, so it also uses `perp_close`.

**Account merges** (`server/src/db/migrations.ts`) re-point `perpOrders`, `perpPositions` and `perpAccounts` to the surviving account. A person can then own two Hyperliquid addresses; the lowest-index one is used for new orders, and each position keeps its own `index` so it is always closed from the address that holds it. The open-position key is `(index, asset)`, so a merge never collides two positions.

**Config** (`server/src/config.ts`): `PERPS_TRADING`, `PERPS_FLOAT_USD` (default 200), `PERPS_SLIPPAGE_BPS`, `PERPS_CLOSE_SLIPPAGE_BPS`, `PERPS_MAX_LEVERAGE`, `PERPS_FEE_BPS`, `HYPERLIQUID_API_URL` (mainnet default; testnet is `https://api.hyperliquid-testnet.xyz`), `PERPS_RECONCILE_TOLERANCE_USD` (default 5). No new secrets: the keys come from `DEPOSIT_MNEMONIC`. With `PERPS_TRADING=on`, config validation requires nothing else, as `config.ts` does for predictions.

## 2. Markets and quotes (server-owned)

The browser never calls Hyperliquid, as with Polymarket.

- **Sync.** Every 5 seconds the server reads `metaAndAssetCtxs` (markPx, oraclePx, funding) and, for the catalog's assets, keeps the asset index (position in `meta.universe`), `szDecimals`, `maxLeverage`, `marginTables`, `onlyIsolated` and mark price. Its info weight is within the budget in section 5.
- **Public route.** `GET /perps/markets` (outside `/v1`, rate-limited per IP, no token) returns `{ markets: [{ asset, markPx, maxLeverage, fundingRate }], maxOrderUSD }`. `maxOrderUSD` is the float's current per-order limit (the smaller of free float and the person-independent cap), `null` while trading is off. The client stores it where `catalog.perps` lives so the sentence engine stays synchronous; `PERP_MARKETS` in `lib/trade/catalog.ts` stays as the fallback until the first load and for demo mode.
- **A quote.** `perp:quote { asset, side, leverage, collateralUSD }` returns:
    - the entry price: a walk down `l2Book` for the position's size, with the slippage cap as the worst case
    - the size in coin and in dollars
    - Hyperliquid's taker fee, and our fee (0)
    - the estimated liquidation price (section 3)
    - the hourly funding rate

  The review asks when it opens, when an input changes, and every 10 seconds while open, exactly as it does for `prediction:quote`.

## 3. Server flows

All handlers sit beside the prediction ones in `server/src/socket` and are rate-limited at 10 orders per minute per user. A new `PerpService` follows `PredictionService` (`server/src/predictions/predictions.ts`): it owns checks, the hold, the order states and the float. Hyperliquid is reached only through `HyperliquidClient`, which is the equivalent of `PoolTrader` in `server/src/predictions/trader.ts`, wrapped by `withTimeouts`.

### Sizing

Given collateral C, leverage L, taker fee rate f (read from `userFees` for the master as a floor, 0.00045 by default), and our fee rate g:

- Notional N = C x L / (1 + L x (f + g)), rounded down to the asset's `szDecimals` in coin.
- Margin = N / L; entry fee = N x f; our fee = N x g. So margin + fees = C, and the person never owes more than they put in.
- The position must clear the minimum: C at least $10 and C x L at least $11. `perp.ts` gains this check beside its `minimum(10)` row ("Positions start at $10." stays the message for collateral; the new one says "A position starts at $11. Raise the collateral or the leverage.").

### Opening: `perp:order { requestId, side, asset, leverage, collateralUSD }`

1. **Check.**
    - `PERPS_TRADING` is `on`, the asset is offered, the leverage is within its bound, the minimum holds.
    - The person has no open position on that asset ("You already hold a BTC position. Close it first.").
    - The balance covers C.
    - The float is free for C plus 1 USDC (the activation, if the person is new) plus 1 USDC of slack.
2. **Hold the money.** One Mongo transaction inserts the order (`placing`, unique on `(accountId, requestId)`), debits C (`perp_open`), and adds C (+1 if new) to `perpFloat.heldE6`.
3. **Fund.**
    - Create the `perpAccounts` row if the person has none.
    - Sign `usdSend` from the master to the person's address for C. A new address is activated by this first transfer; the platform pays.
    - Store the transfer's nonce on the order *before* sending, so a restart can repeat it safely. Release the hold when the transfer is acknowledged.
    - Read the person's `clearinghouseState`. If the free balance is short of C because the activation came out of the amount (open question), top up the shortfall (at most 1 USDC) once from the master. The person's collateral is always whole.
4. **Leverage and mode.** `updateLeverage { asset, isCross: false, leverage }`.
5. **Price and sign.**
    - Limit price = the server's current mark x (1 +/- `PERPS_SLIPPAGE_BPS`), plus for a Long and minus for a Short.
    - Rounded to the tick rule: at most 5 significant figures and at most `6 - szDecimals` decimals; integers always allowed; trailing zeros stripped before signing.
    - Order: `t: { limit: { tif: "Ioc" } }`, `r: false`, no builder.
    - `cloid` is derived from the order's `_id` and saved on the order before posting.
6. **Post, then settle.** Read the per-order status, never the top-level `ok`:
    - **Filled** (`filled: { totalSz, avgPx }`): create the position at the real size and entry. Sweep what is free (collateral minus margin and fees) back to the master and credit it (`perp_refund`).
    - **Partially filled** (`totalSz` below the request): same, at the smaller size. The unused part of the collateral is returned the same way.
    - **Nothing filled, or an `error`** (price moved past the limit, minimum value, insufficient margin, open interest cap): sweep everything back to the master, then credit the lesser of the sweep and C (`perp_refund`). The order is `rejected` with a reason.
    - **No clear answer** (a timeout): the order stays `posted`; the tracker finds it by `cloid` through `orderStatus` and `userFills`, then settles as above.
7. **Push.** `perp:update { requestId, order, position, account }` goes to the person's sockets.

**Recovery.** On startup an order in `placing` or `funding` that never posted is swept back and refunded; one in `posted` goes to the tracker; one in `sweeping` repeats its stored transfer (same nonce, so a duplicate is rejected by Hyperliquid, which is why the nonce is stored first).

### Closing: `perp:close { requestId, positionId }`

1. Check: the position is `open` and belongs to the person. Set it `closing` and insert the close order.
2. Sign a **reduce-only** IOC for the position's whole size at mark x (1 -/+ `PERPS_CLOSE_SLIPPAGE_BPS`), same tick rules, with a `cloid`.
3. On a fill, read the person's `clearinghouseState`, sweep its `withdrawable` back to the master (`usdSend` from the person's key), and only after that credit exactly the swept amount (`perp_close`). Position becomes `closed` with `proceeds` and `realizedPnl = proceeds - collateral`.
4. A partial fill leaves the position `open` at the smaller size and the person can press Close again; nothing is credited until it is flat.
5. A rejected close puts the position back to `open`. The message says nothing was lost (section 7).

A position under $10 of notional is closed with a reduce-only order whose minimum exemption is unconfirmed (open question). If Hyperliquid refuses it, the position stays `open`, the sidebar shows "Too small to close right now." and an error is logged; it is the same pattern as predictions' `TOO_SMALL`.

### Liquidation and other outside closes

The tracker (section 5) sees a position gone or smaller than ours without a close order of ours in flight. It treats this as a close it didn't send: it reads the fills since the position's `openedAt`, sweeps `withdrawable` to the master, credits the sweep (`perp_close`, zero credit if nothing is left), and marks the position `liquidated` if a fill carries Hyperliquid's `liquidation` field, `closed` otherwise. Auto-deleveraging arrives the same way. The ledger follows the fills, never an assumption.

### Liquidation estimate in the preview

Isolated margin, with `mmr` the maintenance margin rate (half the initial margin rate at the asset's maximum leverage for the position's tier):

`liqPx = entry - side x (margin - mmr x N) / size / (1 - side x mmr)`, with `side` +1 for Long and -1 for Short.

The preview labels it "About" and says it excludes funding. Once the position exists, the sidebar shows Hyperliquid's own `liquidationPx` from `clearinghouseState` (which can be null) instead. The formula is from Hyperliquid's margining page and is checked on testnet before launch (open question).

## 4. States

- **Open order:** `placing` -> `funding` -> `posted` -> `filled` | `rejected`. `filled` and `rejected` pass through `sweeping` first when money must come back. Every state names its recovery in section 3.
- **Close order:** `placing` -> `posted` -> `filled` -> `sweeping` -> `done`, or `rejected` back to an `open` position.
- **Position:** `open` -> `closing` -> `closed`; `open` -> `liquidated`.
- **Pushes.** Every state change emits `perp:updated` on the bus (`server/src/events.ts`); sockets push `perp:update` through the account's ordered push chain, as for `prediction:update`.

## 5. Tracking and the rate budget

Hyperliquid allows 1200 weight per minute per IP over REST; `clearinghouseState`, `orderStatus`, `l2Book` and `allMids` weigh 2, most other info calls 20 (plus more per 20 items for `userFills`). The websocket allows only 10 unique users, so no per-person subscriptions.

- **Marks.** The market sync above (weight 20 every 5 s = 240 per minute) is shared by everyone. The client computes live PnL from the mark, as predictions use the best bid.
- **Positions.** The tracker polls `clearinghouseState` for each address with an open position: a viewer's address every 5 seconds while their sidebar is open; the others in a rotation that spends at most half the budget (600 weight a minute). With N positions the rotation takes about N x 0.2 seconds per lap.
- **Fills.** `userFills` (weight 20+) is read for an address only when a position appears, shrinks or vanishes, and in a slow lap every 10 minutes. Fills are keyed by `tid`, so rereading is idempotent. The 2000-fill limit is why a per-address read never asks for more than `userFillsByTime` since the position opened.
- **Orders in doubt.** `orderStatus` by `cloid`.
- **Signing nonces.** Milliseconds, taken from `max(Date.now(), last + 1)` per signer in one process (a single server instance, as the withdrawals' lock assumes).

Every poll writes the snapshot onto the position and pushes it only when something other than the mark changed.

## 6. Float and reconciliation

**The float.**

- Free float is the master's `withdrawable`, read after every order and every 60 seconds, minus `heldE6`. `maxOrderUSD` is served from it.
- An order that doesn't fit is refused before any money moves: "Long and short are limited to $X right now."
- Warnings are logged when free float falls under 25% of `PERPS_FLOAT_USD`, and when it climbs over 200% (the hint to move money back to Arc).

**Rebalancing script**, `server/scripts/perps-rebalance.ts`, run by the operator (the server need not stop, but it must not send from the treasury key at the same time, as in the withdrawals design):

- `arc-to-hl <amount>`: from the treasury (`keyring.operator()`), approve and `depositForBurnWithHook` on Arc's `TokenMessengerV2` to domain 19 with `hookData` naming the master's HyperCore address and perps dex. It writes a `perpRebalances` row. Circle's forwarding fee is about 0.25 USDC per batch (fetched from the fee API at run time).
- `hl-to-arc <amount>`: a signed `sendAsset` from the master to the USDC system address with forwarding data for domain 26; fallback is HyperCore to HyperEVM, then a burn on HyperEVM to Arc.
- It refuses to leave the Arc treasury below the withdrawals' free balance need (what `withdrawal` checks), and prints both sides before asking.

**Reconciliation**, every 10 minutes, errors logged only:

- **Per position:** the address's real size and side match our open record. A mismatch is logged and nothing is changed.
- **Per person:** an address with no open position and more than $1 free (a stuck sweep) is swept to the master and the amount is logged. It is not credited: if the money can't be tied to an order, an operator decides.
- **Solvency:** assets = Arc treasury + unswept deposit addresses + master account value + each person's account value + in-flight `perpRebalances`. Liabilities = the sum of ledger balances + `heldE6`. A shortfall over `PERPS_RECONCILE_TOLERANCE_USD` is an error log. A surplus is the platform's own money (the owner's float and absorbed fees).
- **Activation cost** and **our fee** are summed in the log line, so the owner can see what absorbing costs.

## 7. Errors

Every failure after an optimistic accept takes the trade back in the app, then shows one message in the sidebar's status line.

| What happens                                    | The message                                                                           | Money on the server                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| The price moved past the limit (nothing filled) | "The price moved, so your position didn't open. Nothing was spent."                   | Refunded (swept back, then credited)        |
| Hyperliquid rejects the order (margin, cap)     | "This position couldn't be opened right now. Nothing was spent."                      | Refunded                                    |
| Float is short                                  | "Long and short are limited to $X right now. Nothing was spent."                      | Nothing moved                               |
| Already holds this asset                        | "You already hold a BTC position. Close it first."                                    | Nothing moved                               |
| Leverage over the asset's bound                 | "BTC allows up to 20x."                                                               | Nothing moved                               |
| Hyperliquid doesn't answer at all               | "Hyperliquid isn't answering. Nothing was spent."                                     | Refunded (never posted)                     |
| Not connected at confirm                        | "You're offline. Nothing was spent."                                                  | Nothing moved                               |
| An answer is late or unclear                    | Nothing: the trade stays accepted until the tracker settles it                        | Held until settled                          |
| Only part filled                                | "Opened $X of your $Y. The rest is back in your balance."                             | Remainder credited                          |
| A close fails                                   | "Couldn't close right now. Your position is still open."                              | Nothing moved                               |
| A position is liquidated                        | "Your BTC long was liquidated."                                                       | Remaining margin (often none) credited      |
| A sweep to the master fails                     | Nothing shown: the order stays `sweeping`, the tracker retries, an error is logged    | Held; credited only after the master has it |
| Market sync fails                               | Nothing. The last good list stays and a warning is logged.                            | n/a                                         |
| `PERPS_TRADING=off`                             | "Long and short aren't available right now."                                          | Nothing moved                               |

## 8. Client UI

**The sentence.** `perp.ts`: `check` returns `UNAVAILABLE` only while trading is off or the client is offline (the message changes from "yet" to "right now"); it adds the minimum-position check and the one-position-per-asset check from the account's open perps. The leverage picker's `maxLeverage` comes from the server's markets. `preview` gains the quote's rows when a quote is held: "Position", "Entry price (about)", "Liquidation price (about)", "Fees" (Hyperliquid's taker fee and our fee), "Funding" (per hour), "Most you can lose" (the collateral, true because the margin is isolated). Without a quote it falls back to today's two rows.

**Review.** `components/trade/review-panel.tsx` already has a `live` path for predictions (`prediction`, `live`, `account.quotePrediction`, `account.placePrediction`). A perp intent gets the same path with `account.quotePerp` and `account.placePerp`; the other verbs stay simulated. The confirmation text is "Position opened." The activation fee is never shown: the platform absorbs it.

**Optimistic.** Confirm closes the review, drops the shown balance by the collateral, and adds a position to the sidebar with the quote's size and entry, flagged pending. A fill replaces them with the real ones in place; a failure removes the position and puts the balance back with the message. Each optimistic change is keyed by `requestId`, as in `lib/account/state.ts`.

**Positions in the sidebar.** `Position` in `components/wallet-data.ts` becomes a union of the prediction position and a new perp position. `components/position-row.tsx` renders the perp one with the same hover close button:

- Title: "Long BTC at 5x". Detail: "$500 position, entry $65,000, liquidates near $52,400".
- Worth = collateral + unrealized PnL (from the live mark, with `cumFunding`); the row's PnL tone is gain or loss as for predictions.
- States: pending (the open is in flight), open, closing, "Closed", "Liquidated". Settled rows stay 7 days, as for predictions.
- Close is disabled with the reasons above while the open is pending or a close is in flight.

`lib/account/state.ts` gains `perps` (positions and orders, upserted by id, ignoring older updates, merged by `requestId`), and `useAccount()` gains `quotePerp`, `placePerp`, `closePerp`. `protocol.ts` stays import-free:

```ts
export type PerpPositionView = {
    id: string;
    asset: string;
    side: "long" | "short";
    leverage: number;
    sizeCoin: string;
    entryPx: string | null;
    collateralUSD: UsdcAmount;
    liquidationPx: string | null;
    markPx: string | null;
    unrealizedPnlUSD: UsdcAmount;
    cumFundingUSD: UsdcAmount;
    state: "open" | "closing" | "closed" | "liquidated";
    proceedsUSD: UsdcAmount | null;
    openedAt: string;
    settledAt: string | null;
    updatedAt: string;
};
export type PerpOrderView = { id: string; requestId: string; kind: "open" | "close"; state: string; reason: string | null /* ... */ };
// ClientToServerEvents: "perp:quote", "perp:order", "perp:close" (acks as for predictions)
// ServerToClientEvents: "perp:update" { order, position, account }; "perps" { positions, orders } on bind
```

**PnL page.** `components/pnl/use-activity.ts` gains real perp rows (open, close with realized PnL, liquidation) in place of the mock Long/Short rows for a signed-in person. `perp_open` and `perp_close` ledger kinds count as trades, not deposits. The balance chart treats money in a position as part of the balance until it is closed, so opening a position doesn't show as a drop.

## 9. Testing

**Fake Hyperliquid.** An in-process HTTP server for `/info` and `/exchange`, like `server/test/support/fake-clob.ts`. It keeps accounts, balances, positions and a mark per asset, and implements `meta`, `metaAndAssetCtxs`, `l2Book`, `clearinghouseState`, `userFills`, `orderStatus`, `usdSend`, `updateLeverage` and `order`. Its controls set marks, fill, partly fill or reject the next order, delay it, drop its reply, liquidate a position, and make `usdSend` fail. Responses for `meta` and a few fills come from fixtures recorded from the live API by a script.

**Unit:**

- tick and size rounding (5 significant figures, `6 - szDecimals` decimals, trailing zeros)
- limit price from mark and cap, for both sides
- sizing (margin plus fees equals collateral; rounding down; the $11 minimum)
- the liquidation formula against recorded `clearinghouseState` values
- leverage bounds from `maxLeverage` and `marginTables`
- unit conversion and keyring paths (perp address never equals a deposit address)

**Server integration** (the Mongo harness):

- **Open:** a fill debits, funds, records the real size, and credits back the unused collateral. A partial fill does the same at the smaller size. No fill is a full refund. A duplicate `requestId` is one order. Two concurrent opens can't overdraw the balance or the float. A second position on the same asset is refused.
- **Activation:** the first open for a person creates the account and pays for it from the master; the second doesn't.
- **Recovery:** a crash after the debit, after the transfer, after posting, and during the sweep each end settled exactly once.
- **Close:** it sweeps then credits, once. A partial close leaves the position open. A rejected close restores it.
- **Liquidation and ADL:** the fake liquidates; the tracker settles it, credits what is left, and sets `liquidated`.
- **Float:** short float refuses before any money moves; the hold is released exactly once.
- **Reconciliation:** a size mismatch, a stuck balance and a solvency shortfall are each logged.
- **Merge:** an account with an open position merges and the survivor can close it.
- **Trading off:** orders are refused; existing positions can still be closed.

**Browser (Playwright)**, against the fake:

- Long and Short review shows the quote's rows and a liquidation price; the confirm lowers the balance and adds the position at once, while the fake is still holding the order.
- The real fill replaces the numbers in place; a rejection removes the position and shows the message; a reload while held keeps it.
- Close raises the balance at once and restores the position if the fake rejects it.
- A liquidation shows "Liquidated" in the sidebar and the PnL feed.
- The Review button is blocked with trading off, and with a position already open on that asset.

**Testnet and live check.**

1. `PERPS_TRADING=off` ships first, with markets and quotes live.
2. Testnet (`HYPERLIQUID_API_URL`): a script, `server/scripts/perps-check.ts`, runs the full path with a throwaway mnemonic. The faucet requires a prior mainnet deposit from the same address, so the owner funds the master that way once.
3. Mainnet, with real keys and a $20 float:
    - open and close a $10 position on BTC; confirm the activation fee, the `usdSend` fee, who pays the activation, the account mode of a fresh derived address, and the reduce-only minimum
    - compare the formula's liquidation price with `liquidationPx`
    - one Arc to HyperCore rebalance of $5 and one back
    - then `PERPS_TRADING=on`

## 10. Order of work

Each phase gets its own implementation plan.

1. **Foundation.** Keyring path, config, collections, ledger kinds, `HyperliquidClient` with the fake, the markets sync and `GET /perps/markets`. Ships with trading off.
2. **Quote and open.** `perp:quote`, `perp:order`, the float, recovery. The review's live path with optimistic state.
3. **Tracking, close and liquidation.** The tracker, `perp:close`, the sidebar rows, the PnL rows. Trading turns on only after this, so nobody holds a position they can't see or close.
4. **Rebalancing script and reconciliation.**
5. **Testnet check, mainnet live check,** then the launch blockers below.

## What the owner provides

- Hyperliquid terms review, the custodial question and the US-person question. This is a **launch blocker**, shared with predictions' geoblock (see "Not included").
- Hosting the server outside Hyperliquid's restricted regions. Hyperliquid sees our server's IP; no proxies.
- Funding: a USDC float on Hyperliquid (start with $200), first through Circle's CCTP route by the rebalancing script from the Arc treasury, or a testnet-then-mainnet small deposit for the live check.
- Running the rebalancing script when the float or the treasury drifts (the logs say when).
- A decision on the open questions below, chiefly the activation fee and abstraction mode, which the live check settles.

## Not included

- **A location or eligibility check on people.** Hyperliquid's terms are reported to treat US persons as restricted, and we operate custodially for them. As with predictions, this is acceptable only for a private demo. It must be decided with counsel before any public launch. The order path has one place a check can go: step 1 of opening, shared with `prediction:order`'s.
- routing Hyperliquid traffic through proxies to appear to be in another country
- take profit, stop loss, trigger orders, limit orders, and TWAP
- adding to a position, partial closes, flipping sides, and adjusting margin or leverage after opening
- cross margin, HIP-3 dexes, spot trading, builder codes, vaults and sub-accounts
- automatic rebalancing between Arc and Hyperliquid (a later phase, sharing the multichain work's CCTP client)
- an alerting service; error logs only
- websocket price ticks; the mark refreshes every 5 seconds through the server
- withdrawing directly to Hyperliquid or any other chain; money leaves through the existing withdrawal flow once credited to the ledger

## Open questions

1. **Activation fee.** Is the 1 USDC taken from the sender on top of the amount, or out of the amount? The design tops up any shortfall once, but the live check should settle it.
2. **Fee on `usdSend`.** Is there one between existing accounts? The research found none stated.
3. **Does `usdSend` move the perp balance?** And what is a fresh derived address's account mode (standard, unified, portfolio margin)? A unified account changes which endpoints show balances and whether `usdClassTransfer` is needed.
4. **Reduce-only minimum.** Are closing orders under $10 exempt from the order minimum? It decides whether tiny positions (and tiny partial fills) can be closed.
5. **Margin basis.** Does Hyperliquid check initial margin at the order's limit price or at the fill price? If the limit, the slippage cap eats into the collateral at 50x and sizing needs a margin buffer (a `PERPS_MARGIN_BUFFER_BPS` config).
6. **Does isolated margin take the entry fee from the isolated margin or from the free balance?** The sizing assumes free balance.
7. **Liquidation formula** and maintenance margin per `marginTables` tier: confirm against the margining page and testnet values.
8. **Liquidation marker in REST fills.** The research verified a `liquidation` field in websocket fills; confirm `userFills` carries it, or settle on "gone without our order" and label it "Closed by Hyperliquid".
9. **Duplicate `usdSend` nonce.** The recovery design relies on Hyperliquid rejecting a repeated nonce. Confirm, since a double transfer would move extra float to a person's address (it would be swept back, but only by the next reconciliation).
10. **Master rate limit.** Does `usdSend` volume count toward the address's request budget (10,000 + 1 per USDC traded)? At many opens the master could drop to 1 request per 10 seconds.
11. **CCTP to Arc.** Whether Arc is accepted as the destination of the HyperCore withdrawal forwarding hook (the research saw only examples for domains 0, 3 and 6), and the mainnet `CctpForwarder` address. The fallback route is in section 6.
12. **Withdrawal availability.** Withdrawals read the Arc treasury only; a large amount sitting on Hyperliquid can starve them. Is a reserve rule in the rebalance script enough, or should `withdraw:limits` also account for the float?
13. **SDK.** `@nktkas/hyperliquid` is community-made and pre-1.0 (0.33.3 at research time). Accept it behind our interface, or sign by hand?
14. **Nonce window.** The nonce rule (100 highest, or 20 in a newer version, per the research) needs a recheck; the design only needs strictly increasing milliseconds.
15. **Terms and geography.** The primary terms text wasn't retrievable; whether a custodial operator may serve any user, and which regions, is for counsel.
