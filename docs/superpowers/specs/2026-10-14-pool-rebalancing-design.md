# Pool rebalancing between Arc and Polygon: design

## Goal

The Polymarket pool keeps enough pUSD on Polygon to pay for people's bets, and the Arc treasury keeps enough USDC to pay withdrawals, without the owner moving money by hand. Today the two drift apart by design:

- A stake is debited from a person's Arc balance, but the bet is paid from the pool's deposit wallet on Polygon in pUSD. The Arc treasury gains surplus, the pool shrinks.
- A payout credits an Arc balance, while the winning pUSD comes back to the pool. The pool grows, the treasury owes more than it gained.

`POLYMARKET_FLOAT_USD` sets the target, and `PredictionService` already warns under 25% and over 200% of it. Nothing moves the money. This spec adds a worker that does, in both directions, behind a switch that is off by default. It ships as one release: the worker decides top-ups and drains itself from the first day, and the operator's queued `move` stays as an override.

Facts marked V were checked on 2026-10-14 in public docs, contract sources, the installed SDK or unauthenticated GETs, with the source beside them. Facts marked U could not be checked and are in "Open questions".

## Decisions

Rows marked (owner) were chosen by the owner on 2026-10-14 (see "Owner's decisions" at the end); the others are this spec's design choices.

| Topic | Decision | Why |
| --- | --- | --- |
| Who executes | A worker inside the server, `PoolRebalancer`. The operator script only queues requests, shows status and recovers idle USDC by queueing; it never signs a rebalance. | `perps-rebalance.ts` signs from the treasury key and must not run while the server pays withdrawals. A second signer is the nonce clash this design avoids. |
| Who decides (owner) | The worker decides moves itself, in both directions, from the first release. The operator's queued `move` stays as an override: it skips the bands but obeys every cap and guard. | The float should keep itself: a late owner means refused orders, and nothing moves while the owner is away. |
| Route in | Arc treasury burns USDC with CCTP v2 and Circle's forwarder mints native USDC straight into the pool's deposit wallet. The pool then wraps it into pUSD through its gasless relayer. | The treasury path already exists for Solana withdrawals. Minting into the wallet needs no Polygon key or gas of ours. |
| Route out | One relayer batch of four calls signed by the pool owner key (listed once, in 1.2), forwarded to the Arc treasury. The design does not rely on the batch being atomic. | No POL gas and the Arc treasury signs nothing. Atomicity is unverified, so a half-done batch has a recovery path (6). |
| Who signs | Arc treasury (HD index 0) signs the Arc approve and burn, inside `Payouts`. The pool owner key signs relayer batches. Nothing else signs. | One writer per key keeps nonces safe. |
| One move at a time | At most one active move, enforced by a unique index in Mongo, not only by worker logic. A `stuck` row is not active but blocks new automatic moves in its own direction only. | A stuck drain must not stop top-ups, which keep orders alive. |
| Limits (owner) | Act below 50% and above 150% of `POLYMARKET_FLOAT_USD`; each move $10 to $100; 5 minutes between moves; at most $300 a day from Arc to Polygon; the treasury keeps $100 on top of pending withdrawals and gas. | The bands sit inside the 25% and 200% alarms, so an alarm means the worker is not keeping up; the caps bound what one bug or a bad input can move; the reserve keeps withdrawals payable. |
| Halt (owner) | A `stuck` row or three failed rows in a row stop automatic moves of the same direction only; queued moves still run and the other direction keeps working. | A systematic fault (a wrong asset, a relayer refusal) must not repeat and burn fees every five minutes, and it must not stop the other direction. |
| Ledger | A rebalance never touches a person's balance. | A failure can cost fees or delay, never a person's money. |
| Fees | The house pays the CCTP fees (about $0.07 in, $0.02 out at today's quotes, up to about $0.21 and $0.05 with the headroom in 4). | Moving the float is the house's cost of offering predictions. |
| Switch (owner) | `POOL_REBALANCE=off` by default; `on` starts the worker, which then decides moves and runs queued ones. The owner turns it on after funding. | Same pattern as the Solana and trading switches; money moves on its own only once the owner has funded it and chosen to. |
| Trading off | Automatic decisions run only while `PREDICTIONS_TRADING=on`. Queued moves and moves already in flight run whenever the switch is `on`, so the pool can be funded and the live check run before trading starts. | With trading off nobody spends the float, so deciding has no use. Funding does. |
| Wrap everything | The wrap step wraps all native USDC the wallet holds, not a fixed amount. | It is idempotent and recovers from a failed first try. |
| Relayer | One in-process lock (`RelayerGate`) serves every relayer batch of the server, held from prepare to the stored id. | The relayer takes a per-wallet nonce read at prepare time; redemptions use the same relayer. |

## 1. The route, verified

### 1.1 Arc to Polygon

1. **Burn on Arc.** `depositForBurnWithHook` on TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, destination domain 7 (Polygon PoS), `mintRecipient` the pool's deposit wallet, `burnToken` the Arc USDC ERC-20 view `0x3600…0000`, `destinationCaller` zero, standard finality 2000, and the plain forwarding hook data already in `cctp-burn.ts` (`FORWARD_HOOK_DATA`). The contract requires non-empty hook data, a non-zero recipient and `maxFee < amount` (V, https://raw.githubusercontent.com/circlefin/evm-cctp-contracts/master/src/v2/TokenMessengerV2.sol).
2. **Domains and forwarding.** Arc is domain 26 and Polygon PoS is domain 7; both support standard transfers and the Forwarding Service as destinations (V, https://developers.circle.com/cctp/concepts/supported-chains-and-domains). The TokenMessengerV2 and MessageTransmitterV2 (`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`) addresses are the same on both chains (V, https://developers.circle.com/cctp/references/contract-addresses).
3. **Speed and fee.** Circle's finality page gives about 0.5 seconds for Arc and about 8 seconds for Polygon at standard attestation (https://developers.circle.com/cctp/concepts/finality-and-block-confirmations); the real Arc-to-Polygon time end to end was not measured (U, open question 5). The live forward fee for `26/7?forward=true` was 70,969 units (0.070969 USDC) at `low` and `med`, and 71,067 at `high`, for both finality rows, with a minimum protocol fee of 0 (V, https://iris-api.circle.com/v2/burn/USDC/fees/26/7?forward=true). The forwarding fee is deducted from the amount by default (V, https://developers.circle.com/cctp/concepts/forwarding-service), so the pool receives the amount less the fee.
4. **Native USDC.** Circle mints native USDC on Polygon, `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (V, https://developers.circle.com/stablecoins/usdc-contract-addresses), not USDC.e. For an EVM destination `mintRecipient` is simply the wallet address (V, forwarding page above). `destinationCaller` must stay zero; the forwarder does not support wrapper contracts in v0 (V).
5. **Wrap into pUSD.** The pool's deposit wallet calls the CollateralOnramp `0x93070a847efEf7F70739046A929D47a521F5B8ee`: `USDC.approve(onramp, x)` then `wrap(asset, to, x)`. The caller approves the Onramp, not the pUSD token (V, https://docs.polymarket.com/concepts/pusd).
6. **The Onramp takes native USDC (V, closed).** The pUSD docs page says `_asset` must be USDC.e; that page is stale. The Onramp only pulls the asset and calls `CollateralToken.wrap`, which requires `_asset == USDC || _asset == USDCE`, immutables set at deployment, with no fee (V, https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/collateral/CollateralToken.sol and https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/collateral/CollateralOnramp.sol). The verified implementation `0xCe84E053301A82937F90ee2C2c1889cAb1db25dE` on Sourcify carries USDC `0x3c49…3359` (native), USDCE `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` and VAULT `0xC417fd8e9661c0d2120b64a04bb3278c17e99db1` (V, https://sourcify.dev/server/v2/contract/137/0xCe84E053301A82937F90ee2C2c1889cAb1db25dE?fields=runtimeBytecode,compilation, `transformationValues.immutables`). The deposit docs agree: native USDC or USDC.e is wrapped (V, https://docs.polymarket.com/trading/bridge/deposit). Residual risk, checked by the live wrap: the live proxy `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` could point elsewhere, and Polymarket can pause one asset. The `.env.example` note "wraps USDC.e, not native USDC" is out of date and is fixed in step 6 of the work order.
7. **How the pool's relayer batch works (V, installed `@polymarket/client` 0.13.0).** The relayer runs ordered batches of calls (`to`, `data`, optional `value`) from a deposit wallet, signed by the owner, with no gas needed (V, https://docs.polymarket.com/trading/deposit-wallets). The SDK's low-level `prepareGaslessTransaction(client, { calls, metadata })` takes any `to` and `data`, and `metadata` is a required string. It does not submit in one call: it returns an async generator the caller drives, answering a `requestAddress` request and a `signGaslessTypedData` request with the pool owner key, and ends with a transaction handle (`types-BGxCI8uu.d.ts`). The nonce is fetched from the relayer at prepare time, and the signed batch carries a deadline of now + 600 seconds (`chunk-MY66WYAN.js`). A batch not executed within 10 minutes can therefore never execute later. Polymarket documents no allowlist of call targets, no atomicity guarantee and no relayer rate limit (U, open question 3).
8. **Relayer outcome.** `fetchTransaction` returns `state` (`STATE_NEW`, `EXECUTED`, `MINED`, `CONFIRMED`, `INVALID`, `FAILED`), `errorMsg` and `transactionHash` (V, `@polymarket/bindings/dist/relayer/index.d.ts`). The repo's `transaction()` in `polymarket-trader.ts` keeps only the state; the adapter changes to return the hash too. SDK errors split into a clear refusal (`RequestRejectedError`, `RateLimitError`, `UserInputError`: nothing was sent) and an unknown outcome (`TransportError`, `UnexpectedResponseError`, and the adapter's own timeout) (V, same d.ts).

### 1.2 Polygon to Arc

The batch has four calls, in this order, and this list is used everywhere (encoder, fake, tests):

1. pUSD `approve(offramp, x)`.
2. `CollateralOfframp.unwrap(USDC, wallet, x)` at `0x2957922Eb93258b93368531d39fAcCA3B4dC5854`.
3. native USDC `approve(TokenMessengerV2, x)`.
4. `TokenMessengerV2.depositForBurnWithHook` to domain 26, `mintRecipient` the Arc treasury, `burnToken` native USDC, `destinationCaller` zero, forwarding hook data.

Facts:

- The Offramp pulls pUSD from the caller, has no role check, no fee and only a per-asset pause (V, https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/collateral/CollateralOfframp.sol and https://docs.polymarket.com/concepts/pusd). The token's `unwrap` pays the underlying out of the VAULT, so it needs the vault to hold native USDC and to have approved the token. Whether it does is U (open question 2).
- The live forward fee for `7/26` was 15,513 (`low`), 15,638 (`med`) and 16,288 (`high`) units, about 0.016 USDC (V, https://iris-api.circle.com/v2/burn/USDC/fees/7/26?forward=true). Arc is a forwarding destination (V, supported-chains page).
- **Atomicity is not assumed.** Polymarket calls the batch "ordered" and documents nothing about a failed inner call (U). The design assumes the worst case: calls 1 and 2 may succeed while 3 or 4 fail, leaving native USDC idle in the wallet. Section 6 covers it.
- **Why not send pUSD to the owner key and burn from there.** That key holds no POL for Polygon gas. It is the fallback if the relayer refuses these targets (open question 3).

### 1.3 Routes not used

- Relay, Across or LI.FI from Arc to Polygon: Arc support was not confirmed (see `.superpowers/research/2026-10-14/arc-hl-funding.md`, item 16), and they add a solver between the treasury and the pool. CCTP is what the treasury already uses.
- Polymarket's own bridge: it is a deposit service for users. It can't be driven from the Arc treasury.

## 2. The worker

`PoolRebalancer` (`server/src/predictions/rebalancer.ts`) runs in the server next to the tracker, the redeemer and the reconciler. It starts moves, creates and advances `pool_rebalances` rows through their states. It signs only relayer batches (with the pool owner key, through the trader). The Arc side is signed by `Payouts` (section 4).

- **Start.** Every 2 seconds it takes the `queued` row (there is at most one) and tries to start it: the Arc guard and caps for a top-up (section 3), the float reservation for a drain. If the checks pass, the row moves to `sending` or `submitting`; if not, it moves to `failed` with `lastError` naming the reason and nothing has moved.
- **Evaluate** (only with `PREDICTIONS_TRADING` `on`) every 60 seconds, after the float read, when no row is active and none is paused (section 3). It reads `pool_float` for `balanceE6`, `heldE6` and `unreadFillsE6`; free float is `balanceE6 - heldE6 - unreadFillsE6`, as `freeOf` computes it. The float document must be under 3 minutes old. A decision inserts a `queued` row with `source: "auto"`, so automatic and operator moves take the same start path and the same guards.
- **Advance** active rows every 2 seconds in the fast states and every 30 seconds in the slow ones. `stuck` rows are still advanced (6).
- **Restart-safe.** Everything the worker needs is on the row. `start()` resumes the active rows.
- **The trader.** The worker needs the trader connection, and `POOL_REBALANCE=on` makes the Polymarket secrets mandatory (section 9), so the trader can connect with trading off. Like the redeemer, the worker calls `ensureTrader()` whenever it has a `queued`, active or `stuck` row and no trader. At startup `server.ts` counts those rows with the posted orders and unconfirmed redemptions it already counts for `traderNeeded`.
- **The mint recipient is checked.** Before the first burn of each process the worker asserts the deposit wallet is the one the pool key controls, and refuses with `error` "Pool wallet mismatch" otherwise. `createPolymarketClient` passes `POLYMARKET_DEPOSIT_WALLET` into the SDK, so `client.account.wallet` only echoes the config. The check therefore builds a second client from the same signer **without** the `wallet` option, for which the SDK uses the signer's own deterministic deposit wallet (V, `SecureClientOptions.wallet` doc in `types-BGxCI8uu.d.ts`), and compares the two addresses, and requires code at the address (`eth_getCode`). The compare client is created once per process. Whether building it has side effects beyond reading is U (open question 11); `polymarket-setup.ts` gets the same derived line.

### Operator script

`server/scripts/pool-rebalance.ts`, run from `server/` with `node --env-file=.env`:

- `status` prints both sides (treasury free, pool balance, held, free float), idle native USDC in the pool wallet, the active row and the last five rows.
- `plan` prints what the worker would decide now (it queues nothing).
- `move arc-to-polygon|polygon-to-arc <usd>` inserts one row in state `queued`, `source: "operator"`, `active: true`. The unique index rejects it when another move is active or queued, and the script prints which. It is the override for the bands: the worker starts it under section 3's guard and caps, without the bands.
- `wrap-idle` inserts a `queued` row of kind `wrap_idle`: the worker wraps whatever native USDC the pool wallet holds (6).
- `resolve <id> done|failed` marks a `stuck` row after the owner has checked the chain by hand.
- The script refuses when `POOL_REBALANCE=off`. It never signs, so it can run while the server pays withdrawals.

## 3. Bands and amounts

`T` is `POLYMARKET_FLOAT_USD` (default 100). `free` is the pool's free float. Bands apply to automatic decisions only; a queued move (the operator's override) ignores them but obeys every cap and guard.

| Situation | Rule |
| --- | --- |
| Low | `free < 50% of T`: top up. |
| High | `free > 150% of T`: drain. |
| Top-up amount | `T - free`, rounded up to a whole dollar, at least $10, at most `POOL_REBALANCE_MAX_MOVE_USD`. |
| Drain amount | `free - T`, rounded down to a whole dollar, at least $10, at most the same cap. Only free float is moved; held pUSD never is. |
| After a move | Wait `POOL_REBALANCE_PAUSE_MIN` (default 5) minutes and for a float read taken after the move before the next decision. |

Reasons:

- The 25% and 200% warnings stay as alarms for "the worker is not keeping up", because the worker acts at 50% and 150%. They now read free float, not the raw balance, so a pool with a lot held can't be under 50% free while the alarm stays quiet (`#warnOnFloat` in `predictions.ts`).
- The $10 floor keeps the CCTP fee under about 2% even with the headroom in 4.
- The $100 cap on one move and the $300 a day from Arc to Polygon bound what a bug or a bad input can move.
- The 5-minute pause, and the wait for a float read taken after the move, keep the next decision from running on a float that has not caught up.
- Top-ups use free float, and so does the guard on the Arc side, which is exactly what orders can spend, not the raw balance.
- **Daily cap.** Arc to Polygon moves add up to at most `POOL_REBALANCE_MAX_DAY_USD` in any 24 hours (default 300, rows in any state but `failed` count). Polygon to Arc is not capped by the day, because it returns money to the treasury.
- **Arc guard, under the withdrawals lock.** A top-up is allowed only if the treasury balance after it still covers pending withdrawals, the existing gas reserve (`TREASURY_GAS_RESERVE`), and `POOL_REBALANCE_ARC_RESERVE_USD` (default 100). `Withdrawals` exposes `withTreasuryLock(fn)`, which chains onto the same `#lock` that serialises `create`. The worker runs "read `treasuryFree`, check, move the row from `queued` to `sending`" inside it. A withdrawal created next reads a `treasuryFree` that already subtracts the top-up, so it can't be accepted against money that is about to leave and then fail. The check is a pure function `planPoolMove` shaped like `planRebalance` in `perps-rebalance.ts`, so both are tested the same way. If the guard refuses an automatic move, the worker logs `error` once an hour: "Treasury too low to top up the pool".
- A move smaller than $10 is skipped by the automatic path. If free float is under 10% of `T` and no move is possible, the "float is low" warning remains the signal.
- **Per direction, not global.** A `stuck` row or three failed rows in a row stop automatic moves of their own direction only (6), so a stuck drain does not stop top-ups, which keep orders alive. Owner's decisions, 3.

## 4. Who signs, and the shared nonce

**Arc to Polygon, Arc side.** The Arc treasury signs two transactions, `approve` then `depositForBurnWithHook`, exactly like a Solana withdrawal. They go through `Payouts`, the one writer of treasury nonces (`payouts.ts` `#nextNonce`: the greatest of the chain's pending count and every stored nonce, plus one).

- A `sending` row emits `pool-rebalance:updated`; `Payouts` wakes on it as it does for `withdrawal:updated`.
- `Payouts#pass` handles withdrawals first, then rebalances in state `sending`. The existing rule holds: after a signed but unconfirmed transaction, nothing is signed above it.
- `Payouts` signs both transactions, stores `approveRawTx`, `burnRawTx`, nonces and hashes on the row before broadcasting either, and re-broadcasts the same bytes after a restart.
- **The Solana path is copied, not extracted.** `#settle` calls `#fail`, which refunds the ledger, and the Solana withdrawal code pays people today. The rebalance gets its own `#signRebalance`, `#payRebalance` and `#settleRebalance` in the same style, with a failure that only marks the row `failed`. The two are merged into one implementation after both are live and their tests agree (not part of this work).
- `#nextNonce` also reads the highest stored burn nonce of `pool_rebalances` rows in `sending`.
- `cctp-burn.ts` gains `encodeBurnToEvm({ amount6, domain, recipient, maxFee6 })`. `encodeBurn` is Solana-only today (`SOLANA_DOMAIN`, `solanaBytes32`).
- **One fee parser, one unit.** `Iris.forwardFee` is typed `{ from: 26; to: 5 }` and turns any number into whole 6-decimal units in wei (`toWei` rounds up with `Math.ceil`), while `maxFeeOf` in the script reads whole numbers as units and fractions as dollars. A fractional answer would be read as one unit by the client. `Iris` gets one `forwardFee({ from, to })` for any pair with one rule, whole numbers are 6-decimal units and fractions are dollars, returning units; `maxFeeOf` calls it. A fractional fixture is tested.
- **`maxFee` has headroom.** `maxFee` is `max(high * 3, high + $0.10)` plus the protocol fee in basis points, and always below the amount. The forward fee is dynamic gas and the docs say excess gas is not refunded in the fee, so a Polygon gas spike above a tight `maxFee` would leave the message waiting with `insufficient_fee` and no way out. Whether the unspent part of `maxFee` stays in the mint or is kept by Circle is U (open question 9); the live check measures it and the factor is lowered if it is kept.
- **Iris has one budget.** The 5-requests-a-second window and the 5-minute backoff after a 429 are private to `Payouts` today. They move into one small limiter object, created in `server.ts` and passed to `Payouts` and `PoolRebalancer`.

**Arc to Polygon, Polygon side.** The pool owner key signs the wrap batch through the relayer, in `PoolTrader` (`wrapUsdc`). The trader drives the SDK's workflow generator: it answers `requestAddress` and `signGaslessTypedData` with the pool owner signer and returns the transaction handle.

**Polygon to Arc.** The pool owner key signs one relayer batch (`unwrapAndBurn`); it is the only signature for that direction.

**The relayer gate (`RelayerGate`).** Redemptions use the same relayer, and a deposit wallet's batches carry one nonce read at prepare time (1.1.7). Two batches prepared close together share a nonce, and one fails or is invalid. A Mongo check alone can't prevent this: the redeemer sets a row to `submitted` only after `trader.redeem()` returns, so a rebalance looking for a `submitted` redemption can miss one that is mid-call. The rules:

1. **One mutex.** A small `RelayerGate` is created in `server.ts` and passed to the redeemer and the rebalancer. It is held across prepare, sign, submit and the write of the returned id on the row. Nobody prepares a batch while another is being prepared or submitted.
2. **A Mongo second guard.** After taking the mutex, the holder checks that no earlier batch is unconfirmed: no redemption row `submitted`; no rebalance row whose `relayerTransactionId` or `wrapTransactionId` is stored and not final; no `attemptedAt` younger than 11 minutes without an id. If any exists it lets go and tries on its next tick. Both sides already poll, so a held turn costs at most a few seconds.
3. **A timed-out call shuts the gate for 11 minutes.** `withTimeouts` rejects a slow call after 30 seconds while the call may still complete. The gate stays shut for the signed deadline (600 seconds) plus a minute: after that the batch either executed or can never execute. A restart forgets this timer, but the rebalancer's own `attemptedAt` (rule 2) covers its batches; a redemption that collides is retried by the redeemer as today.
4. The redeemer already submits several due redemptions one after the other without waiting for each to confirm, so two redemptions can share a nonce today. The gate does not change that; it is noted, not part of this work.

## 5. States, tracking and counting

### 5.1 The row

Collection `pool_rebalances`, one document per move:

```
_id, kind: "move" | "wrap_idle",
direction: "arc_to_polygon" | "polygon_to_arc",
source: "auto" | "operator", reason: "low" | "high" | "operator",
amountE6, maxFeeE6, reservedE6 (polygon_to_arc),
active (true while queued, sending, submitting, forwarding or wrapping; removed otherwise),
state, attempts, nextAt, lastError, createdAt, updatedAt, doneAt,
arc:     { approveNonce, approveRawTx, approveTxHash, burnNonce, burnRawTx, burnTxHash }   // arc_to_polygon
polygon: { attemptedAt, relayerTransactionId, burnTxHash, burnLogSeen,
           wrapAttemptedAt, wrapTransactionId, wrapSubmittedAt, mintedE6 }
iris:    { checkedAt, forwardTxHash, feeExecutedE6, delayReason }
```

### 5.2 States

```
arc_to_polygon

queued ──guard + caps ok, under the withdrawals lock──▶ sending ──both Arc txs mined──▶ forwarding
   │                                                       │                              │
   └─ guard or cap refuses ──▶ failed (nothing moved)      └─ refused / reverted          └─ Iris: complete,
                                                              before any burn ──▶ failed       USDC in the wallet
                                                                                               │
              done ◀──wrap confirmed and a float read after it──── wrapping ◀─────────────────┘

polygon_to_arc

queued ──free float reserved (one transaction)──▶ submitting ──batch confirmed, burn log found
   │                                                  │            (one transaction)──▶ forwarding ──Iris: complete──▶ done
   └─ float short ──▶ failed                          ├─ never sent, or refused, or batch failed ──▶ failed (reservation released)
                                                      └─ batch confirmed, no burn log ──▶ stuck

wrap_idle:  queued ──▶ wrapping ──▶ done

forwarding or wrapping older than 2 hours ──▶ stuck   (still followed; see 6)
```

- `queued`: written by the script or by an automatic decision; nothing has been reserved or signed.
- `sending`: the treasury has not both mined. Money is still in the treasury.
- `forwarding`: the burn is mined. The money is on Circle's side and can't come back. A row in `forwarding` only ends in `wrapping` or `done`.
- `wrapping`: native USDC is in the deposit wallet, not yet pUSD.
- `submitting` (Polygon to Arc): the pUSD is reserved and the batch is out; it isn't burned until confirmed with a burn log.
- `done`, defined once: for Arc to Polygon, the wrap is confirmed **and** a float read taken after the confirmation has run (the worker forces `updateBalanceAllowance` for the collateral, then `refreshFloat()`). If that read doesn't show the rise within 10 minutes, the row is `done` anyway with a `warn` (open question 6). For Polygon to Arc, Iris reports `complete` and the same forced read has run.
- `failed`: nothing was burned. `stuck`: money is in flight or idle on Polygon and an owner check is needed.
- A `stuck` row has no `active` flag, so it does not block a move of the other direction; it does block automatic moves of its own direction.

### 5.3 Counting, so the numbers stay right

1. **The pool's free float.** An Arc to Polygon move adds nothing to free float until the wrap is done and the forced balance read shows it. Orders never see pUSD that isn't there.
2. **A Polygon to Arc move reserves first.** `queued` to `submitting` and the float reservation are written in one Mongo transaction (`runInTransaction`), through the same guarded `findOneAndUpdate` orders use (`#reserve` on `pool_float`, `heldE6 += x`), with the row updated by `findOneAndUpdate({ _id, state: "queued" })`. Only free float can be reserved, so a concurrent order and the batch can't spend the same pUSD; a stale float document refuses. The reserved amount is stored on the row (`reservedE6`). `PredictionService` exposes `reserveForMove` and `releaseForMove` for this.
3. **The release is one transaction with the state change, and happens once.** On a confirmed batch with a burn log, one transaction does `findOneAndUpdate({ _id, state: "submitting" })` to `forwarding` and, only if that matched, releases the reservation as spent (`heldE6 -= x`, `unreadFillsE6 += x`), exactly as a fill does, so free float does not jump back before the balance read. A repeat tick matches nothing and releases nothing, so `heldE6` can't go negative. On a failed or never-sent batch the same transaction moves the row to `failed` and releases with nothing spent. After the release the worker forces the same `updateBalanceAllowance` and `refreshFloat()` read as a top-up, so free float is not overstated while the CLOB balance lags (orders the CLOB rejects are refunded as `unavailable`, but should not be accepted at all).
4. **Drift check.** `#openHolds` in `predictions.ts` sums buy orders in `placing` and `posted`. It also sums `reservedE6` of `polygon_to_arc` rows in `submitting`, or the tripwire would "repair" the rebalance reservation away.
5. **The treasury's withdrawal need.** `Withdrawals#treasuryFree` subtracts `owed`, the amounts of withdrawals in `sending`. It also subtracts `arc_to_polygon` rows in `sending`, because their money has not yet left the balance that `getBalance` reads. Once the burn mines, the chain balance already shows it and the row (now `forwarding`) no longer counts. A `polygon_to_arc` move adds to the treasury only when the forwarder mints it, which is when withdrawals can use it.
6. **Solvency.** `PerpReconciler` compares assets (`arcHoldings + master + people + sent`) with what people are owed (`accounts.balance + perpFloat.heldE6`). A top-up moves treasury money out of `arcHoldings`, and the pool's pUSD is what backs payouts credited to people, so it has to count. The additions, each only the figure that can be spent or is in flight:
    - the pool's **free float** (`balanceE6 - heldE6 - unreadFillsE6`), not the gross balance. If the float document is older than 3 minutes, the pass logs a `warn` instead of an `error` for a shortfall;
    - **native USDC idle in the pool wallet**, read with `usdcBalanceE6()`; this also covers an `arc_to_polygon` row in `wrapping`, so that row adds nothing extra;
    - rows in **`forwarding`** (both directions) for up to an hour, with an `error` log after that, as `perpRebalances` do;
    - `polygon_to_arc` rows in **`submitting`** count their `reservedE6`, because the pUSD is held and not yet burned.

    Open positions' share value stays out, as today. Two windows remain and are accepted: after a burn mines and before `Payouts` writes `forwarding` (one pass, seconds), and the seconds between the Arc mint and `done`. The tolerance `PERPS_RECONCILE_TOLERANCE_USD` (default $5) is far below one move, so a shortfall `error` naming about one move's amount that appears in one pass and clears in the next is one of these windows, not an incident.
7. **Daily cap and double-sends.** The cap in section 3 reads the same rows. Only one row is active, enforced by the unique index, so a slow move can't be repeated.
8. **The ledger.** Untouched.
9. **The older script.** `perps-rebalance.ts` sizes its guard from `withdrawals` in `sending` only. It now adds `pool_rebalances` rows in `sending` to `owed`, and refuses to run while any withdrawal is `sending` or any pool row is `queued`, `sending` or `submitting`. It still signs from the treasury key, so with `POOL_REBALANCE=on` the server can start a move between the script's check and its send. The rule is therefore: with the switch on, stop the server, or restart it with `POOL_REBALANCE=off`, before running it. Moving the Hyperliquid top-up into this worker (the option at the end) retires the script's signing.

## 6. Failure and retry

All of it uses stored signed data or stored attempt markers, so nothing is signed or sent twice for one move.

- **Before a burn is mined (Arc side).** The stored `approveRawTx` and `burnRawTx` are re-broadcast after a restart. The existing handling applies unchanged: "already known" and "nonce too low with a mined receipt" count as sent; an unreachable node leaves the row for the next pass; a clear refusal or a revert marks the row `failed` (the treasury still holds the money; only gas was lost). "Nonce too low with no receipt" clears the stored transactions and signs again. After a reverted burn the treasury keeps an allowance for TokenMessengerV2, Circle's contract, up to the move's amount, until the next approve overwrites it. This is left as it is and logged at `info`; it is not set back to zero.
- **After the burn is mined.** Never re-burn. The worker polls Iris for `26`, the burn hash, one request per tick, through the shared limiter (5 requests a second at most, 5 minutes after a 429). `complete` with a `forwardTxHash` ends `forwarding`. A `delayReason` (`insufficient_fee`, `amount_above_max` or `insufficient_allowance_available`, the three documented values) is logged at `error` with the full message. `forwardState` has no documented list, so stall handling is time-based.
- **Wrap (`wrapping`).** The step reads the wallet's native USDC (`usdcBalanceE6()`, an RPC `balanceOf` on `POLYGON_RPC_URL`). When it is at least `amount - maxFee`, it writes `wrapAttemptedAt`, then submits the batch `[USDC.approve(onramp, balance), onramp.wrap(USDC, wallet, balance)]` through the gate, stores the relayer transaction id on the row at once, and polls it. A failed batch, or one unconfirmed after 30 minutes, is retried after 1, 5, 15 minutes, then hourly, and the retry wraps whatever balance is there, so repeating is safe. **The retry does not stop when the row becomes `stuck`**; it continues hourly for as long as the wallet holds native USDC. After 10 tries it logs `error` hourly. The money is safe in the wallet meanwhile.
- **Idle native USDC has a way out.** USDC can be left in the wallet when the owner resolves a stuck row, or when a drain batch is not atomic and the unwrap ran without the burn. `wrap-idle` (the script, section 2) queues a `wrap_idle` row that wraps the balance back into pUSD, where it is free float again. The worker reads `usdcBalanceE6()` every 10 minutes while the trader is connected and logs `warn` hourly "Native USDC is idle in the pool wallet" when it holds more than $1 with no row `wrapping`. The reconciler counts it as an asset (5.3.6).
- **Polygon to Arc batch.**
    - *Never sent.* `polygon.attemptedAt` is written to the row before the relayer is called. A restart that finds `submitting` with no `attemptedAt` knows no batch was sent: the row goes to `failed` and the reservation is released at once, in one transaction.
    - *Clearly refused.* An SDK error that is a refusal (`RequestRejectedError`, `RateLimitError`, `UserInputError`) means nothing was sent: `failed` and release, at once.
    - *Unknown.* A timeout, `TransportError`, `UnexpectedResponseError`, or a restart with `attemptedAt` and no id leaves the outcome unknown. The row stays `submitting`, the reservation stays held, and the worker is not allowed to re-sign. The signed batch can't execute more than 10 minutes after signing (1.1.7), so the window is **11 minutes** from `attemptedAt`, not 30. Meanwhile the worker looks for the id (stored the moment the relayer returns it). If there is still no id when the window ends, the worker scans Polygon for a `DepositForBurn` event whose depositor is the pool wallet and whose amount matches, since the attempt (`eth_getLogs` on TokenMessengerV2, depositor is an indexed topic, V from the contract source), and adopts that burn hash. With no such event, it releases the reservation and marks `failed`: nothing executed.
    - *Confirmed.* A relayer `STATE_CONFIRMED` is not proof of a burn. The worker takes the `transactionHash` from the relayer record (1.1.8), reads the Polygon receipt and requires a `DepositForBurn` log with the pool wallet as depositor and the move's amount. With the log it moves to `forwarding` in the single transaction of 5.3.3. Without the log, it moves to `stuck` in the same kind of transaction, releases the reservation as spent (the pUSD is gone from the pool if the unwrap ran), and logs `error` "Pool rebalance confirmed without a burn" with the transaction hash. The owner runs `wrap-idle` to bring any unwrapped USDC back. The design does not rely on atomicity until it has been seen.
    - *Failed.* `STATE_FAILED` or `STATE_INVALID` with no burn log: `failed` and release with nothing spent. If the unwrap ran anyway the idle-USDC `warn` shows it and `wrap-idle` fixes it.
- **Stuck.** `forwarding` or `wrapping` past 2 hours becomes `stuck`, and so does a confirmed batch with no burn. The worker logs `error` once an hour: "Pool rebalance stuck: needs an operator", with the row id, hashes and the last Iris response. A stuck row is still followed, so an Iris `complete` that arrives late moves it on. The owner clears it with `resolve`. There is no automatic remedy, and no refund path: the burn is final. Runbook for a burned message that is never minted: fetch the message and attestation from Iris (`GET /v2/messages/<source domain>?transactionHash=<burn hash>`), and call `receiveMessage` on MessageTransmitterV2 on the destination chain from a wallet the owner funds; because `destinationCaller` is zero, anyone can submit it. Whether that works for a message carrying the forwarding hook, and what fee the forwarder then takes, is U (open question 8); Circle's support is the other path.
- **Repeated failures.** If the last three rows of a direction are `failed` or `stuck`, the worker halts automatic moves of that direction and logs `error`: "Pool rebalancing halted after repeated failures". Queued moves still run. A successful move of that direction, or `resolve`, lifts the halt (it is derived from the rows, with no stored flag). Owner's decisions, 3.
- **Restart.** Active rows resume from their stored state. Nothing is re-sent that was not stored.

## 7. Switch, trading off and the order path

- `POOL_REBALANCE=off|on`, default `off`. With `off` the worker does not start, the script refuses, and the only code that changes is a `$ne` on the new collection in the treasury's `owed` sum.
- `on` starts the worker: it decides top-ups and drains by the bands in section 3 (while `PREDICTIONS_TRADING=on`) and runs the moves the operator queues, in both directions. The owner turns it on after funding.
- With `PREDICTIONS_TRADING=off`, the worker makes no decisions. It still finishes an active row and runs queued rows. The first funding of the pool is therefore `move arc-to-polygon 100` with the switch on and trading off, not a manual wallet transfer. This works because the Polymarket secrets are required whenever `POOL_REBALANCE=on` (section 9).
- Turning `PREDICTIONS_TRADING` off while a move is in flight is safe: the move completes and the float document is updated; only new automatic decisions stop.
- The order path is unchanged except for one thing it already does: it reserves from `pool_float`. A Polygon to Arc batch is just another reservation, and `#openHolds` counts it (5.3.4).
- Nothing in this spec touches geoblocking, the proxy rules, or the builder fee.

## 8. Logging

A pino child with `component: "pool-rebalancer"`. Every line carries the row id, direction and amount.

- `info`: move queued or planned (with `free`, `T`, the reason), Arc transactions signed, burn mined, Iris complete (with `feeExecuted`), wrap submitted and confirmed, burn log seen, float re-read, done. Daily-cap and reserve refusals.
- `warn`: Iris unreachable or 429, a relayer call that failed and will retry, a stale float document that skipped a decision, native USDC idle in the pool wallet.
- `error` (the owner greps for these, there is no alerting): "Pool rebalance stuck: needs an operator", "Pool rebalancing halted after repeated failures", "Treasury too low to top up the pool", "Pool rebalance burn delayed" (with `delayReason`), "A pool rebalance wrap keeps failing", "Pool rebalance confirmed without a burn", "Pool wallet mismatch". Each is rate limited to once an hour per row.
- The existing "The pool's Polymarket float is low/high" warnings stay, now on free float.

## 9. Data and config

- **`pool_rebalances`**: described in 5.1. Indexes `{ state: 1, createdAt: 1 }`, `{ direction: 1, createdAt: 1 }` and a **unique partial index on `{ active: 1 }`** with `partialFilterExpression: { active: true }`, so two active rows can't exist, whatever the worker or the script does.
- **Config** (`server/src/config.ts`, `.env.example`):

    | Variable | Default | Meaning |
    | --- | --- | --- |
    | `POOL_REBALANCE` | `off` | `off` or `on`. |
    | `POOL_REBALANCE_MAX_MOVE_USD` | 100 | The largest single move. |
    | `POOL_REBALANCE_MAX_DAY_USD` | 300 | The most that may move from Arc to Polygon in 24 hours. |
    | `POOL_REBALANCE_ARC_RESERVE_USD` | 100 | What the treasury keeps for withdrawals after a top-up, on top of pending withdrawals and gas. |
    | `POOL_REBALANCE_MIN_MOVE_USD` | 10 | The smallest automatic move. |
    | `POOL_REBALANCE_PAUSE_MIN` | 5 | Minutes to wait after a move before deciding again. |

    The band thresholds 50% and 150% and the three-failure halt are constants in the module, listed in the Owner's decisions, 2 and 3.

    **The secrets rule.** `config.ts` requires `POLYMARKET_POOL_KEY` and the builder credentials (`TRADING_SECRETS`) only when `PREDICTIONS_TRADING=on`. The `superRefine` is extended: `POOL_REBALANCE=on` requires the same four variables. Without it the trader can't connect with trading off (`createPolymarketTrader` would read missing credentials) and the trading-off flow in section 7 and the live check would loop on "Couldn't connect to Polymarket".

    The existing `CIRCLE_IRIS_URL`, `POLYGON_RPC_URL` and Polymarket settings are used. A dedicated Polygon RPC is needed (the public default is rate limited, and the burn-event scan reads logs).
- **`server.ts`**: creates the `RelayerGate` and the shared Iris limiter, and counts active, queued and stuck rebalance rows with the posted orders and open redemptions for `traderNeeded`.
- **`PoolTrader`** (`trader.ts`, the SDK adapter, `withTimeouts`, `FakeTrader`) gains: `usdcBalanceE6()`, `wrapUsdc(amountE6)`, `unwrapAndBurn({ amountE6, maxFeeE6, recipient })`, `burnEvents({ since })`, `burnLog(transactionHash)` and `derivedWallet()`. `transaction(id)` also returns the chain hash and the relayer error message. The batch calls are built in a new `pool-moves.ts`, next to the encoders, with the contract addresses in one table so they are checked in one place.
- **Rate limits**: none new on the socket; this is server-internal.

## 10. Testing

**Fakes: extend what exists** (`server/test/support`).

- `fake-iris.ts` gains fee answers for `26/7` and `7/26` and `messages` for source domains 26 and 7, with `status`, `forwardTxHash`, `decodedMessage.decodedMessageBody.feeExecuted` and `delayReason`.
- `stub-token-messenger.ts` (anvil) already records `depositForBurnWithHook` arguments; the tests assert domain 7, the `mintRecipient` bytes of the deposit wallet, `destinationCaller` zero, `maxFee`, finality 2000 and the hook data.
- `fake-trader.ts` gains a native USDC balance, `wrapUsdc` that moves it into the pUSD balance, `unwrapAndBurn` that reduces pUSD and records the batch, a partial mode (unwrap runs, burn does not), controllable refusal, timeout and "no answer", `burnEvents`, `burnLog`, and `derivedWallet`.

**Unit.** `planPoolMove` as a table (low, high, between, below the minimum, over the cap, over the day total, reserve refusal, exact boundaries at 50% and 150%, the pause); `encodeBurnToEvm` against a known vector (a wrong `mintRecipient` is unrecoverable); batch encoding for both directions against the list in 1.2; the fee parser against whole-number and fractional fixtures, and `maxFee` with headroom below the amount; the secrets refinement of the config.

**Server integration** (Mongo harness, anvil):

- A top-up end to end: `queued`, the guard, `sending`, both Arc transactions mined in order, `forwarding`, Iris complete, `wrapping`, wrap confirmed, forced read, `done`; free float rises only after the forced read.
- A drain end to end: the reservation, the batch, burn log found, release as spent in one transaction, forced read, Iris complete, `done`; a concurrent order never takes the reserved pUSD, and the drift check does not repair the reservation.
- Operator queue: the script's row is `queued` and does nothing until the worker starts it; a second `move` while one is active or queued is rejected by the unique index; a queued top-up that the Arc guard or the day cap refuses ends `failed` with nothing signed; a queued drain larger than free float ends `failed`.
- Treasury lock: a withdrawal created concurrently with a top-up start is accepted only against a `treasuryFree` that already subtracts the top-up.
- Nonces: a withdrawal, a Solana withdrawal and a rebalance interleaved take distinct nonces; a restart in `sending` re-broadcasts the same bytes and pays once.
- A refused or reverted approve or burn ends `failed`, with no ledger change and the treasury balance unchanged except gas. A burn mined and a stalled Iris never fails or re-burns.
- `treasuryFree` subtracts a `sending` rebalance; after the burn mines, the chain balance already shows it, and a withdrawal is refused when the treasury can't cover it.
- The daily cap, the pause, and "one active move" hold.
- Automatic decisions: with trading on and the switch `on`, free float under 50% of `T` queues one `auto` top-up row for the planned amount; over 150% queues one drain; between the bands queues nothing; a float document older than 3 minutes, a move still in its pause, and a float read older than the last move each skip the decision; an `auto` row and an operator row take the same start path and the same guards.
- The wrap retries and wraps the full balance, a second attempt after a success does nothing, and the retry continues while the row is `stuck`. `wrap-idle` wraps idle native USDC and ends `done`.
- Drain failure classes: a crash before `attemptedAt` fails and releases at once; a refusal fails and releases; a timeout with a matching burn event is adopted; a timeout with none ends `failed` after 11 minutes and releases; a confirmed batch with no burn log ends `stuck` with the reservation released as spent; a repeat tick releases nothing a second time (`heldE6` never goes negative).
- Mint recipient: with a config wallet that differs from the derived one, no burn is signed and `error` "Pool wallet mismatch" is logged.
- The relayer gate: two submissions started at the same instant, one from the redeemer and one from the rebalancer, are serialised and never prepared together; with a redemption `submitted`, no rebalance batch is submitted, and the reverse; after a timed-out call the gate stays shut for 11 minutes.
- Startup: with `POOL_REBALANCE=on`, trading off and a `queued` row, the trader is connected.
- Per direction: a `stuck` drain does not block a top-up; a stuck top-up blocks automatic top-ups; three failures halt one direction only and queued moves still run while it is halted; `resolve` lifts it.
- `stuck` after 2 hours and the hourly error log; a late Iris `complete` moves a stuck row on.
- Trading off: no automatic decision, a queued move runs, an active row finishes. Switch `off`: nothing starts and nothing is decided.
- Iris 429 backs off without changing state, and `Payouts` and the rebalancer share the limiter.
- Solvency: an `arc_to_polygon` row in `forwarding` counts as an asset; a `submitting` drain counts its reservation; idle native USDC counts; a gross-balance figure does not.
- `perps-rebalance.ts` refuses while a pool row is `queued`, `sending` or `submitting`, and counts a `sending` top-up in `owed`.

**Browser.** No change; the app never shows rebalances.

## 11. The owner's live check

On mainnet with small amounts. The server logs every step. Do 1 to 3, 5 and 6 with `POOL_REBALANCE=on`, `PREDICTIONS_TRADING=off`: the worker decides nothing while trading is off, so only the moves you type in run.

1. `pool-rebalance.ts status`: both sides read correctly and the deposit wallet in the config equals the derived one (the script prints both; the earlier `polymarket-setup.ts` line only echoed the config, and is fixed in step 1 of the work order).
2. `move arc-to-polygon 5`. Check the Arc approve and burn hashes, Iris `complete` with a `forwardTxHash`, the time from burn to mint, the native USDC on Polygon in the deposit wallet (about 4.93 with the quote, more if `maxFee` unspent is returned), the wrap transaction, and the CLOB balance rising by about the same. This answers open questions 3, 5, 6 and 9 and confirms the wrap works with native USDC.
3. `move polygon-to-arc 5`. Check that one relayer batch ran, pUSD fell, the burn log was found, a burn event on Polygon appeared, and the Arc treasury rose by about 4.98. This answers open questions 2 and 3, and shows how a batch behaves when a call fails if one does.
4. Start a redemption and a rebalance close together: the gate holds one, and neither fails (open question 4).
5. Restart the server mid-move (during `forwarding`): the row resumes.
6. Run `wrap-idle` with nothing idle (it must do nothing), and once with a few cents of native USDC sent to the wallet by hand if the owner is willing.
7. Automatic decisions: with `POOL_REBALANCE=on`, turn `PREDICTIONS_TRADING=on` with a small float (for example `POLYMARKET_FLOAT_USD=20`), spend the free float below 10 with a real small prediction, and watch the worker top up on its own within a few minutes; then let a payout push free float over 30 and watch the drain.

Run the real float with `POOL_REBALANCE=on` and `PREDICTIONS_TRADING=on` only after 1 to 7 passed. Check 3 matters most for the drain, which depends on the vault holding native USDC (open question 2).

## 12. Order of work

One release. Nothing is turned on before step 7.

1. Config (the `off|on` switch, the secrets refinement), the `pool_rebalances` collection with the unique active index, `planPoolMove` and its tests (bands, amounts, caps, the pause), one Iris fee parser for any pair, `encodeBurnToEvm`, the derived-wallet line in `polymarket-setup.ts`, the `traderNeeded` count. Everything refuses while `POOL_REBALANCE=off`.
2. `Payouts` rebalance signing (copied, not extracted), `withTreasuryLock`, the `treasuryFree` change, the shared Iris limiter, and tests with the stub messenger and Iris fake.
3. `PoolTrader` additions, the `RelayerGate` (in the redeemer too), the transaction hash from the adapter, and the fake trader.
4. `PoolRebalancer`, the start path and both flows: the start path with guard, caps and reservation (shared by operator and automatic rows), the top-up flow, then the drain flow with the burn-log check, idle-USDC recovery and the drift change. Tests.
5. Automatic decisions on top of that start path: evaluate, bands, the pause, per-direction blocking and the halt. Tests.
6. The operator script (`status`, `plan`, `move`, `wrap-idle`, `resolve`), the `perps-rebalance.ts` refusal and `owed` change, the solvency additions, the free-float warnings, logging, and the `.env.example` section (including fixing the "wraps USDC.e, not native USDC" note).
7. The owner's live check 1 to 7: 1 to 6 with the worker `on` and trading off, 7 with a small float and trading on. Then run the real float with `POOL_REBALANCE=on`.

## What the owner provides

- A dedicated Polygon RPC in `POLYGON_RPC_URL`.
- The pool already funded and set up (`polymarket-setup.ts` run once), builder credentials in place. They are also required whenever `POOL_REBALANCE=on`, even with trading off.
- Turning `POOL_REBALANCE=on` after the treasury is funded (it is off by default), and `PREDICTIONS_TRADING=on` after live check 7.
- Arc treasury (HD index 0) USDC for the live check and the float: about $20 for the check, plus the float.
- Running the live check, and watching the `error` logs listed in section 8.
- Contact with Circle's support if a forward stalls (and the `receiveMessage` runbook in 6), and with Polymarket's builder support if the relayer refuses non-Polymarket targets.

## Not included

- Alerting beyond error logs (owner's choice, 2026-10-13).
- Moving money for people: balances never change, and nothing here credits or debits the ledger.
- Several moves at once, or splitting a move.
- Swaps (for example native USDC to USDC.e). If Polymarket pauses native USDC on the Onramp, this design does not work as written.
- Automatic recovery of a burned message that Circle never mints (the manual runbook is in 6).
- Merging the rebalance and Solana pay paths in `Payouts` into one implementation.
- Any change to how the redeemer submits several redemptions in a row (4, rule 4).
- Rebalancing any other venue besides the optional Hyperliquid float below.
- A smart-wallet or multisig for the treasury.
- Predicting the float need from open orders or pending redemptions.
- A reserve for withdrawals sized as a share of everything people hold.

## Hyperliquid master float (option)

`perps-rebalance.ts` is operator-run today and signs from the treasury key. The same worker could keep the Hyperliquid master float near `PERPS_FLOAT_USD` as a second venue. This is an option, not part of the first build, and it is not one of the owner's decisions now.

- **Top-up (Arc to HyperCore)** has the same shape as the pool top-up: the treasury burns through `Payouts`, with Circle's CctpForwarder as `mintRecipient` and `destinationCaller`, and the hook data `buildHookData(master)` already in the script. It needs `HYPERCORE_CCTP_FORWARDER`, one more guard against the same Arc reserve, and the same single-active-move rule (the unique index), so the two venues can't both drain the treasury at once. The row would be a `pool_rebalances` row with another `venue`. It would retire the script's signing, which removes the nonce clash in 5.3.9.
- **Drain (HyperCore to Arc)** needs the master key to sign Hyperliquid's `sendToEvmWithData` with forwarding data for Arc. The script's own header says that this is unverified for Arc as the destination (`perps-rebalance.ts`, the "design question 11" note), and nothing in this research checked it. Until a $5 live test works, draining stays manual.
- **Cost of adding it:** one more config switch, the forwarder address, a venue field and the same tests; about the size of step 4 above.
- **Recommendation:** build the pool first. Add Hyperliquid top-up later if the owner is tired of running the script, and leave its drain manual until the live test.

## Open questions

1. **Closed (verified).** The Collateral Onramp accepts native USDC: the verified pUSD implementation lists native USDC as an accepted asset (1.1.6). Residual risk: the live proxy `0xC011…2DFB` pointing at another implementation, or a per-asset pause. Live check 2 confirms.
2. **Does the vault hold native USDC to pay an unwrap?** An unwrap pays from the vault `0xC417fd8e9661c0d2120b64a04bb3278c17e99db1`; if the vault holds only USDC.e, `unwrap(USDC, …)` fails. Explorers returned 403 and an `eth_call` is a POST, so it was not read. Live check 3 unwraps a few dollars: it works or it reverts. If it reverts, automatic drains fail three times and halt (6) while top-ups go on; what to do about draining is an owner decision at that point.
3. **Does the relayer accept a batch that calls the Onramp, the Offramp, USDC and TokenMessengerV2, and is a batch all-or-nothing?** No allowlist and no atomicity are documented. Checks 2 and 3 run exactly these calls. The design does not depend on atomicity (6). If the relayer refuses, the fallback is the pool owner key paying a little POL for Polygon gas, which is an owner decision at that point.
4. **What does the relayer do with two unconfirmed batches?** The gate prevents it. Check 4 submits a redemption and a rebalance close together and shows whether the gate, or the relayer, orders them.
5. **How fast and how reliable is Circle's forwarding from Arc to Polygon, and what does Iris show?** Check 2 records the time from burn to mint, and the `forwardTxHash`, `feeExecuted` and `forwardState` values on a success. There is no documented list of `forwardState` values or a failure field, so stall handling is time-based.
6. **Does the CLOB balance read show the new pUSD at once?** Check 2 reads `fetchBalanceAllowance` right after the wrap, with and without `updateBalanceAllowance`. If it lags, the forced read keeps it, and `done` waits for it for up to 10 minutes.
7. **Closed (verified).** The relayer record returns the Polygon transaction hash: `fetchTransaction` returns `transactionHash` (1.1.8). The adapter must stop throwing it away; no live test is needed.
8. **Can anyone mint a forwarded message with `receiveMessage` when `destinationCaller` is zero, and what fee does the forwarder then take?** It decides whether the runbook in 6 works. It can only be tried on a stalled forward; ask Circle's support before launch.
9. **Is the unspent part of `maxFee` left in the mint, or kept by Circle?** Decides the real cost of the headroom in 4 and the displayed net. Check 2 compares the minted amount with the quote.
10. **Is a failed inner call a revert of the whole batch?** Same as 3; the first time a batch fails on its own shows it.
11. **Does creating a second SDK client without `wallet` have side effects?** The SDK documents the default as the signer's deterministic deposit wallet; it may call the relayer or create credentials. Check 1 shows it.

## Owner's decisions (2026-10-14)

1. **Who decides: the server, from the first release.** The worker evaluates the float every 60 seconds and queues its own moves; the same release includes the decision logic. `pool-rebalance.ts move` stays as the operator's override. Cost accepted: the bands, the pause and the halt run on real money the day the switch is turned on; live check 7 exercises them with a small float first.
2. **Limits on automatic moves.** Act below 50% and above 150% of `POLYMARKET_FLOAT_USD`; at least $10 and at most $100 per move; a 5-minute pause between moves; at most $300 a day from Arc to Polygon; a fixed $100 kept in the treasury on top of pending withdrawals and gas. Cost accepted: if the float drains faster than $300 a day the pool runs short and orders are refused until the next day; the owner raises the reserve as withdrawals grow.
3. **What stops when a move gets stuck or fails.** Only automatic moves of the same direction: a stuck row, or three failed rows in a row, halt that direction; queued moves still run, and the other direction keeps working. Cost accepted: a stuck drain does not stop top-ups, so the owner must read the `error` logs to notice it.
4. **Direction: both ways from the start.** The worker tops the pool up from Arc and drains it back to Arc. Cost accepted: the drain goes live on real money with the top-up and depends on the vault holding native USDC (open question 2); live check 3 tests it before automatic decisions run, and if it fails the drain halts after three failures while top-ups go on.
5. **Switch.** The worker stays behind its own switch, `POOL_REBALANCE`, off by default. The owner turns it on after funding. Nothing else about safety changes: the guards, caps, reservation, unique active index and per-direction halt all stay as written.
