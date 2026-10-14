# Instant Deposit Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bridged deposit from Ethereum, BNB Chain or Solana (ETH, USDT, USDC, BNB, SOL) is paid to the person's Arc account from a vault of USDC as soon as the source transaction is in a block, when the vault's free balance covers it, and takes today's direct path when it does not.

**Architecture:** A new `server/src/vault/` module holds the vault key (HD path `m/44'/60'/2'/0/0`), the free-balance and reservation arithmetic, the breaker, a `VaultPayer`, a `VaultSettler` and a `VaultMonitor`. `DepositOrders` plans each order as `fronted` (Relay quotes the vault as recipient, `checkQuote` pins the order, refunds and calldata) or `direct` (today's code). Fronted orders get their own tracker step that never reads bridge status to move an order; the payer verifies the source transaction itself, then pays through a stored-before-sent native transfer, and `Ledger.credit` stays the only writer of balances. Ethereum and BNB Chain are built first; Solana (Tasks 13 to 15) reuses every part and adds its quote check, its signature tracking and its instruction match.

**Tech Stack:** Node 24 + TypeScript, Express 5 + socket.io + zod, MongoDB replica set, viem, `@scure/base`, vitest with anvil (Arc, Ethereum, BNB Chain) and the fakes in `server/test/support`, Next.js 16 + React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-instant-deposit-vault-design.md`. Section numbers below (1.3, 3.2, 14.5 ...) are the spec's. Model plans: `2026-10-14-solana-deposits-withdrawals.md`, `2026-10-14-hyperliquid-perps.md`, `2026-10-14-pool-rebalancing.md`.

## Shared files (two other plans are built in this tree at the same time)

`2026-10-14-pool-rebalancing.md` and `2026-10-14-all-time-pnl.md` are built concurrently. Every shared file below is edited by hunks that are additive and local; never rewrite, reformat or reorder a file you share; commit by path with only your own hunks; re-read the file just before editing it.

| File | What this plan changes | Also touched by |
| ---- | ---------------------- | --------------- |
| `server/src/server.ts` | builds `Vault`, `VaultPayer`, `VaultSettler`, `VaultMonitor` (all on `overrides.now`); moves the one line `const sources = ...` above `new DepositOrders(...)` and passes `vault`, `sources`, `minDeposit` to it; passes `vault` and `frontedWindowSeconds` to `OrderTracker`; `Overrides.vaultBroadcast`; start and stop (stop them before `tracker`) | pool, pnl |
| `server/src/db/mongo.ts` | `DepositOrderDoc.route` and `.vault`, `VaultOrderDoc`, `VaultEventDoc`, `Collections.vaultEvents` (and its `connectDatabase` entry), two `depositOrders` indexes, one `vaultEvents` index | pool, pnl |
| `server/src/config.ts` | the `VAULT_*` keys and their `superRefine` rules | pool |
| `server/src/protocol.ts` | `DepositQuoteView.instant?`; `DepositOrderView.instant?/paying?/payAmount?/payTxHash?/held?` (optional); `solana:blockhash` payload `{ orderId?: string }` | pnl |
| `server/src/socket/sockets.ts` | the `solana:blockhash` handler passes the order id | pnl |
| `server/src/validation.ts`, `server/test/unit/validation.test.ts` | `decodeSignature`, a `solanaBlockhash` payload schema | pnl |
| `server/test/unit/config.test.ts`, `server/test/integration/perp-reconciler.test.ts` | new cases appended at the end of the file | pool (both), hyperliquid (config) |
| `server/src/services.ts` | `Services.vault`, `vaultPayer`, `vaultSettler`, `vaultMonitor` (so a test can tick, stop and rebuild them) | pnl |
| `server/src/withdrawals/payouts.ts` | three words get `export` (`alreadySent`, `refused`, `unreachable`) and nothing else | pool |
| `server/.env.example`, `server/README.md` | the vault settings and an operator section | pool (`.env.example`), pnl (`README.md`) |
| `server/test/e2e/serve.ts`, `e2e/backend.ts` | vault controls; one `relay` bridge for Ethereum, BNB Chain and Solana | pnl |
| `lib/account/state.ts`, `components/account-client.ts`, `components/account-provider.tsx` | the pending rule for fronted orders; the final-number flow; the order id on `solana:blockhash` | pnl |
| `server/test/support/stack.ts`, `fake-bridge.ts`, `fake-solana-rpc.ts` | `vault` stack option (one `relay` bridge for all three chains), fronted fake quotes, Solana transaction reads | none today; add only |

Files this plan only reads: `server/src/perps/reconciler.ts` (`arcHoldings` is deliberately not changed; Task 12 pins that with a test), `server/src/withdrawals/sweeper.ts`, `server/src/deposits/*`. New files (all under `server/src/vault/`, plus `server/src/crosschain/fronted-quote.ts`, `server/src/crosschain/fronted-tracker.ts`, `server/scripts/vault.ts`) belong to this plan alone.

## Facts re-verified for this plan (read only, 2026-10-14)

- `POST https://api.relay.link/quote/v2`, no key, placeholder addresses, 19:13 UTC: a BNB USDT quote with `ttl: 180` and `slippageTolerance: "100"` answered 200 with `protocol.v2` present; two steps, an approval (selector `0x095ea7b3`, to the token) then the deposit (selector `0xe8017952`, 266 hex characters = 132 bytes, to the depository `0x4cd00e387622c35bddb9b4c962c136462338bc31`); `orderData.output.deadline` was 604,799 seconds after the quote, so `ttl` is not honoured (3.3); `refunds[0]` is `{ chainId: "bnb", recipient: <refundTo> }` and `refunds[1]` is `{ chainId: "arc", recipient: <recipient> }`, addresses and currencies in lowercase; `minimumAmount` was 1% under `expectedAmount`; the calldata ends with `protocol.v2.orderId`; `extraData` was the constant of 1.3.
- The same call for Solana USDC (20 USDC, `includeComputeUnitLimit`): `refunds[0].recipient` was the exact base58 `refundTo`; the depository `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`; instructions are Compute Budget (`02400d0300`) then the depository (10 keys, data 96 hex characters without `0x`, discriminator `0b9c60da27a3b413`); `relay.ts` adds the `0x`.
- `GET https://api.relay.link/intents/status/v3?requestId=0x179200338421c7da78fd83975012eb00bcba20192f16bea353ca5e72df909694`, 19:13 UTC: `status: "success"`, `inTxHashes` holds one base58 signature, `txHashes` holds the Arc fill, `originChainId` 792703809.
- `https://docs.relay.link/references/api/api_guides/migrating-to-requests-v3`, read 19:15 UTC: `GET /requests/v3` takes `term` (request id, wallet, any tx hash) and the filters `depositTxHash`, `fillTxHash`, `refundTxHash`; a request carries `inTxs[]` and `outTxs[]` with `txHash` (v2's `hash` is renamed); the page does not show where a refund transaction sits, so Task 16 reads it tolerantly and prints the raw body (spec open question 8).
- No occurrence of the old request-list path exists in `server/src` or `server/scripts` today (grep, 19:15 UTC).
- Plan review, 2026-10-14 19:28 to 19:30 UTC, same unauthenticated calls with throwaway placeholder addresses (nothing signed, nothing sent): `POST https://api.relay.link/quote/v2` for BNB USDT (3 USDT, `ttl` 180, `slippageTolerance` "100") answered 200 and confirmed every point of the first bullet again (`deadline` 604,800 s out, `minimumAmount` 2,948,383 against `expectedAmount` 2,978,165, orderId at the end of the 132-byte deposit calldata); Ethereum ETH (0.01 ETH) and Solana SOL (0.05 SOL) and USDC (20 USDC) quotes answered 200 with `refunds[0]` the `refundTo` and a deadline 604,799 or 604,800 s out; `GET https://api.relay.link/intents/status/v3?requestId=0x1792…9694` still answers `status: "success"` with one base58 `inTxHashes` entry. The five bodies are saved as the Task 2 fixtures (they are in the tree already, uncommitted; Task 2 commits them). Their provenance and the commands that made them are in the Appendix at the end.
- `SolanaRpc.getTokenBalance` sums the owner's token accounts and returns 0 both for a zero-balance account and for none, so it cannot show that a refund address holds a USDC token account (spec 14.6 names it for that). Task 13 adds `hasTokenAccount` for it.
- `e2e/account.logic.spec.ts` and `e2e/solana-deposit.logic.spec.ts` build `DepositOrderView` and `DepositQuoteView` literals, and the root `tsconfig.json` includes `e2e`; so the fields this plan adds to those two views are optional in `protocol.ts` (the server always writes them).

## Global Constraints

- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -m "..." -- <paths>`) with only your own hunks. The tree already has unrelated changes (`.impeccable/hook.cache.json`, other specs and plans); never stage them.
- **Comments** are one line each and describe the code as it is. Never read or print any `.env` file (`server/.env.example` is fine).
- **No task calls a real service or moves money.** Tests use the fakes in `server/test/support/` and the anvil chains; the Relay bodies Task 2 needs are already recorded in `server/test/fixtures/relay/` (Appendix), so Task 2 makes no network call either. Nothing in this plan signs or sends outside tests. The owner runs the live checks (after the last task).
- **Clocks.** `startServer` hands `overrides.now` (the stack's `now` option) to the `Vault`, `VaultPayer`, `VaultSettler`, `VaultMonitor` and the `OrderTracker`. A test that needs time to move either passes `now` to `startStack` or builds the component by hand over `stack.server.services` with its own `now`, as `deposit-tracker.test.ts` already does for `OrderTracker`. Order documents carry real `Date`s, so tests that need an older quote move `vault.quotedAt` in the database instead of faking the clock.
- **Test isolation:** vitest runs files in parallel against one Mongo and three anvils. The vault is a per-stack address (each `startStack` makes its own mnemonic), so a test file must never reuse another file's mnemonic or fund an address it did not derive.
- **Browser tests** only from an isolated copy of the repo, on ports 3650 (app), 4650 (API), 4651 (control) via `E2E_PORT`, `E2E_API_PORT`, `E2E_CONTROL_PORT`. Never 3000, 3100, 4500 or 27018. Make the copy: `git archive HEAD | tar -x` into a new directory in your scratchpad, clone `node_modules` and `server/node_modules` into it with `cp -cR`, copy your changed and new files over it, and run `npx playwright test ...` from inside the copy.
- **Checks:** server `cd server && npx vitest run <file>` while working, `cd server && npm test && npx tsc --noEmit` before each server commit; logic `npm run test:logic`; app types `npx tsc --noEmit -p .`; for client tasks also `npx eslint <changed files>` and `npx prettier --check <changed files>` (4 spaces, 120 columns, double quotes). `npm test` needs Foundry's `anvil`; if it is missing, stop and report it.
- **Server conventions:** ESM, imports end in `.ts`, `erasableSyntaxOnly` (no enums, no constructor parameter properties), `noUncheckedIndexedAccess`. `protocol.ts` stays free of imports and runtime code. Next.js differs from what you know (`AGENTS.md`); this plan needs no new Next API.
- **Money:** Mongo amounts are wei `Decimal128` (`toDecimal`, `fromDecimal`, `formatUsdc` in `server/src/db/money.ts`); arithmetic is `bigint`. The ledger moves only through `Ledger.credit`; nothing in `server/src/vault/` writes a balance. Every payout, refund and fill is 18-decimal wei on Arc.
- **Switch:** `VAULT_FRONTING` is `"on" | "off"`, default `"off"`. Off, only new fronted orders stop; the tracker step, payer, settler and monitor keep running for orders already fronted.
- **Spec values, verbatim:**
    - Vault path `m/44'/60'/2'/0/0` (viem `accountIndex: 2`, `addressIndex: 0`); deposits stay on account 0', perps on 1'.
    - Config defaults: `VAULT_TARGET_USDC` 100, `VAULT_LOSS_STOP_USD` 5, `VAULT_QUOTE_WINDOW_SECONDS` 180, `VAULT_UNFILLED_MINUTES` 10, `VAULT_SLIPPAGE_BPS` 100. No `VAULT_MAX_*` key is read.
    - Fronted request: `ttl` = the window (seconds), `slippageTolerance` = `String(VAULT_SLIPPAGE_BPS)`, `refundTo` the owner's address, `recipient` the vault. A quote with `usdcOut - minimumOut` over 3% of `usdcOut` is not fronted (exactly 3% passes).
    - `RELAY_EXTRA_DATA` = `0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`. EVM calldata: native `0x49290c1c` + wallet word + order id (68 bytes), token `0xe8017952` + wallet, token, amount, order id words (132 bytes). Order `version` `"v1"`. Chain names in the order: `ethereum`, `bnb`, `solana`, `arc`.
    - Gas reserve = 0.05 USDC + 0.001 USDC per order counted in `committed`. Reservation `reservedUntil` = created + 60 s, then the end of the quote window once a hash is seen. Vault balance read timeout 1.5 s, pinned to `max(head, highest minedBlock of payouts mined in the last 10 minutes)`. The cheap-check cache is used only when at most 3 s old.
    - Window: the source block's timestamp must be at most `min(quotedAt + VAULT_QUOTE_WINDOW_SECONDS, deadline)`; ETH, BNB and SOL are re-priced (fresh quote, 3 s timeout, pay `min(quoted, fresh)`) when the block is later than 60 s after `quotedAt`; USDC and USDT are not.
    - Tracker: fronted orders are checked on every pass for 2 minutes after creation or last change, then every 15 s; the Relay status lookup has its own loop with a 3 s timeout; with no hash by `quotedAt + window + 2 minutes` a `created` or `sent` order is `expired`.
    - Payout: native USDC transfer, gas 21,000, `maxFeePerGas` the larger of twice the base fee and `MIN_BASE_FEE` (20 gwei), priority fee 1 gwei. A refused send is cleared and retried after a minute on the same nonce; after 5 attempts the order is held `payout_failed`. A nonce is never re-signed on "nonce too low" with no receipt: the order is held `payout_unclear`.
    - Holds: `late`, `mismatch`, `payout_failed`, `payout_unclear`. Settle states: `watching`, `open`, `refilled`, `refunded`, `failed`, `stale`, `none`, and the owner's `recovered`, `lost`, `returned`.
    - Settler cadence: every 15 s for the first 10 minutes of an order, then every 10 minutes while `watching`, every minute once `open`, hourly after 24 hours; it stops at `deadline + 86,400`. A fill is the Arc transfer to the vault between `minimumOut` and 1.05 x `usdcOut`, the nearest to `usdcOut`.
    - Breaker: loss, exposure, drift (7.3). A kind trips when its total is at least `VAULT_LOSS_STOP_USD` (drift: any outflow above 0.01 USDC) and logs `error` once. Monitor every 60 s; "Vault is low" under 25% of `VAULT_TARGET_USDC`, again hourly while low.
    - Log messages, exact: "Vault is low", "Unpaid fronted order: fill reached the vault", "Unpaid fronted order: refunded to the owner", "Relay says filled, nothing reached the vault", "More than one deposit for an order".
    - App copy, exact: steps "Sending", "Confirming", "Added"; "Taking longer than expected" after 2 minutes in Confirming; "Didn't go through"; "We're checking this deposit."; preview "≈ $300.00, added right away". A fronted order never shows "Refunded to your wallet".
    - Solana: chunks of at most 256 signatures; a signature must decode to 64 bytes; `getTransaction` uses `commitment: "confirmed"`, `maxSupportedTransactionVersion: 0`, `encoding: "json"`; `confirmed` counts as in a block.

## Review Focus

1. **A re-priced or partly filled payout under `DEPOSIT_MIN_USDC`.** `Ledger.credit` drops transfers below the dust floor, so paying one would take the vault's money and credit nobody. The payer holds such an order (`late`) and sends nothing. (Task 7 unit test, Task 9 integration test.)
2. **Six-decimal and eighteen-decimal source coins.** Ethereum USDC and USDT have 6 decimals, BNB Chain USDC and USDT have 18; the payout, the reservation and the received figure are always Arc wei equal to `usdcOut`, never off by 10^12. (Task 9 test, Task 11 test.)
3. **A quote carrying an extra refund entry on a third chain, a second payment, or a second input.** Dropped, not partly checked. (Task 3 tests.)
4. **A reported hash that Relay's status never lists** (Relay indexing lags, or lists nothing until the fill). The order is still moved to `in_block` and paid from the chain checks alone. (Task 8 and Task 9 tests.)
5. **A vault below its own gas reserve, or empty.** `free` clamps at 0, a deposit is planned direct, and nothing underflows or throws. (Task 4 and Task 6 tests.)
6. **A deposit paid twice.** Four ways, each stopped by a different layer of spec section 4, each with its own test in Task 9: two payers over one database racing for one order (`"two payers racing for one order store one payout and move the vault's money once"`); the payer's report and the chain scan both crediting the one transfer (`"the payer's report and the scan credit the transfer once"`); one source transaction cited by two orders, and the same calldata sent twice (`"one transaction cited by two orders pays one: the second is held mismatch"`, `"the same calldata sent twice pays once"`); a pass that signs a second transaction after "nonce too low" (`"nonce too low with no receipt parks the order..."` in Task 10).
7. **Two deposits racing for the last of the free balance.** At order time (Task 4 `"two concurrent insertFronted calls that together exceed the vault insert one"`, Task 6 `"two concurrent orders that together exceed the vault: one fronted, one direct"`); at payment time, where two `in_block` orders meet a vault that covers one (Task 9 `"two in_block orders and a vault that covers one: one is paid, the other waits at the head of the queue"`); and an order insert racing a payout (Task 9 `"a new order and a payout racing for the last of the free balance: only one gets it"`). A breaker trip landing between a quote and its insert plans direct (Task 6).
8. **A restart between paying and recording.** One test per crash window in Task 9, each ending with one transfer on chain and one credit: `"restart before the raw transaction is stored"`, `"restart after the raw transaction is stored, before it is broadcast"`, `"restart after the node has the transaction but before the payer recorded it mined"` (the broadcast hook sends the bytes and then throws), `"restart after the receipt, before the credit"` (the scan is stopped). A node that lags behind a mined payout must not hand the next order a used nonce (Task 9 `"a lagging node's lower transaction count does not hand out a nonce a mined payout used"`).
9. **A refund after payment.** Task 11 `"a refund after the payout: ..."` (settle `refunded`, `error` log, vault balance and account balance unchanged) and `"a refunded paid order above the loss threshold stops new fronting and clears when marked recovered"`; Task 5 pins the arithmetic.
10. **A Solana transaction that differs from the quote.** Quote side, Task 13: the fronted check drops a quote whose instruction, order id, amount or refund differ from Relay's order. Landing side, Task 15: the payer holds a landed transaction whose depository instruction differs in amount, order id, one key, fee payer or count, with no payout, no credit and the vault's balance unchanged (`"a landed transaction that differs from the quote is held mismatch and nothing moves"`), and a throttled or empty read pays nothing.

---

### Task 1: Settings, vault key, payout predicates, delivery timing (spec 2.1, 8, 15 steps 1 and 2)

**Files:**
- Modify: `server/src/config.ts`, `server/src/accounts/keyring.ts`, `server/src/withdrawals/payouts.ts` (three `export`s), `server/src/crosschain/tracker.ts` (one log line in `#deliver`), `server/.env.example`
- Test: `server/test/unit/config.test.ts`, `server/test/unit/keyring.test.ts`, `server/test/integration/deposit-tracker.test.ts`, `server/test/integration/payouts.test.ts` and `payouts-solana.test.ts` (must pass untouched)

**Interfaces:**
- Produces config fields: `VAULT_FRONTING: "on" | "off"`, `VAULT_REFUND_EVM: string | undefined` (a 20-byte hex address), `VAULT_REFUND_SOLANA: string | undefined` (base58 that decodes to 32 bytes), `VAULT_TARGET_USDC: number` (positive, 100), `VAULT_LOSS_STOP_USD: number` (positive, 5), `VAULT_QUOTE_WINDOW_SECONDS: number` (int 30 to 600, 180), `VAULT_UNFILLED_MINUTES: number` (int at least 1, 10), `VAULT_SLIPPAGE_BPS: number` (int 1 to 300, 100; above 300 every quote would fail the 3% rule).
- Produces `Keyring.vault(): HDAccount`.
- Produces `export` on `alreadySent`, `refused`, `unreachable` in `payouts.ts`.

- [ ] **Step 1: Write the failing tests.**
    - `config.test.ts`: `"the vault is off by default and its settings have the spec's defaults"` (all eight values above); `"VAULT_FRONTING=on without VAULT_REFUND_EVM is refused, naming the variable"`; `"VAULT_FRONTING=on with SOLANA_DEPOSITS=on and no VAULT_REFUND_SOLANA is refused, naming the variable"`; `"VAULT_FRONTING=on with SOLANA_DEPOSITS=off needs no Solana refund address"`; `"VAULT_FRONTING=on with SOLANA_DEPOSITS=on and SOLANA_RPC_URLS left at the public default is refused"` (and accepted with `SOLANA_RPC_URLS=https://rpc.example`); `"a refund address that is not an address, or not 32 bytes of base58, is refused"`; `"no VAULT_MAX_ variable is read"` (load with `VAULT_MAX_DEPOSIT_USD=1`; `Object.keys(config).filter(k => k.startsWith("VAULT_MAX"))` is `[]`); `"VAULT_SLIPPAGE_BPS above 300 is refused"`.
    - `keyring.test.ts`: `"the vault key is m/44'/60'/2'/0/0"` (equals `mnemonicToAccount(MNEMONIC, { accountIndex: 2, addressIndex: 0 }).address`, and pin the lowercase literal); `"the vault differs from the operator, deposit index 1 and perp index 0"`.
    - `deposit-tracker.test.ts`: `"delivery logs the time from the source block to the credit"`: build the tracker with a pino logger writing to an in-memory stream, deliver one Ethereum order, and assert exactly one record with message `"Bridged deposit credited"` and fields `coin` (`"ethereum:ETH"`), `provider`, and `blockToCreditMs` a number at least 0; a further tick after delivery adds no record; and an order whose source receipt cannot be read still ends `delivered` with no record.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/config.test.ts test/unit/keyring.test.ts test/integration/deposit-tracker.test.ts`).
- [ ] **Step 3: Implement.** Config keys in `fields` and the three refusals in the existing `schema.superRefine`, placed before its `if (switches.length === 0) return;` line (that early return would skip them); compare `SOLANA_RPC_URLS` with `DEFAULT_RPC_URLS.SOLANA_RPC_URLS`. `vault()` is `hdKeyToAccount(root, { accountIndex: 2, addressIndex: 0 })`. In `OrderTracker.#deliver`, after the `#move` to `delivered` that landed (make `#move` return whether it did, so a lost race logs nothing), read the source receipt of `sourceHash` (`sources[chain].getTransactionReceipt`, since `#deliver` holds no receipt) and then `getBlock({ blockNumber: receipt.blockNumber })` for its timestamp (an EVM order; Solana is added in Task 13), and log `info` `{ orderId, coin, provider, blockToCreditMs: deposit.creditedAt - blockTime*1000 }` as `"Bridged deposit credited"`; a failed or empty read logs nothing and delivery has already happened. `.env.example` gets a "Instant credit (the vault)" block with every key, the constraints of 2.2 (EOA, Solana wallet System-owned with a USDC token account) and the note that `RELAY_API_KEY` is advised.
- [ ] **Step 4: Run the new tests, then the full checks** (`cd server && npm test && npx tsc --noEmit`). Expect PASS, `payouts.test.ts` and `payouts-solana.test.ts` unchanged.
- [ ] **Step 5: Commit** "Add the vault settings and key, export the payout predicates, and log how long a bridged deposit takes to credit".

---

### Task 2: Relay: fronted request fields, the v2 order, minimum, deadline and listed hashes (spec 1.3 request side, 9 types, 14.1)

**Files:**
- Modify: `server/src/crosschain/providers/types.ts`, `server/src/crosschain/providers/relay.ts`
- Fixtures (already in the tree, uncommitted; this task commits them): `server/test/fixtures/relay/fronted-eth.json`, `fronted-bnb-usdt.json`, `fronted-solana-sol.json`, `fronted-solana-usdc.json`, `status-solana-filled.json`
- Test: `server/test/unit/crosschain-relay.test.ts`

**Interfaces:**
- Produces in `types.ts`: `QuoteRequest.fronted?: { ttlSeconds: number; slippageBps: number }`; `Quote.minimumOut?: bigint` (Arc wei), `Quote.deadline?: number` (unix seconds), `Quote.relayOrder?: RelayOrder`; `BridgeStatus.sourceTxHashes?: string[]`;
  `RelayOrder = { orderId: Hex; orderData: { version: string; inputs: { payment: { chainId: string; currency: string; amount: bigint }; refunds: { chainId: string; recipient: string; currency: string; extraData: Hex }[] }[]; output: { chainId: string; payments: { recipient: string; currency: string; minimumAmount: bigint; expectedAmount: bigint }[]; calls: unknown[]; deadline: number; extraData: Hex } }; paymentDetails: { chainId: string; depository: string; currency: string; amount: bigint } }`.
- A quote or status with no `protocol.v2` or no `inTxHashes` parses as before (those fields undefined). `protocol.v2` and `minimumAmount` are parsed with `safeParse`: a malformed or changed one leaves `relayOrder` or `minimumOut` undefined, which only makes the fronted check fail closed. It never throws, so a direct quote can't be lost to a change in a field only the vault reads.

- [ ] **Step 1: Check the fixtures are in place** (no network). `ls server/test/fixtures/relay/` lists the five files above, and `grep -c '"orderId"' server/test/fixtures/relay/fronted-*.json` prints 1 for each quote body (`protocol.v2` is present). If one is missing, stop and report it; do not record it inside this task. How they were made, with the exact request bodies, is in the Appendix. Their placeholders are: EVM `user` `0x00000000000000000000000000000000000a11ce` (the wallet), `refundTo` `0x00000000000000000000000000000000000b0b01` (stands for `VAULT_REFUND_EVM`), `recipient` `0x00000000000000000000000000000000000de905` (the vault); Solana `user` `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`, `refundTo` `Vote111111111111111111111111111111111111111`, same recipient. Amounts: ETH 0.01 (`10000000000000000`), BNB USDT 3 (`3000000000000000000`, 18 decimals), SOL 0.05 (`50000000` lamports), Solana USDC 20 (`20000000`).
- [ ] **Step 2: Write the failing tests** in `crosschain-relay.test.ts` (the fake `fetch` pattern already in the file):
    - `"a fronted request sends ttl 180 and slippageTolerance \"100\" and the owner's refundTo"` (parse the body sent).
    - `"a direct request body has no ttl and no slippageTolerance and is otherwise unchanged"` (the key set of the body equals today's: `user, recipient, refundTo, originChainId, destinationChainId, originCurrency, destinationCurrency, amount, tradeType`, plus `includeComputeUnitLimit` on Solana).
    - `"every request carries refundTo"` (direct and fronted).
    - `"the BNB USDT fixture parses minimumOut as its details.currencyOut.minimumAmount x 10^12 and deadline from output.deadline"` (both read from the file, never typed in the test); `"... relayOrder.orderId is the last 32 bytes of the deposit calldata"`; `"the order keeps both refund entries, one payment and empty calls"`; `"relayOrder.paymentDetails.depository is 0x4cd00e387622c35bddb9b4c962c136462338bc31"`.
    - `"a quote with no protocol.v2 has no relayOrder"` (the existing `quote-eth.json` body with `protocol` deleted), `"a protocol.v2 of an unknown shape has no relayOrder and the quote still parses"` (the order id replaced by a number: no throw) and `"the existing fixtures still parse"`.
    - `"both Solana fixtures parse a relayOrder whose source-chain refund recipient is the exact base58 refundTo"`.
    - `"status lists inTxHashes as plain strings, a base58 signature included"` (`status-filled.json` gives one 0x hash; `status-solana-filled.json` gives one 87 to 88 character string and does not throw); `"status without inTxHashes has no sourceTxHashes"`.
- [ ] **Step 3: Run them; expect FAIL** (`cd server && npx vitest run test/unit/crosschain-relay.test.ts`).
- [ ] **Step 4: Implement** in `relay.ts`: zod for `protocol.v2` (optional, `.passthrough()` off), `details.currencyOut.minimumAmount` (optional units, converted with `toArcWei`), `output.deadline`; the request adds `ttl` and `slippageTolerance` only when `request.fronted`; `statusResponse` gains `inTxHashes: z.array(z.string()).optional()` (the existing `txHashes` hex validator stays). `fillTxHash` logic unchanged.
- [ ] **Step 5: Run the file, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 6: Commit** "Read Relay's v2 order, minimum output and listed source hashes, and send ttl and slippage on fronted quotes", with the five fixture files.

---

### Task 3: The fronted quote check for Ethereum and BNB Chain (spec 1.3)

**Files:**
- Create: `server/src/crosschain/fronted-quote.ts`
- Modify: `server/src/crosschain/quotes.ts` (`checkQuote` calls it when `request.fronted` is set)
- Test: `server/test/unit/crosschain-fronted.test.ts`

**Interfaces:**
- Consumes: Task 2 types and fixtures.
- Produces in `fronted-quote.ts`: `RELAY_EXTRA_DATA` (the constant above); `VaultExpect = { kind: "evm"; chainId: number; to: Address; data: Hex; value: bigint } | { kind: "solana"; wallet: string; programId: string; keys: string[]; data: Hex }`; `frontedCheck(quote: Quote, request: QuoteRequest, logger?: { error: (fields: object, message: string) => void }): { ok: true; expect: VaultExpect } | { ok: false; reason: string }`. The Solana branch returns `{ ok: false, reason: "solana is checked in Task 13" }` until Task 13.
- `checkQuote(quote, request, allowed, logger)` returns `false` when `request.fronted` is set and `frontedCheck(...).ok` is false; with no `fronted` it behaves exactly as today.
- Request convention: `request.recipient` is the vault, `request.refundTo` the owner's refund address, `request.sender` the person's wallet.
- Task 2's `RelayOrder` amounts are the order's own units (source units for `inputs` and `paymentDetails`, 6-decimal USDC for `output.payments`); `frontedCheck` converts the output ones with `toArcWei(amount, 6)` before comparing with `usdcOut` and `minimumOut`.

- [ ] **Step 1: Write the failing tests.** Constants `WALLET` `0x…a11ce`, `REFUND` `0x…b0b01`, `VAULT` `0x…de905`; requests built from the Task 2 fixtures via `createRelay` with a fake `fetch`, with `fronted: { ttlSeconds: 180, slippageBps: 100 }`. Each negative test edits one field of a parsed fixture and expects `ok: false` and `checkQuote(...)` false.
    - Accepts: `"the ETH fixture passes and expect is the deposit transaction"` (`expect.to` the depository, `expect.data` 68 bytes starting `0x49290c1c`, `expect.value` 10^16); `"the BNB USDT fixture passes and expect is the deposit, not the approval"` (`expect.data` 132 bytes starting `0xe8017952`, `expect.value` 0n).
    - Drops (each its own test): `"a quote whose recipient is another address"`; `"a source-chain refund entry for another address"` (each of the two refund entries in turn: index 0 changed, then the Arc one changed to not-the-vault); `"a refund entry on a third chain"` and `"a second input"` and `"a second payment"` (Review Focus 3); `"a payment to another recipient or in another currency"`; `"non-empty output.calls"`; `"missing protocol.v2"`; `"orderData.version v2"`; `"calldata whose last 32 bytes are not the order id"`; `"a transaction not sent to paymentDetails.depository"`; `"an unknown selector, and a known selector with the wrong length"`; `"calldata naming another wallet, another token or another amount"`; `"a native value that is not the request amount, and a token quote with a non-zero value"`; `"payment.amount, paymentDetails.amount or the request amount disagreeing"`; `"expectedAmount differing from usdcOut, and minimumAmount from minimumOut"` (the order's amounts are in USDC's 6 decimals and `usdcOut` and `minimumOut` in Arc wei, so the check compares after `toArcWei(amount, 6)`; one test with a 1 wei difference in each); `"a guaranteed minimum 3.01% under usdcOut"` dropped while exactly 3% passes; `"extraData that is not RELAY_EXTRA_DATA"` dropped, once for `output.extraData` and once for the Arc refund entry's, with the logger's `error` called once each time with a message naming the change.
    - `"every dropped order, refund or payment check logs error once with the reason"` (spec section 12: "Logged at `error`"; one case each for the recipient, a refund entry, a payment, `calls` and the order id, with the logger spy; a quote dropped by the base checks logs what it logs today and nothing more).
    - `"without request.fronted, checkQuote is unchanged"` (the old fixtures with the old requests pass; existing `crosschain-quotes.test.ts` stays green).
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/unit/crosschain-fronted.test.ts`).
- [ ] **Step 3: Implement `frontedCheck`.** Run the existing base checks first; then every bullet of 1.3 in order; compare EVM addresses case-insensitively and source chain names by the coin's chain (`ethereum`, `bnb`). `expect` comes from the last EVM transaction. Failures return a `reason` naming the first failing check.
- [ ] **Step 4: Run the file, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Refuse a fronted quote unless its order, refunds, payment and calldata all name the vault and the owner's refund address".

---

### Task 4: Order data, reservations, the free balance and the pinned vault read (spec 2.3, 2.4, 9)

**Files:**
- Create: `server/src/vault/lock.ts`, `server/src/vault/funds.ts`, `server/src/vault/vault.ts`
- Modify: `server/src/db/mongo.ts`
- Test: `server/test/unit/vault-funds.test.ts`, `server/test/integration/vault-funds.test.ts`

**Interfaces:**
- Produces in `mongo.ts`: `DepositOrderDoc.route?: "direct" | "fronted"` and `DepositOrderDoc.vault?: VaultOrderDoc`;
  `VaultOrderDoc = { relayOrderId: string; quotedAt: Date; deadline: number; minimumOut: Decimal128; reserved: Decimal128; reservedUntil: Date | null; expect: VaultExpectDoc; sourceTx: string | null; rejected: string[]; verifiedAt: Date | null; payout: VaultPayoutDoc | null; paidAt: Date | null; attempts: number; hold: { reason: "late" | "mismatch" | "payout_failed" | "payout_unclear"; at: Date; note?: string } | null; release: { amount: Decimal128; note: string; at: Date } | null; settle: "watching" | "open" | "refilled" | "refunded" | "failed" | "stale" | "none" | "recovered" | "lost" | "returned"; received: Decimal128 | null; refillTx: string | null; refilledAt: Date | null; settledNote: string | null; lost: { amount: Decimal128; at: Date } | null; lastValidBlockHeight?: number }`;
  `VaultExpectDoc` is `VaultExpect` with `value: string` (decimal) for EVM; `VaultPayoutDoc = { nonce: number; lastNonce: number | null; rawTx: Hex; txHash: Hex; to: Address; amount: Decimal128; minedBlock: number | null; state: "signed" | "sent" | "mined" | "failed" }`; `VaultEventDoc = { _id: ObjectId; kind: "withdraw" | "filler" | "drift" | "ack"; txHash: string; amount: Decimal128; to: string | null; nonce: number | null; note: string | null; at: Date }`; `Collections.vaultEvents`.
- Indexes: `depositOrders`: unique partial `{ "vault.sourceTx": 1 }` (`partialFilterExpression: { "vault.sourceTx": { $type: "string" } }`), `{ route: 1, state: 1 }`, `{ "vault.settle": 1, updatedAt: 1 }`; `vaultEvents`: `{ txHash: 1 }`.
- Produces `lock.ts`: `class Mutex { run<T>(fn: () => Promise<T>): Promise<T> }` (one at a time, in order; a rejecting `fn` does not block the next).
- Produces `funds.ts` (pure): `gasReserveWei(committedCount: number): bigint` (0.05 + 0.001 each); `committedOrders(orders: DepositOrderDoc[], now: number): DepositOrderDoc[]` (2.4: unmined stored payout whatever `reservedUntil` and hold say; or `in_block`, unpaid, not held; or no payout and `reservedUntil` in the future; fronted and not terminal only); `owedWei(orders): bigint` (sum of `vault.received` of fronted orders with a fill in the vault, no payout, settle not `returned`); `pinnedBlock(head: bigint, orders: DepositOrderDoc[], now: number): bigint`; `freeWei(o: { balance: bigint; orders: DepositOrderDoc[]; now: number }): { free: bigint; committed: bigint; owed: bigint; gasReserve: bigint }` with `free = max(0, balance - gasReserve - committed - owed)`.
- Produces `vault.ts`: `class Vault` with deps `{ collections, client: ArcClient, account: HDAccount, config: Pick<Config, "VAULT_FRONTING" | "VAULT_REFUND_EVM" | "VAULT_REFUND_SOLANA" | "VAULT_QUOTE_WINDOW_SECONDS" | "VAULT_SLIPPAGE_BPS" | "VAULT_TARGET_USDC" | "VAULT_LOSS_STOP_USD" | "VAULT_UNFILLED_MINUTES" | "DEPOSIT_MIN_USDC">, logger, now?: () => number }`, and methods `address: Address`, `withLock<T>(fn: () => Promise<T>): Promise<T>`, `funds(timeoutMs?: number): Promise<VaultFunds>` (reads the open orders, pins the block, reads `getBalance({ address, blockNumber })`, times out at 1.5 s by default and rejects with `VaultReadError`), `insertFronted(order: DepositOrderDoc, o: { unsettledLimit: number }): Promise<"inserted" | "short">` (under the lock: counts the account's `created`/`sent` orders and throws `AppError("rate_limited", "Too many deposits are still waiting to be sent. Try again in a few minutes.")` at the limit, reads `funds`, inserts when `usdcOut <= free`, else returns `"short"`; a `VaultReadError` also returns `"short"`), `extendReservation(orderId: ObjectId, until: Date): Promise<void>` and `releaseReservation(orderId: ObjectId): Promise<void>` (both under the lock), `snapshot(): { free: bigint; at: number } | null`.

- [ ] **Step 1: Write the failing tests.**
    - Unit `vault-funds.test.ts`: `"gasReserveWei is 0.05 plus 0.001 per committed order"`; `"a created order is committed until reservedUntil passes, then not"`; `"an in_block unpaid order stays committed after reservedUntil has passed"`; `"a held order with a signed unmined payout stays committed"` and `"a held order with no payout is not committed"`; `"a mined payout is not committed"`; `"a direct order is never committed"`; `"owed sums received over fronted orders with a fill, no payout, settle not returned"` and `"a returned order is not owed"`; `"freeWei clamps at 0 and never goes negative when the balance is under the gas reserve"` (Review Focus 5); `"pinnedBlock is the head when no payout was mined in the last 10 minutes, and the highest minedBlock above the head otherwise"`; `"18-decimal arithmetic: 300.000000000000000001 USDC stays exact"`; `"Mutex runs two callers in order and survives a rejection"`.
    - Integration `vault-funds.test.ts` (Mongo + anvil Arc, a hand-built `Vault`): `"funds reads the balance pinned to a block a mined payout names"` (the fake client's `getBalance` rejects a `blockNumber` it has not reached: `funds` rejects with `VaultReadError`); `"a node one block behind a mined payout does not make free count the spent money"` (a fake client whose unpinned `getBalance` still answers the balance from before the payout and whose pinned one answers the balance after it: `funds` returns the lower one, and the same test without the pin would have returned the higher one); `"funds times out at 1.5 s"` (a client whose `getBalance` never resolves, fake `timeoutMs` 50); `"insertFronted inserts when usdcOut equals free and returns short for one wei more"`; `"two concurrent insertFronted calls that together exceed the vault insert one"`; `"insertFronted throws rate_limited at 5 open created or sent orders of the account and counts expired ones as closed"`; `"the unique sourceTx index refuses a second order with the same hash and accepts many orders with none"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-funds.test.ts test/integration/vault-funds.test.ts`).
- [ ] **Step 3: Implement** the types and indexes (follow the existing `depositOrders.createIndexes` array), `Mutex`, `funds.ts` and `Vault`. `Vault.funds` queries fronted orders with `state` in `created`, `sent`, `in_block`, or a payout in `signed`/`sent`, or a payout `mined` with `paidAt` in the last 10 minutes (the input of `pinnedBlock`), or a fill (`vault.received`) with no payout; it caches `{ free, at }` for `snapshot()`.
- [ ] **Step 4: Run both files, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Add the vault's order fields, reservations, free balance and pinned balance read".

---

### Task 5: The breaker: loss, exposure and drift (spec 7.3)

**Files:**
- Create: `server/src/vault/breaker.ts`
- Modify: `server/src/vault/vault.ts` (adds `breaker()`)
- Test: `server/test/unit/vault-breaker.test.ts`

**Interfaces:**
- Produces: `breakerState(o: { orders: DepositOrderDoc[]; events: VaultEventDoc[]; now: number; lossStopWei: bigint; unfilledMs: number }): { loss: Kind; exposure: Kind; drift: Kind }` with `Kind = { tripped: boolean; amountWei: bigint }`; `Vault.breaker(): Promise<{ loss: Kind; exposure: Kind; drift: Kind; planningStopped: boolean; paymentsStopped: boolean }>` (`planningStopped` is any kind, `paymentsStopped` is exposure or drift); each kind's first trip logs `error` once ("Vault breaker tripped: loss" and so on), and again only after it cleared. `Vault.breaker()` keeps its last answer, and `Vault.lastBreaker(): { planningStopped: boolean; paymentsStopped: boolean } | null` returns it without a read (null before the first evaluation); Task 6's cheap check uses it.
- Decisions (the spec leaves them open, stated so tests pin them): a kind trips at `>= VAULT_LOSS_STOP_USD`; an unpaid order contributes 0 to the loss kind (the vault is out nothing); an order marked `recovered`, `lost` or `returned` leaves the refunded and stale sums; drift is any `drift` event whose `txHash` has no `ack` event, above 0.01 USDC.

- [ ] **Step 1: Write the failing tests** (orders and events built by hand; $5 default = `parseUnits("5", 18)`):
    - Loss: `"per order max(0, paid - received) for orders refilled in the last 24 hours"`; `"a gain on one order does not cancel a loss on another"`; `"a refunded paid order counts at its full payout whatever its size"` (a $6 one trips, a $4 one does not); `"a refunded unpaid order counts 0"`; `"a stale paid order counts until recovered"`; `"a lost order counts its marked amount for 24 hours"`; `"marking a refunded order recovered clears the kind"`; `"slippage of 1% on a $600 order trips it"`.
    - Exposure: `"trips for a paid order still watching or open more than VAULT_UNFILLED_MINUTES after its payout was mined"`; `"does not count a payout mined 9 minutes ago"`; `"clears when settle becomes refilled"`; `"sums several unfilled orders"`.
    - Drift: `"trips on a drift event with no ack"`; `"an ack with the same txHash clears it"`; `"stays tripped across calls (sticky)"`.
    - `"planningStopped is true for any kind; paymentsStopped only for exposure and drift"`; `"Vault.breaker logs once per trip"` (logger spy, two calls).
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/unit/vault-breaker.test.ts`).
- [ ] **Step 3: Implement** the pure function and `Vault.breaker()` (loads fronted orders touched in the last 9 days or with `settle` in `watching`/`open`/`refunded`/`stale`, and all unacked drift events).
- [ ] **Step 4: Run it, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Add the vault breaker with its loss, exposure and drift kinds".

---

### Task 6: Planning a fronted or direct order, the wallet check, and the fake bridge in fronted mode (spec 1.1, 1.2, 10 preview)

**Files:**
- Create: `server/src/vault/source-balance.ts`
- Modify: `server/src/crosschain/orders.ts`, `server/src/crosschain/views.ts`, `server/src/protocol.ts` (`DepositQuoteView.instant?: boolean`, `DepositOrderView.instant?: boolean`; optional so the existing `e2e` literals still type-check), `server/src/vault/vault.ts` (`cheapCheck`, `frontedRequest`, `insertFronted` checks the breaker), `server/src/server.ts`, `server/src/services.ts`, `server/test/support/fake-bridge.ts`, `server/test/support/stack.ts`
- Test: `server/test/integration/vault-planning.test.ts`, `server/test/unit/vault-source-balance.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces `source-balance.ts`: `sourceHolds(deps: { sources: SourceClients; solana: SolanaRpc }, coin: Coin, wallet: string, amount: bigint): Promise<boolean>` (native `getBalance`, token `balanceOf`, Solana `getBalance`/`getTokenBalance`; any read error returns `false`).
- Produces on `Vault`: `cheapCheck(coin: Coin): boolean` (switch on, that chain's refund address set, `breaker` not planning-stopped from the last evaluation, and the snapshot not fresher than 3 s showing `free` at or under `DEPOSIT_MIN_USDC`; a missing or older snapshot passes); `frontedRequest(base: QuoteRequest): QuoteRequest` (recipient = vault, `refundTo` = the chain's refund address, `fronted: { ttlSeconds: VAULT_QUOTE_WINDOW_SECONDS, slippageBps: VAULT_SLIPPAGE_BPS }`); `setFronting(on: boolean): void` (for tests and the e2e backend).
- `Vault.insertFronted` now also checks `breaker()` under the lock after the open-order count (spec 1.2 step 3) and returns `"stopped"` when planning is stopped; its result type is `"inserted" | "short" | "stopped"`, and `#plan` treats everything but `"inserted"` as direct.
- `DepositOrders` deps gain `vault: Vault | null`, `sources: SourceClients`, `minDeposit: bigint`. The count of open orders against `UNSETTLED_LIMIT` that `create` does before quoting stays (it fails fast for every route); `insertFronted` counts again under the lock. `preview` and `create` call one private `#plan(account, wallet, source, units, { reserve })` returning `{ route: "fronted"; quote; expect } | { route: "direct"; quote }`. `Services.vault: Vault`.
- Produces test support: `FakeBridge` quotes with `request.fronted` set return a `relayOrder` (version `"v1"`, both refunds, one payment to `request.recipient`, `calls: []`, `extraData` `RELAY_EXTRA_DATA`, deadline now + 604,800), `minimumOut` = 99% of `usdcOut`, `deadline`, and EVM calldata in the real shapes of 1.3 (native `0x49290c1c` + wallet word + a 32-byte order id; token `0xe8017952` + four words, to `FAKE_BRIDGE_ADDRESS`, which is also `paymentDetails.depository`); `FakeBridge.advance(ref, "filled", { pay, amount })` fills `amount` when given; `FakeBridge.setSourceTxHashes(ref, hashes)` makes `status` list them as `sourceTxHashes`; `FakeBridge.setRate(symbol, rate)` changes the rate later quotes use (the re-quote tests of Task 9 move it down and up). `startStack({ vault: { refundEvm?: Address; refundSolana?: string } })` sets `VAULT_FRONTING=on`, `VAULT_REFUND_EVM` (default a random address), `VAULT_REFUND_SOLANA` (default `Vote111111111111111111111111111111111111111`, a valid 32-byte base58 string), `SOLANA_RPC_URLS` to the fake Solana RPC (so the public-default refusal never fires), and exposes `stack.vaultAddress` and `stack.fundVault(usdc: string)` (`setBalance` to `usdc` plus 0.05 gas reserve). **One bridge, named `relay`.** The server finds a bridge for a status by `provider.name`, and a fronted request asks `tiers: [["relay"]]`; two fake bridges both named `relay` (the EVM one renamed beside the existing Solana one) would send a Solana order's status to the EVM fake, which never issued it. So with the `vault` option `startStack` builds a single `FakeBridge` named `relay` over `ethereum`, `bnb` and `solana`, passes only it to `bridges` (plus CCTP when asked), and sets both `stack.bridge` and `stack.solanaBridge` to it. Without the option nothing changes (`fake` for Ethereum and BNB Chain, `relay` for Solana), so `deposit-orders.test.ts`'s `provider: "fake"` holds. `test/e2e/serve.ts` does the same in Task 19.

- [ ] **Step 1: Write the failing tests.**
    - Unit `vault-source-balance.test.ts`: `"a wallet holding the amount passes, one wei less fails"` (native and token, fake clients); `"a failed read is false"`.
    - Integration `vault-planning.test.ts` (stack with `vault`, each test funds the vault itself):
        - `"preview of an eligible coin says instant and quotes the vault as recipient"` (`quote.instant` true; the fake bridge saw `recipient` = vault and `refundTo` = the owner's address and `fronted.ttlSeconds` 180).
        - `"an order is fronted: route fronted, vault.expect stored, reservation equal to usdcOut, reservedUntil about 60 s out, settle watching, view.instant true"`.
        - `"a deposit equal to the free balance is fronted and one wei short is direct"` (fund to 300 USDC for a 0.1 ETH order, then `free - 1`); `"neither a $5 nor a $5,000 deposit is refused for its size"` (fund 6,000 and place both).
        - `"switch off, no refund address, or a tripped breaker plans direct with the deposit address as recipient and no ttl"`.
        - `"Relay refusing the quote, or a quote failing frontedCheck, plans direct"` (a fake that answers a vault-recipient quote with another recipient; the direct quote follows).
        - `"a quote under DEPOSIT_MIN_USDC plans direct"`.
        - `"a source wallet with a zero balance plans direct and reserves nothing"`; `"a balance read that fails plans direct"`; `"a wallet that holds the amount is fronted"`.
        - `"the vault empty, or under its gas reserve, plans direct without throwing"` (Review Focus 5).
        - `"two concurrent orders that together exceed the vault: one fronted, one direct"`.
        - `"a vault read that times out plans direct"`; `"the lock is not held across the quote: a hung quote for one account does not delay another account's order"`.
        - `"the direct path is unchanged: provider, recipient and ref come from today's tiers"` (existing `deposit-orders.test.ts` stays green with the vault off).
        - `"deposit:order's answer carries the final usdcOut and instant"`.
        - `"reportSource on a fronted order moves reservedUntil to quotedAt + window"`.
        - `"each create logs the account's open reserved total at info"`; `"each fronted quote logs usdcOut - minimumOut at info"` (spec open question 2).
        - `"a breaker that trips between the quote and the insert plans direct and inserts nothing"` (trip the drift kind with a `vaultEvents` row from a hook that runs while the quote is held; the order is direct and no reservation exists).
        - `"with the vault option there is one bridge named relay: an Ethereum, a BNB Chain and a Solana order are all issued by it, and its status answers for each"` (`stack.bridge === stack.solanaBridge`; advancing a Solana order's ref on `stack.bridge` works).
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-source-balance.test.ts test/integration/vault-planning.test.ts`).
- [ ] **Step 3: Implement.** In `server.ts`, move the one line `const sources = ...` above `new DepositOrders(...)` (it is declared after it today) and build `Vault` from `keyring.vault()`, `client`, `collections` and `overrides.now`. `#plan` follows 1.2: cheap check; Relay-only quote (`tiers: [["relay"]]`, `frontedRequest`) in parallel with `sourceHolds`; `frontedCheck` for the `expect`; at `create` under `vault.insertFronted`; on `"short"` or any refusal fall back to today's `#quote`. The order doc gets `route: "fronted"` and a full `vault` (`settle: "watching"`, `quotedAt` = the time the quote request was sent, `reserved` = `usdcOut`, `reservedUntil` = created + 60 s, `expect` with `value` as a decimal string). `reportSource` calls `vault.extendReservation`. `orderView` and `preview` add `instant`.
- [ ] **Step 4: Run the files, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS, including `deposit-orders.test.ts`.
- [ ] **Step 5: Commit** "Plan each order as fronted or direct, checking the source wallet and the vault's free balance".

---

### Task 7: Source matching, the quote window and the re-price rule for Ethereum and BNB Chain (spec 3.2 items 1 and 3, 3.3)

**Files:**
- Create: `server/src/vault/verify.ts`, `server/src/vault/window.ts`
- Test: `server/test/unit/vault-verify.test.ts`

**Interfaces:**
- Produces in `window.ts` (pure): `windowEndSeconds(o: { quotedAt: Date; deadline: number; windowSeconds: number }): number` (`min(quotedAt/1000 + window, deadline)`); `inWindow(blockTimeSeconds: number, endSeconds: number): boolean` (`<=`); `needsReprice(coin: Coin, blockTimeSeconds: number, quotedAt: Date): boolean` (true for ETH, BNB and SOL when the block is later than `quotedAt + 60 s`; never for USDC and USDT); `payAmount(o: { quoted: bigint; fresh: bigint | null; minDeposit: bigint }): { kind: "pay"; amount: bigint } | { kind: "hold"; reason: "late"; note: string }` (`min(quoted, fresh)`; a result under `minDeposit` is a hold with a note naming the dust floor).
- Produces in `verify.ts`: `matchEvm(o: { tx: { from: Address; to: Address | null; input: Hex; value: bigint; chainId?: number }; receipt: { status: "success" | "reverted" }; expect: Extract<VaultExpect, { kind: "evm" }>; wallet: string }): string[]` (the differences; empty means a match); `verifyEvmSource(deps: { sources: SourceClients }, order: DepositOrderDoc, hash: string): Promise<SourceVerdict>` with `SourceVerdict = { kind: "ok"; blockTime: number } | { kind: "wait" } | { kind: "hold"; reason: "mismatch"; differences: string[] }` (a missing transaction or receipt, or an RPC error, is `wait`; a reverted receipt is `hold` too only if it somehow reaches the payer, but the tracker has already failed it).

- [ ] **Step 1: Write the failing tests.**
    - `matchEvm`: `"the stored transaction matches"`; one test each for a wrong `to`, `input`, `value`, sender (differences name the field), `"the sender compare is case-insensitive"`, `"a wrong chain id"`, `"a reverted receipt"`.
    - `windowEndSeconds`/`inWindow`: `"a block exactly at the end is inside, one second past is late"`; `"the Relay deadline earlier than the window wins"`; `"a 180 s window from quotedAt"`.
    - `needsReprice`: `"61 s after quotedAt re-prices ETH, BNB and SOL, 60 s does not"`; `"USDC and USDT are never re-priced"`.
    - `payAmount`: `"a rise pays the quoted amount"`; `"a fall pays the fresh amount"`; `"no fresh quote means the quoted amount when no re-price was needed"`; `"a result under the dust floor is held late and nothing is paid"` (Review Focus 1); `"exactly the dust floor is paid"`.
    - `verifyEvmSource` with fake clients: `"no receipt yet is wait"`; `"an RPC error is wait"`; `"a matching transaction returns the block timestamp"`; `"a mismatch returns the differences"`.
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/unit/vault-verify.test.ts`).
- [ ] **Step 3: Implement** the pure functions and `verifyEvmSource` (`getTransaction`, `getTransactionReceipt`, `getBlock` on `sources[coin.chain]`).
- [ ] **Step 4: Run it, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Match a person's source transaction to the stored one, and decide the window and the re-price".

---

### Task 8: The fronted tracker step for Ethereum and BNB Chain (spec 3.1)

**Files:**
- Create: `server/src/crosschain/fronted-tracker.ts`
- Modify: `server/src/crosschain/tracker.ts` (delegate fronted orders; cadence), `server/src/server.ts` (pass `frontedWindowSeconds` and `vault`); `server/test/support/fake-bridge.ts` needs nothing more (Task 6)
- Test: `server/test/integration/vault-tracker.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7.
- Produces `FrontedFollower` (deps: `collections`, `providers`, `sources`, `solana`, `vault`, `bus`, `logger`, `windowSeconds`, `now`, `announced`; the tracker builds it from its own deps plus `frontedWindowSeconds` and `vault`): `step(order: DepositOrderDoc): Promise<void>` (chain checks, run on the tracker's pass) and `listHashes(): Promise<void>` (the Relay loop: for `created`, `sent` and mismatch-held orders it calls `provider.status({ ref }, null, coin)` with a 3 s timeout and unions `sourceTxHashes` into the order). `OrderTracker` gets `Deps.frontedWindowSeconds` and `Deps.vault` (both optional, so a tracker built without them follows direct orders only) and runs `listHashes` on its own interval (`pollMs`, never awaited by the chain pass). Whenever a hash is stored on an order, from `listHashes` or from the chain step, the follower calls `vault.extendReservation(order._id, quotedAt + window)` (spec 2.4: "and again when the tracker sees a hash from Relay").
- Behaviours: `created`: a listed hash stores the hashes lowercase and moves the order to `sent`; with no hash by `quotedAt + window + 120 s` the order is `expired`. `sent`: reads every known hash's receipt (skipping `vault.rejected`); the first successful receipt moves to `in_block` with `sourceTxHashes` = that hash; every known hash reverted moves to `failed`; none by the deadline above moves to `expired`. `in_block`: untouched, unless held `mismatch` with no payout, when a Relay-listed hash not in `sourceTxHashes` or `vault.rejected` is appended and the order goes back to `sent` with the hold cleared. Never `#checkBridge`: no `bridging`, `refunded` or Relay-driven `failed`. Cadence: pass interval 0 within 2 minutes of `updatedAt`, then 15 s. `UNSETTLED_LIMIT` counting needs no change (expiry removes it within about 5 minutes).

- [ ] **Step 1: Write the failing tests** (stack with `vault`, `ORDER_POLL_MS` 100; a fake clock only through the stack's `now` or a hand-built tracker, see Global Constraints). Every test here funds the vault, opens its order, and then sets the vault's balance to 0 (`stack.chain.client.setBalance`) before the source transaction goes out. The order is therefore fronted, and from Task 9 on the payer waits at `in_block` for lack of money, so these assertions about the tracker still hold with the payer running:
    - `"a fronted order in_block stays in_block when the fake reports filled, then refunded, then failed, then pending"` (the vault is drained, so no payer can pay it, and the fill is advanced with `{ pay: false }` so that it does not refill the vault; assert the state after each) and `"a created order whose status moves past waiting stays created"`.
    - `"a reported hash with a successful receipt moves sent to in_block with that hash"`; `"a reverted receipt moves sent to failed"`; `"every known hash reverted fails it, one successful among them moves it on"`.
    - `"a replaced transaction: the app reports hash A, the fake lists hash B, only B has a receipt: in_block on B"`.
    - `"an unreported transaction: the fake lists the source hash in created: sent, then in_block"`.
    - `"a reported hash Relay never lists is still moved to in_block from the chain check"` (Review Focus 4).
    - `"a hash Relay lists extends the reservation to the end of the quote window"` (the order reported nothing, the fake lists a hash: `vault.reservedUntil` moves from created + 60 s to `quotedAt` + 180 s).
    - `"with no hash by quotedAt + window + 2 minutes a created order is expired and leaves the open count"`; `"a sent order with no receipt by the same time is expired"`; `"an expired order that Relay later lists stays expired"` (the settler holds it in Task 11).
    - `"a mismatch-held order picks up a newly listed hash, clears the hold, and the rejected hash is ignored"`.
    - `"a fronted order reported 90 s after creation is checked on every pass, not every 15 s"` (fake clock, count receipt reads).
    - `"a slow Relay status never delays the chain check"` (the fake's `status` resolves after 5 s; the receipt-driven move still happens within two passes).
    - `"direct orders behave exactly as before"` (the existing `deposit-tracker.test.ts` stays green).
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/integration/vault-tracker.test.ts`).
- [ ] **Step 3: Implement** `FrontedFollower` and the delegation in `OrderTracker.#step` (`order.route === "fronted"`) and `tick` (a fronted order's poll interval comes from `updatedAt`). Moves use the tracker's existing conditional `#move`.
- [ ] **Step 4: Run it, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Follow fronted orders from the chain alone, and never let the bridge's word move one out of in a block".

---

### Task 9: VaultPayer: verify, reserve, sign, send once, credit and deliver (spec 3.2, 3.6, 4 layers 1 to 4, 10 `paying`)

**Files:**
- Create: `server/src/vault/payer.ts`, `server/src/vault/nonce.ts`
- Modify: `server/src/crosschain/views.ts`, `server/src/protocol.ts` (`DepositOrderView.paying?: boolean`, `payAmount?: UsdcAmount | null`, `payTxHash?: Hex | null`, `held?: boolean`; optional like `instant`), `server/src/server.ts` (build, start, stop; `Overrides.vaultBroadcast`), `server/src/services.ts` (`vaultPayer`), `server/test/support/stack.ts` (`vaultBroadcast` option, passed through; `stack.makeVaultPayer(options?: { broadcast?; now?; ownVault?: boolean })`, which builds another `VaultPayer` over the same database and signer (and the server's `Vault`, or with `ownVault` a new one with its own lock, as a restarted process has) so a test can stop the server's payer and start a fresh one, or run two at once)
- Test: `server/test/unit/vault-nonce.test.ts`, `server/test/integration/vault-payer.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 7, 8; `alreadySent`, `refused`, `unreachable` from `payouts.ts`.
- Produces `nonce.ts`: `nonceFloor(o: { rpcCount: number; minedStored: Iterable<number> }): number` (`max(rpcCount, 1 + the highest nonce a stored payout has used and mined)`; a fallback transport can answer `getTransactionCount` from a node behind the one that mined the last payout, and handing out its nonce again would end in "nonce too low" and a parked order, the same reason `Payouts.#nextNonce` also looks at the stored nonces); `lowestFreeNonce(floor: number, held: Iterable<number>): number` (the lowest value at or above `floor` that is not in `held`).
- Produces `VaultPayer` (deps: `collections`, `vault: Vault`, `client: ArcClient`, `urlClients: ArcClient[]` (one client per configured Arc RPC URL, as the watcher has them; Task 10 asks each for a receipt), `signer: HDAccount`, `sources`, `providers`, `deposits: DepositService`, `bus`, `logger`, `windowSeconds`, `minDeposit`, `pollMs?`, `broadcast?`, `now?`) with `start()`, `stop()`, `tick()`. It wakes on `order:updated`. Each pass takes fronted `in_block` orders with no payout and no hold, oldest `vault.verifiedAt` first (orders not yet verified are verified first, in `updatedAt` order), one at a time.
- Per order, in this order: (1) `verifyEvmSource` on `sourceTxHashes.at(-1)`; (2) `updateOne({ _id, "vault.sourceTx": { $in: [null, hash] } }, { $set: { "vault.sourceTx": hash, "vault.verifiedAt": now } })`, a duplicate-key error holds the order `mismatch`; (3) window check, and the re-price for volatile coins (fresh `bestQuote` with `frontedRequest`, `tiers: [["relay"]]`, 3 s), `payAmount`; (4) under `vault.withLock`: read `funds`, require `balance - gasReserve(n) - committed of the orders ahead - owed >= amount` ("ahead" = stored unmined payouts and `in_block` orders with an earlier `verifiedAt`; the order being paid is never subtracted, because its own `in_block` claim is what this step turns into the payout, and the gas reserve counts the orders ahead plus this one), allocate the nonce (`lowestFreeNonce(nonceFloor(...), held)`, where `held` is every stored unmined `payout.nonce` and `payout.lastNonce`, and the `rpcCount` is `client.getTransactionCount({ address })` at `latest`), sign, and store `vault.payout = { nonce, lastNonce: null, rawTx, txHash, to, amount, minedBlock: null, state: "signed" }` with the conditional `findOneAndUpdate({ _id, route: "fronted", "vault.payout": null, "vault.hold": null }, ...)`; (5) broadcast the stored bytes (state `sent`), wait for the receipt, set `state: "mined"`, `minedBlock`, `paidAt`, release the reservation; (6) `deposits.report(accountDoc, txHash)` with the `AccountDoc` read from `collections.accounts` (`DepositService.report` takes the document, not an id; its errors are ignored, the scan credits anyway); (7) once `collections.deposits.findOne({ accountId, txHash })` exists, set the deposit's `origin = { coin, amount, txHash: sourceTx, orderId }` and move the order to `delivered`, emitting `order:updated`. The recipient is the account's current `depositAddress`, read at signing time. A wait (hash not yet on chain, RPC error, vault short) changes nothing and is retried next pass; a short vault logs `error` once an hour naming the order ids and the shortfall.
- `orderView` adds: `held = vault.hold != null`; `paying = payout != null && payout.state !== "failed" && !held`; `payAmount = formatUsdc(payout.amount)` when `paying`; `payTxHash = payout?.txHash ?? null`; the payout store emits `order:updated`.

- [ ] **Step 1: Write the failing tests.**
    - Unit `vault-nonce.test.ts`: `"takes the floor when nothing is held"`; `"skips held nonces"`; `"takes the lowest gap, not highest plus one"` (floor 5, held `{5, 7}` gives 6); `"ignores held nonces below the floor"`; `"nonceFloor is the RPC count when no payout was mined"`; `"a lagging node's lower transaction count does not hand out a nonce a mined payout used"` (`rpcCount` 4, a mined payout with nonce 4: the floor is 5).
    - Integration `vault-payer.test.ts` (stack with `vault`, funded; the test sends the source transaction from an impersonated wallet on the Ethereum anvil with `sourceChain(...).sendTxs`, taking `to`, `data`, `value` from the `deposit:order` ack, and reports it with `deposit:source`):
        - `"the vault pays the deposit address once, the account is credited exactly usdcOut once, and the order is delivered with origin set"`.
        - `"the payout is stored (state signed, rawTx) before it is broadcast"` (a `vaultBroadcast` that records the order document first).
        - `"the order is paid from the first block: the payout is stored before the fake bridge fills"` (never advance the fake).
        - `"a fill to the vault credits nobody: no deposit document and no balance change"` (advance `filled` afterwards; the vault balance rises).
        - `"a coin with 6 decimals and one with 18 decimals both pay usdcOut exactly"` (ethereum:USDC and bnb:USDT, Review Focus 2).
        - `"a re-priced payout under the dust floor is held late and nothing is sent"` (move `vault.quotedAt` back 61 s, make the fake's re-quote answer below `DEPOSIT_MIN_USDC`; Review Focus 1).
        - `"a volatile coin landing 61 s after quotedAt is paid min(quoted, fresh); a rise pays the quoted amount; a stablecoin is not re-quoted; a failed re-quote waits and is retried"`.
        - `"a block 181 s after quotedAt is held late; 180 s is paid"` (move `quotedAt`).
        - `"a transaction with the wrong to, data, value or sender is held mismatch with no payout and an error log"`; `"one that reverts is failed by the tracker and never reaches the payer"`.
        - `"one transaction cited by two orders pays one: the second is held mismatch"`; `"the same calldata sent twice pays once"` (second hash is held, the settler's log is Task 11).
        - `"an in_block order whose reservation lapsed is still committed and a new order is planned direct"`; `"the vault short at payout time waits at the head of the queue, is paid when refilled, oldest first, and a later order cannot jump it"`; `"a short vault logs the shortfall error once an hour"` (fake clock).
        - `"an account merge between signing and credit: the payout to the old address is still credited to the merged account"`.
        - `"the sweeper leaves the vault's balance alone"` (the sweeper runs on every credit, so after a paid and credited order it has moved the payout from the deposit address to the treasury; assert the treasury gained it and the vault's balance is exactly what it held less the payout, with the vault's transaction count equal to the number of payouts).
        - `"two payers racing for one order store one payout and move the vault's money once"` (Review Focus 6: the server's payer is stopped; two `stack.makeVaultPayer({ ownVault: true })` payers, sharing no lock, both `tick()` at once on one `in_block` order; exactly one stored payout, one transfer from the vault on chain, one credit; the loser signed nothing it stored and broadcast nothing).
        - `"the payer's report and the scan credit the transfer once"` (Review Focus 6: the payer calls `deposits.report` while the watcher scans the same block; one `deposits` document, one `ledger` entry, balance up by `usdcOut` exactly).
        - `"a vault holding exactly the amount plus the gas reserve pays, and one wei less waits"` (0.05 + 0.001 USDC for the one order; pins that the order does not count itself twice).
        - `"two in_block orders and a vault that covers one: one is paid, the other waits at the head of the queue"` (Review Focus 7: fund the vault to exactly the larger order plus its gas reserve; two payer passes at once; exactly one stored payout and `free` never negative; the other is paid after `fundVault` adds money).
        - `"a new order and a payout racing for the last of the free balance: only one gets it"` (Review Focus 7: the vault covers one `usdcOut`; an `in_block` order and a `create` for the same size are started together with `Promise.all`, once with the payout first in the lock and once with the insert first, by holding `vault.withLock` open from the test; in each run exactly one of "payout stored" and "new order fronted" happens, the other is waiting or direct).
        - `"turning VAULT_FRONTING off with a fronted order pending still pays it"` (`setFronting(false)`).
        - Four tests, one per crash window of spec section 4 (Review Focus 8). In each, the server's payer is stopped at the named point and a fresh `stack.makeVaultPayer()` is started over the same database; each ends by asserting one transfer from the vault on chain, one `deposits` document, one `ledger` entry and the order `delivered`:
            - `"restart before the raw transaction is stored"` (the server's payer is stopped before the order reaches `in_block`: nothing on chain, no stored payout; the fresh payer signs once).
            - `"restart after the raw transaction is stored, before it is broadcast"` (`vaultBroadcast` throws before sending; the fresh payer sends the stored bytes, `rawTx` unchanged).
            - `"restart after the node has the transaction but before the payer recorded it mined"` (`vaultBroadcast` sends the bytes for real and then throws, as a crash after the send would; the payout is still `signed`/`sent` in the database while the transfer is mined; the fresh payer re-sends the same bytes, gets "already known" or "nonce too low", finds the receipt, records `mined` and does not park the order).
            - `"restart after the receipt, before the credit"` (the watcher is stopped and the payer's `report` is made to fail, so the transfer is mined and uncredited when the payer stops; the watcher is restarted, credits it once, and the fresh payer links it and delivers).
        - `"paying is true on the view once the payout is stored and false when held"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-nonce.test.ts test/integration/vault-payer.test.ts`).
- [ ] **Step 3: Implement** the payer, signing like `Payouts.#sign` (viem `signTransaction`, `type: "eip1559"`, `chainId: client.chain.id`, `to` the deposit address, `value` the amount, gas 21,000, fees per Global Constraints). Hashes are `keccak256(rawTx)`, lowercase. In `server.ts` build the payer with `urlClients: config.ARC_RPC_URLS.map((url) => createArcClient([url]))`, `broadcast: overrides.vaultBroadcast` and `now: overrides.now`, put it in `Services.vaultPayer`, start it after `tracker.start()` and stop it before `tracker.stop()`.
- [ ] **Step 4: Run both files, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Pay a verified source transaction from the vault once, and deliver the order when the credit lands".

---

### Task 10: VaultPayer: failed payouts, holds, the nonce rule and the owner's release (spec 3.4, 3.5, 4 failures, 6.3 `pay` side)

**Files:**
- Modify: `server/src/vault/payer.ts`, `server/src/vault/nonce.ts`
- Test: `server/test/integration/vault-payer-failures.test.ts`

**Interfaces:**
- Consumes: Task 9.
- Behaviours added to `VaultPayer`:
    - *Refused* (`refused()` and no receipt for the stored hash on any of `urlClients`, each asked on its own, so a lagging fallback node cannot make a mined payout look absent): conditional clear of `vault.payout` (on the stored hash), `payout.lastNonce` kept, `attempts` +1, `error` log, retry after 60 s on the same nonce, maxFee bumped 25% per attempt; after 5 attempts the order is held `payout_failed`. If the nonce is still unmined and later payouts wait behind it, send a zero-value self-transfer on that nonce, recorded in `vaultEvents` (`kind: "filler"`, `nonce`, `txHash`) before it is sent.
    - *Reverted receipt:* `payout.state: "failed"`, held `payout_failed`, `error` log.
    - *RPC unreachable or receipt late:* nothing changes; the same bytes are re-sent.
    - *Nonce too low with no receipt* (`/nonce too low/` and `getTransactionReceipt` null): held `payout_unclear`, `error` log with the stored hash and nonce, never re-signed.
    - *Holds* set `vault.hold = { reason, at, note }`, log `error` once with order id, account, hash and what differed, release the reservation unless a stored payout is unmined, and add a `mismatch` hash to `vault.rejected`.
    - *Release:* an order with `vault.release` set, no hold and no payout (or a `failed` payout) is paid `release.amount` without the source match, the window or the re-price, through the same stored-before-sent path; the nonce allocator (Task 9) gives a fresh nonce. The payer's query for these is any fronted order with a `release` and no hold, **whatever its state** (a `late` order that was `expired` or `failed` when it was held, an `in_block` or `sent` one), because the owner's release is the only thing that moves such an order; on delivery the payer moves it to `delivered` from the state it read, with the same conditional write the tracker uses.
    - The nonce allocator's `held` set is every unmined stored `payout.nonce`, every `payout.lastNonce` of a cleared attempt, and every `vaultEvents` filler with `nonce` at or above the floor of Task 9 (`nonceFloor`).

- [ ] **Step 1: Write the failing tests** (stack with `vault`; `vaultBroadcast` and the Arc RPC fake from `test/support/arc-emulator.ts` for refusals):
    - `"a refused send is cleared, kept on its nonce, and retried and then paid"` (fake clock past the 60 s).
    - `"five refusals hold the order payout_failed"`.
    - `"two overlapping payouts where the first is refused: the retry reuses the first's nonce and the second is neither skipped nor stuck"`.
    - `"a payout held payout_failed with a later payout stored gets its nonce filled by a zero-value self-transfer recorded in vaultEvents before it is sent"`.
    - `"nonce too low with no receipt parks the order payout_unclear and nothing is signed a second time even when the receipt RPC answers late"` (Review Focus 6: after the park, a second and a third pass and a late receipt answer leave one stored `rawTx` and no new `vaultEvents` row).
    - `"nonce too low with a receipt on one RPC URL and none on the others is a mined payout, not a parked one"` (Review Focus 8: three `urlClients`, only the second has the receipt).
    - `"a reverted payout is held payout_failed with state failed"` (a plain native transfer to an ordinary address does not revert, and one the vault can't fund is refused, not reverted; so the test puts reverting code, `0x60006000fd`, at the account's deposit address with `setCode` before the payout, which gives a mined receipt with status `reverted`).
    - `"an RPC that cannot be reached changes nothing and the same bytes are sent next pass"`.
    - `"a held order keeps its unmined payout committed and releases a reservation with no payout"`.
    - `"a pay release on a late order pays release.amount once, delivers the order, and skips the window check"`; `"a release on a parked payout_unclear order signs on a fresh nonce"`; `"a release amount above usdcOut on a payout hold is refused by the payer"` (logged, held again).
    - `"the exposure and drift breakers stop payments: an in_block order waits at Confirming, then is paid once cleared; the loss breaker alone does not stop them"` (insert a `drift` event / an unfilled paid order).
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/integration/vault-payer-failures.test.ts`).
- [ ] **Step 3: Implement** the failure paths, holds, release and the allocator input.
- [ ] **Step 4: Run it and `vault-payer.test.ts`, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Retry refused vault payouts on the same nonce, hold the ones nothing can settle, and pay the owner's releases".

---

### Task 11: VaultSettler: follow every fronted order to its fill or refund (spec 5, 3.4 last paragraphs, 6.1)

**Files:**
- Create: `server/src/vault/settler.ts`
- Modify: `server/src/server.ts`, `server/src/services.ts` (`vaultSettler`)
- Test: `server/test/integration/vault-settler.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9; `transfersInReceipt` from `server/src/chain/native-transfers.ts`.
- Produces `VaultSettler` (deps: `collections`, `providers`, `client: ArcClient`, `vault: Vault`, `bus`, `logger`, `tickMs?`, `now?`) with `start()`, `stop()`, `tick()`. It follows fronted orders with a Relay `ref` and `settle` of `watching` or `open` until `deadline + 86,400`, at the cadence in Global Constraints. Transitions: a listed deposit (`sourceTxHashes`) sets `open`, and holds an `expired` or `failed` order with no payout as `late` with an `error` log; more than one listed hash logs `error` "More than one deposit for an order"; `filled` with a fill hash reads the Arc receipt, takes the transfer to the vault between `minimumOut` and 1.05 x `usdcOut` nearest to `usdcOut`, stores `received`, `refillTx`, `refilledAt`, sets `refilled` and logs `info` the gap `paid - received`; no such transfer logs `error` "Relay says filled, nothing reached the vault" and stays `open`; filled with no payout logs `error` "Unpaid fronted order: fill reached the vault" and holds the order if it is not already; `refunded` sets `refunded` with an `error` log (unpaid: "Unpaid fronted order: refunded to the owner"); `failure` sets `failed`; paid and unsettled at the end sets `stale`; held with no deposit ever listed by the end sets `none` and moves the order to `failed`. A fill that arrives before the payout needs no code.

- [ ] **Step 1: Write the failing tests** (stack with `vault`; the fake's `advance` drives Relay):
    - `"a fill refills the vault: settle refilled, received and refillTx stored, the account is credited exactly the quoted output"`.
    - `"a fill 2% under the quote records the gap at info"` (`advance(ref, "filled", { amount })`).
    - `"a fill to the vault credits nobody"` (cross-check with Task 9).
    - `"filled with nothing in the receipt for the vault logs 'Relay says filled, nothing reached the vault' and stays open"` (`pay: false`).
    - `"a refund after the payout: settle refunded, an error log, the vault balance unchanged, the account balance unchanged"` (Review Focus 9; the error message carries the order, amount, coin and refund address; no second transfer leaves the vault and the account is never debited).
    - `"a refund that arrives before the payout: the person is still paid, and settle becomes refunded"` (drain the vault so the order waits at `in_block`, advance the fake to `refunded`, refill the vault: one payout, `delivered`, an `error` log; spec 6.1 row "Bridge refunds before the payout").
    - `"a refunded paid order above the loss threshold stops new fronting and clears when marked recovered"` (Review Focus 9: an order of 0.01 ETH, $30 at the fake's rate, against the default $5 threshold; afterwards `vault.breaker().planningStopped` is true and a new order is planned direct; setting `vault.settle` to `recovered` in the database lets the next order be fronted again; a refunded 0.001 ETH order, $3, trips nothing).
    - `"a failure stage sets failed, kept apart from refunded"`.
    - `"a paid order Relay never settles becomes stale after the deadline plus a day"` (fake clock) `"and an order Relay never saw becomes none and failed"`.
    - `"a late transaction: expired order, Relay later lists the deposit: held late, error logged, nothing paid; the fake then fills to the vault: 'Unpaid fronted order: fill reached the vault' with received"`.
    - `"two same-sized orders in one fill are logged, not crashed"` (the fill hash is shared; the nearest-to-quote rule assigns; no exception).
    - `"the same calldata sent twice lists two hashes: one payout and the 'More than one deposit' error"`.
    - `"6- and 18-decimal coins store received in Arc wei"` (Review Focus 2).
    - `"the cadence: 15 s in the first 10 minutes, 10 minutes while watching afterwards, one minute once open, hourly after 24 hours"` (count `status` calls over a fake clock).
- [ ] **Step 2: Run it; expect FAIL** (`cd server && npx vitest run test/integration/vault-settler.test.ts`).
- [ ] **Step 3: Implement** the settler.
- [ ] **Step 4: Run it, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Follow every fronted order to its fill or refund, and make an unpaid or refunded one loud".

---

### Task 12: VaultMonitor: the low warning, the drift scan and the snapshot (spec 5 last two paragraphs, 7.3 drift)

**Files:**
- Create: `server/src/vault/monitor.ts`, `server/src/vault/drift.ts`
- Modify: `server/src/chain/native-transfers.ts` (adds `findTransfersFrom`), `server/src/server.ts`, `server/src/services.ts` (`vaultMonitor`)
- Test: `server/test/integration/vault-monitor.test.ts`, `server/test/unit/vault-drift.test.ts`, `server/test/unit/native-transfers.test.ts` (new `findTransfersFrom` cases beside its `findTransfersTo` ones), `server/test/integration/perp-reconciler.test.ts` (one added test)

**Interfaces:**
- Produces `findTransfersFrom(client: ArcClient, sender: Address, fromBlock: number, toBlock: number): Promise<NativeTransfer[]>`: the same range-halving as `findTransfersTo`, filtering `args: { from: sender }`. `queryRange` hard-codes `args: to ? { to } : undefined` today and narrows a too-big single block by recipient, which a sender query has nothing to narrow by; so give `queryRange` a `filter: { to?: Address[]; from?: Address }` parameter (the existing callers pass `{ to }` and behave as now, and `native-transfers.test.ts` stays green), and a single block that is still too much for a `from` query rethrows.
- Produces `drift.ts`: `explainsOutflow(o: { transfer: NativeTransfer; payouts: { txHash: string; to: string[]; amount: bigint }[]; eventHashes: Set<string> }): boolean` (the hash is a stored payout whose `to` is one of the account's current or former deposit addresses and whose amount equals the log's value, or it is in `vaultEvents`).
- Produces `VaultMonitor` (deps: `collections`, `client`, `vault`, `logger`, `intervalMs?` (60,000), `lagBlocks?` (3), `now?`) with `start()`, `stop()`, `tick()`. Each tick: (a) reads `funds`, logs `error` "Vault is low" when `free` is under 25% of `VAULT_TARGET_USDC` (again hourly while low) and `info` when it recovers, and updates `vault.snapshot()`; (b) the drift scan from the `cursors` document `_id: "vault-drift"` (starting at the head the first time, staying `lagBlocks` behind): each unexplained outflow above 0.01 USDC writes a `drift` `vaultEvents` row and an `error` log with hash, amount and `to`; (c) evaluates `vault.breaker()` so its trip logs fire. The Solana refund-address hourly check is added in Task 15.

- [ ] **Step 1: Write the failing tests.**
    - Unit `vault-drift.test.ts`: `"a stored payout to the deposit address for its amount is explained"`; `"to a former deposit address is explained"`; `"a second transfer for one order (a hash no payout has) is not"`; `"a wrong to, and a wrong amount, are not"`; `"a hash in vaultEvents (a withdrawal or a filler) is"`; `"an outflow of 0.01 USDC or less is ignored"`.
    - Integration `vault-monitor.test.ts`: `"a log at the 25% crossing and one an hour after, then an info on recovery"` (fake clock); `"a stranger's transfer out of the vault writes a drift event, trips the breaker and stops payments"`; `"a recorded withdrawal and a nonce filler do not"`; `"the scan resumes from the stored cursor after a restart and never re-reads old blocks"`; `"the first run starts at the head"`; `"findTransfersFrom returns only transfers from the vault"` and `"findTransfersFrom halves a range its client refuses as too big"` (both in `native-transfers.test.ts`, with the fake client that file already uses for `findTransfersTo`; the third case there, a single block still too big, rethrows); `"the snapshot is refreshed by a tick and the cheap check ignores it once older than 3 s"`.
    - `perp-reconciler.test.ts`: `"the vault's balance is not counted in arcHoldings"` (fund the vault, assert `arcHoldings` is unchanged).
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-drift.test.ts test/unit/native-transfers.test.ts test/integration/vault-monitor.test.ts test/integration/perp-reconciler.test.ts`).
- [ ] **Step 3: Implement** the three pieces and wire the monitor in `server.ts`.
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Warn when the vault runs low and catch any outflow no payout explains".

---

### Checkpoint before Task 13 (spec 15 step 1, 14.9): the direct-path medians

Spec 15 step 1 says the medians of the direct path go to the owner **before the Solana parts of step 4 are built**; the owner's decision to include Solana stands, and there is no code gate. Task 1's log line is deployable alone, and an executor cannot send real deposits. So, when Task 12 is committed and before starting Task 13, the executor writes to the owner, in its report, that: (1) Task 1's `"Bridged deposit credited"` line is what live check 14's direct half reads (`blockToCreditMs` per chain, a few dozen real deposits with `VAULT_FRONTING=off`); (2) Tasks 13 to 15 are purely additive (until Task 13 lands, a Solana quote fails `frontedCheck` and the order is direct), so the owner's medians can only remove them; (3) it will go on to Task 13 unless the owner says to stop. If the owner has already given numbers, they go in that report. This is a report, not a wait for a reply.

---

### Task 13: Solana: the fronted quote check, `getTransaction` and `getBlockHeight` (spec 14.3, 14.5 reads, 14.8)

**Files:**
- Modify: `server/src/crosschain/fronted-quote.ts`, `server/src/crosschain/solana.ts`, `server/src/crosschain/tracker.ts` (Solana block time for the Task 1 log line), `server/test/support/fake-solana-rpc.ts`, `server/test/support/fake-bridge.ts`
- Test: `server/test/unit/crosschain-fronted-solana.test.ts`, `server/test/integration/crosschain-solana.test.ts`

**Interfaces:**
- Produces on `SolanaRpc`: `hasTokenAccount(owner: string, mint: string): Promise<boolean>` (`getTokenAccountsByOwner` with a non-empty answer: true for an account holding zero, which `getTokenBalance` cannot tell from none; Task 15's refund-address check and `vaultStatus` use it); `getBlockHeight(): Promise<number>`; `getTransaction(signature: string): Promise<SolanaTransaction | null>` with `SolanaTransaction = { signatures: string[]; err: unknown; blockTime: number | null; keys: string[]; signers: string[]; instructions: { programId: string; keys: string[]; data: Hex }[] }`. `keys` is the static keys, then `meta.loadedAddresses.writable`, then `.readonly`; `signers` is the first `message.header.numRequiredSignatures` keys; instruction data is converted from base58 to lowercase hex; the call uses `{ commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }`; a null result is `null`.
- `frontedCheck` Solana branch (14.3), returning `{ ok: true, expect: { kind: "solana", wallet, programId, keys, data } }`: exactly one top-level depository instruction; its `programId` equals `paymentDetails.depository`; `paymentDetails.chainId` is `"solana"` and its `currency` is the coin's mint (the System id for SOL); the instruction's u64 amount at data bytes 8 to 16 equals the request amount, as do `payment.amount` and `paymentDetails.amount`; the last 32 bytes of the data equal `orderId`; the source-chain refund entry is `chainId: "solana"` with `recipient` exactly `request.refundTo` and the input's currency; the Arc refund and every payment name the vault; `calls` is empty. `checkQuote`'s Solana base checks run first.
- Fake RPC controls: `setTransaction(signature, tx)`, `setBlockHeight(n)`, `rejectBadSignature(signature)` (any `getSignatureStatuses` batch containing it answers a JSON-RPC error `Invalid param: WrongSize`). `FakeBridge` Solana fronted quotes carry a `relayOrder` whose `orderId` is the last 32 bytes of the instruction data.

- [ ] **Step 1: Write the failing tests.**
    - `crosschain-fronted-solana.test.ts` (fixtures of Task 2, `ALLOWED` programs): `"both recorded Solana bodies pass for a fronted request"` (`expect.keys` has 5 keys for SOL and 10 for USDC, `expect.data` 48 bytes); then dropped: `"a Solana refund recipient that is another address"` (and `"differing only in case"`); `"an Arc refund that is not the vault"`; `"a payment recipient that is not the vault"`; `"non-empty calls"`; `"protocol.v2 missing or another version"`; `"instruction data not ending with the order id"`; `"a programId that is not paymentDetails.depository"`; `"two depository instructions"`; `"an amount that is not the request's, in the instruction, payment.amount or paymentDetails.amount"` (a deposit smaller than requested, which the old ceiling check accepts); `"the fronted request body has includeComputeUnitLimit, ttl, slippageTolerance and refundTo the owner's Solana address"`.
    - `crosschain-solana.test.ts` (fake RPC): `"hasTokenAccount is true for a token account holding zero and false for an owner with none"`; `"getBlockHeight returns the height"`; `"getTransaction resolves static and loaded keys in order and marks the signers"`; `"getTransaction converts base58 instruction data to hex"`; `"getTransaction returns null for an unknown signature and keeps blockTime null"`; `"a second URL is tried when the first fails"`.
    - `deposit-tracker.test.ts` (one more): `"a Solana delivery logs the block time to credit time"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/crosschain-fronted-solana.test.ts test/integration/crosschain-solana.test.ts`).
- [ ] **Step 3: Implement** the Solana check, the two RPC methods (through the existing multi-URL `call`), the fakes and the log line.
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Check fronted Solana quotes against Relay's order, and read Solana transactions and block heights".

---

### Task 14: Solana: signature tracking, the order id on the blockhash and the dropped-transaction fast fail (spec 14.4)

**Files:**
- Modify: `server/src/crosschain/fronted-tracker.ts`, `server/src/crosschain/orders.ts` (`blockhashFor`), `server/src/validation.ts`, `server/src/protocol.ts` (`solana:blockhash` payload `{ orderId?: string }`), `server/src/socket/sockets.ts`
- Test: `server/test/integration/vault-tracker-solana.test.ts`, `server/test/integration/socket.test.ts`, `server/test/unit/validation.test.ts`

**Interfaces:**
- Produces `DepositOrders.blockhashFor(account, orderId?: string): Promise<{ blockhash: string; lastValidBlockHeight: number }>`: reads `getLatestBlockhash`, and for a fronted Solana order of that account stores `vault.lastValidBlockHeight`.
- Produces `decodeSignature(value: string): boolean` (base58 that decodes to 64 bytes) in `validation.ts`; `reportSource` refuses a Solana signature that fails it with `bad_request`; a Relay-listed one that fails is ignored and logged.
- The follower's `sent` step for Solana: one batched `getSignatureStatuses` per pass over every known signature of every `sent` Solana order in chunks of at most 256; a chunk the node rejects is bisected until the offending signature is marked bad on its order (`vault.rejected`) and the rest are read; `confirmed` or `finalized` with no error is `in_block` with `sourceTxHashes` set to that signature (as given, not lowercased); every known signature errored is `failed`; `processed` or unknown waits; `getBlockHeight` is read at most once per pass, only while a `sent` order has no status for any signature, and past `vault.lastValidBlockHeight` with no status the order is `failed` at once.

- [ ] **Step 1: Write the failing tests** (stack with `vault`, `SOLANA_DEPOSITS=on`, fake Solana RPC):
    - `"a confirmed signature moves sent to in_block with the signature as given"`; `"a processed signature waits"`; `"an errored signature fails the order"`; `"two signatures for one order: the confirmed one wins"`.
    - `"an unreported signature listed in the fake's inTxHashes is found: created, sent, in_block"`; `"a Relay-listed junk entry is ignored and logged"`.
    - `"reportSource refuses a base58 string that does not decode to 64 bytes"`.
    - `"a fake RPC that rejects any batch containing a bad entry is bisected and the other orders in the batch are read"` (three orders, one bad signature; the bad one is marked, the others move on; assert the fake's request count stays under 12).
    - `"an expired blockhash with no status fails the order at once, and a status keeps it"`; `"getBlockHeight is called at most once per pass"`.
    - `"solana:blockhash with an order id stores lastValidBlockHeight on that order and answers the blockhash; without one it still answers"`; `"another account's order id is ignored"`; `"the rate limit of 30 a minute still holds"`.
    - `"a throttled RPC delays the move and pays nothing early"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/integration/vault-tracker-solana.test.ts test/integration/socket.test.ts test/unit/validation.test.ts`).
- [ ] **Step 3: Implement** the batching with a small `readStatuses(rpc, signatures, onBad)` helper in `fronted-tracker.ts` and the socket change: the handler parses its payload with a new `solanaBlockhash` schema in `validation.ts` (`orderId` optional, the 24-hex shape of `sourceReport.shape.orderId`; an old client's `{}` still parses), keeps `solanaOpen` and the 30-a-minute limit, and returns `services.orders.blockhashFor(await boundAccount(socket), input.orderId)` instead of calling `services.solana.getLatestBlockhash()` directly. The `ClientToServerEvents` payload type changes from `Record<string, never>` to `{ orderId?: string }`.
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Track fronted Solana deposits by signature, and fail a dropped one as soon as its blockhash expires".

---

### Task 15: Solana: the payer's instruction match, the refund-address check and the Solana flows (spec 14.5, 14.6)

**Files:**
- Modify: `server/src/vault/verify.ts`, `server/src/vault/payer.ts`, `server/src/vault/monitor.ts`, `server/src/vault/vault.ts` (Solana USDC refund-address state in `cheapCheck`)
- Test: `server/test/unit/vault-verify-solana.test.ts`, `server/test/integration/vault-solana.test.ts`

**Interfaces:**
- Produces `matchSolana(o: { tx: SolanaTransaction; signature: string; expect: Extract<VaultExpect, { kind: "solana" }>; wallet: string }): string[]` and `verifySolanaSource(deps: { solana: SolanaRpc }, order, signature): Promise<SourceVerdict>`: `err` null; first signature equals the stored one; key 0 is `order.wallet`; exactly one top-level instruction for `expect.programId` or with `expect.keys`; its keys equal `expect.keys` as public keys in order; its data equals `expect.data`; its `keys[1]` is one of `tx.signers`. A null transaction, an RPC error or a null `blockTime` is `wait`.
- The payer picks `verifyEvmSource` or `verifySolanaSource` by the coin's chain; the window uses `blockTime`; the re-price applies to SOL.
- `VaultMonitor` checks the Solana refund address hourly (`getAccountInfo` System-owned, which is owner `11111111111111111111111111111111`, and `hasTokenAccount(address, USDC mint)` from Task 13; `getTokenBalance` cannot show that an account exists): while it fails, `Vault.cheapCheck` returns false for `solana:USDC` and `error` is logged; it also runs once at startup. Until the first check has finished `cheapCheck` returns false for `solana:USDC` (fail closed); a Solana SOL order is not affected by this check. `Vault` keeps the answer (`setSolanaRefundOk(boolean)`, read by `cheapCheck`).

- [ ] **Step 1: Write the failing tests.**
    - Unit: `"the right transaction matches, keys from static and from loadedAddresses"`; one test each for `"an error set"`, `"another fee payer"`, `"no depository instruction"`, `"the instruction only as an inner instruction (not in the top-level list)"`, `"one key swapped"`, `"data differing in the amount"`, `"data differing in the order id"`, `"a second depository instruction"`, `"keys[1] not a signer"`; `"extra instructions around the right one are accepted"`; `"keys compare by public key only, not by flags"`; `"a null blockTime waits"`; `"the window edge: blockTime at the end is inside, one second past is late"`.
    - Integration `vault-solana.test.ts` (stack with `vault`, `SOLANA_DEPOSITS=on`): `"a SOL and a USDC order are fronted, paid once after confirmed, credited once and delivered"`; `"a processed signature waits"`; `"an unreported signature is found and paid"`; `"two signatures for one order pay once and log the double send"`; `"a late block time holds the order late"`; `"a landed transaction that differs from the quote is held mismatch and nothing moves"` (Review Focus 10: one run each for a different amount, a different order id, one key swapped and another fee payer; each ends with no stored payout, no `deposits` document, the vault's balance unchanged, `hold.reason` `mismatch`, an `error` log naming the differences, and the reservation released); `"the restart table of Task 9 holds with a Solana order"`; `"a throttled getTransaction delays the payout and pays nothing early"`; `"with SOLANA_DEPOSITS off nothing Solana is fronted"`; `"the existing crosschain-solana suites pass unchanged with fronting off"`; `"a refund address that is a program account, or holds no USDC token account, plans Solana USDC direct and logs error; SOL is unaffected"` (the test sets the fake RPC's `setAccount` and `setTokenBalance` for `stack`'s `VAULT_REFUND_SOLANA` and calls the monitor's `tick()` before it expects a fronted Solana USDC order; a token account holding zero counts as one); `"until the first refund-address check has run, Solana USDC is planned direct"`; `"the hourly check runs at startup and every hour"` (fake clock).
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-verify-solana.test.ts test/integration/vault-solana.test.ts`).
- [ ] **Step 3: Implement** the match, the verifier selection and the monitor check.
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Pay fronted Solana deposits only against the exact depository instruction, and keep an eye on the refund address".

---

### Task 16: Relay request detail and the request-list guard (spec 11)

**Files:**
- Modify: `server/src/crosschain/providers/relay.ts`
- Test: `server/test/unit/crosschain-relay.test.ts`, `server/test/unit/relay-retired-path.test.ts` (new)

**Interfaces:**
- Produces `export const REQUESTS_V3_PATH = "/requests/v3"` and, on the object `createRelay` returns (its type becomes `BridgeProvider & { requestDetail(ref: string): Promise<{ status: string; refundTo: string | null; refundTxHash: string | null; raw: unknown }> }`), `requestDetail`: `GET ${baseUrl}${REQUESTS_V3_PATH}?term=<ref>` with `x-api-key`, throwing `AppError("unavailable", "RELAY_API_KEY is required for request details.")` when no key is configured; it takes `requests[0]` and finds `refundTo` and `refundTxHash` by key name anywhere in that object (the v3 refund location is unverified, open question 8), returning the whole object as `raw`.

- [ ] **Step 1: Write the failing tests.**
    - `crosschain-relay.test.ts`: `"requestDetail builds its URL from REQUESTS_V3_PATH with term and the x-api-key header"`; `"requestDetail finds a nested refundTxHash and refundTo and returns raw"`; `"without a key it throws unavailable and makes no request"`; `"an empty requests list is a not-found error"`.
    - `relay-retired-path.test.ts`: `"no file under server/src or server/scripts contains the retired request-list path, comments included"` (read every `.ts` file recursively; the needle is assembled as `"requests" + "/v2"` so this file never matches itself, and it lives in `test/`, outside the scan); `"REQUESTS_V3_PATH is exactly /requests/v3"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/crosschain-relay.test.ts test/unit/relay-retired-path.test.ts`).
- [ ] **Step 3: Implement** `requestDetail` and the constant. Any comment about the retirement says "the old request list".
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Add Relay's v3 request detail for the operator, and a test that keeps the retired request-list path out of the code".

---

### Task 17: The operator's `vault.ts` and its guarded commands (spec 6.2, 6.3, 5 drift acknowledgements)

**Files:**
- Create: `server/src/vault/ops.ts`, `server/scripts/vault.ts`
- Modify: `server/README.md` (an "Instant credit (the vault)" section), `server/.env.example` (a line per command's needs)
- Test: `server/test/unit/vault-script.test.ts`, `server/test/integration/vault-ops.test.ts`

**Interfaces:**
- Produces in `ops.ts` (all take `{ collections, client, vault, now? }` and return plain data; the script only parses arguments and prints):
    - `vaultStatus(): Promise<{ address; balance; reserved; free; owed; loss24h; settings; refund: { evm; solana: { address; systemOwned; hasUsdcAccount } | null }; bySettle: Record<string, number>; byHold: Record<string, number> }>` (`hasUsdcAccount` from `SolanaRpc.hasTokenAccount`).
    - `openOrders(): Promise<{ unsettled: OrderRow[]; held: OrderRow[] }>` (age, coin, amount, bridge, request id, refund address, hold reason).
    - `refundedOrders(relay?: { requestDetail }): Promise<(OrderRow & { detail?: unknown })[]>`.
    - `settleOrder(id: string, outcome: "recovered" | "lost" | "returned", o: { amount?: bigint; note?: string }): Promise<void>` (allowed from `refunded`, `stale`, `open`, and for `returned` only an unpaid order; `lost` records `vault.lost = { amount, at }` defaulting to the payout less anything recovered).
    - `payInfo(id: string): Promise<{ storedHash: Hex | null; storedNonce: number | null; vaultNonce: number; depositAddressReceived: boolean; credited: boolean }>` (what spec 6.3 says `pay` prints first: the stored hash and nonce, the vault's transaction count, whether the deposit address received the transfer, and whether a credited deposit carries that hash; the script prints it before it plans or writes).
    - `planPay(order, o: { amount?: bigint; credited: boolean }): { ok: true; amountWei: bigint } | { ok: false; reason: string }` and `payOrder(id, o: { amount?: bigint; note?: string }): Promise<void>`: writes `vault.release = { amount, note, at }` and clears the hold; refuses unless the order is fronted, held, and has no payout or one `failed` or parked with no receipt; the settler has recorded a fill (`received` above zero) or the hold is `payout_failed`/`payout_unclear`; the amount is at most `received` (default `received`) or, for the two payout holds, at most `usdcOut`; and no credited deposit has the stored hash. A parked or failed payout is cleared with `payout = null` in the same write.
    - `planWithdraw(o: { amount: bigint; to: Address; openOrders: number; owed: bigint; ignoreOwed: boolean; free: bigint }): { ok: true } | { ok: false; reason: string }` and `withdraw(o: { amount: bigint; to: Address; ignoreOwed?: boolean; send: boolean }): Promise<{ txHash: Hex | null }>`: refuses while any fronted order is `created`, `sent` or `in_block` or has a payout `signed`/`sent`, and while `owed` is above zero without `ignoreOwed`; writes a `vaultEvents` `withdraw` row (hash and amount) before broadcasting; without `send` it only prints.
    - `clearDrift(txHash: string, note: string): Promise<void>` (writes an `ack` event).
    - `parseVaultArgs(argv: string[]): { command: string; args: string[]; flags: { yes: boolean; note?: string; amount?: string; ignoreOwed: boolean } }` (the script's only parsing, kept in `ops.ts` so a unit test imports it without opening a database).
- Script usage: run from `server/` as `node --env-file=.env scripts/vault.ts <status|open|refunds|settle|pay|withdraw|clear-drift> ...`; prints what it would do and changes nothing without `--yes-send-real-money` (every writing command, not only `withdraw`). The refusal reasons are printed whole.

- [ ] **Step 1: Write the failing tests.**
    - Unit `vault-script.test.ts`: `"planPay refuses an order that is not held, one with a live payout, one with no fill and no payout hold, an amount above received, and an amount above usdcOut on a payout hold"`; `"planPay accepts the default amount received"`; `"planPay refuses when a credited deposit has the stored hash"`; `"planWithdraw refuses while an order is open or a payout is signed or sent, and while owed is above zero unless ignoreOwed"`; `"planWithdraw refuses more than free"`; `"the script refuses to write without --yes-send-real-money"` (argument parser only).
    - Integration `vault-ops.test.ts` (stack with `vault`): `"status reports address, balance, reserved, free, owed and counts by settle and hold"`; `"settle recovered clears the loss kind of the breaker; lost records the amount; returned closes an unpaid order"`; `"pay writes the release and clears the hold, and the server's payer pays through the stored-before-sent path once and delivers"` (end to end with Task 10); `"pay on a parked payout_unclear order clears the payout and the payer signs a fresh nonce"`; `"payInfo reports a parked order's stored hash and nonce, the vault's count, and whether the deposit address received it"`; `"withdraw writes vaultEvents before broadcasting and the drift scan does not flag it"`; `"clear-drift writes an ack and the drift kind clears"`; `"refunds with a fake requestDetail prints the refund hash"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/vault-script.test.ts test/integration/vault-ops.test.ts`).
- [ ] **Step 3: Implement** `ops.ts` and the thin script (same structure as `scripts/perps-rebalance.ts`: header comment with usage, `loadConfig`, `connectDatabase`, `createArcClient`, `createKeyring(...).vault()`). Document in the README: funding the vault is a plain USDC send to the printed address; run `withdraw` with `VAULT_FRONTING=off` and the server restarted to remove the race; what each `settle` outcome means; the log lines to watch.
- [ ] **Step 4: Run them, then `cd server && npm test && npx tsc --noEmit`.** Expect PASS.
- [ ] **Step 5: Commit** "Add the operator's vault script: status, open orders, refunds, settle, pay, withdraw and clear-drift".

---

### Task 18: The app state: the pending entry for a paying order (spec 10 Optimistic credit)

**Files:**
- Modify: `lib/account/state.ts`, `components/account-client.ts` (the 2-minute backstop timer; the reconnect loop skips `order:` entries)
- Test: `e2e/vault-deposit.logic.spec.ts`, `e2e/account.logic.spec.ts` (must pass unchanged)

**Interfaces:**
- Consumes: Task 9's `DepositOrderView.paying`, `payAmount`, `payTxHash`, `held`.
- `PendingDeposit.txHash` widens to `PendingKey = Hex | \`order:${string}\``, and the `reverted` action's `txHash` to `PendingKey` too. `#bind` in `account-client.ts` loops over `state.pending` on every reconnect and calls `#confirm` (an Arc `deposit:submit`) for each; it must skip `order:` entries, which are not transactions (the server would refuse them and the client would then show a "reverted" notice). In the `session` action, an `order:` entry whose order is not `paying` in the new session's `orders` (or is delivered, failed or held there) is dropped, and one whose order is `paying` there is kept or added, since a reconnect delivers orders as a list and no `order` action follows. In the `order` action: when `order.paying` is true, the order is not `delivered` or `failed`, and its `payTxHash` is not already among `state.deposits`, a pending entry `{ txHash: "order:<id>", amount: toWei(order.payAmount), sentAt: now }` is added (replaced if present, with the new amount); the entry is removed when the order is `delivered`, `failed` or `expired`, when `held` is true, when `paying` is false, and by `settle()` when the credited deposit's `txHash` equals the order's `payTxHash`. `AccountClient` arms a 120,000 ms timer per `paying` push (re-armed by each push) that dispatches the existing `reverted` action with the `order:<id>` key, quietly; it is cleared on removal and on `reset`.

- [ ] **Step 1: Write the failing tests** (reducer-level, no browser, in the style of `account.logic.spec.ts`):
    - `"a paying push adds a pending entry of payAmount and the optimistic balance rises"`; `"a second push with a lower payAmount replaces the entry, not adds one"`.
    - `"the entry stays while paying stays true across pushes"`.
    - `"delivered removes it and the credited deposit counts once"`; `"failed removes it"`; `"held removes it"`; `"paying false removes it"`.
    - `"a credit that arrives before the delivered push removes it (payTxHash matches) and the balance is never counted twice"`; `"a credit that arrived before the paying push means the entry is never added"`; `"a late older push (updatedAt older than the held one) does not re-add it"`.
    - `"the history shows one pending row for the entry, then the credited row"`.
    - `"the backstop timer removes an entry after 120 s with no push, and a push re-arms it"` (fake timers on the client).
    - `"a reconnect reports the pending Arc deposits again but never an order: entry"` (a fake socket records the `deposit:submit` calls).
    - `"a session that lists the order as no longer paying drops its entry, and one that lists it paying keeps it"`.
- [ ] **Step 2: Run them; expect FAIL** (`npm run test:logic`).
- [ ] **Step 3: Implement** the state rule and the timer.
- [ ] **Step 4: Run `npm run test:logic`, `npx tsc --noEmit -p .`, `npx eslint` and `npx prettier --check` on the changed files.** Expect PASS.
- [ ] **Step 5: Commit** "Count a fronted deposit in the balance as soon as the server is paying it".

---

### Task 19: The app UI: three steps, "right away", the final number, copy, and the browser specs (spec 10)

**Files:**
- Modify: `components/deposit-progress.tsx`, `lib/account/deposit-preview.ts`, `components/deposit-form.tsx`, `components/wallet-sidebar.tsx` (its `DepositForm` call site and the `onDepositCoin` type), `components/account-client.ts`, `components/account-provider.tsx`, `server/test/e2e/serve.ts`, `e2e/backend.ts`
- Test: `e2e/vault-deposit.logic.spec.ts` (more cases), `e2e/vault-deposit.spec.ts` (new), `e2e/bridged-deposit.spec.ts` and `e2e/solana-deposit.spec.ts` (must pass with the vault off)

**Interfaces:**
- Consumes: Tasks 6, 9, 14, 18.
- `deposit-progress.tsx`: `FRONTED_STEPS = ["Sending", "Confirming", "Added"]`; for an order with `instant` true, `DONE` is `sent: 1, in_block: 2, delivered: 3`; an `instant` order never shows `OUTCOMES.refunded`; `failed` shows "Didn't go through"; `held` shows "We're checking this deposit." (neutral tone); after 2 minutes in Confirming from `updatedAt` the line adds "Taking longer than expected" (a pure `confirmingSlow(order, now): boolean`, re-evaluated by a 10 s interval in the component). The four-step list is unchanged for direct orders.
- `previewText(coin, amount, payout)`: when `payout.instant`, the `in about …` clause becomes `, added right away`: "≈ $300.00, added right away" for EVM and "You get about 9.97 USDC, added right away" for Solana (fee and held-SOL parts unchanged).
- Final number: `DepositForm.onSubmit` becomes `(amount: string, reviewedOut: string | null) => Promise<DepositResult>` (the form passes the quote showing for that amount, `payout?.usdcOut ?? null`), and `wallet-sidebar.tsx`'s `onSubmit` and the provider's `depositCoin` pass it on. `AccountClient.bridgeDeposit` and `solanaDeposit` gain `reviewedOut: string | null`; after `deposit:order` answers, if `!order.instant` and `Number(order.usdcOut) < Number(reviewedOut)` the wallet is not opened and the result is `"price_changed"` (a new `DepositResult` member); `DepositForm` clears its `quoted` entry and asks `ask.current(amount)` again at once (the quote effect depends on `[quoting, amount]` and would not fire again by itself), showing the new number and waiting for another press; equal or higher goes on. The abandoned `created` order expires on its own and counts against `UNSETTLED_LIMIT` meanwhile, which the form need not handle. `solanaDeposit` passes `{ orderId: order.id }` to `solana:blockhash`.
- E2E backend (`server/test/e2e/serve.ts`): one `FakeBridge` named `relay` over `ethereum`, `bnb` and `solana` replaces the two (the control `/bridge/advance` picks its issuer by `order.provider === solanaBridge.name`, which would send every EVM order to the wrong fake if both were named `relay`; with one bridge it is just that bridge); the env sets `VAULT_REFUND_EVM` and `VAULT_REFUND_SOLANA` and leaves `VAULT_FRONTING=off`; new controls `POST /vault/fronting { on }` (calls `vault.setFronting`), `POST /vault/fund { usdc }` (`setBalance` on the vault plus its gas reserve), `POST /vault/order-state { address, state }` (moves the newest order of that person's account to `failed` with the tracker's conditional write and emits `order:updated`) and `POST /vault/hold { address, reason }` (sets `vault.hold` on it and emits). The last two exist because a browser wallet sends exactly the transactions the server hands it, so a reverted or mismatching source transaction can't be produced from the page without breaking the chain every other spec shares; the server side of both is covered by Tasks 8, 9 and 10. `e2e/backend.ts` gets `setVaultFronting(on)`, `fundVault(usdc)`, `failNewestOrder(address)` and `holdNewestOrder(address, reason)`.

- [ ] **Step 1: Write the failing tests.**
    - Logic: `"an instant order shows Sending, Confirming, Added with sent=1, in_block=2, delivered=3 done"`; `"a direct order keeps the four steps"`; `"confirmingSlow is false at 119 s and true at 120 s"`; `"a held order says 'We're checking this deposit.'"`; `"a failed instant order says 'Didn't go through'"`; `"an instant order never says 'Refunded to your wallet'"`; `"previewText says 'added right away' for instant EVM and Solana quotes and 'in about 2 s' otherwise"`; `"price_changed: a direct order whose usdcOut is lower than reviewed stops before the wallet opens and the form shows the new number; equal or higher goes on"` (fake client socket); `"solana:blockhash is sent with the order id"`.
    - Browser `vault-deposit.spec.ts` (fake bridge, vault funded and fronting on via the controls): `"an eligible coin shows 'right away', three steps, and the balance rises when the payout is made and before the fill"`; `"the vault short shows the four direct steps and the final number, and waits for another press"`; `"a failed order shows 'Didn't go through' and no balance change"` (`failNewestOrder` after the wallet sent); `"a held order shows 'We're checking this deposit.'"` (`holdNewestOrder`); `"the history row reads +$300.00 from 0.1 ETH on Ethereum"`.
    - `"bridged-deposit.spec.ts keeps passing with the vault off"`.
- [ ] **Step 2: Run them; expect FAIL** (`npm run test:logic`; browser specs from the isolated copy on 3650/4650/4651).
- [ ] **Step 3: Implement** the component, text, form and client changes and the backend controls. Read `components/deposit-form.tsx` and `wallet-sidebar.module.css` for the existing step styles; add no new label beyond those in Global Constraints.
- [ ] **Step 4: Run `npm run test:logic`, `npx tsc --noEmit -p .`, `npx eslint` and `npx prettier --check` on the changed files, `cd server && npx tsc --noEmit`, then `bridged-deposit.spec.ts`, `solana-deposit.spec.ts` and `vault-deposit.spec.ts` from the isolated copy.** Expect PASS.
- [ ] **Step 5: Commit** "Show instant deposits as three steps, quote them as added right away, and stop at a lower final number".

---

## After Task 19 (the owner's, not tasks)

Spec section 13 live checks 1 to 16 and section "What the owner provides". In order: check 14 first, with `VAULT_FRONTING=off` (the Task 1 log line gives the block-to-credit medians per chain; the executor's report at the Checkpoint before Task 13 already told the owner these are wanted, spec 15 step 1 and 14.9); fund the vault with $20; checks 1 to 13 and 15 and 16; then `VAULT_FRONTING=on`. Owner inputs: `VAULT_REFUND_EVM`, `VAULT_REFUND_SOLANA` (with a USDC token account), paid `ETHEREUM_RPC_URLS`, `BNB_RPC_URLS`, `SOLANA_RPC_URLS`, `RELAY_API_KEY`, `VAULT_TARGET_USDC`.

## Self-review notes

- Spec coverage: 1.1 and 1.2 Task 6 (the breaker check inside the lock too); 1.3 Tasks 2, 3; 1.4 Task 6 (Relay only: `tiers: [["relay"]]`, Across and CCTP stay on the direct path); 2.1 Task 1; 2.2 Tasks 1, 15; 2.3 and 2.4 Task 4; 3.1 Tasks 8, 14; 3.2 Tasks 7, 9, 15; 3.3 Tasks 7, 9; 3.4 and 3.5 Tasks 9, 10; 3.6 Tasks 9, 10; 4 Tasks 9, 10; 5 Tasks 11, 12; 6.1 Task 11; 6.2 and 6.3 Task 17; 7.1 Tasks 4, 6; 7.2 Task 1; 7.3 Tasks 5, 10, 12; 8 Task 1; 9 Tasks 2, 4, 9; 10 Tasks 18, 19; 11 Task 16; 12 each task's tests; 13 split across tasks; 14 Tasks 13 to 15 (14.4 Task 14, 14.5 Task 15, 14.6 Tasks 1 and 15, 14.8 Task 1, 14.9 Task 1's log line and the owner's check 14); 15 is the task order (Solana tasks 13 to 15 come after the EVM path works end to end).
- Spec additions this plan makes, each needed to build what the spec asks: `DepositOrderView.payAmount` and `payTxHash` (the spec says `paying` carries the payout's amount and that a credit arriving first must not count twice, which needs the payout hash); `vault.rejected` and `vault.lost`, `vault.lastValidBlockHeight` fields; `VAULT_SLIPPAGE_BPS` capped at 300; the breaker threshold is "at least"; an unpaid refunded order counts 0 in the loss kind; a payout under the dust floor is held `late`; the cheap-check snapshot is used only when under 3 s old; `Vault.setFronting` for tests and the e2e backend.
- Facts not yet checkable without a key, transaction or money stay open exactly as the spec lists them (open questions 1 to 15); no task resolves one, and the fakes behave as the spec assumes.
- Changes the plan review (2026-10-14) made to the planner's draft, beyond wording: the five Review Focus items for a deposit paid twice, two deposits racing for the last of the free balance, a restart between paying and recording, a refund after payment and a Solana transaction that differs from the quote, each with named tests in their owning task; the Relay fixtures are recorded and in the tree, so no task reaches a network; one `relay` fake bridge instead of two with the same name; `insertFronted` checks the breaker; the nonce floor looks at stored mined nonces; the owner's release reaches orders in any state; `SolanaRpc.hasTokenAccount` for the refund-address check, which fails closed before its first run; `protocol.ts` fields optional so existing `e2e` literals type-check; the reconnect loop of the app skips `order:` entries; the browser specs use two test-backend controls where a page cannot produce a reverted or mismatching transaction; shared files `validation.ts`, `config.test.ts`, `perp-reconciler.test.ts` listed; a checkpoint before Task 13 for spec 15 step 1.

## Appendix: where the Relay fixtures came from

Recorded 2026-10-14 between 19:28 and 19:30 UTC by the plan review, unauthenticated (no API key, no cookie), with throwaway placeholder addresses; nothing was signed or sent, and no request carried the owner's email. Each quote is `POST https://api.relay.link/quote/v2` with `content-type: application/json`, saved pretty-printed with 4 spaces. The common fields are `destinationChainId` 5042, `destinationCurrency` `0x3600000000000000000000000000000000000000`, `tradeType` `EXACT_INPUT`, `ttl` 180, `slippageTolerance` `"100"`, and `recipient` `0x00000000000000000000000000000000000de905`.

- EVM (`user` `0x00000000000000000000000000000000000a11ce`, `refundTo` `0x00000000000000000000000000000000000b0b01`): `fronted-eth.json` has `originChainId` 1, `originCurrency` the zero address, `amount` `10000000000000000`; `fronted-bnb-usdt.json` has `originChainId` 56, `originCurrency` `0x55d398326f99059fF775485246999027B3197955`, `amount` `3000000000000000000`.
- Solana (`user` `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`, `refundTo` `Vote111111111111111111111111111111111111111`, `originChainId` 792703809, `includeComputeUnitLimit` true): `fronted-solana-sol.json` has `originCurrency` `11111111111111111111111111111111`, `amount` `50000000`; `fronted-solana-usdc.json` has `originCurrency` `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, `amount` `20000000`.
- `status-solana-filled.json` is `GET https://api.relay.link/intents/status/v3?requestId=0x179200338421c7da78fd83975012eb00bcba20192f16bea353ca5e72df909694`.

To record them again (the owner's call, not a task): the same bodies, then check `protocol.v2.orderId` is present and that `refunds[0].recipient` is the `refundTo` sent. Docs read for the request fields: `https://docs.relay.link/references/api/get-quote-v2` (2026-10-14).
