# All-time PnL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PnL page tells the truth for every range however old the history is: its chart comes from a server-side `pnl:series` and its table pages back through the whole history with `activity:list` and a "Show older" button.

**Architecture:** A new `server/src/pnl/` module reads the entity collections (`deposits`, `withdrawals`, `positions`, `prediction_orders`, `perp_positions`), never the ledger. `PnlService` cuts events into local days with `Intl` and rolls them into day, week or month buckets; `ActivityFeed` merges per-source queries into one cursor-paged list. One small write is added so a partial prediction sale is recorded (`soldPart` on the sell order). The client replaces the row-derived chart with the server series (`lib/pnl/*`, a hook and a store) and layers server pages under the live rows it already has.

**Tech Stack:** Node 24 + Express 5 + socket.io + zod + MongoDB replica set (server), vitest, Next.js 16 + React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-all-time-pnl-design.md`. Spec section 11's steps 1 to 8 map to Tasks 1 to 12 below (step 2 is Tasks 2 to 4, step 3 is Task 5, step 4 is Tasks 6 and 7, step 5 is Tasks 8 and 9, step 6 is Tasks 10 and 11, step 7 is Task 12, step 8 is folded into Task 11). The spec's "Open questions" 1 to 4 are live checks and belong to the owner, after Task 12.

## Global Constraints

- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -- <paths>`) with only your own hunks. The working tree already has unrelated changes (`.impeccable/hook.cache.json`, other specs under `docs/superpowers/specs/`); never stage them.
- **Comments** are one line each and describe the code as it is.
- Never read or print any `.env` file.
- **No real external service and no real transaction in any test.** Use the fakes in `server/test/support/`. The live checks (end of this plan) are the owner's.
- **Browser tests** run only from an isolated copy of the repo, on ports 3650 (app), 4650 (API), 4651 (control) via `E2E_PORT`, `E2E_API_PORT`, `E2E_CONTROL_PORT`. Never 3000, 3100, 4500 or 27018. Other sessions share this working tree, `.next` and port 3100, so a run in the tree itself corrupts theirs. Make the copy like this: `git archive HEAD | tar -x` into a new directory in your scratchpad, clone `node_modules` and `server/node_modules` into it with `cp -cR` (an APFS clone, so it is fast), then copy your changed and new files over it. Run `npx playwright test ...` from inside the copy.
- **Checks:** server `cd server && npm test && npx tsc --noEmit`; logic `npm run test:logic`; app types `npx tsc --noEmit -p .`; for client tasks also `npx eslint <the files you changed>`; and `npx prettier --check <the files you changed>` for every task (the repo's `.prettierrc.json`: 4 spaces, 120 columns, double quotes). Run every one that applies before each commit. `npm test` in `server/` needs Foundry's `anvil` (or `ANVIL_PATH`) and starts its own throwaway MongoDB (see `server/README.md`, "Tests"); if `anvil` is missing, stop and report it rather than skipping the suite.
- **Tests that wait on a limiter or a clock** use the injected `now` or a paced loop; none sleeps longer than 12 s, and vitest's per-test timeout is 30 s (`server/vitest.config.ts`).
- **Server conventions:** ESM, imports end in `.ts`, `erasableSyntaxOnly` (no enums, no constructor parameter properties), `noUncheckedIndexedAccess`. `server/src/protocol.ts` stays free of imports and runtime code; the app imports it as types from `@/server/src/protocol`.
- **Next.js:** `AGENTS.md` says this Next differs from what you know. Nothing here needs a new Next API (client components only). If you reach for routing, data fetching or config, read the guide in `node_modules/next/dist/docs/` first.
- **Money:** amounts are wei `Decimal128` in the database. Read them with `fromDecimal` into `bigint`, sum as `bigint`, and format with `formatUsdc`. Never do `Number` math on wei. Client figures are `Number(string)` for display only.
- **Spec values, verbatim:**
    - `pnl:series` payload `{ tz: string }`, at most 64 characters (zod); a non-string is `bad_request`; a string `Intl` rejects (including `""`) is cut in `UTC` and the answer's `tz` is `"UTC"`. Ranges `7D`, `30D`, `All`; `7D` and `30D` are always 7 and 30 `day` points ending on the local date of `now`.
    - `All` starts at the local date of the account's earliest event of any kind, and never has fewer than 7 days. Unit: `day` when the days from the first date to today (both counted) are `<= 90`; else `week` when the Monday-aligned weeks (both ends counted) are `<= 90`; else `month`. The first bar of `7D` and `30D` starts from the sum of every earlier event; for `All` it starts from 0.
    - Events `(at, net, pnl)`: deposit `creditedAt`, `+amount`, 0; withdrawal (state not `failed`) `createdAt`, `-amount`, 0; prediction position in `closed | won | lost` at `settledAt`, pnl `closed: proceeds - cost`, `won: payout - cost`, `lost: -cost`; partial sale (`prediction_orders` with `soldPart`) at `soldPart.at`, pnl `soldPart.proceeds - soldPart.cost`; perp position in `closed | liquidated` at `settledAt`, pnl `proceeds - collateral` (never `realizedPnl`). Swaps are not events.
    - `start` is a local date `YYYY-MM-DD` (a Monday for a week, the 1st for a month); `balance`, `pnl`, `net` are `formatUsdc` strings.
    - `pnl:changed` (no payload) goes to the account's owner-checked sockets on: `deposit:credited`, `withdrawal:updated`, `position:settled`; `prediction:updated` only for a sell with state `filled`; `perp:updated` only when it carries no position or a position with `settledAt` set. The client asks again 400 ms (trailing debounce) after it.
    - Limits: `pnl:series` 30 per minute per user (`keyPrefix: "pnl-series"`), `activity:list` 60 per minute per user (`keyPrefix: "activity-list"`), both on top of the shared 40 events per 10 seconds. Logs at `info`: message `pnl.series` and `pnl.feed`, each with the duration and the row count per source.
    - `activity:list` payload `{ before?: string; limit?: number; filter?: "all" | "trades" | "deposits" }`; `limit` default 50, 1 to 100; `deposits` is deposits and withdrawals, `trades` is swaps, predictions, sales and perps. Cursor `next` is `<atMs>:<rank>:<id>`, opaque to the client.
    - `SETTLED_KEEP_MS` stays 35 days; the session, the 7-day swaps and the sidebar do not change.
    - Copy: "Show older", "Couldn't load your history.", "No balance yet", "Nothing here yet", "No deposits yet"; headings "Balance on Mar 3" (day), "Balance, week of Mar 3" (week), "Balance in March" (month); the hover line says "that day", "that week" or "that month"; unlabelled strings stay "Balance", "PnL so far", "PnL over 7 days", "PnL over 30 days". No other new labels.

## Review Focus

1. **"Show older" clicked twice, or a page answer that lands after the person switched filter.** The page is appended once, to the filter it was asked for, and never twice. (Task 10 tests.)
2. **Two `pnl:series` requests in flight and the older answer lands last** (a burst of `pnl:changed`). The newer series stays on screen. (Task 8 test.)
3. **An event dated after the local "today"** (the Arc node's clock a few seconds ahead of the server, or midnight passing during a run). It lands in today's bar and the last balance still equals the total; nothing is dropped. (Task 2 test.)
4. **A withdrawal on a loaded page that later fails.** Its row disappears, as it does from the live list today, and does not linger from the page. (Task 10 test.)
5. **A garbled `before` cursor** (wrong shape, rank out of range, a time past the Date range, a non-hex id). `bad_request`, never a Mongo error or a thrown `ObjectId`. (Tasks 6 and 7 tests.)
6. **A partial sale booked twice, or counted twice** (money moved twice). A repeated fill and two `settleLate` calls at once write one `soldPart` and one ledger row; a partial sale followed by a sale of the rest counts the first part once (in `soldPart`) and the rest once (on the closed position). (Task 1 tests for the repeat and the race; Task 4 test for the follow-up sale.)
7. **A restart or crash in the middle of a sell fill.** The fill is one transaction, so a fill that fails after the position was changed leaves no `soldPart`, no ledger row and the order still `posted`. (Task 1 rollback test.)
8. **Two `pnl:series` requests at once, and a run that fails.** Concurrent identical requests share one run; a run that rejects is not kept, so the next request runs again instead of getting the old error. (Task 3 tests.)
9. **An outage.** A database error on `pnl:series` answers `internal` and leaves the socket usable (Task 5 test). In the browser, a failing `pnl:series` shows "Couldn't load your history." and a later `pnl:changed` repairs it, and a failing `activity:list` never shows "Nothing here yet" and repairs itself (Task 12 tests).
10. **A limiter that hides another limiter.** The shared 40-events-in-10-seconds limit trips before a 60-a-minute one, so the `activity:list` limit test is paced across two windows. (Task 7 test.)

---

### Task 1: The partial-sale record (spec §4)

**Files:**

- Modify: `server/src/db/mongo.ts` (`PredictionOrderDoc`), `server/src/predictions/predictions.ts` (`#bookSellFill`, `#settleSell`, `settleLate`), `server/src/protocol.ts` (`PredictionOrderView`), `server/src/predictions/views.ts` (`orderView`)
- Test: `server/test/integration/prediction-close.test.ts`, `server/test/integration/prediction-tracker.test.ts`, `server/test/unit/prediction-views.test.ts` (new). The reconciler test imports `PredictionReconciler` from `server/src/predictions/reconciler.ts`.

**Interfaces:**

- Produces, `PredictionOrderDoc.soldPart?: { cost: Decimal128; proceeds: Decimal128; at: Date }`, wei. Set only on a sell order whose fill left the position open.
- Produces, `PredictionOrderView.soldPart?: { costUSD: UsdcAmount; proceedsUSD: UsdcAmount; at: string }`, present only when the doc has it (spec section 11 lists the view field with `activity:list`; it lands here so the order every `prediction:update` push carries has it from the start).
- `#bookSellFill` now returns `{ order: PredictionOrderDoc; position: PositionDoc; account: AccountDoc }`: `order` is `moved` with `soldPart` applied in the keep branch, `moved` itself otherwise. `#settleSell` and `settleLate` pass that `order` to `#afterSettle`.

- [ ] **Step 1: Write the failing tests.**
    - `prediction-close.test.ts`, `"a buy that fills while a sell is out leaves the position open and records the sold part on the sell order"` (same setup as `"shares bought while a sell is posted stay open after the sell settles"`, same file): the sell order has `soldPart`; `fromDecimal(soldPart.cost) + fromDecimal(left.cost)` is `wei("20")` (the cost before: 10 + 10); `fromDecimal(soldPart.proceeds)` equals the amount of the `prediction_sell` ledger row; `soldPart.at` is a `Date`; `positions.countDocuments({ accountId })` is still 1 and none is `closed`; a `prediction:updated` listener on `h.bus` saw the sell order with `soldPart`.
    - `"a sell that closes the position sets no soldPart"`: after `"a filled close credits the proceeds and closes the position"`'s flow the order has no `soldPart` key.
    - `prediction-tracker.test.ts`, `"a late sell fill that leaves shares records the sold part"` (use `heldPosition()`; fill `{ makingE6: 12_000_000n, takingE6: 5_760_000n }`): order `{ state: "filled", lateFill: "settled" }`; position `open` with shares 8_000_000 and cost `wei("4")`; `soldPart.cost` is `wei("6")` and `soldPart.proceeds` is `wei("5.76")`; `h.state(...)` has `balance` `wei("5.76")` and `sum === balance`.
    - `"a late partial sell fill booked twice records one sold part"`: `stored` is the failed order re-read from `predictionOrders` after `heldPosition()`; two concurrent `h.service.settleLate(stored, 12_000_000n, 5_760_000n)`; one `prediction_sell` row, one `soldPart`, and the balance is `wei("5.76")`, not twice that.
    - `prediction-tracker.test.ts`, `"a partial sell fill delivered twice records one sold part"`: a posted sell on a position of 20 shares; `await h.service.settle(order, 12_000_000n, 5_760_000n)` twice in a row (a repeat is a no-op): one `prediction_sell` row and one `soldPart`.
    - `prediction-close.test.ts`, `"a partial sell fill that fails midway leaves no sold part"` (a restart or crash in the middle of the fill's transaction): build a posted sell with the buy-during-sell setup above (do not settle it yet), note the position's shares and cost, and delete the account document (`accounts.deleteOne`) once the buy has filled, so the credit inside the transaction throws "No account … to credit", then `await expect(h.service.settle(sell, ...)).rejects.toThrow()`. Afterwards the sell order is still `posted` with no `soldPart` key, the position is still `closing` with its shares and cost unchanged, and there is no `prediction_sell` ledger row. (The transaction rolls back as one; this proves `soldPart` is written inside it and not after it.)
    - `prediction-close.test.ts`, `"after a partial sale the reconciler finds no mismatch"`: use a private `predictionHarness()` (not the shared `h`), seed the holder with `own.trader.setHoldings([{ tokenId: TOKEN, sharesE6: 20_000_000n }])` because the holder's shares never went through the trader, run the buy-during-sell flow, then `new PredictionReconciler({ collections, trader: () => own.trader, logger, intervalMs: 0 }).tick()` with a capturing `pino` logger (the pattern at the top of `prediction-redeemer.test.ts`). Assert no log line with message "The pool's holdings don't match the positions". If the fake trader's holdings arithmetic makes the expected figure differ from 20 shares, fix the seeded number, not the assertion.
    - `prediction-views.test.ts`: `"orderView carries soldPart as costUSD, proceedsUSD and an ISO at"` (cost `wei("6")`, proceeds `wei("5.76")` gives `{ costUSD: "6", proceedsUSD: "5.76", at: <iso> }`); `"orderView leaves soldPart out when the doc has none"` (`"soldPart" in view` is false).
- [ ] **Step 2: Run them and watch them fail.** Run: `cd server && npx vitest run test/integration/prediction-close.test.ts test/integration/prediction-tracker.test.ts test/unit/prediction-views.test.ts`. Expected: FAIL (`soldPart` undefined).
- [ ] **Step 3: Implement.** Add the optional field to `PredictionOrderDoc` and to `PredictionOrderView`, and have `orderView` add it with a conditional spread so the key is absent when the doc has none (`costUSD`, `proceedsUSD` through `formatUsdc(fromDecimal(...))`, `at` through `toISOString()`). In `#bookSellFill`'s keep branch, in the same session, `findOneAndUpdate` the sell order `{ _id: moved._id }` with `$set: { soldPart: { cost: before.cost - newCost, proceeds, at: now } }` and `returnDocument: "after"` (`newCost` is the value already computed for the position; `proceeds` is the amount credited, net of fee) and return that order. Write it before the credit or after it, but inside the same `session`; the rollback test above is what proves it. The enclosing fill guard (`state: "posted"`, or the late-fill guard) is what makes it once; add no new guard.
- [ ] **Step 4: Run** the three files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Record the result of a partial prediction sale on the sell order`.

### Task 2: Day cutting and bucketing, pure (spec §3.3, protocol types)

**Files:**

- Create: `server/src/pnl/zones.ts`, `server/src/pnl/series.ts`
- Modify: `server/src/protocol.ts`
- Test: `server/test/unit/pnl-zones.test.ts`, `server/test/unit/pnl-series.test.ts`

**Interfaces:**

- Produces, `protocol.ts`: `PnlUnit = "day" | "week" | "month"`; `PnlPoint = { start: string; balance: UsdcAmount; pnl: UsdcAmount; net: UsdcAmount }`; `PnlRangeKey = "7D" | "30D" | "All"`; `PnlSeries = { tz: string; ranges: Record<PnlRangeKey, { unit: PnlUnit; points: PnlPoint[] }> }`.
- Produces, `zones.ts`: `type Zone = { tz: string; dateOf(ms: number): string }` and `zoneOf(tz: string): Zone`. `dateOf` returns the local `YYYY-MM-DD` from a cached `Intl.DateTimeFormat` (`en-CA`, `calendar: "gregory"`, `numberingSystem: "latn"`, `formatToParts`). A name `Intl` rejects gives the `UTC` zone with `tz: "UTC"`. Accepted zones are cached by the name as given, and `tz` echoes that name.
- Produces, `series.ts`: `type DayTotals = { net: bigint; pnl: bigint }`; `addDays(date: string, n: number): string`; `buildRanges(days: ReadonlyMap<string, DayTotals>, today: string): PnlSeries["ranges"]`. All date arithmetic is on calendar numbers (`Date.UTC(y, m - 1, d)` over 86_400_000), never on instants. `days` has a key for every event, even one whose `net` and `pnl` are both 0 (a perp closed at exactly its collateral), because `All` starts at the earliest key; `buildRanges` never looks at the amounts to decide the start. A key later than `today` is summed into `today` first. Week buckets start on the Monday on or before a date, month buckets on the 1st; `balance` is the running total at the end of the bucket.

- [ ] **Step 1: Write the failing tests.**
    - `pnl-zones.test.ts`: `"an event at 23:30 UTC is the next day in Asia/Tokyo and the same day in UTC"` (`2026-10-13T23:30:00Z`); `"New York spring-forward day keeps 00:30 and 23:30 local on one date"` (`2026-03-08T05:30:00Z` and `2026-03-09T03:30:00Z` both give `2026-03-08`; `2026-03-08T04:59:00Z` gives `2026-03-07`); `"New York fall-back day keeps 00:30 and 23:30 local on one date"` (`2026-11-01T04:30:00Z` and `2026-11-02T04:30:00Z` give `2026-11-01`; `2026-11-02T05:00:00Z` gives `2026-11-02`); `"Asia/Kolkata and Asia/Kathmandu cut on local midnight"` (`2026-10-13T18:29:00Z` and `18:30:00Z` give `2026-10-13` then `2026-10-14` for Kolkata; `18:14:00Z` and `18:15:00Z` for Kathmandu); `"current names work"` (`Europe/Kyiv`, `America/Argentina/Buenos_Aires` keep their own `tz`); `"a name Intl rejects is UTC"` (`"Not/AZone"`, `""`, a 64-character string: `tz` is `"UTC"` and `dateOf` is the UTC date); `"a zone is built once"` (`zoneOf("Asia/Tokyo") === zoneOf("Asia/Tokyo")`).
    - `pnl-series.test.ts`, with `today = "2026-10-14"` (a Wednesday) unless a case says otherwise:
        - `"no events give 7, 30 and 7 zero points ending on today"` (unit `day`, last `start` is `2026-10-14`, every amount `"0"`).
        - `"7D and 30D start from every earlier event"` (a `+500` net 40 days ago and `-100` pnl 35 days ago: every 7D point and the first 30D point have balance `"400"`).
        - `"quiet days carry the running balance"`; `"7D and 30D have exactly 7 and 30 points, all days"`.
        - `"All is never fewer than 7 points, even for an event today"` (first `start` is `2026-10-08`).
        - `"an event whose net and pnl are 0 still sets where All starts"` (one key at `2026-07-17` with `{ net: 0n, pnl: 0n }` and one at today with `+10`: `All` is `day` with 90 points).
        - `"the All unit follows the aligned counts"`, one event at the first date each: `2026-07-17` (90 days) is `day` with 90 points; `2026-07-16` (91 days) is `week` with 14 points; 400 days back is `week`; `2025-01-27` (a Monday, 90 aligned weeks) is `week` with 90 points; `2025-01-26` (a Sunday, 91 aligned weeks though 627 days) is `month`; `2018-07-28` is `month`.
        - `"week starts are Mondays and month starts are the 1st, each a valid date"`.
        - `"week and month buckets sum net and pnl"`; `"the last balance is the total in 7D, 30D and All"`.
        - `"an event dated after today lands in today's bar"` (key `2026-10-15` with `+10`: the last 7D, 30D and All balance includes it and no earlier bar changes).
        - `"a 7D range over the New York spring-forward day has 7 points"` (`today = "2026-03-10"`: starts `2026-03-04` to `2026-03-10`).
- [ ] **Step 2: Run them and watch them fail.** Run: `cd server && npx vitest run test/unit/pnl-zones.test.ts test/unit/pnl-series.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `zones.ts`, `series.ts` and the protocol types. Format with `formatUsdc` from `server/src/db/money.ts`.
- [ ] **Step 4: Run** both files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Cut events into local days and roll them into day, week or month bars`.

### Task 3: `PnlService` reads and the shared history seed (spec §3.1 to 3.3, §7 log)

**Files:**

- Create: `server/src/pnl/pnl.ts`, `server/test/support/history-seed.ts`
- Modify: `server/src/services.ts` (`pnl: PnlService`), `server/src/server.ts` (build it beside `sessions`, with `{ collections, logger: logger.child({ component: "pnl" }), now: overrides.now }`, and add it to `services`)
- Test: `server/test/integration/pnl-series.test.ts`

**Interfaces:**

- Consumes: `zoneOf`, `buildRanges`, `DayTotals` (Task 2).
- Produces, `PnlService`: `constructor(deps: { collections: Collections; logger: Logger; now?: () => number })` and `series(accountId: ObjectId, tz: string, now?: number): Promise<PnlSeries>`. One `find({ accountId, ... })` per source with only the needed fields projected, the five reads in `Promise.all`. Concurrent calls with the same `(accountId, tz)` share one run (a `Map` of in-flight promises, deleted in a `finally` so a run that rejects is not served to the next request); nothing is cached after. Every event adds a key to the per-date map even when its `net` and `pnl` are both 0. Logs `logger.info({ accountId, ms, rows: { deposits, withdrawals, positions, sales, perps } }, "pnl.series")`.
- Produces, `history-seed.ts` (used by Tasks 3, 4, 5, 6, 7, 12):

    ```ts
    export type SeedRow =
        | { kind: "deposit"; usdc: string; at: Date; txHash?: string; logIndex?: number }
        | { kind: "withdrawal"; usdc: string; at: Date; state?: WithdrawalState }
        | { kind: "swap"; at: Date; state?: SwapOrderState; sent?: boolean }
        | {
              kind: "prediction";
              state: PositionState;
              cost: string;
              proceeds?: string;
              payout?: string;
              openedAt: Date;
              settledAt?: Date;
          }
        | { kind: "sale"; cost: string; proceeds: string; at: Date }
        | {
              kind: "perp";
              state: PerpPositionState;
              collateral: string;
              proceeds?: string;
              openedAt: Date;
              settledAt?: Date;
          };
    export function seedRows(collections: Collections, accountId: ObjectId, rows: SeedRow[]): Promise<ObjectId[]>;
    ```

    It inserts complete documents (every required field of `DepositDoc`, `WithdrawalDoc`, `SwapOrderDoc`, `PositionDoc`, `PredictionOrderDoc` with a `soldPart`, `PerpPositionDoc`), one per row, and returns their `_id`s in order. Fields the row type does not carry get fixed defaults: a prediction or sale is on the question "Will it rain?" with the outcome "Yes" and a fresh `tokenId` per row (the open-position unique index is `(accountId, tokenId)` for `open` and `closing` only, so settled rows could share one, but a fresh one is safe for every state), 20 shares, event `evt-seed`; a perp is a long on `BTC` at 5x with a fresh `index`/`asset` pair (its open-position unique index is `(index, asset)` for `active` rows, and `active` is `true` only for `open` and `closing`); `settledAt` is null for `open` and `closing` rows and `proceeds`/`payout` default to null. A sale is a filled sell order with `soldPart` and no `positionId`. `_id`s are ObjectIds stamped with the row's own date (`at`, `openedAt` or `creditedAt`, with a random tail, as `objectIdAt` in `server/test/e2e/serve.ts` does), so id order follows date order like real data. `sent: false` on a swap leaves `txHashes` empty. A deposit gets a random `txHash` unless one is given; a withdrawal a random `requestId`. It writes no ledger rows and does not touch the account balance.

- [ ] **Step 1: Write the failing tests** in `pnl-series.test.ts` (a throwaway database from `connectDatabase(inject("mongoUri"), ...)` as the harnesses do; `tz` is `"UTC"` and `now` is `Date.UTC(2026, 9, 14, 12)` unless a case says otherwise; amounts are the sums of the figures):
    - `"the regression: old history is in the 7D and 30D starting balance and in All"`: seed a deposit 500 (500 days ago), a prediction `lost` cost 100 (400 days ago), a perp `liquidated` collateral 40 proceeds 0 (200 days ago), a perp `closed` collateral 50 proceeds 80 (50 days ago), a deposit 20 (10 days ago). Assert 7D points all have balance `"410"`; the first 30D point has balance `"390"` and the last `"410"`; the sum of 7D and of 30D `pnl` is `"0"`; `All` has unit `week` and the sum of its `pnl` is `"-110"` and its last balance `"410"`.
    - `"a withdrawal in sending counts; a failed one does not; a Solana withdrawal in forwarding counts"` (net of the day is `-` the sum of the first and third).
    - `"a lost prediction and a zero-proceeds liquidation show in pnl"`; `"a won position is payout minus cost and a closed one proceeds minus cost"`.
    - `"a partial sale adds soldPart.proceeds minus soldPart.cost at soldPart.at"`.
    - `"the figures are the same in every range today"`: last balance of 7D, 30D and All is equal.
    - `"concurrent identical requests share one run"`: two simultaneous `series` calls log `pnl.series` once; a later third call logs again. The log carries `ms` and `rows` with counts. The service is built with a capturing `pino` logger (`pino({ level: "info" }, { write: (line) => lines.push(JSON.parse(line)) })`, as `perp-harness.ts` does).
    - `"a run that fails is not served to the next request"` (an outage): `vi.spyOn(collections.deposits, "find").mockImplementationOnce(() => { throw new Error("db down"); })`; two simultaneous `series` calls both reject with "db down"; a third call after they settle resolves with the real series.
    - `"an event with zero net and zero pnl still sets where All starts"`: a perp `closed` with proceeds equal to its collateral 100 days ago and a deposit today; `All` starts 100 days back (unit `week`).
    - `"a zone Intl rejects answers in UTC"`: `series(id, "Not/AZone")` has `tz: "UTC"`.
    - `"no account rows give three ranges of zeros"`.
- [ ] **Step 2: Run and watch it fail.** Run: `cd server && npx vitest run test/integration/pnl-series.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `pnl.ts`, `history-seed.ts` and the wiring. A settled position's time is `settledAt ?? updatedAt`, as the client's `predictionActivity` reads it. A missing `proceeds` or `payout` counts as 0.
- [ ] **Step 4: Run** the file, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Read an account's whole PnL history from the entity collections`.

### Task 4: The ledger check against real flows (spec §9 Ledger check, Deposits)

**Files:**

- Test: `server/test/integration/pnl-ledger.test.ts` (new). No production file changes unless a test finds a bug; fix it in the smallest place.

**Interfaces:**

- Consumes: `PnlService` (Task 3), `predictionHarness` (`server/test/support/prediction-harness.ts`), `perpHarness` (`server/test/support/perp-harness.ts`), `PredictionResolver` (see `prediction-resolver.test.ts` for its construction with a fake Polymarket), `PerpTracker` (see `perp-tracker.test.ts`'s liquidation test).
- Helper in the test file: `cashPlusOpenCost(h, accountId)`: the account's `balance` plus the `cost` of positions in `open | closing` plus the `collateral` of perp positions in `open | closing`. The harness `seedAccount` writes the ledger row only, so each test also inserts a matching `deposits` document (same amount, `creditedAt` now) through `seedRows` so the series sees it.

- [ ] **Step 1: Write the tests** (each finishes a real flow, then asserts `last point of All` `balance` equals `formatUsdc(cashPlusOpenCost)` for the three ranges):
    - `"buy then sell"`; `"buy then resolve won"`; `"buy then resolve lost"` (after the real buy, update the position's `marketId`, `tokenId` and `conditionId` to a fresh market from `startFakePolymarket()`'s fixtures, as `market()` and `holder()` do in `prediction-resolver.test.ts`, call `fake.resolve(id, ["1", "0"])` and `resolver.tick()`; the resolver is built as in that file's `beforeAll`).
    - `"perp open then close"`; `"perp open then liquidation to zero"`.
    - `"two buys, one sold: the balance is cash plus the cost of the one still open"`.
    - `"a partial prediction sale: the balance is cash plus the remaining cost"` (the buy-during-sell flow of Task 1).
    - `"a partial sale and then a sale of the rest count each part once"` (money moved twice): continue that flow by selling the remaining shares with `h.service.close` until the position is `closed`; the series' last balance equals the account's cash (nothing is open), and `All`'s summed `pnl` equals `soldPart.proceeds - soldPart.cost` plus `closed.proceeds - closed.cost` (not either of them twice).
    - `"two deposits from one transaction each count once, and net equals the ledger's deposit entries"`: credit two `NativeTransfer`s (same `txHash`, `logIndex` 0 and 1) through `h.ledger.credit(transfer, accountId, "scan")`; the sum of `net` over `All` equals the sum of `kind: "deposit"` ledger amounts, and `deposits` has 2 documents.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/pnl-ledger.test.ts`. Expected: PASS where Tasks 1 to 3 are right; any FAIL is a missing event kind or a wrong sign, fix it in `pnl.ts`.
- [ ] **Step 3: Run** `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 4: Commit.** Message: `Check the PnL series against the ledger after real prediction and perp flows`.

### Task 5: `pnl:series` and the `pnl:changed` push (spec §5, §7, §8)

**Files:**

- Modify: `server/src/protocol.ts` (events), `server/src/validation.ts` (`pnlSeries`), `server/src/socket/sockets.ts`
- Test: `server/test/integration/pnl-socket.test.ts` (new)

**Interfaces:**

- Consumes: `services.pnl.series` (Task 3).
- Produces, `ClientToServerEvents["pnl:series"]: (payload: { tz: string }, ack: (result: Ack<PnlSeries>) => void) => void`; `ServerToClientEvents["pnl:changed"]: () => void`.
- Produces, `validation.ts`: `pnlSeries = z.object({ tz: z.string().max(64) })`.
- Handler order, like the other events: `parse`, the limiter (`pnlSeriesLimit`, `keyPrefix: "pnl-series"`, 30 per 60 s, `rate_limited` "Too many requests. Try again shortly."), then `boundAccount(socket)`, then `services.pnl.series(account._id, tz)`.
- `pnl:changed` is emitted inside the owner-checked loops of the `deposit:credited` (that handler is not in `enqueue` today; emit in its loop), `withdrawal:updated`, `position:settled`, `prediction:updated` (only when `update.order.side === "sell" && update.order.state === "filled"`) and `perp:updated` (only when `!update.position || update.position.settledAt`) handlers, to sockets whose `identity.userId` is the account's `privyUserId`.

- [ ] **Step 1: Write the failing tests** (`startStack` as `prediction-socket.test.ts` does; add `PREDICTIONS_TRADING` and its Polymarket env from that file):
    - `"pnl:series answers all three ranges for the bound account"` (seed two deposits with `seedRows`; ranges `7D`, `30D`, `All`; 7 and 30 points; last balances equal).
    - `"an unbound socket is refused with wallet_not_connected"`.
    - `"two users never see each other's totals"`.
    - `"bad payloads answer bad_request naming tz"`: a missing payload and `{}` (both parse as `{}`), `{ tz: 5 }`, a 65-character string; each message contains `tz`. (A bare number as the whole payload fails the object itself and the message does not name a field, so it is not asserted here.)
    - `"an unknown zone answers tz UTC"` (`"Not/AZone"`).
    - `"the 31st request in a minute is rate_limited"` (31 sequential requests stay under the shared 40-in-10-seconds limit, so only this limiter can answer the last).
    - `"a database error answers internal and the socket keeps working"` (an outage): `vi.spyOn(stack.server.services.pnl, "series").mockRejectedValueOnce(new Error("db down"))`; the first ask answers `{ ok: false, error: { code: "internal" } }` (the message is generic, not "db down"); the second ask answers the series.
    - `pnl:changed` reaches only the owner's sockets (a second user's socket gets none) after: `"a deposit credit"` (a real transfer to the deposit address as `socket.test.ts` does), `"a withdrawal update"` (`bus.emit("withdrawal:updated", ...)` with a seeded withdrawal and its account), `"a sell fill"` (real `prediction:close` flow), `"a settled perp"` (`bus.emit("perp:updated", { order, position, account })` with a seeded `closed` perp position, `settledAt` set, and a minimal order cast to `PerpOrderDoc`), `"a settled prediction"` (`bus.emit("position:settled", ...)`); and not after `"a buy fill"` (real `prediction:order`) or `"a funding tick on an open perp"` (`perp:updated` with a position whose `settledAt` is null). A positive case awaits `pnl:changed` on the owner's socket; a negative case awaits the matching `prediction:update` or `perp:update` first (the handler emits `pnl:changed` right after it, in the same push) and then 300 ms more before asserting that none came. A second user's socket, bound to its own account, must receive no `pnl:changed` in any case. A hand-built `PerpOrderDoc` needs every field `perpOrderView` reads (`_id`, `requestId`, `kind`, `asset`, `side`, `leverage`, `state`, `reason`, `steps: {}`, `collateral`, `sizeCoin`, `createdAt`, `updatedAt`), or the handler throws, logs a warning and sends nothing, and the test waits for a push that never comes.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/pnl-socket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the event types, the limiter, the handler and the emits.
- [ ] **Step 4: Run** the file, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Serve the PnL series over the socket and tell clients when it changes`.

### Task 6: `ActivityFeed`, the paged history (spec §10.1, §10.2, §10.5 server)

**Files:**

- Create: `server/src/pnl/feed.ts`
- Modify: `server/src/protocol.ts` (types), `server/src/validation.ts` (`activityPage`), `server/src/services.ts` (`feed: ActivityFeed`), `server/src/server.ts` (build it beside `pnl`)
- Test: `server/test/integration/activity-feed.test.ts` (new), `server/test/unit/validation.test.ts` (extend)

**Interfaces:**

- Consumes: `seedRows` (Task 3); the existing views `depositView`, `withdrawalView`, `swapOrderView`, `positionView`, `orderView`, `perpPositionView`.
- Produces, `protocol.ts`: `ActivityFilter = "all" | "trades" | "deposits"`; `ActivityItem` and `ActivityPage` exactly as spec §10.1 (`kind`, `at` ISO, `part: "open" | "settle"` on `prediction` and `perp`); `PredictionOrderView` already has `soldPart` (Task 1).
- Produces, `validation.ts`: `activityPage = z.object({ before: z.string().regex(/^\d{1,16}:\d:[0-9a-f]{24}$/, "a cursor from a previous page").optional(), limit: z.coerce.number().int().min(1).max(100).optional(), filter: z.enum(["all", "trades", "deposits"]).optional() })`.
- Produces, `ActivityFeed`: `constructor(deps: { collections: Collections; logger: Logger; now?: () => number })`, `page(accountId: ObjectId, input: { before?: string; limit?: number; filter?: ActivityFilter }): Promise<ActivityPage>`.
    - Eight sources with these ranks and `at` fields: 0 deposit (`creditedAt`), 1 withdrawal (`createdAt`, state not `failed`, the same as today's table and the series), 2 swap (`createdAt`, `txHashes.0` exists, any state), 3 prediction open (`positions.openedAt`), 4 prediction settle (`positions.settledAt`, state in `closed | won | lost`), 5 sale (`prediction_orders` with `soldPart`, `soldPart.at`), 6 perp open (`perp_positions.openedAt`), 7 perp settle (`settledAt` not null). A source is skipped when the filter excludes it.
    - An item's key is `(atMs, rank, id)` with `id` the document's `_id` hex; order is the key descending. Each source asks for its next `limit + 1` rows strictly after the cursor key, sorted `(at desc, _id desc)`, with the bound in the query: `at < cursor.at`, or `at == cursor.at` and (`rank < cursor.rank`, or `rank == cursor.rank` and `_id < cursor.id`). The merge sorts by the key, takes `limit`, and `next` is the last item's cursor when more than `limit` merged rows exist, else `null`.
    - A bad cursor (rank above 7, `atMs` past 8.64e15, an id that is not 24 hex characters) throws `AppError("bad_request", "Invalid before: a cursor from a previous page")`.
    - Logs `logger.info({ accountId, ms, rows: { <source>: count } }, "pnl.feed")`.

- [ ] **Step 1: Write the failing tests.**
    - `validation.test.ts`: `"activityPage accepts no fields, a filter and a limit of 1 or 100"`; `"activityPage rejects limit 0, 101 and 1.5, an unknown filter and a malformed before, naming the field"`.
    - `activity-feed.test.ts` (throwaway database, `seedRows`):
        - `"130 rows over all kinds page at 50 and every row appears once, newest first"`: 30 deposits, 20 withdrawals, 20 swaps, 15 settled predictions (30 items), 10 sales, 10 settled perps (20 items), timestamps drawn from 10 values so many tie. Pages are 50, 50, 30; the last `next` is `null`; the concatenation has 130 distinct keys in non-increasing `(at, rank, id)` order (decode `next` to read the key).
        - `"trades and deposits filters page the same way"`: `trades` gives 80 items (50 then 30), `deposits` gives exactly 50 and `next` is `null`.
        - `"more than limit rows with one timestamp in one source are not cut"`: 60 deposits at one instant, `limit: 25` gives 25, 25, 10, each once.
        - `"an empty account gives { items: [], next: null }"`.
        - `"a position is two items with the right part"`: an open position gives one `open`; a `won` one gives `open` at `openedAt` and `settle` at `settledAt`; when both are the same millisecond the `settle` item comes first.
        - `"a partial sale is one sale item with soldPart and no open"`.
        - `"a swap that was never sent and a failed withdrawal are absent"`.
        - `"two deposit logs in one transaction split across two pages appear once each"` (`limit: 1`; two different `deposit.id`).
        - `"limit defaults to 50"`.
        - `"cursors round trip and keys order by time, then rank, then id"`: `decodeCursor(encodeCursor(key))` equals `key`; `compareKeys` puts the later `at` first, then the higher `rank`, then the higher `id`, and returns 0 only for equal keys.
        - `"a garbled before is bad_request"`: `"x"`, `"1:9:" + 24 hex`, `"99999999999999999:0:" + 24 hex`, `"1:0:zzzzzzzzzzzzzzzzzzzzzzzz"`.
        - `"a run logs pnl.feed with ms and a count per source"`.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/activity-feed.test.ts test/unit/validation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, the schema, `feed.ts` and the wiring. Export a pure `compareKeys(a, b)` and `encodeCursor` / `decodeCursor` from `feed.ts` for the merge and the tests.
- [ ] **Step 4: Run** both files, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Page an account's whole activity history with a stable cursor`.

### Task 7: The `activity:list` socket event (spec §10.5)

**Files:**

- Modify: `server/src/protocol.ts` (event), `server/src/socket/sockets.ts`
- Test: `server/test/integration/activity-socket.test.ts` (new)

**Interfaces:**

- Consumes: `services.feed.page` and `activityPage` (Task 6).
- Produces, `ClientToServerEvents["activity:list"]: (payload: { before?: string; limit?: number; filter?: ActivityFilter }, ack: (result: Ack<ActivityPage>) => void) => void`. Handler order as Task 5, limiter `activityList` (`keyPrefix: "activity-list"`, 60 per 60 s, "Too many requests. Try again shortly.").

- [ ] **Step 1: Write the failing tests** (`startStack`, `seedRows`):
    - `"activity:list answers the first page and then the next with the cursor"` (60 deposits, `limit` 50 then `before: next`).
    - `"filter trades lists no deposits"`.
    - `"an unbound socket is refused with wallet_not_connected"`.
    - `"two users never see each other's rows"`.
    - `"bad payloads answer bad_request naming the field"`: `limit` 0, 101 and 1.5, `filter: "x"`, `before: "garbage"`, and a well-formed cursor with rank 9.
    - `"the 61st request in a minute is rate_limited by its own limiter"`: the shared limit of 40 events every 10 seconds would answer `rate_limited` at the 41st request and hide the 60-a-minute limit, so pace it: send 39 requests (all `ok`; the bind's `account:open` is the 40th event of the window), wait 10.5 seconds (`await new Promise((r) => setTimeout(r, 10_500))`, inside vitest's 30 s timeout), send 21 more (all `ok`; that is 60 in under a minute), then the 61st is `{ ok: false, error: { code: "rate_limited" } }`. Another user is not held up by it.
    - `"a database error answers internal"` (an outage): `vi.spyOn(stack.server.services.feed, "page").mockRejectedValueOnce(new Error("db down"))`; the ask answers `internal`, the next ask answers the page.
- [ ] **Step 2: Run and watch them fail.** Run: `cd server && npx vitest run test/integration/activity-socket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the event type, the limiter and the handler.
- [ ] **Step 4: Run** the file, then `cd server && npm test && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Serve the activity history over the socket`.

### Task 8: Client plumbing for the series: labels, store, account client, hook (spec §6.1)

**Files:**

- Create: `lib/pnl/labels.ts`, `lib/pnl/series-store.ts`, `components/pnl/use-pnl-series.ts`
- Modify: `components/account-client.ts` (`AccountSnapshot.pnl`, `loadPnlSeries`, the `pnl:changed` listener, `disconnect`), `components/account-provider.tsx` (`Account.pnl`, `Account.loadPnlSeries`, `IDLE`, `Provide` defaults)
- Test: `e2e/pnl-series.logic.spec.ts` (new)

**Interfaces:**

- Produces, `labels.ts` (dates are local: `new Date(y, m - 1, d)`, formatted with `Intl.DateTimeFormat("en-US")`):
    - `parseStart(start: string): Date`
    - `headingFor(unit: PnlUnit, start: string): string` ("Balance on Mar 3", "Balance, week of Mar 3", "Balance in March")
    - `nounFor(unit: PnlUnit): string` ("that day", "that week", "that month")
    - `hoverLine(unit: PnlUnit, net: number): string` (`PnL that day`, or `PnL that day, and $50.00 deposited` / `withdrawn` when `net` is not 0, amount through `formatUsd(Math.abs(net))` from `lib/trade/format.ts`)
    - `valueText(unit: PnlUnit, start: string, balance: number): string` (the slider's `aria-valuetext`: `Mar 3: $500.00`, `Week of Mar 3: $500.00`, `March: $500.00`)
- Produces, `series-store.ts`: `storedSeries(tz: string): PnlSeries | null`; `nextSeriesRequest(): number` (increasing); `saveSeries(tz: string, request: number, series: PnlSeries): boolean` (false and nothing stored when a higher request number has already been saved for that `tz`, or when `request` was issued before the last `resetPnlStores()`); `subscribeSeries(listener: () => void): () => void`; `resetPnlStores(): void` (empties the store and notifies subscribers; it also records the current request counter as a floor, so an answer to a request sent before the reset, which can land after the next person has signed in, is refused instead of stored).
- Produces, `AccountSnapshot.pnl: { bound: number; changed: number }`: `bound` goes up by one after every successful `account:open` (set where `this.#bound = socket`), `changed` goes up on each `pnl:changed`; `disconnect()` calls `resetPnlStores()` and resets both to 0 (its "is there anything to reset" test must include `pnl.bound !== 0 || pnl.changed !== 0`, or a sign-out with nothing else loaded leaves the counters up); both updates replace `#snapshot` and call `#emit()`. `AccountClient.loadPnlSeries(tz: string): Promise<PnlSeries | ApiError>` (like `quotePerp`: `UNREACHABLE` unless state is `ready` and a socket exists; `emitWithAck("pnl:series", { tz })` with `CONNECT_TIMEOUT_MS`). `Account` gains `pnl: AccountSnapshot["pnl"]` and `loadPnlSeries: (tz: string) => Promise<PnlSeries | ApiError>` (default in `Provide`: an `unavailable` `ApiError`).
- Produces, `usePnlSeries(): { series: PnlSeries | null; failed: boolean }`. The zone is `Intl.DateTimeFormat().resolvedOptions().timeZone` read through `useSyncExternalStore` with a `null` server snapshot (as `useNow` does). It asks only when `pnl.bound > 0`: at once on mount and whenever `bound` changes (the card mounts after the socket was bound, so the first ask comes from the mount), and 400 ms (trailing) after `changed` changes; each answer is saved with `saveSeries(tz, request, series)`; `failed` is true only after an error answer with nothing stored for the zone, and clears on the next success; timers are cleared on unmount. It reads `series` with `useSyncExternalStore(subscribeSeries, () => storedSeries(tz))`.

- [ ] **Step 1: Write the failing tests** in `e2e/pnl-series.logic.spec.ts` (logic project, in the style of `account.logic.spec.ts`):
    - `"the heading follows the unit"`: `headingFor("day", "2026-03-03")` is "Balance on Mar 3"; week "Balance, week of Mar 3"; month "Balance in March".
    - `"the hover line says that day, that week or that month"`: `hoverLine("week", 0)` is "PnL that week"; `hoverLine("day", 50)` ends ", and $50.00 deposited"; `hoverLine("month", -20)` ends ", and $20.00 withdrawn".
    - `"valueText names the bucket"` for the three units.
    - `"parseStart gives local midnight on the date, also on daylight saving days"` (`2026-03-08`, `2026-11-01`: `getDate()` and `getHours() === 0`).
    - `"the store keeps a series per zone"`; `"a stale answer cannot replace a newer one"` (`const a = nextSeriesRequest(); const b = nextSeriesRequest(); saveSeries("UTC", b, newer)` is true, then `saveSeries("UTC", a, older)` is false and `storedSeries("UTC")` is `newer`); `"resetPnlStores empties it"`; `"an answer to a request sent before a reset is refused after it"` (`const old = nextSeriesRequest(); resetPnlStores(); saveSeries("UTC", old, series)` is false and `storedSeries("UTC")` is null; a request taken after the reset saves); `"subscribers hear a save and not a refused save"`.
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/pnl-series.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three new files and the client and provider changes. `AccountSnapshot` is built in three places that all need the new `pnl` field: the class's initial `#snapshot`, `disconnect()`'s reset, and `IDLE` in the provider.
- [ ] **Step 4: Run** the spec, then `npm run test:logic`, `npx tsc --noEmit -p .` and `npx eslint lib/pnl components/pnl components/account-client.ts components/account-provider.tsx`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Ask the server for the PnL series and keep the last answer per zone`.

### Task 9: The Balance card on the series (spec §6.2)

**Files:**

- Create: `lib/pnl/chart.ts`
- Modify: `components/pnl/balance-card.tsx`, `components/pnl/pnl-screen.tsx` (`<BalanceCard />` takes no props; it calls `usePnlSeries()`), `lib/trade/activity.ts` (delete `balanceHistory`, `daysSince`, `BalanceDay` and `DAY`), `e2e/trade.logic.spec.ts`, `e2e/perp-positions.logic.spec.ts`
- Test: `e2e/pnl-chart.logic.spec.ts` (new)

**Interfaces:**

- Consumes: `usePnlSeries`, `headingFor`, `hoverLine`, `valueText` (Task 8).
- Produces, `chart.ts`: `type Bar = { start: string; date: Date; balance: number; pnl: number; net: number }`; `type Chart = { unit: PnlUnit; bars: Bar[]; pnl: number; high: number; low: number; empty: boolean }`; `chartOf(range: PnlSeries["ranges"][PnlRangeKey]): Chart`. `pnl` is the sum of the bars' `pnl`; `empty` is true when every balance is 0; `date` is `parseStart(start)`.
- The card: the bars, the headline Balance (last bar, or the hovered one), the PnL pill (sum, or the hovered bar's), the hover line (`hoverLine`), the heading (`headingFor` when a bar is hovered, "Balance" otherwise) and the slider's `aria-valuetext` (`valueText`) all come from `chartOf(series.ranges[range])`. A bar's tone comes from its `pnl` (`trendOf(Math.round(pnl * 100) / 100)`). The unlabelled strings are unchanged. The slider keeps `aria-label="Balance by day"`, `aria-valuemax` = number of bars. Loading with nothing stored: a block like the page's `Placeholder` card (`aria-busy="true" aria-label="Loading balance"`, `h-[420px] animate-pulse rounded-[34px] bg-panel`) in place of the whole card; the label is for screen readers and the browser test, not visible text. Failed with nothing stored: the card's heading and range control with "Couldn't load your history." in the chart area, at the chart's height (`h-[clamp(160px,28vh,260px)]`). Empty: "No balance yet" as now.

- [ ] **Step 1: Write the failing tests** (`pnl-chart.logic.spec.ts`): `"the headline PnL is the sum of the bars' pnl"`; `"empty is true only when every balance is zero"`; `"bars keep the server's order and parse the amounts"` (including a negative `pnl` and `net`); `"high and low come from the balances"`.
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/pnl-chart.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `chart.ts`, then the card and screen, then delete the old functions. Fix the specs that used them: in `trade.logic.spec.ts`'s `describe("balance history")` delete `"a bar a day, ending today, with deposits apart from PnL"` and `"fees alone don't count as a day's realized PnL"` and any helper only they use, drop the `balanceHistory`/`daysSince` assertions from the rest (keep each test's row-shape assertions) and rename the block `describe("activity rows")`; in `perp-positions.logic.spec.ts` rewrite `"opening a position does not show as a drop in the balance chart"` to assert every `perpActivity(position())` row has `change` 0, and drop the `balanceHistory` lines from `"perp_open and perp_close ledger rows are trades, not deposits"` (keep the `kind` and `change` assertions). Remove the imports and helpers the edits leave unused (`balanceHistory`, `daysSince`, `depositActivity`, `Activity`, `closes`, `row`, `now`, `at` in the first file; `balanceHistory` in the second) and keep the ones still used.
- [ ] **Step 4: Run** the new spec, `npm run test:logic`, `npx tsc --noEmit -p .` and `npx eslint components/pnl lib/pnl lib/trade/activity.ts e2e/trade.logic.spec.ts e2e/perp-positions.logic.spec.ts e2e/pnl-chart.logic.spec.ts`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Draw the Balance card from the server's series and drop the client-side history sums`.

### Task 10: Client plumbing for the history pages: mapping, overlay, page state (spec §10.3)

**Files:**

- Create: `lib/pnl/activity-pages.ts`
- Modify: `lib/account/state.ts` (`HistoryRow.id`), `lib/trade/activity.ts` (`saleActivity`, `activityFromItem`), `components/account-client.ts` (`loadActivityPage`), `components/account-provider.tsx` (`Account.loadActivityPage`), `components/pnl/use-activity.ts` (deposit id, sale rows)
- Test: `e2e/activity-pages.logic.spec.ts` (new), `e2e/account.logic.spec.ts` (extend)

**Interfaces:**

- Produces, `HistoryRow.id?: string` in `state.ts`: the `DepositView.id` of a credited row, absent on a pending one. `key` is unchanged (the sidebar and its tests use it).
- Produces, `lib/trade/activity.ts`:
    - `saleActivity(order: PredictionOrderView): Activity | null` (null without `soldPart`): `id: "sale:<order.id>"`, `at: new Date(soldPart.at)`, `kind: "close"`, `title: "Sold part of <outcome> on <question>"`, `detail: "<shares> shares, <$X> back"` (through `formatUnits(Number(shares), "shares")` and `formatUsdShort`), `amountUSD: cost`, `change: proceeds - cost`, `symbols: [QUOTE]`.
    - `activityFromItem(item: ActivityItem, ctx: { now: Date; priceOf: (symbol: string) => number | null }): Activity | null`: deposit through `depositActivity({ key: item.deposit.id, ... })`; withdrawal through `withdrawalActivity({ id: withdrawal.requestId, amountUSD, at: createdAt, pending: state === "sending", to })`; swap through `swapActivity(order, usd)` with `usd` the paid amount at `priceOf(order.from.token)` only when the order's `createdAt` is within 7 days of `ctx.now` and a price exists, else `null`; prediction and perp through `predictionActivity(position)` / `perpActivity(position)` taking the row whose id ends `:open` for `part: "open"` and `:settle` for `"settle"` (null if absent); sale through `saleActivity`.
- Produces, `activity-pages.ts`:
    - `type PagesState = { items: ActivityItem[]; next: string | null; loaded: boolean }`; `NO_PAGES: PagesState`
    - `itemKey(item: ActivityItem): string` (kind plus the document id, plus `part`)
    - `firstPage(state: PagesState, page: ActivityPage): PagesState`: not loaded gives the page; loaded unions by `itemKey` (newest first, new copy wins) and keeps `state.next`.
    - `olderPage(state: PagesState, before: string, page: ActivityPage): PagesState`: returned unchanged unless `state.next === before`; otherwise appends by `itemKey` and takes `page.next`.
    - `type FeedState = Record<ActivityFilter, PagesState>`; `NO_FEED: FeedState`; `type FeedAction = { type: "first"; filter: ActivityFilter; page: ActivityPage } | { type: "older"; filter: ActivityFilter; before: string; page: ActivityPage }`; `feedReducer(state: FeedState, action: FeedAction): FeedState`: routes the action to `firstPage` or `olderPage` of the filter it names and leaves the other filters' states as they were (the same object).
    - `matchesFilter(filter: ActivityFilter, a: Activity): boolean` (the card's current kind test: `deposits` is kinds `deposit` and `withdrawal`, `trades` is the rest).
    - `overlay(o: { pages: readonly Activity[]; more: boolean; live: readonly Activity[]; hidden: ReadonlySet<string> }): Activity[]`: the union by `Activity.id`, the live row winning a clash; while `more`, live rows older than the oldest page row are dropped unless `pending`; ids in `hidden` are removed from the result; newest first (`byNewest`).
- Produces, `AccountClient.loadActivityPage(req: { before?: string; filter: ActivityFilter }): Promise<ActivityPage | ApiError>` (the same shape as `loadPnlSeries`: `UNREACHABLE` unless the state is `ready` and a socket exists; `emitWithAck("activity:list", { filter, ...(before ? { before } : {}) })` with `CONNECT_TIMEOUT_MS`; no `limit`, so the server's 50 applies) and `Account.loadActivityPage` with the same type (default in `Provide`: an `unavailable` `ApiError`; `PrivyAccountProvider` passes `client.loadActivityPage` and `client.loadPnlSeries` to `<Provide>`).
- `useActivity`: deposit rows use `key: row.id ?? row.key`; it adds `saleActivity` rows for every `predictions.orders` entry that has `soldPart`.

- [ ] **Step 1: Write the failing tests.**
    - `activity-pages.logic.spec.ts`:
        - mapping: `"each part maps to the same Activity id the live rows use"` (`prediction:<id>:open` and `:settle`, `perp:<id>:open` and `:settle`, `deposit:<DepositView.id>`, `withdrawal:<requestId>`, `swap:<id>`, `sale:<id>`); `"a sale row's change is proceeds minus cost"`; `"a swap older than 7 days has no USD size and a recent one is priced"`; `"a settle part of an open position maps to null"`.
        - overlay: `"the live row wins a clash"`; `"live rows older than the oldest page row are dropped while more pages exist, and kept at the end"`; `"pending live rows survive the floor"`; `"a hidden id is removed even when a page row has it"` (Review Focus 4: a page withdrawal whose `withdrawal:<requestId>` is hidden); `"rows are newest first"`.
        - pages: `"an older page that answers after the person switched filter lands on the filter it was asked for"` (Review Focus 1: `feedReducer` with an `older` action for `deposits` while `trades` was the filter shown leaves the `trades` state untouched, the same object, and appends to `deposits`); `"a first page on a loaded state does not duplicate and keeps next"`; `"an older page whose before is not next is ignored"` and `"the same older page applied twice appends once"` (Review Focus 1); `"an older page moves next on"`.
        - `matchesFilter` for the three filters.
    - `account.logic.spec.ts`: `"a credited history row carries the deposit id and a pending one has none"`; the existing `toEqual` on a pending row still passes.
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/activity-pages.logic.spec.ts e2e/account.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** both specs, then `npm run test:logic`, `npx tsc --noEmit -p .` and `npx eslint lib components/pnl components/account-client.ts components/account-provider.tsx`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `Map server history pages to activity rows and lay them under the live rows`.

### Task 11: The Activity card pages back through history, plus docs (spec §10.4, §11 step 8)

**Files:**

- Create: `components/pnl/use-activity-feed.ts`
- Modify: `lib/pnl/activity-pages.ts` (`bodyState`), `components/pnl/activity-card.tsx`, `components/pnl/pnl-screen.tsx` (`<ActivityCard live={state.activity} />`), `docs/sentence-builder.md` (the "The PnL page" section: the chart comes from the server's `pnl:series` in day, week or month bars with correct balances for any history age; the table pages through the whole history with "Show older"; update the Tests list with the new specs; remove the sentence saying the list is "what the server holds"), `server/README.md` (in the Socket.io table add rows for `pnl:series` `{ tz }` (the balance by day, week or month for 7D, 30D and All, 30 a minute per user), `pnl:changed` (server to client, no payload: something that moves the series happened) and `activity:list` `{ before?, limit?, filter? }` (a page of the whole history, newest first, 60 a minute per user); in the Layout list add `src/pnl/`: the PnL series and the paged activity history), `docs/superpowers/plans/2026-10-12-polymarket-followups.md` (replace the known-gap line "The server keeps settled positions for 35 days, so the PnL page's "all time" range misses older predictions." with "Fixed by the all-time PnL work: the PnL page reads `pnl:series` and `activity:list`, so the 35-day trim only affects the sidebar.")
- Test: `e2e/activity-pages.logic.spec.ts` (extend with `bodyState`)

**Interfaces:**

- Consumes: Task 10's `PagesState`, `FeedState`, `NO_FEED`, `feedReducer`, `overlay`, `matchesFilter`, `activityFromItem`; `useAccount().pnl.bound` and `loadActivityPage`; `useTrade().catalog` for `priceOf`.
- Produces, `bodyState(o: { filter: ActivityFilter; loaded: boolean; more: boolean; rows: number }): "rows" | "busy" | "nothing" | "no-deposits"` in `activity-pages.ts`: `rows` when `rows > 0`; otherwise `busy` while the first page has not answered or more pages exist; `nothing` or `no-deposits` (by filter) only when nothing is listed, the first page has answered and no more exist.
- Produces, `useActivityFeed(filter: ActivityFilter, live: readonly Activity[]): { rows: Activity[]; loaded: boolean; more: boolean; loadingMore: boolean; loadMore: () => void }`. It keeps a `FeedState` (`useReducer(feedReducer, NO_FEED)`), fetches the active filter's first page when it is not loaded and again after every change of `pnl.bound`, only while `pnl.bound > 0` (before that there is no bound socket, and the call would only come back `UNREACHABLE`); a first page that fails is asked again after `RETRY_MS` (3 seconds, a constant in `lib/pnl/activity-pages.ts`), repeatedly, with the timer cleared on unmount, on a change of filter and on a change of `pnl.bound`, and until it answers the filter stays not loaded (so the card stays `busy`, never `nothing`). `loadMore` asks `loadActivityPage({ before: next, filter })`, ignored while `loadingMore`; the answer goes to the filter it was asked for through `olderPage`. A failed page leaves `more` true so the button retries. `hidden` is the set of `withdrawal:<requestId>` ids of `withdrawals` in state `failed`. Until the filter's first page answers, `rows` are the live rows that match.
- The card: filter chips send the filter to the hook; the table body is `bodyState`: `busy` renders the empty message's element with a non-breaking space and `aria-busy="true"` (same height as the message, no text), `nothing` and `no-deposits` keep today's messages, "Show older" is a text button under the last row while `more`, disabled while `loadingMore`, gone at the end. No counter, no "end of history" label, no infinite scroll.

- [ ] **Step 1: Write the failing tests** (extend `activity-pages.logic.spec.ts`): `"bodyState is rows whenever rows exist"`; `"bodyState is busy until the first page answers"`; `"bodyState is nothing or no-deposits only once loaded with no more pages"` (the filter picks which); `"with more pages and nothing listed bodyState is busy, never nothing"` (`loaded` true, `more` true, `rows` 0).
- [ ] **Step 2: Run and watch them fail.** Run: `npm run test:logic -- e2e/activity-pages.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `bodyState`, the hook, the card and screen changes and the three doc edits. Keep the card's `motion.tr` row animation, `key={filter}` on `tbody` and the 12-row stagger as they are.
- [ ] **Step 4: Run** the spec, then `npm run test:logic`, `npx tsc --noEmit -p .` and `npx eslint components/pnl lib/pnl`. Expected: pass. The browser specs for both cards run in Task 12.
- [ ] **Step 5: Commit.** Message: `Page the Activity card back through the whole history and update the PnL docs`.

### Task 12: E2E seeding and the browser tests for both cards (spec §9 Browser, §10.5)

**Files:**

- Modify: `server/test/e2e/serve.ts` (`/seed` also takes `history`; a `/gate` route), `e2e/backend.ts` (`HistorySeed`, `seedHistory`, `gate`), `e2e/positions.ts` (add 16 and 17 to `RESOLVED`), `e2e/pnl.spec.ts`
- Test: `e2e/pnl.spec.ts`

**Interfaces:**

- Consumes: `seedRows` (Task 3).
- Produces, `serve.ts`: `/seed` takes `{ address, deposits?, history? }`; `deposits` now defaults to `[]` (today `seed()` spreads it and would throw without it) and works as before, `history` is an array of `HistorySeed` written with `seedRows` and, unlike `deposits`, touches neither the balance nor the ledger. A `HistorySeed` is the `SeedRow` shape with its Date fields given as days: `daysAgo` becomes `at` (deposit, withdrawal, swap, sale) or `openedAt` (prediction, perp), `settledDaysAgo` becomes `settledAt`; each is `new Date(Date.now() - days * 86_400_000)`.
- Produces, `serve.ts`: `/gate` takes `{ address, name: "pnl" | "feed", mode: "hold" | "fail" | "off" }`. It gates one person only, because the backend is shared by every test and project running in parallel and a global gate would stall their PnL pages. The first call wraps `services.pnl.series` and `services.feed.page` once (keeping the originals); a wrapped call whose `accountId` is the gated person's (found as `services.accounts.find(userIdOf(normalize(address)))` does elsewhere in the file) waits on a promise (`hold`), throws an `Error("gated")` (`fail`, which the socket answers as `internal`), or runs (`off`, which also releases every waiter); every other account runs untouched. (The socket handlers call these methods on `services` at request time, so replacing the method on the object holds the request.)
- Produces, `backend.ts`: `type HistorySeed` (a plain JSON union written out in this file, mirroring `SeedRow` with the `daysAgo` fields; it imports nothing from `server/`), `seedHistory(address: string, rows: HistorySeed[])` and `gate(address: string, name: "pnl" | "feed", mode: "hold" | "fail" | "off")`.
- Seeded predictions read "Yes on Will it rain?" (Task 3's defaults), so a test can find their rows by that title.

- [ ] **Step 1: Write the tests** in `e2e/pnl.spec.ts` (use `connect`, `balance`, `chart`, `activity`, `rows` already in the file; read the headline figures from the slider's `aria-valuetext` and the PnL pill text, not from the animated number). Any test that sets a gate turns it `"off"` in a `finally`, so a failure cannot leave the person's later requests held.
    - `"a 400-day-old loss is in 7D, 30D and All"`: `seedHistory` a deposit 500 (`daysAgo` 500), a `lost` prediction cost 100 (400, settled 400), a `liquidated` perp collateral 40 proceeds 0 (200, settled 200), a deposit 20 (10). The cash balance stays 0 (history seeds do not touch it); only the chart is asserted. For each range click it and assert the slider's `aria-valuetext` ends in `$380.00` and, for `All`, the PnL pill contains `$140.00` (it reads `−$140.00`), for 7D and 30D `$0.00`.
    - `"the chart's placeholder shows while the series loads and the stored series shows at once on a second visit"`: seed one deposit with `seedDeposits`; `gate(address, "pnl", "hold")`, open `/pnl`, `connect`; assert `page.getByLabel("Loading balance")` is visible and the text `Couldn't load your history.` is not; release (`"off"`) and assert the chart is visible. Hold again, go to Trade through the dock and back to PnL, and assert the chart is visible within 1 second while the gate is held and `getByLabel("Loading balance")` has count 0. (The Activity card has its own `aria-busy` element while its first page loads, so the assertion does not use `[aria-busy]`.)
    - `"opening the page before the session is ready never shows Couldn't load your history"`: `page.addInitScript` installs a `MutationObserver` on `document` (`childList`, `subtree`, `characterData`) that sets `window.__sawFailure = true` when the document's text contains that sentence; `goto("/pnl")`, `connect`, wait for the chart, assert `__sawFailure` is not true.
    - `"a failing series says so, and the next pnl:changed repairs it"` (an outage): `gate(address, "pnl", "fail")`, open `/pnl`, `connect`; the chart area reads `Couldn't load your history.` (timeout 10 s); `gate(address, "pnl", "off")`, then `sendFromOutside(depositAddress, "5")` (address from `accountOf`); the sentence goes away and the chart is visible.
    - `"a new deposit updates the bars without a reload"`: after the chart shows, `sendFromOutside(depositAddress, "50")`, assert the slider's last value text rises by `$50.00` (seed `500` first: `$500.00` becomes `$550.00`).
    - `"a position resolved while the page is open updates the bars without a reload"`: use the questions at index 16 (desktop) and 17 (mobile) of the two-outcome list, and add both indices to `RESOLVED` in `e2e/positions.ts` (resolving closes a market for everyone, and `predictions.spec.ts` already owns 12 to 15). `seedDeposits` 500, `buyPredictions(address, [{ market, outcome: market.outcomes[1] }])`, open `/pnl`, `connect`, assert the PnL pill reads `$0.00`; then `resolveMarket(marketIdOf(outcome.tokenId), ["1", "0"])` and `resolveNow()` (the second outcome loses), and assert the pill matches `/−\$\d/` (the cost is just under $10, so the exact figure is not asserted) and the slider's last value text is below `$500.00`.
    - `"more than 50 old rows show Show older, which loads the next page and goes away at the end"`: `seedHistory` 120 deposits (1 to 120 days ago); on `/pnl`, `rows` has 50; click "Show older": 100; click again: 120 and the button is gone.
    - `"a failed older page leaves Show older, which then works"`: the same seed; after the first 50 rows `gate(address, "feed", "fail")`, click "Show older": the button is back, enabled, and `rows` still 50; `"off"`, click again: 100.
    - `"the Deposits chip lists old deposits"`: with the same seed, click Deposits and then "Show older" until 120.
    - `"the first paint of a person with old history never shows Nothing here yet"`: seed only a 400-day-old `lost` prediction (settled 400); `gate(address, "feed", "hold")`, open `/pnl`, `connect`; assert the Activity card has an `[aria-busy="true"]` element and no "Nothing here yet" text; release and assert two rows, `Yes on Will it rain?` and `Lost Yes on Will it rain?`.
    - `"a failing first page never shows Nothing here yet and repairs itself"` (an outage): the same seed with `gate(address, "feed", "fail")`; `connect`; wait 3.5 seconds (one retry fails); the card still has no "Nothing here yet"; `"off"`; the two rows appear within 10 seconds.
    - Extend `"phones fit the PnL page without scrolling sideways"` with the 120-deposit `seedHistory` and a visible "Show older".
- [ ] **Step 2: Run and watch them fail** from an isolated copy (see Global Constraints): `E2E_PORT=3650 E2E_API_PORT=4650 E2E_CONTROL_PORT=4651 npx playwright test e2e/pnl.spec.ts`. Expected: the new tests FAIL (no seeding, no gate).
- [ ] **Step 3: Add** the backend routes and helpers until the new tests pass.
- [ ] **Step 4: Run** `e2e/pnl.spec.ts`, and the specs that already touch the PnL page or its data: `e2e/withdraw.spec.ts` (its "the PnL feed lists a withdrawal under Deposits, and the chart drops by it" now goes through `pnl:changed` and the paged table), `e2e/swaps.spec.ts` (its "Nothing here yet" checks now wait for the first page), `e2e/highlights.spec.ts`, `e2e/predictions.spec.ts` and `e2e/wallet-sidebar.spec.ts`, all from the isolated copy with the three ports, then `npm run test:logic`, `npx tsc --noEmit -p .`, `cd server && npm test && npx tsc --noEmit` and `npx eslint e2e server/test/e2e`. Expected: pass; the existing `"switching the activity filter never stretches the card past where it ends up"` still passes.
- [ ] **Step 5: Commit.** Message: `Test the PnL chart and the paged history end to end`.

---

## After Task 12 (the owner's, not tasks)

Spec "Open questions", live checks against the real deployment:

1. Count `prediction_orders` with `side: "sell"`, `state: "filled"` whose `positionId` points at a position still `open` or `closing` (partial sales booked before Task 1). Above zero, those accounts' series differ from the ledger by those sales.
2. Count `accounts` that have `formerDepositAddresses` (an account merge ever ran). Above zero, those accounts' series show the absorbed positions as a loss of their cost, which the owner decided to leave.
3. After launch, read the `pnl.series` and `pnl.feed` log lines. If the 95th percentile of `ms` passes 100, move the day-grouping into Mongo (spec 3.3) or add the cache.
4. Check the server image's Node (`deploy/server.Dockerfile`, `node:26-slim`) accepts the browsers' current zone names (log how often the `UTC` fallback fires).

## Self-review notes

- Spec coverage: §1 is the problem statement; §2 decisions are Global Constraints; §3 Tasks 2 to 4; §4 Task 1; §5 Task 5; §6.1 Task 8, §6.2 Task 9, §6.3 and §10.3, 10.4 Tasks 10 and 11; §7 and §8 Tasks 5, 7 and the logs in Tasks 3 and 6; §9 Tasks 2 to 5, 8, 9, 12; §10.1 to 10.2 Tasks 6 and 7, §10.5 Tasks 6, 7, 10, 12; §11 step 8 is in Task 11.
- Decisions the spec left open, made here: failed withdrawals are not in `activity:list` (parity with today's table and the series); a swap's size on a page is judged from `createdAt`; pending live rows are exempt from the "older than the oldest page row" cut; the series store is emptied on `disconnect()` so one person's chart never shows for the next sign-in; the per-source query carries the cursor bound itself, which makes the merge exact for ties larger than `limit`; `soldPart` on the view is `{ costUSD, proceedsUSD, at }`; the loading state is the page's `Placeholder` block for the whole card; the `deposit:credited` handler is not in `enqueue` today, so `pnl:changed` is sent from its own loop; week and month headings carry no year (the spec's strings); a first history page that fails is asked again every 3 seconds and the card stays busy meanwhile (the spec only says a failed older page leaves the button); `resetPnlStores()` also refuses answers to requests sent before the reset; the browser gates (`/gate`) are scoped to one person because the e2e backend is shared by parallel tests.
