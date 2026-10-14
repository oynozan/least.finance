# All-time PnL: design

## Goal

The PnL page tells the truth for every range, however old the history is. Today it is built only from the account snapshot, and the snapshot forgets things. This spec moves the page's figures and its history list to the server without making the snapshot bigger.

The work has two phases, **built together as one delivery** (Owner's decisions, 1). The names only split the spec and the review:

- **Phase 1** fixes every figure. The server answers one event, `pnl:series`, from the entity collections. One small write is added so a partial prediction sale is recorded (section 4). This is the whole of the reported bug.
- **Phase 2** makes the table list the whole history, with a paged `activity:list` (section 10) and a "Show older" button.

Read-only investigation of the code as of 2026-10-14. No code was changed.

## 1. What is wrong today

### 1.1 What the PnL page shows and where each number comes from

The page is `components/pnl/pnl-screen.tsx`: a Balance card and an Activity card. Both are built from one list of `Activity` rows (`lib/trade/activity.ts`) that `components/pnl/use-activity.ts` assembles from the client's account state. That state is filled only by the socket: `account:open` (the session), then the pushes `positions`, `perps`, `swaps`.

| Row kind | Comes from | What the snapshot holds | What is lost |
| --- | --- | --- | --- |
| Deposit | `session.deposits` (`Sessions.describe`) | The newest 50 | Everything older. `AccountClient.loadOlder()` exists but nothing calls it. |
| Withdrawal | `session.withdrawals` (`Withdrawals.recent`) | The newest 50, any age | Everything older than the 50th. |
| Swap | `swaps` push (`SwapOrders.recent`) | Orders the wallet sent whose `updatedAt` is in the last 7 days (`RECENT_MS`) or that are still `sent`; the 50-row limit applies to both together | Every swap older than 7 days. |
| Prediction | `positions` push (`PredictionService.positions`) | Open and closing ones, plus ones settled in the last 35 days (`SETTLED_KEEP_MS`, `predictions.ts:35`) | Every position settled more than 35 days ago. |
| Perp | `perps` push (`PerpService.positions`) | Active ones, plus ones settled in the last 35 days (`SETTLED_KEEP_MS`, `perps.ts:32`) | Every position settled more than 35 days ago. |

How the page turns rows into figures:

- Every row has a `change`: a deposit adds itself, a withdrawal takes itself off, a settled prediction or perp adds `payout − cost` (`proceeds − collateral` for perps, fees included). Opening a position and swapping move nothing (`change` is 0), so the collateral and stake stay part of the balance.
- `balanceHistory(activity, days, now)` makes one bar per local day. Its starting balance is the sum of `change` over all loaded rows older than the first day. Each bar adds that day's rows. The big "Balance" is the last bar; hovering a bar shows that day's balance and PnL.
- The headline PnL is the sum of the bars' PnL over the range. "PnL" and "realized" are the same number today (only a close has a non-zero `change` besides deposits and withdrawals), so one field is enough.
- The page has three ranges, 7D, 30D and All. There is no 1D, 1W or 1M. 7D and 30D are exactly 7 and 30 bars. "All" is `daysSince(activity)`, the days back to the oldest **loaded** row, clamped to 7 to 90 bars.
- The headline Balance is therefore the sum of loaded rows, not the account's balance. It also differs by design from the sidebar's balance: it keeps the money in open positions at cost, the sidebar shows cash.
- The table lists the loaded rows newest first, filtered by All, Trades or Deposits on the client. Its empty states are "Nothing here yet" and "No deposits yet".
- Unrealized PnL is not on this page.

### 1.2 What the sidebar shows

`components/wallet-sidebar.tsx` shows: the cash balance (`optimisticBalance`), a hover history of the loaded deposits and withdrawals (`mergeEntries`), and the open positions plus predictions and perps settled in the last 7 days (`SETTLED_SHOWN_MS`, `wallet-data.ts`). It shows no all-time figure and nothing in it is cumulative, so the 35-day trim does not make it wrong. It stays as it is. Its history list has the same 50-row ceiling as the page has today. The page's table moves past that ceiling (section 10); the sidebar's list does not, and that is accepted and out of scope.

### 1.3 Which ranges break

A trimmed row is never wrong on its own. It is wrong because the starting balance and the "All" window are sums over what is loaded.

| Range | What breaks, and from when |
| --- | --- |
| 7D, 30D | The PnL figure is right: everything settled in the last 30 days is loaded. The **balance** (every bar and the big number) is wrong from day 36 after the first settlement, because the starting balance leaves out every position settled more than 35 days ago. It is also wrong for anyone with more than 50 deposits or more than 50 withdrawals, because the starting balance leaves out the oldest of those. |
| All | The PnL is wrong from the same day: the window starts at the oldest loaded row and the trimmed settlements are not in it. The balance is wrong for the same reasons. Past 90 days the window is clamped, so the bars show 90 days and the rest is only in the starting balance. |
| Table | Incomplete: deposits and withdrawals past 50 each, swaps past 7 days, settled positions past 35 days are not listed at all. Phase 2 fixes this. |

A loss settled 40 days ago makes the balance read too high; a win makes it read too low. The error never goes away.

One more gap, in the data and not in the snapshot: a **partial prediction sale** is recorded nowhere but the ledger. `#bookSellFill` in `predictions.ts`, when the sale leaves `left >= SHARE_STEP_E6` shares, shrinks the position and keeps it open. The sold part's proceeds are credited, but no position or order carries the result, so no figure built from positions can include it. This does happen: `place()` has no guard against a position that is `closing` (only `#openPosition` blocks a second sell, `predictions.ts:315-322`), `#bookBuyFill` upserts into `open` and `closing` positions (`:549-551`), and the comment at `:618` says a buy that fills while a sell is out stays open. So a buy that fills during a sell, or a late sell fill (`settleLate`, `:724-737`), takes the keep branch. Section 4 closes the gap.

## 2. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Scope | Phase 1 and phase 2 are built together: the series and totals, and the paged history table with "Show older". | The chart and the table then both tell the truth for old history in one delivery, and they share the partial-sale record and one test seed. |
| Headline Balance | Unchanged: cash plus the money in open positions at cost, now correct over the whole history. | The meaning stays the same, and it needs no second series and no live prices. It stays different from the sidebar's cash figure. |
| Partial prediction sale | Recorded on the sell order as `soldPart` (section 4). | One optional field written in the fill's own transaction, so no new position document and no change to the open-position index, the reconciler's dust count or the sidebar. |
| Positions absorbed by an old account merge | Nothing is done. | Merges run only at start-up for accounts from before one account per person, and new accounts cannot be merged. |
| Source of truth | The entity collections: `deposits`, `withdrawals`, `positions`, `prediction_orders` (partial sales only), `perp_positions`. Not the ledger. | They are re-pointed to the surviving account on a merge, the ledger rows are not (`mergeInto`). They carry the per-row detail. They are never trimmed. Only a trim in the views does that. |
| The ledger | Used in tests as the check: after each finished flow the series' last balance equals the account's cash plus the cost of positions still open. | The ledger is atomic with the balance, so it catches a missing event kind. It is not a production check: while an order holds money (a pending buy or perp order) or after a rejected perp order returned less than it took, cash plus open cost differs from the series. |
| Where numbers are computed | On the server. The client no longer computes the series from rows. `balanceHistory` and `daysSince` are deleted in the step that switches the page. | One source for the chart. The client cannot compute what it does not hold. |
| Where days are cut | In the server's code, with `Intl`, on the account's rows. Not in a Mongo `$dateTrunc`. | The same engine that checks the time zone name cuts the days, so a name `Intl` accepts can never fail later in Mongo. Mongo 7.0's zone database cannot be checked from public docs. A person has a few hundred rows, so reading them is milliseconds. |
| Transport | One socket event, `pnl:series`, and one push, `pnl:changed`. No HTTP route. | The web app does not call `/v1` for account data; the socket is already bound to the signed-in account (`boundAccount`). One surface, one auth path. |
| What stays in the snapshot | Everything, unchanged: the session's 50 deposits and withdrawals, the 7-day swaps, the 35-day settled positions. `SETTLED_KEEP_MS` stays 35 days. | The sidebar, the optimistic balance and the pending rows depend on it. It is small and fast. |
| Consistency | One read per source, all ranges cut from the same rows. | The three ranges can never disagree about today's bar. |
| Indexes | None added. | Every collection read already has an index that starts with `accountId` (`mongo.ts`). At a few hundred rows per account a new index buys nothing; add one only if the logged durations ask for it. |
| Cache | None. Concurrent identical requests share one run. | A cache needs invalidation, and a stale chart is a worse failure than a slow one. Revisit on the numbers in Open questions. |
| Freshness | The client asks again when the server pushes `pnl:changed`. | One mechanism for "something that changes the chart happened". |
| Ranges | Keep 7D, 30D, All. No new ranges. | The owner asked for correctness, not more controls. |
| New labels | None, except the "Show older" button (10.4). The new unit is shown only in the hover line. | Minimal cards: essentials only. |

## 3. The series: `pnl:series`

### 3.1 Request and response

```
"pnl:series": (payload: { tz: string }, ack: Ack<PnlSeries>)

type PnlSeries = {
    tz: string;
    ranges: Record<"7D" | "30D" | "All", {
        unit: "day" | "week" | "month";
        points: { start: string; balance: UsdcAmount; pnl: UsdcAmount; net: UsdcAmount }[];
    }>;
};
```

- One call returns all three ranges, so changing the range is instant and never waits.
- `tz` is the browser's IANA name (`Intl.DateTimeFormat().resolvedOptions().timeZone`), a string of at most 64 characters (zod). The server builds a cached `Intl.DateTimeFormat` for it. A name `Intl` rejects is cut in `UTC` instead, and the answer's `tz` says `UTC`; the chart still loads, with days that may start a few hours off. A payload that is not a string is `bad_request`.
- `start` is the bucket's first **local date** as `YYYY-MM-DD` (a Monday for a week, the 1st for a month), not an instant. The client shows it with `new Date(y, m - 1, d)`, so no time zone arithmetic happens in the browser and a 23 or 25 hour day is never an issue.
- `balance` is at the end of the bucket. `pnl` is the realized PnL inside it. `net` is deposits minus withdrawals inside it (the old `deposited`).
- Amounts are `formatUsdc` strings, like every other view.

### 3.2 Events

Each event is an `(at, net, pnl)` triple. Every amount is wei (`Decimal128`), read as `bigint` on the server. `realizedPnl` on perp positions is **not** used: it is in E6 and null while open. The server uses `proceeds − collateral` for perps, as `perpActivity` does.

| Kind | Which docs | `at` | `net` | `pnl` |
| --- | --- | --- | --- | --- |
| Deposit | all of the account's | `creditedAt` | `+amount` | 0 |
| Withdrawal | state not `failed` (a failed one is refunded once) | `createdAt` | `−amount` | 0 |
| Prediction | `positions` in state `closed`, `won`, `lost` | `settledAt` | 0 | `closed`: `proceeds − cost`; `won`: `payout − cost`; `lost`: `−cost` |
| Partial prediction sale | `prediction_orders` that have `soldPart` (section 4) | `soldPart.at` | 0 | `soldPart.proceeds − soldPart.cost` |
| Perp | `perp_positions` in state `closed`, `liquidated` | `settledAt` | 0 | `proceeds − collateral` |
| Swap | none | | | Swaps move no balance and realize nothing, so they are not events. |

The balance after a bucket is the running sum of `net + pnl` over all events up to its end, with no lower bound. That is the same meaning as today (open money counted at cost), now over the whole history.

The five reads are independent and take no cross-collection snapshot. A settlement that lands between two reads shows up in the next push, and every range shows the same thing meanwhile because they are cut from the same rows.

### 3.3 Bucketing

The server does all of this in one function, `PnlService.series(accountId, tz, now)`:

1. **Read.** One query per source, `find({ accountId, ... })` with only the fields in 3.2 projected. Each row becomes an event.
2. **Cut into local days.** The event's local date is `YYYY-MM-DD` from the cached `Intl.DateTimeFormat` (`formatToParts`) for `tz`. The server sums `net` and `pnl` per date in a map. From here on it works on dates as calendar numbers (`Date.UTC` on year, month, day), never on instants, so a daylight saving day cannot change a count.
3. **Build the bucket lists.** The server builds the full list of dates for each range, and a bucket with no events is a zero bucket with the running balance carried through. Nothing is left for the client to fill.
    - `7D` and `30D`: the last 7 and 30 local dates, ending on the local date of `now`. Always `day`.
    - `All`: from the local date of the account's **earliest event of any kind**, to today, never fewer than 7 days.
4. **Pick the unit for `All` from the aligned bucket count.** Let `d` be the days from the first date to today, both counted. If `d <= 90`, the unit is `day`. Otherwise count the Monday-aligned weeks from the first date's week to today's week, both counted; if that is `<= 90`, the unit is `week`; otherwise it is `month`. Past 7.5 years the month count grows beyond 90; the bars already shrink with `min-w-[3px]` and this is accepted.
5. **Roll up.** Week buckets take the Monday on or before each date, month buckets the 1st. The first bar's starting balance in `7D` and `30D` is the sum of every event before the first date, so it includes the whole past. For `All` it is 0.
6. **Format.** `balance`, `pnl` and `net` become `formatUsdc` strings.

No account, or no events: three ranges of zeros, 7, 30 and 7 days. The page shows "No balance yet", as now.

If a run ever gets slow, the day-grouping in step 2 can move into Mongo (`$group` on `$dateToString` with `timezone`), with steps 3 to 6 unchanged. That would put Mongo's zone database back in play, so that move needs a test of the current browser zone names against `mongo:7.0` first.

## 4. The partial-sale record

The one write-path change (Owner's decisions, 3). It makes the result of a partial prediction sale exist as data.

- `PredictionOrderDoc` gains an optional field `soldPart: { cost: Decimal128; proceeds: Decimal128; at: Date }`. It is set only on a sell order whose fill left the position open, and never on a sell that closes the position (that result already lives on the closed position, so it would count twice).
- In `#bookSellFill`, the keep branch already computes the position's new cost. In the same transaction it now also sets `soldPart` on the sell order: `cost` is the position's cost before minus the new cost (the same two numbers, so the parts add up exactly), `proceeds` is the amount credited to the balance (net of fee, the same `proceeds` the ledger entry carries), `at` is the `now` of the transaction. The function returns the updated order, and `#settleSell` and `settleLate` pass that order to `#afterSettle`, so `prediction:updated` carries it.
- The write is under the same guard as the fill (`state: "posted"` or the late-fill guard), so a repeated fill does nothing and `soldPart` is set once.
- No position document is added, so the open-position uniqueness index, the reconciler's dust count (`reconciler.ts:74,89-94`, which reads every `closed` position's shares) and the sidebar's list are untouched. The sale is not a row in the sidebar. Its result is in the bar and the table lists it as a `sale` row (10.1), so no bar carries a result without a row.
- Partial sales booked before this change have no `soldPart`, so for those accounts the series differs from the ledger by that sale's result. Trading is off until the owner's live check, so none are expected; Open questions 1 gives the check.

A merged account's absorbed position (`movePositions` in `db/migrations.ts` marks it `closed` with proceeds 0, so it reads as a loss of its cost) is **not** changed here (Owner's decisions, 4); see Not included.

## 5. Freshness: `pnl:changed`

- The server sends `pnl:changed` (no payload) to the account's room when an event that can move the series fires. It is added in the same `bus.on` handlers, inside the existing `enqueue`, to the same owner-checked loop.
    - `deposit:credited`, `withdrawal:updated` and `position:settled`: always. A settlement that moves no money (a lost prediction) still fires `position:settled`, which is why the push is on events and not on the account `version`.
    - `prediction:updated`: only when the order is a sell and `filled`. A buy does not move the series (open money counts at cost).
    - `perp:updated`: only when the event carries no position or a settled one (`settledAt` set). The tracker also emits `perp:updated` for funding and liquidation-price changes on an open position (`perps/tracker.ts:268-297`); those must not trigger a refetch.
- The client asks for the series again, trailing-debounced by 400 ms because one trade fires several events, only while the PnL page holds a series.

## 6. The client (phase 1)

### 6.1 State

- The series lives in a small hook beside `use-activity.ts` (`use-pnl-series.ts`), asked through a new `AccountClient` method next to `loadOlder`. A module-level store keeps the last answer for the session, keyed by `tz`, so coming back to the page draws the old bars at once and refreshes underneath.
- It asks only once the account state is `ready` (the session is open and the socket is bound, `boundAccount` would otherwise answer `wallet_not_connected`), again after every reconnect once `account:open` has answered, and on `pnl:changed`.

### 6.2 Balance card

- The bars, the headline Balance, the PnL and the hover line come from `PnlSeries.ranges[range]`. The headline PnL is the sum of the points' `pnl`; the hovered bucket shows its own.
- A bar's tone comes from its `pnl`.
- The hover line says "that day", "that week" or "that month" from `unit`; the heading reads "Balance on Mar 3", "Balance, week of Mar 3" or "Balance in March". The strings for an unlabelled range are unchanged.
- Loading: with no answer yet and none stored, the chart area shows the same pulsing panel as the page's `Placeholder`, at the chart's height. With a stored answer it draws that and does not flash. A new answer replaces the bars; the grow-in already keys on the range.
- Failure: if the call fails and there is nothing stored, the chart area reads "Couldn't load your history." and the call is repeated on the next reconnect or `pnl:changed`. With something stored, nothing changes on screen.
- Empty: all zero is "No balance yet", as now.
- Every bucket is present, so `point()` in `balance-card.tsx` keeps dividing by the bar count.

### 6.3 Activity card

It pages back through the whole history with `activity:list` and shows the live rows from the snapshot on top of the pages. Sections 10.3 and 10.4 give the rows and the card.

## 7. Auth, limits, privacy

- The event runs through the socket's existing handshake auth (a Privy token) and `boundAccount`, so a person can only read the account bound to their own socket. The server never takes an account id from the payload.
- It shares the 40 events per 10 seconds limit and has its own limiter, 30 per minute per user, in the style of `withdrawQuotes` in `sockets.ts`.
- Nothing about other people, nothing secret: the answer holds the person's own totals by date. No email, no wallet addresses.
- A run is logged at `info` with its duration and the row count per source (`pnl.series`), which is the data for the decision in Open questions 2.

## 8. Errors

| Case | Result |
| --- | --- |
| Socket not bound to an account | `wallet_not_connected` |
| `tz` is not a string, or is over 64 characters | `bad_request` |
| `tz` is a string `Intl` does not know | Cut in `UTC`, answer's `tz` is `UTC` |
| Rate limit | `rate_limited` |
| Database error | The generic error; the client keeps what it shows and retries as in 6.2. |

## 9. Testing

This section tests the series (phase 1). The tests for `activity:list` and the table are in 10.5. Both sets are written with the code they test, in the order of section 11, and the browser tests share one seed.

**Server integration (vitest, real Mongo from `global-setup`; a fake clock injected like `#now` in the other services; no anvil needed except where the harnesses use it):**

- *Regression, the bug.* Seed a deposit 500 days ago, a prediction lost 400 days ago, a perp liquidated 200 days ago, a perp closed 50 days ago, a deposit 10 days ago. Assert 7D and 30D balances include all of them in the starting balance, `All` totals include them, and the PnL of 7D and 30D equals only the last 30 days.
- *Ledger check.* Run real flows through the prediction and perp harnesses: buy then sell, buy then resolve won, buy then resolve lost, perp open then close, perp open then liquidation to zero. After each finished flow the series' last balance equals the account's cash plus the cost of what is still open. With one position left open it equals cash plus its cost.
- A withdrawal in `sending` counts; a `failed` one does not; a Solana withdrawal in `forwarding` counts.
- A lost prediction and a zero-proceeds liquidation show in `pnl`.
- *Partial sale.* A buy that fills while a sell is out, and a late sell fill, both leave the position open and set `soldPart` with the right cost and proceeds; `soldPart.cost` plus the remaining position's cost equals the cost before; the series' last balance equals cash plus open cost; a full sell sets no `soldPart`; the reconciler logs no mismatch after the sale (`prediction-ledger`, `prediction-close`).
- *Bucketing.* Spans of 80 days, 400 days and 3000 days give `day`, `week`, `month`; 90 days of history is `day`, 91 days with 90 or fewer aligned weeks is `week`, and a span that is 90 weeks long but touches 91 Monday-aligned weeks is `month`; `All` is never fewer than 7; a no-event account gives zeros; quiet days are present with the running balance carried; 7D and 30D have exactly 7 and 30 points; every `start` is a valid date and a Monday for weeks.
- *Zones.* An event at 23:30 UTC lands on the next day for `Asia/Tokyo` and the same day for `UTC`. A 7D range across the New York spring-forward day (2026-03-08) and the fall-back day (2026-11-01) still has 7 points, and events at 00:30 and 23:30 local on those days fall on the same date. A zone with a half-hour or 45-minute offset (`Asia/Kolkata`, `Asia/Kathmandu`) cuts on local midnight. Current names such as `Europe/Kyiv` and `America/Argentina/Buenos_Aires` work; a name `Intl` rejects gives a `UTC` answer with `tz: "UTC"`.
- *Consistency.* The last point of 7D, 30D and All has the same `balance`.
- *Deposits.* Two deposits from one transaction (two logs) each count once, and the series' `net` equals the sum of the ledger's `deposit` entries (`deposits` is unique on `(chainId, txHash, logIndex)` and the ledger on `(kind, refId)`).
- *Socket.* An unbound socket is refused; two users never see each other's totals; payload validation; the rate limit; `pnl:changed` reaches only the owner's sockets after a deposit credit, a withdrawal update, a sell fill, a settled perp, and does not fire for a buy or a funding tick on an open perp.

**Logic specs (Playwright `logic` project, no browser):**

- The hover and heading wording per `unit`.
- A date string to the label in the browser's zone.
- The existing `balanceHistory` and `daysSince` specs in `trade.logic.spec.ts` and `perp-positions.logic.spec.ts` move to the server tests above and are deleted with the functions.

**Browser (Playwright, the e2e backend):** `server/test/e2e/serve.ts` `/seed` learns to seed old settled positions and perps beside deposits, and more than 50 old rows for the paging tests in 10.5.

- With a 400-day-old loss, 7D, 30D and All all show the balance and PnL that include it.
- The chart's placeholder shows while the series loads and the stored series shows at once on a second visit.
- Opening the page before the session is ready never shows "Couldn't load your history".
- A new deposit or a closed position updates the bars without a reload (`pnl:changed`).
- Phones: no horizontal scroll.

## 10. Phase 2: the history table

Built in the same delivery as phase 1 (Owner's decisions, 1). The series (sections 3 to 6) needs none of this, so the two can be reviewed apart.

### 10.1 `activity:list`

```
"activity:list": (payload: { before?: string; limit?: number; filter?: "all" | "trades" | "deposits" }, ack: Ack<ActivityPage>)

type ActivityItem =
  | { kind: "deposit";    at: string; deposit: DepositView }
  | { kind: "withdrawal"; at: string; withdrawal: WithdrawalView }
  | { kind: "swap";       at: string; order: SwapOrderView }
  | { kind: "prediction"; at: string; part: "open" | "settle"; position: PositionView }
  | { kind: "sale";       at: string; order: PredictionOrderView }
  | { kind: "perp";       at: string; part: "open" | "settle"; position: PerpPositionView };
type ActivityPage = { items: ActivityItem[]; next: string | null };
```

- Newest first. `limit` defaults to 50, at most 100 (the same bound as `depositPage`). Validated with a zod schema beside `depositPage` in `validation.ts`.
- `filter` is applied on the server: `deposits` is deposits and withdrawals, `trades` is swaps, predictions, sales and perps, as the card's filter does today. A filtered page is always full, so "Show older" never leads to an empty page.
- A position is two rows, its opening (`openedAt`) and its settlement (`settledAt`), each its own item with `part`. Open positions have only the `open` item. A partial sale is one `sale` item built from the sell order (`PredictionOrderView` gains `soldPart`), with no `open` part, so one buy never lists two "open" rows.
- Swaps are the orders the wallet sent (`txHashes.0` exists), in every state.
- The view types are the existing ones, so no new serialisation beyond `soldPart`.

### 10.2 Paging

- The cursor `next` is `<atMs>:<rank>:<id>` of the last item, where `rank` orders the sources and `id` is the document's `_id`. It is opaque to the client.
- Each source is queried for its newest `limit` rows with `at <= cursor.at`, sorted by `(at desc, _id desc)`. The server merges and sorts by the full key `(at, rank, id)` descending, drops items at or after the cursor key, takes `limit`. `next` is the last item's key when more remain, otherwise null. More than `limit` rows with one timestamp in one source can no longer be cut arbitrarily.
- Positions use two queries (by `openedAt`, by `settledAt` not null), perps the same.
- No new index. The existing `accountId`-first indexes narrow every query to the account's rows, which are sorted in memory. If the logged `pnl.feed` durations call for an index, add plain `(accountId, at)` ones, not partial ones: the repo already met the planner skipping a `$type` partial filter (`db/migrations.ts:160-168`).

### 10.3 Table rows

The rows shown are the union, by `Activity.id`, of the pages loaded so far for the chosen filter and the live rows (today's `useActivity` output, including pending buys, pending withdrawals and optimistic rows) whose `at` is not older than the oldest loaded page row when more pages exist. On a clash the live row wins: it is fresher. This keeps the table instant, keeps pending rows, and has no gap, because a page is complete down to its last row.

- **The deposit id comes from the document.** Today a deposit's `Activity.id` is built from `txHash`, or `txHash:logIndex` only when the loaded list holds more than one log for that transaction (`historyRows` in `lib/account/state.ts:595-607`). A page and the live list can disagree on that. Phase 2 changes `historyRows` to carry `DepositView.id`, and the row id becomes `deposit:<DepositView.id>`. The optimistic pending row keeps `txHash` as its id and is dropped when a credited deposit with that `txHash` arrives, as today.
- **A partial sale arrives live.** The `prediction:update` payload already carries the sell order, and with `soldPart` on its view the client builds the `sale` row from it. The table needs no refetch on `pnl:changed`. After every reconnect (`account:open`) the first page of the active filter is fetched again, so a missed push is repaired.
- Swap rows from a page show their USD size only when the order is 7 days old or less and its coin has a price; older ones show "—". The order does not store its dollar size, and today's price for an old swap would be wrong.

### 10.4 Activity card

- The filter chips send `filter` to the server and swap the list to that filter's pages.
- Until the first page for the filter has answered, no empty message is shown (it would flash for anyone with old history). Rows already live show. If there are none the card keeps its body height with `aria-busy`, no extra text.
- A text button "Show older" sits under the last row while `next` is set. It loads one page, is disabled while loading, and goes away at the end. No infinite scroll, no counter, no "end of history" label.
- A failed page leaves the button, which then retries.
- The empty states stay "Nothing here yet" and "No deposits yet", and appear only once `next` is null and nothing is listed.

### 10.5 Phase 2 limits and tests

`activity:list` has the same auth as 7, with its own limiter, 60 per minute per user. It is logged as `pnl.feed`.

Server: 130 rows over all kinds, many with the same timestamp, paged at 50 (every row once, newest first, `next` null at the end, the same for `trades` and `deposits`); ties of more than `limit` rows in one source; an empty account gives `{ items: [], next: null }`; a position's open and settle appear as separate items with the right `part`; a partial sale is one `sale` item with no `open`; a swap that was never sent is absent; two deposit logs in one transaction split across two pages appear once each and keep one id between the live list and the page; `limit` and `filter` validation; an unbound socket is refused, two users never see each other's rows, and the rate limit holds. Logic: the item-to-`Activity` mapping for every `part`, the overlay (live wins, older live rows dropped while more pages exist, pending rows survive). Browser: more than 50 old rows show "Show older", which loads the next page and goes away at the end; the Deposits chip lists old deposits; the first paint of a person with old history never shows "Nothing here yet".

## 11. Order of work

Phase 1 and phase 2 are built together (Owner's decisions, 1). Each step is built with its tests (sections 9 and 10.5).

1. The partial-sale record (section 4) and its tests. It changes no screen.
2. `PnlService`: reading, bucketing, the unit rule, with integration tests including the ledger check and the zone cases.
3. Protocol types, the `pnl:series` event, validation, limiter, the `pnl:changed` push and the log line.
4. The `activity:list` event (section 10.1, 10.2 and 10.5): reading, cursor paging, the `filter`, the `soldPart` field on `PredictionOrderView`, validation beside `depositPage`, the limiter and the `pnl.feed` log line, with its server tests.
5. Client, Balance card: the hook and store, the card on the series. Delete `balanceHistory` and `daysSince`. Logic specs.
6. Client, Activity card: the deposit-id change in `historyRows`, the pages merged with the live rows, the filter chips on the server, the "Show older" button (sections 10.3 and 10.4). Logic specs.
7. E2E seeding and the browser tests for both cards.
8. Docs: `docs/sentence-builder.md` (the PnL page section no longer describes "what the server holds" for the chart or the table), and the known-gap line about the 35-day trim in `docs/superpowers/plans/2026-10-12-polymarket-followups.md`.

Steps 1 to 4 ship with no visible change (the old client ignores the new events and the extra `soldPart` field); step 5 switches the chart and step 6 the table.

## Not included

- A result cache (see Decisions).
- New indexes (see Decisions and 10.2).
- Unrealized PnL on the PnL page, or an all-time figure in the sidebar.
- New ranges (1D, 1W, 1M, 1Y) or a custom range.
- Raising `SETTLED_KEEP_MS` or loading older deposits into the sidebar's history.
- Infinite scroll, export, or per-kind totals. The page shows none of these, and the by-kind split is available in tests only.
- A backfill of partial sales booked before section 4 (see Open questions 1).
- **Any change to the merge migration** (Owner's decisions, 4). `movePositions` marks the absorbed position `closed` with proceeds 0, which the series reads as a loss of its cost. Merges run only at start-up for accounts from before one account per person; new accounts cannot be merged (`docs/superpowers/plans/2026-10-12-polymarket-followups.md:128-134`). Deleting the absorbed document would remove a record that `prediction_orders.positionId` may point to, and a `closed`, proceeds 0 document cannot be told from a real zero-proceeds sale. Open questions 2 counts the accounts this touches.
- Storing a swap's dollar size at order time.

## Open questions

1. **Were any partial prediction sales booked before section 4?** Trading is off until the owner's live check, so none are expected. Live check, in the Mongo shell on the VPS: count `prediction_orders` with `side: "sell"` and `state: "filled"` whose `positionId` points to a position that is still `open` or `closing`. Above zero, those accounts' series differ from the ledger by those sales.
2. **Did any account merge ever run?** Live check: count `accounts` that have `formerDepositAddresses` (only a merge sets it). Zero means no account is touched. Above zero, those accounts' series show the absorbed positions as a loss of their cost, which the owner decided to leave (Owner's decisions, 4).
3. **Does one run stay fast on a real account?** Live check: after launch, read the `pnl.series` log lines (duration, row counts). If the 95th percentile passes 100 ms, move the day-grouping into Mongo (3.3) or take the cache.
4. **Do the browsers' current zone names all exist in Node 26's `Intl`?** `Europe/Kyiv` is accepted by the local Node 26.11 (checked 2026-10-14); the server image is `node:26-slim` (`deploy/server.Dockerfile`), whose exact build was not checked. A newer browser name `Intl` lacks falls back to `UTC` (section 8) and costs only a few hours of offset in the day edges. Live check: log how often the fallback fires.

## Owner's decisions (2026-10-14)

1. **How much to build now: phase 1 and phase 2 together.** The series and totals (`pnl:series`, sections 3 to 6) and the paged history table with "Show older" (`activity:list`, section 10) are one delivery. Accepted cost: a paged event, a merge of pages with the live rows, the "Show older" button, and about as much client and test work again as phase 1.
2. **Headline Balance on the PnL page: kept as it is.** Cash plus the money in open positions at cost, now correct over the whole history. Accepted cost: it stays different from the sidebar's cash figure.
3. **Partial prediction sale: recorded on the sell order (`soldPart`, section 4).** One optional field, written in the fill's own transaction, and listed in the table as a `sale` row (10.1).
4. **Positions absorbed by an old account merge: nothing is done.** Merges cannot happen for new accounts. Accepted cost: the series of any account that was merged shows a loss of the absorbed cost (Open questions 2 counts them).
