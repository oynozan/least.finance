# Withdrawals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People withdraw USDC from their account balance to one of their linked EVM wallets on Arc. The balance drops at once, and the payout comes from a treasury that every deposit is swept into.

**Architecture:**

- The treasury is HD index 0 of `DEPOSIT_MNEMONIC`. A sweeper moves every credited deposit into it, and a catch-up pass runs every 10 minutes.
- A withdrawal debits the ledger and records itself in one Mongo transaction.
- A single payout worker signs from the treasury and stores the signed transaction before broadcasting it, so a restart re-sends instead of paying twice. A failed payout is refunded once.
- The app is optimistic, like deposits.

**Tech Stack:**

- Server: Node ≥ 24, Express 5, socket.io 4.8, MongoDB 7 (replica set), viem 2.56, zod 4, vitest with anvil and the Arc emulator.
- App: Next.js 16 and React 19, Privy 3.48, motion.
- Tests: Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-withdrawals-design.md`

## Global Constraints

### Commits and tests

- **Shared `main`.** Commit by path (`git commit -m "<msg>" -- <paths>`) with only your task's files. Commits carry no `Co-Authored-By` trailer. Other sessions commit to `main` too: never reset, stash, rebase or force. Never stage `.impeccable/hook.cache.json`.
- **Shared files carry other sessions' work in progress.** A swaps session is editing `protocol.ts`, `sockets.ts`, `mongo.ts`, `migrations.ts`, `validation.ts`, `services.ts`, `server.ts`, `events.ts`, `config.ts`, `stack.ts`, `serve.ts`, `e2e/backend.ts` and the account client at the same time.
    - Before every commit, read `git diff` on each file you're committing. If a file has hunks you didn't write, commit only your own hunks: `git diff <file>` → keep your hunks → `git apply --cached`, then `git commit -m <msg>` without paths.
    - Never edit, revert or "fix" someone else's uncommitted code. If their edits break your build, wait a few minutes and retry. If that keeps failing, say so in your report.
- **Running tests.** Always run them from an isolated copy, never the repo:
    - Build the copy: `git archive HEAD | tar -x` into a scratch directory, then `cp -cR` both `node_modules` and `server/node_modules`, then overlay your uncommitted files.
    - Server: `cd server && npx vitest run <files>` and `npx tsc --noEmit`.
    - Logic: `LOGIC_ONLY=1 npx playwright test --project=logic`.
    - E2E: `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test`. Ports 3800, 4800 and 4801 belong to another agent.
- **Style.** One-line comments. Match each file's 4-space indentation and Prettier style. Server imports use `.ts` extensions. `npx eslint` must show no errors on changed app files.
- **Next-specific code.** Read the relevant guide under `node_modules/next/dist/docs/` first (AGENTS.md).

### Contracts other code depends on

- `server/src/protocol.ts` stays import-free, because the client imports it as types.
- `components/deposit-button.tsx` keeps its accessible name "Deposit", its `data-phase` and its `aria-busy`.
- `useAccount().history` keeps its shape (PnL reads it).
- The ledger is the only balance writer, through `debitInSession` and `creditInSession`. Each change is one transaction: the balance `$inc`, the version bump and an entry unique on `(kind, refId)`. A debit's filter requires `balance >= amount`.
- Pushes to one account go through the per-account `pushing` chain in `server/src/socket/sockets.ts`, so they arrive in bus order.
- Coin and network logos are official SVGs from `public/logos`. Never draw one.
- **The coin-list highlight** is one per list, at z-index -1 inside an isolated `ul`, never one per row. If the withdraw form has its own list, add it to `e2e/highlights.spec.ts`.

### Money

- Arc USDC is native, with 18 decimals. Read balances with `getBalance`, never the 6-decimal ERC-20 view at `0x3600…0000`. Amounts on the wire are 18-decimal `UsdcAmount` strings.
- Every server transaction uses gas limit 21,000 and `maxFeePerGas` of at least 20 gwei (`MIN_BASE_FEE` in `server/src/chain/arc.ts`).
- There are no fees (0%). The operator absorbs gas.
- The treasury's gas reserve is 0.01 USDC.
- The sweep's dust floor is 10 × its gas cost.
- The catch-up sweep runs every 10 minutes (`SWEEP_INTERVAL_MS = 600_000`).
- `WITHDRAW_MIN_USDC` defaults to 0.01.
- `withdraw:create` allows 10 per minute per user.

### Copy

- **Solana recipient:** `bad_request` "USDC on Arc can't go to a Solana wallet. Link an EVM wallet to withdraw."
- **Treasury short:** `insufficient_funds` "Withdrawals can pay at most ${X} right now. Nothing was taken." `${X}` is formatted like "$12.50".
- **Failure notice:** "Didn't go through. Your balance is back."
- **Withdrawal history row:** "−$50.00 · to 0x12…ab". States read "Sending" and "Sent".
- **Solana-only person:** a row labeled "Connect an EVM wallet".

## Review Focus

1. **A double click or a retry** with the same `requestId` makes one withdrawal and one debit. Two different withdrawals at once that together exceed the balance: only one goes through. Task 3.
2. **Two withdrawals at once that together exceed what the treasury can pay:** the second is refused before anything is debited. Task 3.
3. **A server restart after signing but before the receipt** re-broadcasts the same raw transaction and pays exactly once. Task 4.
4. **Two deposits to the same address in quick succession** sweep without a nonce clash, and the address ends with only dust. Task 2.
5. **The wallet in use is Solana, with an EVM wallet also linked:** Withdraw defaults to that EVM wallet, and the field's maximum is the server's credited balance, not the optimistic one that includes pending deposits. Task 8.

---

### Task 1: Treasury key, ledger kinds, the withdrawals collection and protocol types

**Files:**

- Modify: `server/src/accounts/keyring.ts`, `server/src/deposits/ledger.ts`, `server/src/db/mongo.ts`, `server/src/protocol.ts`, `server/src/config.ts`, `server/.env.example`
- Test: `server/test/unit/keyring.test.ts`, `server/test/unit/config.test.ts`, `server/test/integration/withdrawal-ledger.test.ts` (new)

**Interfaces:**

- Produces:
    - `Keyring.operator(): HDAccount`, the account at index 0. `signerAt` keeps refusing indexes below 1.
    - `config.WITHDRAW_MIN_USDC: bigint` (wei), defaulting to 0.01 USDC.
    - `LedgerEntryDoc.kind` gains `"withdrawal" | "withdrawal_refund"`. `debitInSession`'s `kind` accepts `"prediction_buy" | "withdrawal"`, and `creditInSession`'s accepts `... | "withdrawal_refund"`.
    - `WithdrawalDoc`:
        - `{ _id: ObjectId; accountId: ObjectId; requestId: string; amount: Decimal128; to: string; state: "sending" | "sent" | "failed"; nonce: number | null; rawTx: Hex | null; txHash: Hex | null; failure: string | null; createdAt: Date; updatedAt: Date }`
        - `collections.withdrawals` is named `"withdrawals"`, with indexes `{ accountId: 1, _id: -1 }`, unique `{ accountId: 1, requestId: 1 }` (`request_unique`) and `{ state: 1, createdAt: 1 }`.
    - Protocol: `WithdrawalState`, `WithdrawalView`, `WithdrawLimits`, `WalletSession.withdrawals`, the events `withdraw:limits` and `withdraw:create`, and the push `withdrawal:update`, exactly as in the spec's Protocol section. `WalletSession.withdrawals` becomes required. Wire `sessions.ts` to return `[]` for now, so the type checks.

- [ ] **Step 1: Write the failing tests:**
    - `keyring.operator().address` equals `mnemonicToAccount(mnemonic, { addressIndex: 0 }).address`, and `signerAt(0)` still throws.
    - The `WITHDRAW_MIN_USDC` default is `parseUnits("0.01", 18)`, and `"0.5"` parses to `parseUnits("0.5", 18)`.
    - `"a withdrawal debit and its refund each happen once"`: `runInTransaction(s => debitInSession(s, id, 5n * 10n**18n, "withdrawal", ref))` lowers the balance by 5 USDC. A second `creditInSession(..., "withdrawal_refund", ref)` for the same ref throws a duplicate key error and leaves the balance unchanged. A debit above the balance throws `insufficient_funds`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/keyring.test.ts test/unit/config.test.ts test/integration/withdrawal-ledger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the keyring, config, ledger, mongo, protocol and `.env.example` changes, plus `sessions.ts` returning `withdrawals: []`.
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit` (server, then the root app). Expected: all pass. Update existing session assertions that compare the whole session object, such as `http.test.ts`, to include `withdrawals: []`.
- [ ] **Step 5: Commit** with the message "Lay the ground for withdrawals: the treasury key, ledger kinds and a withdrawals collection".

### Task 2: Sweep deposits into the treasury

**Files:**

- Create: `server/src/withdrawals/sweeper.ts`
- Modify: `server/src/server.ts`, `server/src/services.ts`
- Test: `server/test/integration/sweeper.test.ts`

**Interfaces:**

- Consumes: `Keyring.operator()` and `signerAt(index)` (Task 1), `bus "deposit:credited"`, `MIN_BASE_FEE`, and `collections.counters` (the highest assigned deposit index; read how `accounts.ts` assigns indexes).
- Produces:

```ts
export const SWEEP_INTERVAL_MS = 600_000;
export class Sweeper {
    constructor(deps: {
        client: ArcClient;
        keyring: Keyring;
        collections: Collections;
        bus: Bus;
        logger: Logger;
        intervalMs?: number;
    });
    start(): void; // subscribes to deposit:credited and starts the catch-up loop
    stop(): Promise<void>;
    sweep(index: number): Promise<Hex | null>; // null when the balance is at or under the dust floor
    sweepAll(): Promise<void>; // indexes 1..highest assigned
}
```

- Sweeps of one index are serialized: a second call waits for the first and then re-reads the balance.
- The amount is the balance minus `21_000n * maxFeePerGas`.
- It logs the treasury address once at start: "Treasury: 0x…".

- [ ] **Step 1: Write the failing tests:**
    - `"a credited deposit is swept into the treasury"`: deposit 50 USDC to a user's address through the stack. Afterwards the deposit address holds no more than dust, the treasury gained about 50 USDC less gas, and the account balance is still 50.
    - `"two quick deposits to one address sweep without a clash"`: two sends back to back, then both sweeps settle. Every sweep transaction succeeded, and the address ends at no more than dust.
    - `"the catch-up pass sweeps an address the bus never mentioned, and leaves dust alone"`: use `setBalance` on index 3 to put 7 USDC there, and on index 4 to put 1 wei. After `sweepAll()`, index 3 is swept and index 4 is untouched.
    - `"a sweep credits nobody"`: after sweeping, no new `deposits` document exists for the treasury.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/sweeper.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sweeper.ts`, then start and stop it in `startServer` (stopped in `close()`) and add it to `Services`.
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass. Existing tests that assert deposit-address balances may need to allow for the sweep. Change only what the sweep explains.
- [ ] **Step 5: Commit** with the message "Sweep every credited deposit into the treasury".

### Task 3: Withdrawal limits and creation

**Files:**

- Create: `server/src/withdrawals/withdrawals.ts`, `server/src/withdrawals/views.ts`
- Modify: `server/src/validation.ts`, `server/src/events.ts`
- Test: `server/test/integration/withdrawals.test.ts`, `server/test/unit/validation.test.ts`

**Interfaces:**

- Consumes: `Ledger.runInTransaction`, `debitInSession` (Task 1), `identity.authorizeWallet`, `Keyring.operator()`, and `ArcClient`.
- Produces:

```ts
export const TREASURY_GAS_RESERVE = 10n ** 16n; // 0.01 USDC in wei
export class Withdrawals {
    constructor(deps: {
        collections: Collections;
        ledger: Ledger;
        client: ArcClient;
        treasury: Address;
        bus: Bus;
        logger: Logger;
        minWithdraw: bigint;
    });
    limits(account: AccountDoc): Promise<{ max: bigint; min: bigint }>;
    create(account: AccountDoc, input: { requestId: string; amount: string; to: Address }): Promise<WithdrawalDoc>;
    recent(accountId: ObjectId, limit?: number): Promise<WithdrawalDoc[]>; // newest first, default 50
}
export function withdrawalView(doc: WithdrawalDoc): WithdrawalView; // in views.ts
// events.ts: "withdrawal:updated": [{ withdrawal: WithdrawalDoc; account: AccountDoc | null }]
// validation.ts: withdrawRequest = z.object({ requestId: z.uuid(), amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "an amount such as 12.5"), to: z.string().trim().min(32).max(64) })
```

- `create` runs these steps under one in-process async lock:
    1. Validate the amount: at least the minimum, at most 6 decimals.
    2. Compute the treasury's free balance: `getBalance(treasury)` − the sum of every `sending` withdrawal − `TREASURY_GAS_RESERVE`, floored at 0. A payout that's mined but not yet marked `sent` is subtracted twice for a moment, which only errs on the safe side.
    3. If it's short, refuse with the treasury-short copy.
    4. In one transaction, run `debitInSession(..., "withdrawal", _id)` and insert the doc as `sending`.
    5. Emit `withdrawal:updated`.
- A duplicate `requestId` for the account returns the existing doc and doesn't debit.
- Recipient checks (the Solana `bad_request`, `authorizeWallet`) belong to the socket layer (Task 5), so `create` takes an already-authorized `Address`.

- [ ] **Step 1: Write the failing tests:**
    - `"limits are the smaller of the balance and what the treasury can pay"`: balance 100, treasury 30 + reserve gives max 30. Treasury 500 gives max 100.
    - `"a withdrawal debits once and starts sending"`: the balance drops by 25, one `withdrawal` ledger entry exists, and the state is `sending`.
    - `"the same requestId twice makes one withdrawal"`: both calls return the same `_id`, and there's one debit.
    - `"two withdrawals that together exceed the balance: one goes through"`: run them concurrently against a balance of 40, for 30 each. One resolves and one rejects with `insufficient_funds`. The balance ends at 10.
    - `"a treasury that can't cover it refuses before debiting"`: treasury 20 and a request for 50 rejects with "Withdrawals can pay at most $20.00 right now. Nothing was taken.", and the balance is unchanged.
    - `"two withdrawals at once can't overdraw the treasury"`: treasury 50 + reserve, two concurrent requests for 30 from two accounts. One succeeds and the other is refused.
    - `"under the minimum, or more than 6 decimals, is a bad request"`.
    - The validation cases for `withdrawRequest`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/withdrawals.test.ts test/unit/validation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Take a withdrawal off the balance only when the treasury can pay it".

### Task 4: The payout worker

**Files:**

- Create: `server/src/withdrawals/payouts.ts`
- Test: `server/test/integration/payouts.test.ts`

**Interfaces:**

- Consumes: `WithdrawalDoc` and `withdrawal:updated` (Tasks 1 and 3), `Ledger.creditInSession(..., "withdrawal_refund", _id)`, and `Keyring.operator()`.
- Produces:

```ts
export class Payouts {
    constructor(deps: {
        collections: Collections;
        ledger: Ledger;
        client: ArcClient;
        signer: HDAccount;
        bus: Bus;
        logger: Logger;
        pollMs?: number /* 1_000 */;
        broadcast?: (rawTx: Hex) => Promise<Hex>; // default client.sendRawTransaction; tests and the e2e backend wrap it
    });
    start(): void; // wakes on withdrawal:updated (state sending) and every pollMs
    stop(): Promise<void>;
    tick(): Promise<void>; // pays every `sending` withdrawal, oldest first, one at a time
}
```

**Per withdrawal:**

1. If `rawTx` is null:
    - Take `getTransactionCount(treasury, "pending")`.
    - Sign a transfer of `amount` to `to` (gas 21,000, `maxFeePerGas` = max(2 × base fee, 20 gwei), `maxPriorityFeePerGas` 1 gwei).
    - Store `nonce`, `rawTx` and `txHash` with a conditional update on `{ _id, state: "sending", rawTx: null }`.
2. Broadcast `rawTx`. "Already known" or "nonce too low" counts as broadcast; let the receipt decide.
3. Wait for the receipt (timeout 30 s; on timeout leave the withdrawal for the next tick):
    - success → `sent`
    - reverted → `failed`
4. Fail it for good, without waiting for a receipt, if the broadcast is refused for a reason other than those two (for example insufficient funds).
5. `failed` and its refund commit in one transaction: a conditional state move on `{ _id, state: "sending" }` plus `creditInSession(..., "withdrawal_refund", _id)`. `failure` holds a short reason.
6. Every successful move emits `withdrawal:updated` with the account from the refund (or a fresh read for `sent`).

- [ ] **Step 1: Write the failing tests**, with `pollMs` 100:
    - `"a withdrawal is paid to the wallet and ends sent"`: the recipient's Arc balance rises by exactly the amount, the state is `sent` with `txHash`, and the treasury fell by the amount plus gas.
    - `"a refused broadcast fails the withdrawal and refunds once"`: `broadcast` throws "insufficient funds for gas * price + value". The state is `failed`, the balance is back, and there's one `withdrawal_refund` entry. Calling `tick()` again adds nothing.
    - `"a reverted payout is refunded"`: set code `0xfe` at the recipient so the transfer reverts. The withdrawal ends `failed` and is refunded once.
    - `"a restart after signing re-sends the same transaction and pays once"`:
        - Give the first worker a `broadcast` that stores but never sends, then stop it.
        - Start a second worker with the default broadcast.
        - The stored `txHash` is the one mined, the recipient is paid once, and the treasury nonce advanced by 1.
    - `"pushes arrive as sending, then sent"`: collect `withdrawal:updated` states.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/payouts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Pay withdrawals from the treasury, once, even across a restart".

### Task 5: Withdrawals over the socket, in the session, and through merges

**Files:**

- Modify: `server/src/socket/sockets.ts`, `server/src/server.ts`, `server/src/services.ts`, `server/src/sessions.ts`, `server/src/db/migrations.ts`, `server/README.md`, `server/test/support/stack.ts`
- Test: `server/test/integration/withdraw-socket.test.ts`, `server/test/integration/migration.test.ts`

**Interfaces:**

- Consumes: `Withdrawals`, `Payouts` and `Sweeper` (Tasks 2–4), and `identity.authorizeWallet`.
- Produces:
    - Socket handlers:
        - `withdraw:limits` acks `{ max, min }` as `UsdcAmount` strings.
        - `withdraw:create`:
            1. Parse with `withdrawRequest`.
            2. Run the new `withdrawals` limiter: 10 per 60 s per user.
            3. A base58 Solana address gets the Solana `bad_request` copy before any Privy call.
            4. Otherwise `authorizeWallet` (an unlinked wallet is `forbidden`), then `create`.
            5. Ack the view.
    - `withdrawal:updated` → `withdrawal:update` to the account's room through the `pushing` chain, with the same owner check as `deposit:credited`.
    - `WalletSession.withdrawals` = `withdrawalView` of `recent(accountId)`.
    - `startServer` builds `Withdrawals`, `Payouts` (signer `keyring.operator()`) and `Sweeper`, starts them, and stops them in `close()`. `Overrides` gains `payoutBroadcast?: (rawTx: Hex) => Promise<Hex>`.
    - `mergeInto` re-points `withdrawals` to the survivor.
    - `startStack` exposes `stack.treasury: Address` and `stack.fundTreasury(usdc: string): Promise<void>`.
    - The README documents the events, the treasury, sweeping, `WITHDRAW_MIN_USDC`, and "don't send from the treasury key while the server runs".

- [ ] **Step 1: Write the failing tests:**
    - `"withdrawing over the socket pays a linked wallet and pushes sending then sent"`.
    - `"an unlinked wallet is forbidden; a Solana address is a bad request with no Privy lookup"`.
    - `"the session hands back recent withdrawals, newest first"`.
    - `"limits come back as UsdcAmount strings"`.
    - `"another person's socket gets no withdrawal push"`: the push reaches the owner's second socket and not another account's.
    - `"an account merge carries withdrawals over"`, in `migration.test.ts`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/withdraw-socket.test.ts test/integration/migration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit` (server and root). Expected: all pass.
- [ ] **Step 5: Commit** with the message "Withdraw over the socket, and carry withdrawals through sessions and merges".

### Task 6: Withdrawals in the client state

**Files:**

- Modify: `lib/account/state.ts`, `components/account-client.ts`, `components/account-provider.tsx`
- Test: `e2e/account.logic.spec.ts`

**Interfaces:**

- Consumes: the Task 1 protocol types and the Task 5 events.
- Produces:
    - Ready state:
        - `withdrawals: WithdrawalView[]`, newest first. The action `{ type: "withdrawal"; withdrawal }` upserts by `id` and ignores one whose `updatedAt` is older than the stored one.
        - `pendingWithdrawals: { requestId: string; amount: bigint; to: string; at: number }[]`, cleared when a view with the same `requestId` arrives or the request is refused.
        - `session` takes `session.withdrawals`.
    - `optimisticBalance` subtracts pending withdrawals and `sending` ones not yet reflected by the server (the account version decides, as with deposits). `failed` withdrawals don't subtract.
    - `AccountClient.withdrawLimits(): Promise<WithdrawLimits | ApiError>` and `AccountClient.withdraw(amount: string, to: string): Promise<"sent" | "refused" | "failed">`. `withdraw` makes the `requestId` with `crypto.randomUUID()`, adds the pending row, emits `withdraw:create`, and on refusal removes the pending row and sets the notice to the server's message.
    - `withdrawal:update` dispatches `withdrawal`. A `failed` update sets the notice "Didn't go through. Your balance is back."
    - `Account` gains `withdrawals: WithdrawalView[]`, `pendingWithdrawals`, `withdrawLimits()` and `withdraw(amount, to)`. `history` is unchanged.

- [ ] **Step 1: Write the failing logic tests:**
    - `"a withdrawal upserts by id and ignores a stale update"`.
    - `"a pending withdrawal lowers the balance until the server's view arrives"`.
    - `"a failed withdrawal doesn't lower the balance"`.
    - `"the session restores withdrawals"`.
- [ ] **Step 2: Run** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/account.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all logic tests and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Keep withdrawals in the app's account state, optimistically".

### Task 7: E2E backend: a treasury the tests can fund and a payout they can fail

**Files:**

- Modify: `server/test/e2e/serve.ts`, `e2e/backend.ts`
- Test: `e2e/withdraw.spec.ts` (new; this task adds only the backend check)

**Interfaces:**

- Consumes: `Overrides.payoutBroadcast` and the treasury from Task 5.
- Produces:
    - Control routes:
        - `/treasury/fund { usdc }` sets the treasury's Arc balance.
        - `/treasury` returns `{ address, balance }`.
        - `/withdrawals/fail-next {}` makes the next payout broadcast throw "insufficient funds for gas * price + value".
    - `e2e/backend.ts`: `fundTreasury(usdc: string)`, `treasury(): Promise<{ address: string; balance: string }>` and `failNextPayout()`.
    - `serve.ts` funds the treasury with 100,000 USDC at start, so existing specs never meet a short treasury.

- [ ] **Step 1: Write the failing test** `"the test backend funds the treasury and can fail a payout"`: `fundTreasury("123")` makes `treasury().balance` `"123"`. `failNextPayout()` resolves.
- [ ] **Step 2: Run** `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/withdraw.spec.ts --project=desktop`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, plus the whole e2e suite. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Let the browser tests fund the treasury and fail a payout".

### Task 8: Withdraw in the sidebar

**Files:**

- Create: `components/withdraw-form.tsx`
- Modify: `components/wallet-sidebar.tsx` (the Deposit section only), `components/wallet-sidebar.module.css`
- Test: `e2e/withdraw.spec.ts`, plus `e2e/highlights.spec.ts` if the form adds a list

**Interfaces:**

- Consumes: `Account.withdrawLimits`, `withdraw`, `withdrawals` and `pendingWithdrawals` (Task 6). From `components/arc-wallet.ts`: `linkedWallets`, `depositWalletAddress`, `useActiveWallet` and `useLinkOtherWallet`. The backend helpers (Task 7).
- Produces:
    - A Withdraw button beside Deposit: the same pill style, accessible name "Withdraw".
    - **Opening the form:**
        - It calls `withdrawLimits()`. While the limits load, the field shows no maximum, and there's no loading text.
        - The amount field reuses the deposit form's field. Over `max` it turns red and shakes, and decimals are capped at 6.
        - The submit button is named "Withdraw".
    - **The recipient:**
        - With two or more linked EVM wallets, a picker of rows named by short address. It defaults to `depositWalletAddress` when that is EVM, else the first EVM wallet.
        - With one EVM wallet there's no picker.
        - With none, a "Connect an EVM wallet" row runs `useLinkOtherWallet()("evm")`.
    - **History:** withdrawal rows ("−$50.00 · to 0x12…ab", "Sending" then "Sent") merge into the sidebar's history list by time. Failed ones show the failure notice once, and their row says "Didn't go through".
    - The status line uses the existing `role="status"` region.

- [ ] **Step 1: Write the failing e2e tests:**
    - `"withdrawing drops the balance at once and pays the wallet"`:
        - Sign up with 200 and withdraw 50.
        - The balance reads $150.00 before the push, and the row shows "Sending", then "Sent".
        - `chainRpc("eth_getBalance", [wallet])` rose by 50 × 10¹⁸.
    - `"more than the maximum turns the amount red and shakes it"`: with `fundTreasury("30")` the maximum is $30.00, and typing 40 turns the amount red.
    - `"with two EVM wallets, the picked one is paid"`.
    - `"a Solana-only person is asked to connect an EVM wallet"`.
    - `"the wallet in use is Solana with an EVM wallet linked: the EVM wallet is the default, and the maximum is the credited balance"`: seed a pending deposit so the optimistic balance is higher. The maximum stays at the credited one.
    - `"a failed payout puts the balance back and says so"`: run `failNextPayout()` first. The balance returns, and the status reads "Didn't go through. Your balance is back."
    - `"Escape closes the form and returns focus to Withdraw"`.
- [ ] **Step 2: Run** `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/withdraw.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole e2e suite. Take desktop and mobile screenshots of the open form and of a "Sending" row, and look at them. Expected: all pass, and it matches the Deposit form's look.
- [ ] **Step 5: Commit** with the message "Withdraw from the sidebar to a linked wallet".

### Task 9: Withdrawals in PnL

**Files:**

- Modify: `lib/trade/activity.ts`, `components/pnl/use-activity.ts`, `components/pnl/activity-card.tsx`
- Test: `e2e/trade.logic.spec.ts`, `e2e/pnl.spec.ts`

**Interfaces:**

- Consumes: `Account.withdrawals` and `pendingWithdrawals` (Task 6).
- Produces:
    - `withdrawalActivity({ id, amountUSD, at, pending, to }): Activity`, with kind `"withdrawal"`, title "Withdrawal", detail "USDC to {short address}" and change −amountUSD.
    - `balanceHistory` counts withdrawals as money moved (the same bucket as deposits, negative), not PnL.
    - The "Deposits" filter includes withdrawals.
    - `failed` withdrawals are left out.

- [ ] **Step 1: Write the failing tests:**
    - Logic: `"a withdrawal lowers that day's balance and isn't PnL"`.
    - E2E: `"the PnL feed lists a withdrawal under Deposits, and the chart drops by it"`.
- [ ] **Step 2: Run** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/trade.logic.spec.ts`, then `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/pnl.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all logic tests and the whole e2e suite. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Count withdrawals in PnL as money moved".

### Task 10: A live check (the product owner)

No agent runs this. It needs real funds.

1. Restart the server and note the "Treasury: 0x…" line.
2. Deposit 2 USDC. Within a few seconds the deposit address is empty and the treasury holds about 2 USDC.
3. Withdraw 1 USDC to your linked wallet. The balance drops at once, the row reads "Sent", and the wallet receives 1 USDC.
