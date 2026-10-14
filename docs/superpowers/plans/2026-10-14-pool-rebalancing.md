# Pool Rebalancing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server worker keeps the Polymarket pool's free pUSD near `POLYMARKET_FLOAT_USD` and the Arc treasury able to pay withdrawals, moving USDC between Arc and Polygon in both directions with CCTP v2, behind a switch that is off by default.

**Architecture:** A `PoolRebalancer` worker (`server/src/predictions/`) owns `pool_rebalances` rows through their states. The Arc treasury's approve and burn are signed only by `Payouts` (copied from its Solana path, no ledger refund). The pool owner key signs only Polymarket relayer batches (wrap in, unwrap-and-burn out), always through one `RelayerGate` shared with the redeemer. A top-up reserves nothing; a drain reserves free float through `PredictionService`. Decisions (bands, caps, pause, halt) are pure functions; the operator's `pool-rebalance.ts` only queues rows.

**Tech Stack:** Node 24 + TypeScript, MongoDB replica set, viem, `@polymarket/client` 0.13.0 (behind `PoolTrader`), vitest with anvil (Arc), Mongo harness and the fakes in `server/test/support`.

**Spec:** `docs/superpowers/specs/2026-10-14-pool-rebalancing-design.md`. Section numbers below (1.2, 5.3 ...) are the spec's. Model plans: `2026-10-14-solana-deposits-withdrawals.md`, `2026-10-14-hyperliquid-perps.md`.

## Global Constraints

- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -m "..." -- <paths>`) with only your own hunks; the tree already has unrelated changes (`.impeccable/`, other specs). Never stage them.
- **Comments** are one line each and describe the code as it is. Never read or print any `.env` file (`server/.env.example` is fine).
- **No real service and no real transaction in any test.** Use `server/test/support` fakes and the anvil stubs. Nothing signs or sends outside tests. Live checks that move money are the owner's (after Task 15); no task runs one.
- **No client or browser change.** The app never shows rebalances (spec 10). No Playwright, no Next.js file is touched.
- **Checks:** `cd server && npx vitest run <file>` while working; `cd server && npm test && npx tsc --noEmit` before each commit.
- **The ledger is never touched** by a rebalance: no `debitInSession`/`creditInSession` call in any pool code (spec Decisions, 5.3.8).
- **Units, so no task mixes them up:** Mongo money fields are `Decimal128` whole numbers (`toDecimal`/`fromDecimal` in `server/src/db/money.ts`); `*E6` fields hold 6-decimal USDC units and `amount` fields on `withdrawals` hold 18-decimal wei. `Withdrawals#treasuryFree` and `Iris.forwardFee` answer in **wei**; `planPoolMove`, `PoolTrader` and every `pool_rebalances` money field are **E6**. Convert with `weiToE6`/`e6ToWei` (`money.ts`) and `weiToUsdc6` (`cctp-burn.ts`); never compare the two directly. Config dollar figures are JS numbers; `usdToE6` (Task 2) is the only conversion to E6.
- **Test isolation:** `vitest` runs files in parallel against one shared Mongo and one shared anvil. Every test file or harness that signs from a treasury or installs a stub contract uses its own `generateMnemonic(wordlist)` and its own random stub addresses (`privateKeyToAddress(generatePrivateKey())`), never the constants of `payouts-solana.test.ts`. Otherwise two files share a nonce, a balance and a stub call log.
- **Switch:** `POOL_REBALANCE` `"off" | "on"`, default `"off"`. Off: the worker is not built, the script refuses, the only changed behavior is one extra query on the new collection in `Withdrawals#treasuryFree`.
- **Spec values, verbatim:**
    - Config defaults: `POOL_REBALANCE_MAX_MOVE_USD` 100, `POOL_REBALANCE_MAX_DAY_USD` 300 (Arc to Polygon only, rows in any state but `failed`, 24 hours), `POOL_REBALANCE_ARC_RESERVE_USD` 100, `POOL_REBALANCE_MIN_MOVE_USD` 10, `POOL_REBALANCE_PAUSE_MIN` 5. Constants: bands 50% and 150% of `POLYMARKET_FLOAT_USD`; halt after 3 failed or stuck rows of one direction; alarms stay at 25% and 200%.
    - `POOL_REBALANCE=on` requires `POLYMARKET_POOL_KEY` and the three builder credentials, even with trading off.
    - CCTP: Arc domain 26, Polygon domain 7, `minFinalityThreshold` 2000, `destinationCaller` zero, hook data `FORWARD_HOOK_DATA`. TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` (same on both chains). Polygon native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`. CollateralOnramp `0x93070a847efEf7F70739046A929D47a521F5B8ee`, CollateralOfframp `0x2957922Eb93258b93368531d39fAcCA3B4dC5854`. pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (the SDK's `collateralToken`; spec 1.1.6 names it only as "the live proxy").
    - `maxFee` is `max(high * 3, high + $0.10)` plus the protocol fee in basis points, always below the amount.
    - Cadence: start path every 2 s; evaluate every 60 s; fast states every 2 s, slow states (`forwarding`, `wrapping`, and `stuck` rows, which are still followed) every 30 s; idle-USDC read every 10 min; float document must be under 3 minutes old; relayer window 11 minutes (signed deadline 600 s plus 60 s); `forwarding`/`wrapping` older than 2 hours become `stuck`; "done" waits at most 10 minutes for the float to show a wrap.
    - Wrap retry delays 1, 5, 15 minutes, then hourly; wrap batch unconfirmed after 30 minutes is retried; after 10 tries log `error` hourly.
    - `error` messages (exact, each at most once an hour per row): "Pool rebalance stuck: needs an operator", "Pool rebalancing halted after repeated failures", "Treasury too low to top up the pool", "Pool rebalance burn delayed", "A pool rebalance wrap keeps failing", "Pool rebalance confirmed without a burn", "Pool wallet mismatch". `warn`: "Native USDC is idle in the pool wallet" (hourly, over $1, no row `wrapping`).
    - Batch order out (1.2): pUSD `approve(offramp, x)`; `unwrap(USDC, wallet, x)`; USDC `approve(TokenMessengerV2, x)`; `depositForBurnWithHook` to domain 26 with the Arc treasury as `mintRecipient`. Batch in (1.1.5): USDC `approve(onramp, x)`; `onramp.wrap(USDC, wallet, x)`.
- **Spec additions this plan makes** (each needed to build what the spec asks; see "Spec findings"): row fields `mintRecipient`, `resolvedAt`, `polygon.relayerFinalAt`, `polygon.wrapFinalAt`, `polygon.balanceBeforeE6`; `PoolTrader.syncBalance()`; `Iris.forwardFee` keeps returning USDC wei.

## Review Focus

The riskiest inputs, each with the test that owns it. A reviewer checks these first.

**Money moved twice**

1. **A restarted worker re-burns on Arc.** Signed bytes are stored before either send; a restart re-sends the same bytes; a mined burn is never signed again. (Task 5: "restart in sending re-sends the same bytes", "a burn mined and nothing else ever re-burns".)
2. **A restarted worker re-sends the Polygon drain batch.** `polygon.attemptedAt` with no id means the batch may still execute for 11 minutes; it is never submitted a second time. (Task 12: "a worker restarted after attemptedAt with no id never submits again".)
3. **The release of a drain's reservation runs twice** (two ticks on one row). Only the tick that wins the guarded state change releases. (Task 12: "a repeat tick releases nothing a second time".)
4. **The wrap batch ran but its answer was lost.** The wallet's USDC is gone after the window; a second wrap must not be waited for forever or sent blind. (Task 11: "an unknown wrap that executed ends done through the float check without a second batch" and its mirror case.)

**A restart mid-move**

5. Restart in `sending` (Task 5), in `forwarding` (Task 11), in `wrapping` with and without a stored batch id (Task 11), in `submitting` with and without `attemptedAt` (Task 12).

**Two moves at once**

6. **The operator's row and the worker's decision are inserted at the same instant.** The loser hits the unique index and is dropped quietly, not logged as an error, not retried in a loop. (Task 13.)
7. **A withdrawal and a top-up start together** (Task 4), **a redemption and a rebalance batch start together** (Task 8).

**An outage**

8. **The Arc treasury read fails while a queued top-up starts.** The row stays `queued`, nothing is signed, nothing is failed. (Task 10.) **The Arc node is unreachable while Payouts sends** (Task 5). **The Polygon RPC fails while the wrap reads the wallet** (Task 11). **Relayer lookups keep throwing** (Task 12). **The idle-USDC read fails in the solvency check**, which must warn, not raise a false alarm (Task 15). **Iris is down or answers 429** (Tasks 10, 11).

**Odd inputs**

9. **The operator types an odd amount** (`0`, `-5`, `5.5555555`, `abc`, `1e3`). The script refuses it before touching Mongo. (Task 14.)
10. **A tiny `POLYMARKET_FLOAT_USD` (5 or 15).** A minimum-sized top-up must not push free float over 150% and trigger a drain the next minute. (Task 2.)
11. **Circle forwards less than `amount - maxFee`** (partial arrival, or the fee kept). The wrap waits for the full expected balance and never wraps a partial arrival early; at exactly the threshold it wraps. (Task 11.)

---

### Task 1: Config, row type, collection, unique active index, env example (spec 5.1, 9)

**Files:**
- Modify: `server/src/config.ts`, `server/src/db/mongo.ts`, `server/src/events.ts`, `server/.env.example`
- Test: `server/test/unit/config.test.ts`, `server/test/integration/pool-rebalances-db.test.ts` (create)

**Interfaces:**
- Produces config keys: `POOL_REBALANCE: "on" | "off"`, `POOL_REBALANCE_MAX_MOVE_USD`, `POOL_REBALANCE_MAX_DAY_USD`, `POOL_REBALANCE_ARC_RESERVE_USD`, `POOL_REBALANCE_MIN_MOVE_USD`, `POOL_REBALANCE_PAUSE_MIN` (numbers, defaults in Global Constraints).
- Produces in `mongo.ts`: `PoolDirection = "arc_to_polygon" | "polygon_to_arc"`; `PoolRebalanceState = "queued" | "sending" | "submitting" | "forwarding" | "wrapping" | "done" | "failed" | "stuck"`; `PoolRebalanceDoc` with exactly the spec 5.1 fields plus `mintRecipient: string | null` (Arc leg: the pool wallet the burn mints to), `resolvedAt: Date | null`, `polygon.relayerFinalAt`, `polygon.wrapFinalAt`, `polygon.balanceBeforeE6` (all nullable). `direction` is `null` for `kind: "wrap_idle"`. `active?: true` is absent (not `false`) once a row ends. `Collections.poolRebalances` (collection `pool_rebalances`). Types: `amountE6`, `maxFeeE6`, `reservedE6`, `polygon.mintedE6`, `polygon.balanceBeforeE6` and `iris.feeExecutedE6` are `Decimal128` (0 for a `wrap_idle` row's amounts), hashes and ids are strings, instants are `Date`. Invariant, written in the type's comment: `updatedAt` changes only when `state` changes (stuck timing and the pause read it); `attempts`, `nextAt`, `iris.checkedAt` and the signed-transaction fields are written without touching it.
- Produces Bus event `"pool-rebalance:updated": [{ rebalance: PoolRebalanceDoc }]`.
- Indexes: `{ state: 1, createdAt: 1 }`, `{ direction: 1, createdAt: 1 }`, and `{ active: 1 }` unique with `partialFilterExpression: { active: true }` named `one_active`.

- [ ] **Step 1: Write the failing tests.**
    - `config.test.ts`: `"pool rebalancing defaults"` (off, 100, 300, 100, 10, 5); `"POOL_REBALANCE=on without the pool key and builder secrets names each missing one, with trading off"`; `"POOL_REBALANCE=on with the four secrets loads"`; `"a minimum move above the maximum move is refused"`; `"PREDICTIONS_TRADING=on still names its four secrets"` (existing behavior kept).
    - `pool-rebalances-db.test.ts` (Mongo only): `"a second active row is a duplicate key"` (`isDuplicateKey`); `"rows without active never collide"` (two `done` rows); `"unsetting active frees the slot"`.
- [ ] **Step 2: Run them; expect FAIL.** `cd server && npx vitest run test/unit/config.test.ts test/integration/pool-rebalances-db.test.ts`
- [ ] **Step 3: Implement** the six keys (`z.coerce.number()`, positive except reserve and pause which allow 0), the extended `superRefine` (secrets needed when either switch is on, message names the switch), the types, collection, indexes (`ensureIndexes` gains `poolRebalances`), the Bus event, and the `.env.example` section: the six variables with one-line comments, a note that `POLYGON_RPC_URL` must be a dedicated provider, the old line 109 "# Polymarket's Collateral Onramp wraps USDC.e (bridged), not native USDC, into pUSD." replaced by "# The Collateral Onramp wraps native USDC and USDC.e into pUSD.", and the `POLYMARKET_FLOAT_USD` comment changed to say the warnings fire under 25% and over 200% of the pool's free float and the rebalancer acts at 50% and 150%
- [ ] **Step 4: Run the new tests, then `npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Add the pool rebalancing switch, config, row type and one-active index".

---

### Task 2: The pure decisions: guard, bands, amounts, pause, halt (spec 3, 6 "Repeated failures")

**Files:**
- Create: `server/src/predictions/pool-plan.ts`
- Test: `server/test/unit/pool-plan.test.ts` (create)

**Interfaces:**
- Consumes: `PoolDirection`, `PoolRebalanceState` from Task 1.
- Produces (all E6 bigint, times in ms):
    - `planPoolMove(o: { direction: PoolDirection; amountE6: bigint; maxMoveE6: bigint; treasuryFreeE6: bigint; arcReserveE6: bigint; movedTodayE6: bigint; maxDayE6: bigint; freeFloatE6: bigint }): { ok: true } | { ok: false; kind: "amount" | "cap" | "day" | "reserve" | "float"; reason: string }`. Rules: amount above zero; amount at most `maxMoveE6`; Arc to Polygon only: `movedTodayE6 + amount <= maxDayE6` and `treasuryFreeE6 - amount >= arcReserveE6`; Polygon to Arc only: `amount <= freeFloatE6`. `treasuryFreeE6` already nets pending withdrawals and gas. The minimum is not here (operator moves may be smaller).
    - `decidePoolMove(o: { tradingOn: boolean; targetE6: bigint; freeE6: bigint; floatAt: number; now: number; lastMoveAt: number | null; pauseMs: number; minMoveE6: bigint; maxMoveE6: bigint; halted: Record<PoolDirection, boolean> }): { move: null; why: "trading_off" | "stale_float" | "in_pause" | "float_before_move" | "in_band" | "too_small" | "halted" } | { move: { direction: PoolDirection; reason: "low" | "high"; amountE6: bigint } }`.
    - `isHalted(o: { stuck: boolean; last: { state: PoolRebalanceState; resolvedAt: Date | null }[] }): boolean`, `last` newest first.
    - `usdToE6(usd: number): bigint` = `BigInt(Math.round(usd * 1e6))`; the one conversion from a config dollar figure (`POLYMARKET_FLOAT_USD`, `POOL_REBALANCE_*_USD`) to E6, used by Tasks 10, 13 and 14.
    - Constants `BAND_LOW_PCT = 50`, `BAND_HIGH_PCT = 150`, `HALT_AFTER = 3`, `FLOAT_MAX_AGE_MS = 180_000`.

- [ ] **Step 1: Write the failing tests** (target T = $100 unless said).
    - `decidePoolMove`: `"free 49.99 is low and exactly 50 is in band"`; `"exactly 150 is in band and 150.01 is high"`; `"the top-up is T minus free rounded up to a whole dollar"` (free 30.2 gives 70); `"a top-up is capped at the maximum"` (T 200, free 0 gives 100); `"a top-up is raised to the minimum"` (T 12, free 5 gives 10); `"the drain is free minus T rounded down"` (free 160.9 gives 60) `"and capped"` (free 400 gives 100); `"a drain under the minimum is too_small"` (T 15, free 23 gives 8, skipped); `"a minimum-sized top-up never trips the drain"` (T 5, free 1 gives a $10 top-up; then free 11 is high but the drain of 6 is too_small); `"trading off, a float older than 180 s (181 s stale, 180 s fresh), a move inside the pause, and a float read taken at or before the last move each decide nothing"`; `"a halted direction skips only its own"` (both directions, both halted flags).
    - `planPoolMove`: `"an in-bounds top-up is ok"`; `"zero is refused as amount"`; `"above the move cap is cap"`; `"day total 250 + 60 is day, exactly 300 is ok"`; `"treasury free 150, amount 60, reserve 100 is reserve; free 160 is ok"`; `"a drain is not limited by the day total or the reserve"`; `"a drain above free float is float; equal is ok"`.
    - `usdToE6`: `"converts whole, fractional and float-error dollars exactly"` (100 gives 100_000_000n, 12.5 gives 12_500_000n, `0.1 + 0.2` gives 300_000n).
    - `isHalted`: `"three failed rows halt"`; `"two failed and a done do not"`; `"a stuck row halts at once"`; `"three failed rows whose newest has resolvedAt do not"`; `"fewer than three rows never halt on failures"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/pool-plan.test.ts`
- [ ] **Step 3: Implement** the four functions and constants in `pool-plan.ts`. Compare with integer math (`free * 2n < target`, `free * 2n > target * 3n`). Dollar rounding by `1_000_000n` steps. Reason strings are plain sentences ending in a period.
- [ ] **Step 4: Run; expect PASS,** then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** "Decide pool moves by pure functions: guard, bands, amounts, pause and halt".

---

### Task 3: One Iris fee parser, `maxFee` headroom, `encodeBurnToEvm` (spec 1.1, 4 "One fee parser", "maxFee has headroom")

**Files:**
- Modify: `server/src/crosschain/iris.ts`, `server/src/withdrawals/cctp-burn.ts`, `server/scripts/perps-rebalance.ts` (`maxFeeOf` only), `server/test/support/fake-iris.ts`
- Test: `server/test/unit/iris.test.ts`, `server/test/unit/cctp-burn.test.ts`, `server/test/unit/perps-rebalance.test.ts`

**Interfaces:**
- Produces in `iris.ts`: `POLYGON_DOMAIN = 7`; `feeUnits(value: number | string): bigint` (whole numbers are 6-decimal units, fractions are dollars, rounded up); `Iris.forwardFee(input: { from: number; to: number; setup?: boolean }): Promise<{ med: bigint; high: bigint; minimumFeeBps: number }>` still in USDC **wei** (18 decimals) so Solana callers are unchanged (spec says "units"; see Spec findings); `IrisMessage` gains `feeExecutedE6: bigint | null` (from `decodedMessage.decodedMessageBody.feeExecuted`) and `delayReason: string | null` (top-level `delayReason`). `message({ domain, burnTxHash })` already takes any domain.
- Produces in `cctp-burn.ts`: `encodeBurnToEvm(input: { amount6: bigint; domain: number; recipient: Address; maxFee6: bigint; burnToken?: Address }): Hex` (`mintRecipient` is the recipient left-padded to 32 bytes; `burnToken` defaults to `ARC_USDC_ERC20`; zero `destinationCaller`; finality 2000; `FORWARD_HOOK_DATA`); `maxFeeWithHeadroom(input: { amount6: bigint; high6: bigint; minimumFeeBps: number }): bigint` = `min(max(high*3, high + 100_000) + ceil(amount6 * minimumFeeBps / 10_000), amount6 - 1n)`. `minimumFeeBps` may be fractional (Iris quotes it as a JSON number), and `bigint * number` does not compile, so compute the protocol part in integers: `bps100 = BigInt(Math.ceil(minimumFeeBps * 100))`, then `(amount6 * bps100 + 999_999n) / 1_000_000n`. `high6` is `weiToUsdc6(high)` at the call site.
- Fake Iris: fee answers for `26/7` (med 70_969, high 71_067) and `7/26` (med 15_638, high 16_288) with `forward=true`, setters `setPoolFees(direction, { med, high, bps? })` (`bps` becomes the 2000 row's `minimumFee`, default 0); `setMessage`/`setForwarded` gain an optional `domain` (served only for that source domain when given, any domain when omitted, so existing tests are unchanged); `setDelayed(hash, reason, domain?)` serves `{ status: "pending_confirmations", delayReason }`; `setForwarded` may carry `feeExecuted`.

- [ ] **Step 1: Write the failing tests.**
    - `iris.test.ts`: `"forwardFee works for 26 to 7 and 7 to 26 and returns minimumFeeBps"` (with `setPoolFees(..., { bps: 1.3 })` it returns 1.3); `"a whole number is units and a fraction is dollars"` (a fractional fixture is served through `createIris({ baseUrl, fetch })` with a hand-written `fetch`, so the fake needs no fractional mode: `0.070969` gives 70_969 units, i.e. `70_969n * 10n**12n` wei; `70969` gives the same; `feeUnits` is also tested directly); `"message carries feeExecutedE6 and delayReason"`; the first existing test's `toEqual({ med, high })` becomes `toMatchObject` because `forwardFee` now also returns `minimumFeeBps`; the other Solana tests are unchanged.
    - `cctp-burn.test.ts`: `"encodeBurnToEvm passes domain 7, the recipient left-padded to 32 bytes, zero destinationCaller, finality 2000 and the forwarding hook"` against a literal vector for recipient `0x00000000000000000000000000000000000a11ce` (`mintRecipient` is `0x` + 24 zero hex digits + 40 hex digits of the address); `"burnToken can be overridden"`; `"maxFeeWithHeadroom: high 71_067 on 10 USDC gives 213_201"`; `"high 16_288 gives 116_288 (the additive branch)"`; `"the protocol basis points add on top"` (bps 1 on 10_000_000 adds 1_000); `"it is clamped below the amount"` (amount 100_000 gives 99_999); `"fractional basis points round up"` (bps 1.3 on 10_000_000 adds 1_300; bps 0.01 on 10_000_000 adds 10).
    - `perps-rebalance.test.ts`: `"maxFeeOf reads whole numbers as units and fractions as dollars through feeUnits"` (existing behavior kept).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/iris.test.ts test/unit/cctp-burn.test.ts test/unit/perps-rebalance.test.ts`
- [ ] **Step 3: Implement.** `toWei` in `iris.ts` becomes `feeUnits(value) * 10n**12n`; the `forwardFee` input type widens; `maxFeeOf` in the script calls `feeUnits`. `encodeBurn` (Solana) is untouched. Parse a fractional value by its decimal digits (`Math.ceil(Number((value * 1e6).toFixed(6)))` at the least), not by a bare float product.
- [ ] **Step 4: Run the three files, then `npm test && npx tsc --noEmit`.** Expect PASS (the Solana withdrawal suites prove no regression).
- [ ] **Step 5: Commit** "Share one Iris fee parser, add maxFee headroom and the EVM burn encoder".

---

### Task 4: Shared Iris limiter, treasury lock, `treasuryFree` counts a top-up (spec 4 "Iris has one budget", 3 "Arc guard", 5.3.5)

**Files:**
- Create: `server/src/crosschain/iris-limiter.ts`
- Modify: `server/src/withdrawals/withdrawals.ts`, `server/src/withdrawals/payouts.ts` (limiter only), `server/src/server.ts` (create one limiter, pass to `Payouts`)
- Test: `server/test/unit/iris-limiter.test.ts` (create), `server/test/integration/withdrawals-pool.test.ts` (create); `server/test/integration/payouts-solana.test.ts` must still pass unchanged

**Interfaces:**
- Produces `class IrisLimiter { constructor(o?: { perSecond?: number; backoffMs?: number }); take(now: number): boolean; backoff(now: number): void; blockedUntil(): number }` (defaults 5 and 300_000, today's constants in `payouts.ts`).
- Produces on `Withdrawals`: public `treasuryFree(): Promise<bigint>` (was `#treasuryFree`) and `withTreasuryLock<T>(fn: () => Promise<T>): Promise<T>`, chained on the same `#lock` as `create`. `treasuryFree` also subtracts the `amountE6` (converted to wei with `e6ToWei`) of `poolRebalances` rows `{ direction: "arc_to_polygon", state: "sending" }`.
- `Payouts` Deps gains `irisLimiter?: IrisLimiter` (default a private one); its `#irisAsked` and `#irisBackoffUntil` are replaced by it.

- [ ] **Step 1: Write the failing tests.**
    - `iris-limiter.test.ts`: `"five takes in one second pass and the sixth is refused"`; `"a second later it allows again"`; `"backoff blocks every take for five minutes"`; `"two holders of one limiter share the budget"`.
    - `withdrawals-pool.test.ts` (as `withdrawals.test.ts` builds its stack): `"treasuryFree subtracts an arc_to_polygon row in sending and not one in forwarding"`; `"a polygon_to_arc row never subtracts"`; `"withTreasuryLock runs after an earlier create and before a later one"`; `"a withdrawal created while a top-up start holds the lock sees a treasuryFree that already subtracts the top-up, and is refused when it no longer fits"` (inside the lock: read free, flip a seeded row to `sending`; release; the concurrent create then sees the lower free).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/iris-limiter.test.ts test/integration/withdrawals-pool.test.ts`
- [ ] **Step 3: Implement** the limiter, the two `Withdrawals` changes and the `Payouts` swap. Rename uses of `#treasuryFree` inside `Withdrawals` to the public method.
- [ ] **Step 4: Run the new files, `test/integration/payouts-solana.test.ts` and `withdrawals.test.ts`, then the full checks.** Expect PASS ("Iris is asked at most once per tick and at most 5 times per second" still green).
- [ ] **Step 5: Commit** "Share the Iris budget and let a pool top-up take the treasury lock".

---

### Task 5: `Payouts` signs the rebalance's approve and burn (spec 4 "Arc to Polygon, Arc side", 6 "Before a burn is mined")

**Files:**
- Modify: `server/src/withdrawals/payouts.ts`
- Test: `server/test/integration/payouts-pool.test.ts` (create; copy the structure of `payouts-solana.test.ts`: stub TokenMessenger and USDC view via `installStub`, fake Iris, real Mongo, but with its own mnemonic and random stub addresses, see Test isolation)

**Interfaces:**
- Consumes: `PoolRebalanceDoc` (`arc.*`, `amountE6`, `maxFeeE6`, `mintRecipient`) and the Bus event (Task 1), `encodeApprove`, `encodeBurnToEvm`, `POLYGON_DOMAIN` (Task 3).
- Produces: `Payouts` handles `poolRebalances` rows `{ direction: "arc_to_polygon", state: "sending" }` after the withdrawals in `#pass`: `#signRebalance`, `#payRebalance`, `#settleRebalance`, `#failRebalance`, copied in style from the Solana path and **not** sharing code with it. `#failRebalance` guarded-updates `sending` to `failed` (`$unset active`, `lastError`, `doneAt`) and touches no ledger. The burn mined moves guarded `sending` to `forwarding` and emits `pool-rebalance:updated`. Payouts wakes on that event when `rebalance.state === "sending"`. `#nextNonce` also reads the highest `arc.burnNonce` of `sending` rows. Like the Solana path it signs against the `usdc` and `tokenMessenger` addresses in its Deps (so the stub is what the tests record) and passes `burnToken: usdc` to `encodeBurnToEvm`. Storing the signed bytes sets `arc.*` only: it must not touch `updatedAt` (Task 1 invariant), unlike `#signSolana`.

- [ ] **Step 1: Write the failing tests.**
    - `"approve then burn go out in nonce order and the stub records domain 7, the pool wallet as mintRecipient, zero destinationCaller, the stored maxFee, finality 2000 and FORWARD_HOOK_DATA"`.
    - `"both raw transactions and hashes are stored before either is broadcast"`.
    - `"the burn mined moves sending to forwarding and emits pool-rebalance:updated once"`.
    - `"a refused approve ends failed with no ledger row and the treasury unchanged except gas"` and `"a reverted burn ends failed the same way"` (assert `ledger` count unchanged and no `withdrawal_refund`).
    - `"restart in sending re-sends the same bytes and the burn is recorded once"`.
    - `"an Arc withdrawal, a Solana withdrawal and a rebalance interleaved take distinct nonces"`.
    - `"a burn mined and nothing else ever re-burns"` (tick five times, stub burn count stays 1).
    - `"a reverted burn leaves the allowance and logs info, and sets nothing back to zero"`.
    - `"an unreachable node leaves the row sending and the next pass re-sends the same bytes"` (Review Focus 8: broadcast throws a fetch failure; row unchanged, no second signing).
    - `"storing the signed bytes leaves updatedAt alone, and the burn mined sets it"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/payouts-pool.test.ts`
- [ ] **Step 3: Implement** as described; reuse the file's `alreadySent`, `refused`, `unreachable` helpers and its "nothing is signed above an unsent or unconfirmed transaction" rule (`#payRebalance` returns false while its transaction is unconfirmed and `#pass` stops there, as `#paySolana` does).
- [ ] **Step 4: Run the new file, `payouts-solana.test.ts`, `payouts.test.ts`, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Pay a pool top-up's approve and burn from the treasury, with no ledger effect".

---

### Task 6: Polygon batch encoders and the `PoolTrader` additions, with the fake (spec 1.2, 9 `PoolTrader`)

**Files:**
- Create: `server/src/predictions/pool-moves.ts`, `server/test/unit/pool-moves.test.ts`, `server/test/unit/fake-trader-pool.test.ts`
- Modify: `server/src/predictions/trader.ts`, `server/src/predictions/redeemer.ts` (the new `transaction` shape only), `server/test/support/fake-trader.ts`, `server/test/unit/trader-timeout.test.ts`, `server/test/integration/prediction-redeemer.test.ts`

**Interfaces:**
- Produces `pool-moves.ts`: `POLYGON = { usdc, pusd, onramp, offramp, tokenMessenger } as const` (addresses in Global Constraints, the only place they are written); `type Call = { to: Address; data: Hex }`; `wrapCalls(o: { amountE6: bigint; wallet: Address }): Call[]` (two calls); `unwrapAndBurnCalls(o: { amountE6: bigint; maxFeeE6: bigint; wallet: Address; recipient: Address }): Call[]` (four calls, order of 1.2, the burn via `encodeBurnToEvm` with `burnToken: POLYGON.usdc`, domain 26); `DEPOSIT_FOR_BURN_EVENT` (the `DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)` ABI item, copied from TokenMessengerV2.sol); `decodeBurnLog(log: { topics: Hex[]; data: Hex }): { depositor: Address; amountE6: bigint } | null`.
- Produces in `trader.ts`: `type BatchSubmit = { kind: "submitted"; transactionId: string } | { kind: "refused"; message: string } | { kind: "unknown" }` (`refused` means nothing was sent); `type RelayerTransaction = { state: TransactionState; hash: string | null; errorMsg: string | null }` (`TransactionState` is the existing `"pending" | "confirmed" | "failed"`; the raw `STATE_*` names stay inside the adapter); `PoolTrader` gains `usdcBalanceE6(): Promise<bigint>`, `syncBalance(): Promise<void>` (forces the CLOB's `updateBalanceAllowance` for the collateral), `wrapUsdc(amountE6: bigint): Promise<BatchSubmit>`, `unwrapAndBurn(o: { amountE6: bigint; maxFeeE6: bigint; recipient: Address }): Promise<BatchSubmit>`, `burnEvents(o: { since: Date }): Promise<{ txHash: Hex; amountE6: bigint }[]>` (burns by the pool wallet), `burnLog(transactionHash: Hex): Promise<{ amountE6: bigint } | null>` (the pool wallet's `DepositForBurn` in that receipt), `derivedWallet(): Promise<{ configured: Address; derived: Address; hasCode: boolean }>`; `transaction(id)` now returns `RelayerTransaction`. `withTimeouts` bounds all new calls; a timed-out `wrapUsdc` or `unwrapAndBurn` is `{ kind: "unknown" }`.
- Produces `FakeTrader` controls: `setUsdc(e6)`, `onNextBatch(b: "submit" | "refuse" | "unknown-executed" | "unknown-lost" | "partial")`, `confirmBatch(id)`, `failBatch(id)`, `burns: { txHash: Hex; amountE6: bigint }[]`, `lagBalance(on)` (until `syncBalance`, `balanceE6` shows the old figure), `setDerived(o)`, `batches` (records kind and amounts); `derivedWallet` defaults to a matching wallet with code. A confirmed wrap moves native USDC into the pUSD balance; a confirmed unwrap-and-burn lowers pUSD and records a burn (its hash is the batch's `hash`); `partial` runs the unwrap (pUSD down, native USDC up) without a burn; `unknown-executed` applies the batch on confirm but answers `unknown`.

- [ ] **Step 1: Write the failing tests.**
    - `pool-moves.test.ts`: `"wrapCalls is USDC.approve(onramp, x) then onramp.wrap(USDC, wallet, x)"` (decode both); `"unwrapAndBurnCalls has the four calls of 1.2 in order against the right targets"`; `"the fourth call burns native USDC to domain 26 with the treasury as mintRecipient, zero destinationCaller, finality 2000, the forwarding hook and the given maxFee"`; `"decodeBurnLog reads depositor and amount from a log built with encodeEventTopics and ignores another event"`.
    - `fake-trader-pool.test.ts`: `"a confirmed wrap moves native USDC into pUSD"`; `"a confirmed unwrapAndBurn lowers pUSD and records a burn"`; `"partial unwraps without a burn"`; `"lagBalance holds balanceE6 until syncBalance"`; `"refuse answers refused and records nothing"`.
    - `trader-timeout.test.ts`: `"a hung wrap and a hung unwrapAndBurn are unknown"`; `"hung usdcBalanceE6, syncBalance, burnEvents, burnLog and derivedWallet reject as timed out"`.
    - `prediction-redeemer.test.ts` keeps passing with the new `transaction` shape (`FakeTrader.transaction` returns `{ state, hash, errorMsg }`).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/pool-moves.test.ts test/unit/fake-trader-pool.test.ts test/unit/trader-timeout.test.ts`
- [ ] **Step 3: Implement** the encoders, interface, `withTimeouts`, the redeemer's read of `.state`, and the fake. The real adapter is Task 7; until it lands `tsc` fails because `createPolymarketTrader` lacks the new methods, so Tasks 6 and 7 are committed together after Task 7 (each still gets its own review).
- [ ] **Step 4: Run the new files and `prediction-redeemer.test.ts`.** Expect PASS (full `tsc` waits for Task 7).
- [ ] **Step 5: Do not commit.** `tsc` is red until Task 7 gives the real adapter the new methods, so Task 7's commit takes both tasks' files (`git commit -m "Add the Polygon batch encoders, the pool trader's wrap, unwrap and burn-scan calls, and their relayer adapter" -- <both tasks' paths>`).

---

### Task 7: The real adapter: relayer workflow, Polygon reads, derived wallet (spec 1.1.7 and 1.1.8, 2 "The mint recipient is checked")

**Files:**
- Create: `server/src/predictions/polygon-reader.ts`, `server/test/unit/polygon-reader.test.ts`
- Modify: `server/src/predictions/polymarket-trader.ts`, `server/scripts/polymarket-setup.ts`, `server/test/support/fake-clob.ts`, `server/test/integration/polymarket-trader.test.ts`

**Interfaces:**
- Produces `polygon-reader.ts`: `createPolygonReader(client: PolygonClient): PolygonReader` where `PolygonClient` is the `Pick<PublicClient, "readContract" | "getLogs" | "getTransactionReceipt" | "getCode" | "getBlockNumber">` viem members used, so tests pass hand-written stubs; `PolygonReader = { usdcBalanceE6(owner: Address): Promise<bigint>; hasCode(address: Address): Promise<boolean>; burnEvents(o: { wallet: Address; since: Date; now: Date }): Promise<{ txHash: Hex; amountE6: bigint }[]>; burnLog(o: { wallet: Address; hash: Hex }): Promise<{ amountE6: bigint } | null> }`. `burnEvents` scans from `head - ceil(elapsedSeconds) - 200` blocks (blocks are at least 1 s apart, so this over-covers) with `getLogs` on `POLYGON.tokenMessenger`, the event, `args: { depositor: wallet }`, in ranges of at most 2_000 blocks (a restart days after `attemptedAt` would otherwise ask a public RPC for a range it refuses), then keeps the logs whose `decodeBurnLog` depositor matches.
- `createPolymarketTrader(config, logger, options?: { polygon?: PolygonReader })` (default `createPolygonReader(createPublicClient({ chain: polygon, transport: http(config.POLYGON_RPC_URL) }))`) implements the Task 6 methods. `createPolymarketClient(config, captures?, options?: { ignorePinnedWallet?: boolean })` (its return type is unchanged; the signer it builds comes from a new exported `createPoolSigner(config, captures)` that the trader also calls for the batch driver, because the batch's typed data must be signed by the same owner key); `derivedWallet()` builds the second client with `ignorePinnedWallet: true`, once per process, and returns `{ configured: client.account.wallet, derived: second.account.wallet, hasCode }`.
- Batch driver (private helper `submitBatch(calls, metadata)`): `prepareGaslessTransaction(client, { calls, metadata })` (imported from `@polymarket/client/actions`; the error classes `RequestRejectedError`, `RateLimitError`, `UserInputError` from `@polymarket/client`), then loop `next(...)`: answer `requestAddress` with the owner address, `signGaslessTypedData` with the owner signer's `signTypedData`; the handle's `transactionId` is returned as `submitted`. `RequestRejectedError`, `RateLimitError`, `UserInputError` become `{ kind: "refused", message }`; any other error or no handle becomes `{ kind: "unknown" }`. `metadata` is `"Wrap native USDC into pUSD"` / `"Unwrap pUSD and burn to Arc"`.
- `transaction(id)` returns `{ state, hash: found.transactionHash || null, errorMsg: found.errorMsg || null }`.
- `fake-clob.ts` gains `nextSubmit(response: { status: number; body: Json })` (the next `POST /submit` answers it) and exposes the decoded `calls` of each submitted body (`body.depositWalletParams.calls[].{target,data,value}`).

- [ ] **Step 1: Write the failing tests.**
    - `polygon-reader.test.ts` (stub client): `"usdcBalanceE6 reads balanceOf on native USDC"`; `"burnEvents asks only for the wallet as depositor from a block range that covers the window, and drops a log whose amount or depositor doesn't decode"`; `"a window of 5_000 blocks is read in ranges of at most 2_000"`; `"burnLog finds the wallet's DepositForBurn in a receipt and returns null for another depositor"`; `"hasCode is false for 0x"`.
    - `polymarket-trader.test.ts` (fake CLOB): `"wrapUsdc submits one batch of two calls to native USDC and the Onramp and returns the relayer id"`; `"unwrapAndBurn submits four calls in the order of 1.2"`; `"a 400 on submit is refused and a 500 or a dropped connection is unknown"`; `"transaction returns the hash and error message of the relayer record"` (extends the existing state-mapping test: CONFIRMED has the hash, FAILED has `error_msg`); `"derivedWallet equals wallet without a pinned wallet and differs when POLYMARKET_DEPOSIT_WALLET pins another"` (the Polygon reader is the stub).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/polygon-reader.test.ts test/integration/polymarket-trader.test.ts`
- [ ] **Step 3: Implement.** `polymarket-setup.ts` prints a second line `Derived wallet: <address>` (and a warning line when it differs from the printed deposit wallet). `usdcBalanceE6` is `reader.usdcBalanceE6(client.account.wallet)`; `syncBalance` calls `updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL })`.
- [ ] **Step 4: Run the files, then `npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit Tasks 6 and 7 together** "Run the pool's wrap and unwrap batches through the relayer and read the Polygon side" (paths of both tasks).

---

### Task 8: `RelayerGate`, used by the redeemer (spec 4 "The relayer gate")

**Files:**
- Create: `server/src/predictions/relayer-gate.ts`, `server/test/integration/relayer-gate.test.ts`
- Modify: `server/src/predictions/redeemer.ts`, `server/src/server.ts` (create the gate, pass it to the redeemer)
- Test: `server/test/integration/prediction-redeemer.test.ts` (extend)

**Interfaces:**
- Produces `GATE_SHUT_MS = 11 * 60_000` and `class RelayerGate { constructor(o: { collections: Collections; now?: () => number }); run<T>(submit: () => Promise<T>, o: { from: "redeemer" | "rebalancer" }): Promise<{ ran: true; value: T } | { ran: false; reason: "shut" | "unconfirmed" }>; shut(): void }`.
    - `run` queues behind an in-process mutex held until `submit` settles, then (after taking it) refuses with `shut` while a `shut()` is in force, or `unconfirmed` when Mongo shows an earlier batch: a rebalance row with `polygon.relayerTransactionId` set and `polygon.relayerFinalAt` null, or `polygon.wrapTransactionId` set and `polygon.wrapFinalAt` null, or an attempt (`polygon.attemptedAt` / `polygon.wrapAttemptedAt`) younger than 11 minutes with no id stored. A drain row with `relayerFinalAt` set, and a wrap whose id and attempt were cleared by the flow (Task 11), never block: only rows that can still have a live batch count. For `from: "rebalancer"` only, also any `predictionRedemptions` row `submitted`. The redeemer skips the redemption check so its several due redemptions in one pass still go out one after another as today (spec 4 rule 4: the gate does not change that).
- `PredictionRedeemer` Deps gains `gate?: RelayerGate`. `#submit` wraps `trader.redeem` and the write of `submitted` in `gate.run(..., { from: "redeemer" })`; `ran: false` leaves the row due for the next tick (no failure recorded); a redeem error matching `/timed out/` also calls `gate.shut()`.

- [ ] **Step 1: Write the failing tests.**
    - `relayer-gate.test.ts`: `"two submissions started at the same instant never overlap"` (record enter/exit order of two `run` calls, one per `from`); `"a rebalance row with a relayer id and no relayerFinalAt blocks the redeemer"`, `"a wrap id with no wrapFinalAt blocks it"`, `"an attempt 5 minutes old with no id blocks it and one 12 minutes old does not"`; `"a drain row with relayerFinalAt set and an id no longer blocks"`; `"the rebalancer's own row with a young attempt and no id blocks the rebalancer too"` (a restart waits out the window); `"a redemption in submitted blocks the rebalancer and not the redeemer"`; `"shut() closes the gate for 11 minutes for both and then opens it"` (fake clock); `"a refused run leaves no side effect"`.
    - `prediction-redeemer.test.ts`: `"two due redemptions are both submitted in one pass"`; `"a timed-out redeem shuts the gate and the next due redemption waits"`; `"a held gate records no failure and no attempt"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/relayer-gate.test.ts test/integration/prediction-redeemer.test.ts`
- [ ] **Step 3: Implement** the gate and the redeemer change.
- [ ] **Step 4: Run both files, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Serialise relayer batches with one gate shared by the redeemer and the rebalancer".

---

### Task 9: Float reservations for moves, drift check, free-float alarms (spec 5.3.2 to 5.3.4, 3 "Reasons")

**Files:**
- Modify: `server/src/predictions/predictions.ts`, `server/test/support/prediction-harness.ts` (accept `logger` and `floatUsd` options; today the logger is silent and `POLYMARKET_FLOAT_USD` is fixed at 100, and Task 10's harness needs both)
- Test: `server/test/integration/prediction-float.test.ts` (extend)

**Interfaces:**
- Produces on `PredictionService`: `reserveForMove(session: ClientSession, amountE6: bigint): Promise<void>` (the guarded `#reserve`; throws `AppError("float_short")`); `releaseForMove(session: ClientSession, reservedE6: bigint, spentE6: bigint): Promise<void>` (`#release`; and it refreshes the in-memory mirror). `#openHolds` also adds `reservedE6` of `poolRebalances` rows `{ direction: "polygon_to_arc", state: "submitting" }`. `#warnOnFloat` reads **free float** (`balance - held - unread` from the updated document) against 25% and 200% of `POLYMARKET_FLOAT_USD`.

- [ ] **Step 1: Write the failing tests.**
    - `"reserveForMove holds free float, and beyond it throws float_short with nothing held"`.
    - `"a release as spent adds to unreadFillsE6 and the next refreshFloat clears it, so free float does not jump back before the read"`.
    - `"a release with nothing spent restores free float"`.
    - `"the drift check counts a submitting drain's reservation and does not repair it away"`.
    - `"the low alarm fires on free float: balance 100, held 80 warns low though the balance alone does not"` and `"the high alarm reads free float"` (captured pino lines).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/prediction-float.test.ts`
- [ ] **Step 3: Implement** the two methods, the extra sum, and the alarm input.
- [ ] **Step 4: Run the file, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Let a pool move reserve free float, and warn on free float".

---

### Task 10: `PoolRebalancer` I: worker, start path, wiring, harness (spec 2, 3 "Arc guard", 5.2, 7)

**Files:**
- Create: `server/src/predictions/rebalancer.ts` (worker, start path, advance loop), `server/src/predictions/rebalance-flows.ts` (`FlowContext`, `FLOWS`; empty until Tasks 11 and 12), `server/src/predictions/rebalance-log.ts` (error constants, `HourlyLog`), `server/src/predictions/pool-inputs.ts`, `server/test/support/pool-harness.ts`
- Modify: `server/src/server.ts`
- Test: `server/test/integration/pool-rebalancer-start.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1 to 9 (`planPoolMove`, `maxFeeWithHeadroom`, `Withdrawals.treasuryFree/withTreasuryLock`, `IrisLimiter`, `RelayerGate`, the `PoolTrader` additions, `PredictionService.reserveForMove`).
- Produces `rebalance-log.ts`: `POOL_ERRORS` (the seven error strings of Global Constraints) and `class HourlyLog { constructor(logger: Logger, now: () => number); once(key: string, level: "warn" | "error", fields: object, message: string): void }`.
- Produces `pool-inputs.ts`: `newPoolRebalance(o: { kind: "move" | "wrap_idle"; direction: PoolDirection | null; source: "auto" | "operator"; reason: "low" | "high" | "operator"; amountE6: bigint; now: Date }): PoolRebalanceDoc` (state `queued`, `active: true`, `attempts: 0`, every other spec 5.1 field `null`, a `wrap_idle` row has amount 0; the one place a row is built, used by Tasks 13 and 14); `type PoolConfig = Pick<Config, "PREDICTIONS_TRADING" | "POLYMARKET_FLOAT_USD" | "POOL_REBALANCE_MAX_MOVE_USD" | "POOL_REBALANCE_MAX_DAY_USD" | "POOL_REBALANCE_ARC_RESERVE_USD" | "POOL_REBALANCE_MIN_MOVE_USD" | "POOL_REBALANCE_PAUSE_MIN">`; `movedLast24hE6(collections, now: number, excludeId?: ObjectId): Promise<bigint>` (sum of `amountE6` of `kind: "move"`, `arc_to_polygon` rows not `failed` created in the last 24 hours); `haltedDirections(collections): Promise<Record<PoolDirection, boolean>>` (per direction: the newest 3 `kind: "move"` rows and whether a `stuck` row exists, through `isHalted`).
- Produces `rebalancer.ts`: `class PoolRebalancer { constructor(deps: { collections; ledger; withdrawals: Pick<Withdrawals, "treasuryFree" | "withTreasuryLock">; service: PredictionService; trader: () => PoolTrader | null; needTrader: () => void; treasury: Address; iris: Iris; limiter: IrisLimiter; gate: RelayerGate; bus: Bus; logger: Logger; config: PoolConfig; now?: () => number }); start(): void; stop(): Promise<void>; tick(): Promise<void> }` and `poolRowsOpen(collections): Promise<number>` (rows `queued`, `sending`, `submitting`, `forwarding`, `wrapping`, `stuck`). `tick` starts the `queued` row, then calls `FLOWS[key]` for each row in a flow state (the fast state `submitting` each tick; the slow states `forwarding`, `wrapping` and `stuck` at most every 30 s per row by the injected clock). `sending` is Payouts' and has no flow.
- Produces `rebalance-flows.ts`: `type FlowContext = { collections; trader: PoolTrader; treasury: Address; pendingSend: Set<string>; iris: Iris; limiter: IrisLimiter; gate: RelayerGate; service: PredictionService; ledger: Ledger; bus: Bus; logger: Logger; now: () => number; config: PoolConfig; log: HourlyLog; move(row, to: PoolRebalanceState, patch?: Record<string, unknown>): Promise<PoolRebalanceDoc | null> }` (guarded by the row's current state, `$unset active` on `done`/`failed`/`stuck` and never sets it again, so a row that leaves `stuck` for `wrapping` or `done` cannot collide with a newer active row on the unique index; sets `updatedAt` and `doneAt` only on a state change, emits `pool-rebalance:updated`); `pendingSend` holds the ids of drain rows this process has reserved and not yet attempted to send (Task 12), so a row whose send was held back by the gate is retried while a `submitting` row with no `attemptedAt` that is not in the set (a restart) is known never to have been sent; `type Flow = (ctx: FlowContext, row: PoolRebalanceDoc) => Promise<void>`; `FLOWS: Record<string, Flow>` keyed `` `${direction ?? kind}:${state}` ``.
- Produces `pool-harness.ts`: `poolHarness(o?: { trading?: "on" | "off"; treasuryUsdc?: string; floatUsd?: number })` over `predictionHarness` (its `floatUsd` option, Task 9) plus anvil: real `Withdrawals` and `Payouts` signing from a fresh mnemonic with stub messenger and USDC view installed at fresh random addresses on each call (see Test isolation; `payouts-solana.test.ts` shows the wiring), a `startFakeIris` with `createIris`, a `FakeTrader` whose `derivedWallet` defaults to a matching wallet with code, one `IrisLimiter`, one `RelayerGate`, a mutable clock, the `rebalancer`, helpers `queue(o)`, `rowOf(id)`, `setTreasury(usdc)`, `pass()` (`rebalancer.tick()`, `payouts.tick()`, `rebalancer.tick()`).
- Start path (each tick, on the single `queued` row):
    1. Without a trader: `needTrader()` and leave it queued.
    2. `arc_to_polygon`: price with `iris.forwardFee({ from: 26, to: 7 })` through the limiter (Iris unreachable or limiter empty: leave queued, `warn`); `maxFeeE6 = maxFeeWithHeadroom(...)`; `trader.derivedWallet()` once per process (cache a success; a throw leaves the row `queued` like an unreachable Iris; `configured !== derived` or `!hasCode` ends the row `failed` with `lastError: "Pool wallet mismatch"` and the `error` log); then `withdrawals.withTreasuryLock`: read `treasuryFree()` (wei, so `weiToE6` it), `planPoolMove` (E6; limits through `usdToE6`; `movedLast24hE6` excluding this row; `freeFloatE6` is unused for this direction, pass 0n), and either move `queued` to `sending` storing `maxFeeE6` and `mintRecipient` (the configured wallet), or `failed` with `lastError` = the plan's reason (a `reserve` refusal also logs "Treasury too low to top up the pool"). A throw from `treasuryFree` leaves the row `queued`.
    3. `polygon_to_arc`: price with `forwardFee({ from: 7, to: 26 })`; the plan check (`freeFloatE6` from the `pool_float` document, 0n when missing; the treasury, reserve and daily inputs are unused for this direction, pass 0n; `reserveForMove` below is the authoritative guard); one `ledger.runInTransaction`: `service.reserveForMove`, then `findOneAndUpdate({ _id, state: "queued" }, { state: "submitting", reservedE6, maxFeeE6 })` (no match aborts the transaction); after the commit the id joins `pendingSend`; `float_short` ends the row `failed` with "Free float is short." The send step is Task 12.
    4. `wrap_idle`: `queued` to `wrapping` with no guard other than the trader.
- `server.ts`: reuse the `RelayerGate` Task 8 created, build the rebalancer only when `POOL_REBALANCE === "on"`, start it with the other workers and stop it first on close, pass `needTrader: () => ensureTrader()` (a bare `ensureTrader` is read before its `const` and throws; the other workers use the arrow too), `treasury: keyring.operator().address` and `logger.child({ component: "pool-rebalancer" })` (every line carries the row id, direction and amount; `info` lines per spec 8 for each transition), and add `poolRowsOpen` to the posted and redemption count behind `traderNeeded`.

- [ ] **Step 1: Write the failing tests.** `pool-rebalancer-start.test.ts`:
    - `"a queued top-up inside the caps moves to sending with maxFeeE6 from Iris and the pool wallet as mintRecipient"`; `"a top-up above the move cap ends failed"`; `"a top-up the daily cap refuses ends failed, naming the cap, with nothing signed"` (seed 250 moved today plus 60); `"a top-up the Arc reserve refuses ends failed and logs 'Treasury too low to top up the pool' once an hour"`.
    - `"an RPC failure reading the treasury leaves the row queued and signs nothing"` (Review Focus 8).
    - `"a queued drain bigger than free float ends failed with nothing reserved"`; `"a queued drain reserves free float and moves to submitting in one transaction"` (held +x, `reservedE6` stored).
    - `"Iris unreachable leaves the row queued and a 429 backs the shared limiter off"`.
    - `"a configured wallet that differs from the derived one signs nothing and logs 'Pool wallet mismatch'"`, `"so does a wallet with no code"`, `"and the check runs once per process"`.
    - `"newPoolRebalance fills every spec 5.1 field and a wrap_idle row has amount 0"`; `"a derivedWallet call that throws leaves the row queued"`.
    - `"with no trader the worker asks for one and leaves the row queued"`; `"poolRowsOpen counts queued, active and stuck rows and not done or failed ones"`; `"an error line repeats at most once an hour per key"`.
    - Whole server (`startStack({ env: { POOL_REBALANCE, POLYMARKET_POOL_KEY, the three builder vars } })`): `"switch off: a queued row stays queued and nothing is decided"`; `"switch on: a queued top-up against an unfunded treasury ends failed inside the running server"`. The startup rule (spec 10: with the switch on, trading off and a `queued` row, the trader is connected) is covered by `poolRowsOpen`'s test, the worker's `needTrader` test and the `server.ts` count; the stack always hands the server a trader, so a whole-server test cannot tell connected from not.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/pool-rebalancer-start.test.ts`
- [ ] **Step 3: Implement** the files above and the `server.ts` wiring.
- [ ] **Step 4: Run the file, then `npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Start pool moves under the treasury lock, with the worker wired into the server".

---

### Task 11: `PoolRebalancer` II: the top-up flow, wrap, `wrap_idle`, stuck (spec 5.2, 6 "After the burn is mined", "Wrap", "Idle native USDC", "Stuck")

**Files:**
- Modify: `server/src/predictions/rebalance-flows.ts`, `server/src/predictions/rebalancer.ts` (the 10-minute idle read)
- Test: `server/test/integration/pool-topup.test.ts` (create)

**Interfaces:**
- Consumes: Task 10's `FlowContext`, `FLOWS`, harness and `HourlyLog`; Task 8's `RelayerGate.run`; Task 6's `PoolTrader` additions (`BatchSubmit`, `RelayerTransaction`).
- Produces `FLOWS` keys `arc_to_polygon:forwarding`, `arc_to_polygon:wrapping`, `arc_to_polygon:stuck`, `wrap_idle:wrapping`.
- Forwarding: one `iris.message({ domain: 26, burnTxHash: arc.burnTxHash })` per tick through the limiter (429: `limiter.backoff`, state unchanged, `warn`); a `delayReason` logs "Pool rebalance burn delayed" with the reason and the full message; `complete` stores `iris.forwardTxHash`, `iris.feeExecutedE6` and moves to `wrapping`. Nothing here re-burns or fails.
- Wrapping: if `polygon.wrapTransactionId` is set and `wrapFinalAt` is null, poll `trader.transaction` (its `state` is `"pending" | "confirmed" | "failed"`). `"failed"`, or 30 minutes since `wrapSubmittedAt`, clears `wrapTransactionId` **and** `wrapAttemptedAt` together (the signed batch can no longer run, so the gate must not keep waiting on it) and sets `nextAt` for the retry (1, 5, 15 minutes, then hourly, by `attempts`; after 10 attempts the "A pool rebalance wrap keeps failing" error hourly). `"confirmed"` stores `wrapFinalAt`. A lookup that throws changes nothing.
    - Submitting, when due: read `usdcBalanceE6()` (a throw leaves the row as it is, with a `warn`; the next tick tries again). At `>= amountE6 - maxFeeE6` (any balance above zero for `wrap_idle`; zero idle ends `done` with no batch) read `trader.balanceE6()`, then inside `gate.run(..., { from: "rebalancer" })` write `wrapAttemptedAt`, `polygon.balanceBeforeE6` and `mintedE6` (the balance about to be wrapped) in one update, call `trader.wrapUsdc(balance)`, and on `submitted` store `wrapTransactionId` and `wrapSubmittedAt`. `ran: false` writes nothing. `refused` unsets `wrapAttemptedAt` (nothing was sent) and sets `nextAt` like a failed batch. `unknown` calls `gate.shut()` and keeps `wrapAttemptedAt` with no id.
    - An unknown wrap (a stored `wrapAttemptedAt` with no id, including after a restart) is decided once 11 minutes have passed since `wrapAttemptedAt`: read `usdcBalanceE6()`; still `>= amountE6 - maxFeeE6` (above zero for `wrap_idle`) means the batch never ran, so unset `wrapAttemptedAt` and wrap again; below that means it ran and turned the USDC into pUSD, so set `wrapFinalAt` to the window's end and go on to the Done check below. (Waiting for a balance that is already wrapped would leave the row `wrapping` until it went `stuck`.)
    - A retry always wraps the balance found then, and keeps going while the row is `stuck`. The wrap batch is never submitted twice for one stored id.
- Done (top-up and `wrap_idle`): once `wrapFinalAt` is set (the batch is `"confirmed"`, or the unknown wrap above ran), call `trader.syncBalance()` and `service.refreshFloat()`, and finish when `pool_float.balanceE6 >= polygon.balanceBeforeE6 + polygon.mintedE6` with `balanceAt` after `wrapFinalAt`; 10 minutes after `wrapFinalAt` without that, `done` anyway with a `warn`. A forced read that throws is retried next tick.
- Stuck: `forwarding` or `wrapping` older than 2 hours (by `updatedAt`) becomes `stuck` and is still followed: `arc_to_polygon:stuck` polls Iris like `forwarding` while `iris.forwardTxHash` is null, and runs the wrapping flow once it is set; a late `complete` moves `stuck` back to `wrapping` (without setting `active` again, see `move`); "Pool rebalance stuck: needs an operator" is logged hourly with the row id, hashes and the last Iris body.
- Idle: every 10 minutes while the trader is connected the worker reads `usdcBalanceE6()` and warns hourly "Native USDC is idle in the pool wallet" when above $1 with no row `wrapping`.

- [ ] **Step 1: Write the failing tests** (`pool-topup.test.ts`).
    - `"end to end: queued, sending, both Arc transactions mined, forwarding, Iris pending then complete, wrapping, wrap confirmed, forced read, done"`; free float unchanged until `syncBalance` and `refreshFloat` (use `lagBalance`).
    - `"a delayReason logs 'Pool rebalance burn delayed' and neither fails nor re-burns"` (stub burn count stays 1).
    - `"a stalled Iris after the burn never fails, becomes stuck after 2 hours with the hourly error, and a late complete moves it on"`.
    - `"the wrap waits until the wallet holds at least amount minus maxFee, and wraps at exactly that"` (Review Focus 11: one unit less submits nothing).
    - `"the wrap wraps the whole balance, not the amount"`.
    - `"a failed wrap batch retries after 1, 5, 15 minutes then hourly, wrapping whatever the balance is"`; `"a second attempt after a success does nothing"`; `"a wrap unconfirmed for 30 minutes is retried"`; `"the retry continues while the row is stuck"`; `"after 10 tries 'A pool rebalance wrap keeps failing' is logged hourly"`.
    - `"a forced read that never shows the rise ends done after 10 minutes with a warn"`.
    - `"an unknown wrap that ran ends done through the float check without a second batch"` (the wallet's USDC is gone after 11 minutes; `trader.batches` stays at one) and `"an unknown wrap that never ran is wrapped again after 11 minutes"` (Review Focus 4).
    - `"a refused or failed wrap clears the attempt, so the gate does not hold the retry"` (the retry goes out at 1 minute, not 11).
    - `"a Polygon RPC failure reading the wallet leaves the row wrapping and fails nothing"` (Review Focus 8).
    - `"a new worker resumes polling a stored wrap batch id and submits nothing"` (Review Focus 5).
    - `"wrap_idle wraps idle USDC and ends done, and with nothing idle ends done without a batch"`; `"idle USDC over $1 warns hourly and under $1 does not"`.
    - `"Iris answering 429 or unreachable while forwarding leaves the state unchanged and backs the shared limiter off"`.
    - `"Payouts and the rebalancer share one Iris budget"` (a 429 seen by one blocks the other).
    - `"a new worker on the same rows resumes forwarding from the stored burn hash and signs and burns nothing"` (restart safety).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/pool-topup.test.ts`
- [ ] **Step 3: Implement** the four flows and the idle read.
- [ ] **Step 4: Run the file and `pool-rebalancer-start.test.ts`, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Follow a pool top-up from Circle's forward to wrapped pUSD, and wrap idle USDC".

---

### Task 12: `PoolRebalancer` III: the drain flow (spec 5.3.2 to 5.3.3, 6 "Polygon to Arc batch")

**Files:**
- Modify: `server/src/predictions/rebalance-flows.ts`, `server/src/predictions/rebalancer.ts` (send step after the reservation)
- Test: `server/test/integration/pool-drain.test.ts` (create)

**Interfaces:**
- Consumes: Task 10's `FlowContext` (`pendingSend`, `treasury`, `move`), `FLOWS`, the harness, `PredictionService.releaseForMove` (Task 9), `RelayerGate.run` (Task 8), and Task 6's `unwrapAndBurn`, `transaction`, `burnLog`, `burnEvents`, `syncBalance`.
- Produces `FLOWS` keys `polygon_to_arc:submitting`, `polygon_to_arc:forwarding`, `polygon_to_arc:stuck`.
- Behavior: the release helper runs one `ledger.runInTransaction`: guarded `findOneAndUpdate({ _id, state: "submitting" }, ...)` to the target state and, only if that matched, `releaseForMove(session, reservedE6, spent)`; a second tick matches nothing and releases nothing.
    - *Send* (each tick for a row in `ctx.pendingSend`, which includes the pass that reserved it): inside `gate.run(..., { from: "rebalancer" })` write `polygon.attemptedAt` and leave `pendingSend`, call `trader.unwrapAndBurn({ amountE6, maxFeeE6, recipient: ctx.treasury })`, and on `submitted` store `polygon.relayerTransactionId` at once. `ran: false` writes nothing and the row stays in `pendingSend`, so the next tick tries again (the reservation is held meanwhile; the gate frees when the blocking redemption or batch is final). A `submitting` row with no `attemptedAt` that is not in `pendingSend` (a restart) was never sent: `failed` with the reservation released, nothing spent, at once. `refused` is `failed`, released, nothing spent, and sets `polygon.relayerFinalAt` (nothing was sent, so the gate must not wait for it). `unknown` calls `gate.shut()` and leaves the row `submitting` with `attemptedAt` and no id; no later tick or restart submits again.
    - *Track* (fast): with an id, `trader.transaction(id)` (`state` is `"pending" | "confirmed" | "failed"`). On `"confirmed"` or `"failed"` set `polygon.relayerFinalAt`; with a `hash`, `trader.burnLog(hash)`. A log whose amount equals the row's `amountE6` moves the row to `forwarding` (release as spent, `polygon.burnTxHash`, `burnLogSeen: true`), then `syncBalance()` and `refreshFloat()`. `"confirmed"` with no log, or with no hash and no adopted burn from the scan below, is `stuck` (release as spent, `error` "Pool rebalance confirmed without a burn" with the hash). `"failed"` with no log is `failed` (release, nothing spent). Lookups that throw, or no id, for 11 minutes from `attemptedAt` fall back to `trader.burnEvents({ since: attemptedAt })`: an event with the move's amount is adopted as `burnTxHash` and goes to `forwarding` (release as spent); none is `failed` (release, nothing spent); either way set `polygon.relayerFinalAt` when the window ends. A `"confirmed"` record with no hash also uses this scan.
    - *Forwarding* (slow): `iris.message({ domain: 7, burnTxHash })` through the limiter; `complete` stores the Iris fields, runs the forced read, and the row is `done`. Stuck after 2 hours and the late-complete rule as in Task 11. `polygon_to_arc:stuck` follows Iris the same way when the row has a `burnTxHash`; a row that went `stuck` from `submitting` (no burn) has nothing to follow and only logs the hourly stuck error until `resolve`.

- [ ] **Step 1: Write the failing tests.**
    - `"end to end: reservation, batch, burn log found, release as spent in one transaction, forced read, Iris complete, done"`; `"a concurrent order can't take the reserved pUSD"` (an order larger than the remaining free float gets `float_short`); `"the drift check doesn't repair the reservation"` (run `refreshFloat` while `submitting`).
    - `"a restart that finds submitting with no attemptedAt fails and releases at once"`.
    - `"a refusal fails and releases"`.
    - `"a timeout with a matching burn event is adopted"`; `"a timeout with none stays submitting for 11 minutes, then fails and releases"` (fake clock: 10 minutes still `submitting`, 11 `failed`).
    - `"transaction lookups that keep throwing for 11 minutes fall back to the burn scan"`; `"a confirmed record with no hash falls back to the burn scan"`; `"a log with another amount is not taken as the move's burn"`.
    - `"a worker restarted after attemptedAt with no id never submits again"` (Review Focus 2: the second worker's `trader.batches` has no new entry, the row waits the 11 minutes, then scans).
    - `"a send held back by the gate keeps the reservation and goes out when the gate opens; a restart in that state fails and releases"`.
    - `"a refused batch sets relayerFinalAt, so the gate is open to the redeemer at once"`.
    - `"a confirmed batch with no burn log ends stuck, released as spent, and logs 'Pool rebalance confirmed without a burn' with the hash"`; `"a failed batch with no log ends failed with nothing spent"`.
    - `"a repeat tick releases nothing a second time and heldE6 never goes negative"` (two concurrent ticks on one row).
    - `"the batch is not submitted while a redemption is submitted, and the row is retried after it confirms"`.
    - `"a stalled Iris after the burn becomes stuck at 2 hours and a late complete finishes it"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/pool-drain.test.ts`
- [ ] **Step 3: Implement** the flows and the send step. This task adds no `debitInSession` or `creditInSession` call.
- [ ] **Step 4: Run the file and `pool-topup.test.ts`, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Drain the pool back to Arc: reserve, unwrap and burn in one batch, and settle the reservation once".

---

### Task 13: `PoolRebalancer` IV: automatic decisions, pause, per-direction halt (spec 2 "Evaluate", 3, 6 "Repeated failures", 7)

**Files:**
- Modify: `server/src/predictions/rebalancer.ts`, `server/src/predictions/pool-inputs.ts`
- Test: `server/test/integration/pool-decisions.test.ts` (create)

**Interfaces:**
- Produces `readDecisionInputs(collections, config, now: number): Promise<{ tradingOn: boolean; targetE6: bigint; freeE6: bigint | null; floatAt: number | null; lastMoveAt: number | null; pauseMs: number; minMoveE6: bigint; maxMoveE6: bigint; halted: Record<PoolDirection, boolean>; active: number }>` (reads `pool_float` id `"polygon"`; `targetE6`, `minMoveE6`, `maxMoveE6` come from the config dollars through `usdToE6` and `pauseMs` is `POOL_REBALANCE_PAUSE_MIN * 60_000`; `freeE6` is `balanceE6 - heldE6 - unreadFillsE6`, null with no document; `lastMoveAt` is the newest `updatedAt` of any `kind: "move"` row; `active` counts rows with `active: true`). The worker and the Task 14 `plan` command both call it.
- Evaluate (in `tick`, every 60 s by the injected clock, only when `config.PREDICTIONS_TRADING === "on"`, `active === 0` and the float document exists): `decidePoolMove`; a decision first runs `planPoolMove` as an advisory check (reserve refusal logs "Treasury too low to top up the pool", day cap logs `info`, neither queues a row, so a low treasury alone cannot halt top-ups); otherwise it inserts `newPoolRebalance({ kind: "move", source: "auto", reason, ... })` (`queued`, `active: true`, `attempts: 0`). A duplicate-key error on that insert is dropped with an `info`. A halted direction logs "Pool rebalancing halted after repeated failures" hourly (per direction) and decides nothing for it; queued operator rows still run. The advisory `planPoolMove` takes the treasury read through `weiToE6` like the start path, and a throw from that read skips the decision with a `warn`.

- [ ] **Step 1: Write the failing tests.**
    - `"free under 50% of T with trading on queues exactly one auto top-up for the planned amount"`; `"over 150% queues one drain"`; `"between the bands queues nothing"`.
    - `"a float document older than 3 minutes, a move still in its pause, and a float read older than the last move each skip the decision"`; `"no pool_float document and no trader decide nothing and do not throw"`.
    - `"an auto row and an operator row take the same start path and the same guards"` (same plan refusal on both).
    - `"the operator's row and the evaluate insert at the same instant: the loser is a quiet duplicate key"` (Review Focus 6: no `error` line, one active row).
    - `"a stuck drain doesn't block a top-up; a stuck top-up blocks automatic top-ups"`.
    - `"three failed rows halt one direction only, a queued move of that direction still runs, and a success or resolve (resolvedAt) lifts the halt"`.
    - `"with trading off nothing is decided, a queued move runs and an active row finishes"`; `"after an auto move the next decision waits for the pause and a newer float read"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/pool-decisions.test.ts`
- [ ] **Step 3: Implement** `readDecisionInputs`, the evaluate step, and the halted-direction gating (the start path never consults `halted`).
- [ ] **Step 4: Run the file and the two flow files, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Decide pool moves automatically by the bands, with a pause and a per-direction halt".

---

### Task 14: The operator script and the older rebalance script's refusal (spec 2 "Operator script", 5.3.9)

**Files:**
- Create: `server/scripts/pool-rebalance.ts`, `server/test/unit/pool-rebalance-script.test.ts`
- Modify: `server/scripts/perps-rebalance.ts`, `server/test/unit/perps-rebalance.test.ts`

**Interfaces:**
- Consumes: `readDecisionInputs`, `decidePoolMove`, `movedLast24hE6` (Tasks 10, 13), `createPolymarketTrader`, `Withdrawals`-free treasury read as `perps-rebalance.ts` does it (`arc.getBalance` less `sending` withdrawals and pool rows, less `TREASURY_GAS_RESERVE`).
- Produces exports in `pool-rebalance.ts` (all pure or Mongo-only, none signs): `parseUsd(text: string): bigint` (E6; accepts `^\d+(\.\d{1,6})?$` above zero, else throws "Enter an amount above zero with at most 6 decimals."); `queueMove(collection, o: { direction: PoolDirection; amountE6: bigint }): Promise<{ ok: true; id: ObjectId } | { ok: false; active: PoolRebalanceDoc | null }>` (inserts `newPoolRebalance({ kind: "move", source: "operator", reason: "operator", ... })` from Task 10; a duplicate key returns the active row); `queueWrapIdle(collection)` (kind `wrap_idle`, same result type); `resolveRow(collection, id: string, outcome: "done" | "failed"): Promise<boolean>` (throws on an id that is not an ObjectId, as `markArrived` does; guarded on `state: "stuck"`; sets `state`, `resolvedAt`, `doneAt`, never `active`); `refusalWhileOff(env)` (the message when `POOL_REBALANCE` is not `"on"`).
- Commands from `server/`: `node --env-file=.env scripts/pool-rebalance.ts status | plan | move arc-to-polygon|polygon-to-arc <usd> | wrap-idle | resolve <id> done|failed`. The script checks `POOL_REBALANCE` before loading config or touching Mongo. `status` prints the treasury free, pool balance, held, free float, idle native USDC, the configured and derived wallet (and a warning when they differ), the active row and the last five rows. `plan` prints the worker's decision and queues nothing.
- Produces in `perps-rebalance.ts`: `refusalReason(o: { sendingWithdrawals: number; busyPoolRows: number }): string | null` (non-null when either is above zero: it signs from the treasury key) and `owedOf(o: { withdrawals: { amount: Decimal128 }[]; poolRows: { amountE6: Decimal128 }[] }): bigint` (wei: the withdrawals plus the pool rows, `e6ToWei`); `main` counts `withdrawals` in `sending` and `poolRebalances` in `queued`, `sending`, `submitting`, calls `refusalReason`, and feeds `owedOf` the `arc_to_polygon` rows in `sending`. The header comment gains the rule: with `POOL_REBALANCE=on`, stop the server or restart it with `off` before running it.

- [ ] **Step 1: Write the failing tests.**
    - `pool-rebalance-script.test.ts`: `"parseUsd refuses 0, -5, 5.5555555, abc and 1e3 and accepts 5, 5.5 and 0.000001"` (Review Focus 9); `"queueMove inserts one queued operator row"`; `"a second move while one is active or queued is rejected and returns the active row"`; `"queueWrapIdle inserts a wrap_idle row, and is rejected while a move is active"`; `"resolveRow marks only a stuck row, sets resolvedAt, and refuses an id that is not an ObjectId"`; `"the script refuses when POOL_REBALANCE is off or unset"` (`spawnSync(process.execPath, ["scripts/pool-rebalance.ts", "status"], { env })`, non-zero status, stderr mentions the switch).
    - `perps-rebalance.test.ts`: `"refusalReason refuses while a withdrawal is sending or a pool row is queued, sending or submitting, and allows neither"`; `"owedOf adds a sending top-up to the withdrawals' wei"`.
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/unit/pool-rebalance-script.test.ts test/unit/perps-rebalance.test.ts`
- [ ] **Step 3: Implement** both scripts, modeled on `perps-rebalance.ts` (`import.meta.main` guard, `connectDatabase`, `finally` close).
- [ ] **Step 4: Run both files, then the full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Add the pool-rebalance operator script and make the older rebalance script respect pool moves".

---

### Task 15: Solvency counts the pool's money (spec 5.3.6)

**Files:**
- Create: `server/src/predictions/pool-assets.ts`
- Modify: `server/src/perps/reconciler.ts`, `server/src/server.ts` (pass `poolAssets`)
- Test: `server/test/integration/pool-solvency.test.ts` (create; built on `perp-harness.ts` like `perp-reconciler.test.ts`)

**Interfaces:**
- Produces `poolAssets(o: { collections: Collections; trader: () => PoolTrader | null; now?: () => number; logger: Logger }): () => Promise<{ assetsE6: bigint; stale: boolean }>`: free float (`balanceE6 - heldE6 - unreadFillsE6` of `pool_float`; `stale` when `balanceAt` is older than 3 minutes), plus `usdcBalanceE6()` (0 without a trader; a throw counts 0 and makes the answer `stale: true`, so an outage warns instead of raising a false shortfall), plus `amountE6 - maxFeeE6` of both directions' `forwarding` rows younger than an hour (older ones log `error` and are not counted), plus `reservedE6` of `polygon_to_arc` rows in `submitting`. `arc_to_polygon` rows in `wrapping` add nothing (the idle USDC covers them). It is passed to the reconciler whatever the switch says (it only adds assets).
- `PerpReconciler` Deps gains `poolAssets?: () => Promise<{ assetsE6: bigint; stale: boolean }>`; when given, its total joins `assets`, and a shortfall over the tolerance logs `warn` instead of `error` while `stale`.

- [ ] **Step 1: Write the failing tests.**
    - `"a failing idle-USDC read counts zero and marks the answer stale, so the shortfall is a warn"` (Review Focus 8);
    - `"an arc_to_polygon row in forwarding counts as an asset"`; `"a polygon_to_arc forwarding row counts too"`; `"a forwarding row over an hour old isn't counted and logs an error"`; `"a submitting drain counts its reservation"`; `"idle native USDC counts"`; `"a wrapping top-up adds nothing beyond the idle USDC"`; `"the gross balance isn't counted, only free float"`; `"a shortfall with a stale float document logs warn, not error"`; `"without poolAssets the existing reconciler tests are unchanged"` (run `perp-reconciler.test.ts`).
- [ ] **Step 2: Run; expect FAIL.** `cd server && npx vitest run test/integration/pool-solvency.test.ts`
- [ ] **Step 3: Implement** `pool-assets.ts`, the reconciler hook, and the `server.ts` wiring (`poolAssets({ collections, trader: () => trader, logger })`).
- [ ] **Step 4: Run the file and `perp-reconciler.test.ts`, then `npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Count the pool's free float, idle USDC and money in flight in the solvency check".

---

## After Task 15 (the owner's, not tasks)

Spec section 11, in order, on mainnet with small amounts; `POOL_REBALANCE=on` and `PREDICTIONS_TRADING=off` for 1 to 6: (1) `pool-rebalance.ts status` shows the configured and derived wallet equal; (2) `move arc-to-polygon 5`: Arc hashes, Iris `complete` with `forwardTxHash`, burn-to-mint time, native USDC in the wallet, the wrap, the CLOB balance rise (answers open questions 3, 5, 6, 9); (3) `move polygon-to-arc 5`: one relayer batch ran, a burn log, the treasury rose by about 4.98 (answers 2, 3, 10); (4) a redemption and a rebalance close together (4); (5) restart mid-`forwarding`; (6) `wrap-idle` with nothing idle, and once with cents sent by hand; (7) `POLYMARKET_FLOAT_USD=20`, `PREDICTIONS_TRADING=on`, spend free float under 10, watch the top-up, then push it over 30 and watch the drain. Real float only after 1 to 7 pass. Also: a dedicated `POLYGON_RPC_URL`; ask Circle support about `receiveMessage` for a stalled forward (question 8); read the `error` logs.

## Spec findings

- **`Iris.forwardFee` returns wei, not units.** Spec 4 says "returning units", but the Solana withdrawals (`withdrawals.ts`, `payouts.ts`) and their tests use wei. Task 3 keeps wei and adds one `feeUnits` rule; pool code converts with `weiToUsdc6`.
- **`maxFee` formula and the quoted dollar figures disagree.** `max(high*3, high + $0.10)` gives about $0.21 in (matches the spec's figure) but about $0.116 out, while the spec says "about $0.05" out, which is `high * 3` alone. Task 3 follows the formula; a ruling is needed if the intended out-cap is $0.05.
- **The Mongo guard in the relayer gate would stop the redeemer sending several redemptions in a row,** which spec 4 rule 4 says must not change. Task 8 lets the redeemer ignore its own `submitted` rows; only the rebalancer checks them.
- **The pUSD token address is not in the spec** (it names only "the live proxy `0xC011...`"). Task 6 uses `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`; checked against the installed `@polymarket/client` 0.13.0, whose `contracts.collateralToken` is exactly that address. The Onramp and Offramp addresses are not in the SDK and rest on the spec's sources.
- **"Not final" and "halt lifted by resolve" need fields the row lacks:** `polygon.relayerFinalAt`, `polygon.wrapFinalAt`, `resolvedAt`. The wrap's "float shows the rise" check needs `polygon.balanceBeforeE6`; the burn needs `mintRecipient` on the row so `Payouts` never reads the trader. The forced `updateBalanceAllowance` needs `PoolTrader.syncBalance()`, which the spec's method list omits.
- **Top-up below the $10 minimum is raised, a drain below it is skipped.** The spec says both "at least $10" and "smaller than $10 is skipped"; Task 2 raises the top-up (otherwise a small `POLYMARKET_FLOAT_USD` never refills) and skips the drain.
- **Evaluate runs the guard before queueing.** Otherwise a low treasury queues a row every five minutes that fails and, after three, halts top-ups. A refusal logs and queues nothing (Task 13).
- **`wrap_idle` rows have no direction** and never count toward the daily cap or the halt; `queueMove` and the halt read only `kind: "move"` rows.
- **`derivedWallet()` returns the configured wallet, the derived one and whether code exists,** so the worker needs no second call for `eth_getCode`.
- **Tasks 6 and 7 share one commit:** `tsc` is red between them because the interface grows before the adapter.
- **The Hyperliquid option** at the end of the spec is not planned (it is marked not part of the first build).
- **Spec gap, an unknown wrap.** Spec 6 retries a wrap only while the wallet still holds USDC, but a batch whose answer was lost may have run, leaving the wallet empty and the row `wrapping` until it went `stuck`. Task 11 decides it after the 11-minute window: balance still there means it never ran (wrap again), balance gone means it ran (go to the float check).
- **Spec gap, `active` and `stuck`.** The spec removes `active` on `stuck` and lets a late Iris `complete` move the row on. Setting `active` again could hit the unique index when a newer move is active, so `move` never sets it again (Task 10).
- **Spec gap, the gate against stale attempts.** Rule 2 would hold the gate 11 minutes after a refused or failed batch. Tasks 11 and 12 clear or finalise the attempt marker when a batch is known not to run, and Task 8's guard ignores such rows.
- **Spec gap, a held drain send.** A drain whose send waits on the gate would look like a "never sent" row on the next tick. Task 10 and 12 keep a per-process `pendingSend` set so only a restart reads it as never sent.
- **`Iris.forwardFee` now also returns `minimumFeeBps`,** so the one existing `toEqual` in `iris.test.ts` becomes `toMatchObject` (Task 3).
- **The log scan is chunked** (Task 7), since a restart long after `attemptedAt` would otherwise ask a public RPC for a range it refuses.
- **Tests share one anvil and one Mongo,** so every harness here uses a fresh mnemonic and fresh stub addresses (Global Constraints).
