# One Account per Person Implementation Plan (spec step 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts belong to the Privy user, not to an EVM wallet. A signed-in user's socket binds to their one account without naming a wallet. Existing accounts are re-keyed, and a person's several accounts are merged without losing an old deposit address.

**Architecture:** `AccountService` is keyed by `privyUserId`. The socket event `account:open` replaces `wallet:connect`. Binding uses only the verified token, so it no longer calls Privy's API. A one-time, idempotent migration in `connectDatabase` merges each person's accounts into the oldest, moving balances through the ledger. Merged deposit addresses live on in `formerDepositAddresses`, so the registry, the ledger and deposit reports keep crediting them. Crediting stays by deposit address.

**Tech Stack:** Node + Express + socket.io + MongoDB (replica set, transactions) + viem on the server, vitest with mongodb-memory-server and anvil. Next.js 16 + Privy client. Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-09-wallets-accounts-instant-balances-design.md`, section 2. Solana sign-in and linking (section 3) is plan 2b.

## Global Constraints

- **Commits:**
    - Commit by path (`git commit -- <paths>`).
    - No `Co-Authored-By` trailer.
    - Other sessions commit to `main` too, and may leave changes staged.
- **Don't touch** `server/src/crosschain/*`, `server/src/config.ts` or `server/test/support/{anvil,global-setup,source-chains}.ts`, which belong to session `tradeeverything-00`.
- **Running tests:** run everything from an isolated copy, never the main directory, since peers share ports and `.next`.
    - Build the copy with `git archive HEAD | tar -x`, then `cp -cR` both `node_modules` and `server/node_modules`, and overlay your changed files.
    - Server: `cd server && npx vitest run <files>` and `npx tsc --noEmit`.
    - E2E: `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641 npx playwright test`.
- **Keep:**
    - Crediting goes by deposit address (`registry.lookup(transfer.to)`), exactly once per `(chainId, txHash, logIndex)`.
    - The ledger stays the only writer of a balance.
    - `server/src/protocol.ts` stays import-free, because the client imports it as types.
    - The error code `wallet_not_connected` keeps its name. Its messages become "Open your account first."
- **Comments:** one line each. Match each file's 4-space indentation.

## Review Focus

1. **A brand-new person opens the app on two devices at the same moment.** Both `account:open` calls race. Afterwards there is exactly one account, and both sockets are bound to it. Test in Task 2, once the unique index exists.
2. **The server restarts in the middle of the migration.** Each merge is one transaction, and a rerun finishes the rest without double-counting a balance. Test in Task 2.
3. **USDC sent to a merged account's old deposit address after the merge.** It credits the survivor once, and the survivor's sockets get the push. Test in Task 2.
4. **A person signs out and someone else signs in on the same tab.** The new connection carries the new person's token and binds to their account, never the previous one. Test in Task 1 (`socket.test.ts`). The client side is `AccountClient.connect` keyed by the user ID, which reconnects when the ID changes.
5. **Privy's API is down or rejects our secret.** Binding still works, because only the token is checked, locally. Test in Task 1.

---

### Task 1: Accounts keyed by person, bound without a wallet

**Files:**
- Modify:
    - `server/src/protocol.ts`:
        - `AccountView` loses `wallet`.
        - `"account:open"` replaces `"wallet:connect"`.
    - `server/src/db/mongo.ts`:
        - `AccountDoc` loses `wallet`.
        - `ensureIndexes` stops creating `wallet_unique`, and drops it if it exists.
    - `server/src/accounts/accounts.ts`
    - `server/src/sessions.ts`
    - `server/src/socket/sockets.ts`
    - `server/src/http/app.ts`
    - `server/src/validation.ts`: drop `connectWallet`
    - `server/src/deposits/views.ts`
    - `server/test/e2e/serve.ts`
    - `components/account-client.ts`
    - `components/account-provider.tsx`
    - `e2e/account.logic.spec.ts`: drop `wallet` from the `AccountView` fixtures
- Test:
    - `server/test/integration/socket.test.ts`
    - `server/test/integration/http.test.ts`
    - `server/test/integration/hardening.test.ts`
    - `server/test/integration/deposits.test.ts`
    - `server/test/integration/deposits-scan.test.ts`
    - `server/test/mainnet/scan.test.ts`: the raw `AccountDoc` literal

**Interfaces:**
- Produces, in `protocol.ts`:
    - `AccountView = { depositAddress: Hex; balance: UsdcAmount; version: number }`
    - `ClientToServerEvents["account:open"]: (payload: Record<string, never>, ack: (result: Ack<WalletSession>) => void) => void`
- Produces, in `AccountService`:
    - `find(privyUserId: string): Promise<AccountDoc | null>`
    - `open(privyUserId: string): Promise<AccountDoc>`. On a duplicate-key race it re-reads by `privyUserId` and returns the winner. `#claim` is deleted.
- Produces, in `Sessions`:
    - `open(identity: Identity): Promise<AccountDoc>`
    - `existing(identity: Identity): Promise<AccountDoc>`. With no account it throws `wallet_not_connected` "Open your account first."
    - `#authorize` is deleted.
- Produces, over HTTP, where every route acts on the signed-in user:
    - `POST /v1/account` returns `WalletSession`, opening the account on first use.
    - `GET /v1/account` returns `AccountView`.
    - `GET /v1/account/deposits` returns `DepositPage`.
    - `POST /v1/account/deposits` returns `DepositReceipt`.
    - The `/v1/wallets/connect` and `/v1/accounts/:wallet*` routes go.
- Produces, in the client:
    - `AccountClient.connect(userId: string, accessToken: () => Promise<string | null>)` is keyed by the Privy user ID. `#bind` emits `"account:open"` with `{}`.
    - `PrivyAccountProvider` connects when `ready && authenticated && user?.id`.
- Produces, in `serve.ts`:
    - `/seed` calls `accounts.open(userIdOf(address))`.
    - `/account` calls `accounts.find(userIdOf(address))`.
    - The control API stays address-based, so `e2e/backend.ts` is unchanged.

- [ ] **Step 1: Write the failing tests.** Add or rewrite these:
    - `socket.test.ts`:
        - `"account:open binds the signed-in person's account without a wallet address"`: ack `ok`, with a `depositAddress`. A second `account:open` returns the same `depositAddress`.
        - `"one account per person, however many wallets they've linked"`: `privy.setUser(userId, [w1, w2])`. Two sockets for that user get the same `depositAddress`, and `accounts.countDocuments({ privyUserId: userId })` is `1`.
        - `"a person's deposits aren't pushed to someone else"`: two users each open an account. A credit to A's address reaches A's socket and not B's.
        - `"a new connection with another person's token binds that person's account"`: A opens, then disconnects. A new socket with B's token opens a different `depositAddress`, and A's next credit isn't pushed to it.
    - `hardening.test.ts`:
        - `"binding needs no answer from Privy's API"`: with `privy.failLookups(10, 500)`, `account:open` is `ok`, and `privy.userLookups` doesn't grow.
        - Replace the "wallet moves between users" and "someone else's wallet isn't let through" cases with `"an account stays with its person when a wallet is relinked to someone else"`. User A opens an account. `privy.setUser(B, [A's wallet])` follows. B's `account:open` gives a different `depositAddress`, and A's account keeps its balance.
    - `http.test.ts`: the four new routes, including `GET /v1/account` before any open returning `wallet_not_connected`. Delete the old `/v1/wallets/connect` and `/v1/accounts/:wallet*` cases.
    - Update the existing `findOne({ wallet })`, `find(user.wallet)` and `.account.wallet` uses in `deposits.test.ts`, `deposits-scan.test.ts` and `socket.test.ts`. They find by `privyUserId: user.userId`.
- [ ] **Step 2: Run them and confirm they fail.** `cd server && npx vitest run test/integration/socket.test.ts test/integration/http.test.ts test/integration/hardening.test.ts`. Expected: FAIL, with the `account:open` ack missing (a timeout) and 404 on `/v1/account`.
- [ ] **Step 3: Implement** the interfaces above.
    - `sockets.ts`: `boundAccount` and the `deposit:credited` filter keep comparing `account.privyUserId` with `identity.userId`, which is now the account's own key. Reword their messages to "Open your account first."
    - `views.ts`: `accountView` drops `wallet`.
    - The `ensureIndexes` drop of `wallet_unique` ignores "index not found" (Mongo code 27).
- [ ] **Step 4: Run them and confirm they pass,** with the whole server suite (`cd server && npx vitest run`) and `npx tsc --noEmit`. Then run the whole e2e suite in the isolated copy. Expected: all pass. The client now binds with `account:open`.
- [ ] **Step 5: Commit** the files above, with the message "Key accounts by person, and bind the socket without a wallet address".

### Task 2: Merge each person's accounts, and keep old deposit addresses crediting

**Files:**
- Create: `server/src/db/migrations.ts`, `server/test/integration/migration.test.ts`
- Modify:
    - `server/src/db/mongo.ts`:
        - `AccountDoc.formerDepositAddresses?: string[]`
        - `LedgerEntryDoc.kind: "deposit" | "merge"`
        - `connectDatabase` runs the migration before `ensureIndexes` and returns its report.
        - Index changes: `privy_user` becomes `privy_user_unique` (unique, after dropping the old name), plus `former_deposit_addresses_unique` (unique, partial on `formerDepositAddresses` existing).
    - `server/src/deposits/registry.ts`: `add`, `load` and `refresh` map every former address to the account too.
    - `server/src/deposits/ledger.ts:104-107`: the credit filter matches `depositAddress` or `formerDepositAddresses`.
    - `server/src/deposits/deposits.ts:89`: the report check accepts former addresses.
    - `server/src/server.ts`: logs the report once at startup.

**Interfaces:**
- Consumes `AccountService.open(privyUserId)` (Task 1).
- Produces, in `server/src/db/migrations.ts`:
    - `export type MigrationReport = { rekeyed: number; merged: number }`
    - `export async function mergeAccountsByPerson(client: MongoClient, collections: Collections): Promise<MigrationReport>`
- Produces, in `mongo.ts`:
    - `Database` gains `migration: MigrationReport`.

**Merge rules** (the algorithm the tests don't fully pin):
1. **Group** accounts by `privyUserId`. For each group with two or more accounts, the survivor is the earliest `createdAt`, with the lowest `depositIndex` breaking a tie.
2. **Merge each other account into the survivor in its own transaction:**
    1. `$inc` the survivor's balance by the other's balance, and bump its `version`.
    2. Insert one ledger entry `{ kind: "merge", accountId: survivor, amount: other.balance, balanceAfter, refId: other._id }`. The unique `(kind, refId)` index makes a rerun a no-op.
    3. Re-point the other's `deposits` and `ledger` rows to the survivor.
    4. `$addToSet` the other's `depositAddress` and its own former addresses onto the survivor's `formerDepositAddresses`.
    5. Delete the other account.
3. **Re-key** with `$unset: { wallet: "" }` on every account that still has the field. `rekeyed` counts those.

- [ ] **Step 1: Write the failing tests** in `migration.test.ts`. Each one inserts raw account, deposit and ledger docs with a `MongoClient` into the database that `startStack` will use, then starts the stack:
    - `"a person's single account is re-keyed and keeps its address and balance"`: the doc loses `wallet`. That user's `account:open` returns the same `depositAddress` and balance.
    - `"a person's two accounts merge into the older, through the ledger"`: A is older with 3 USDC and B has 2 USDC. Afterwards:
        - There is one account, with balance 5 and A's `depositAddress`.
        - One `merge` ledger entry has `refId` B's id.
        - B's deposits are listed in the survivor's history.
    - `"USDC sent to a merged account's old address credits the survivor"`: after the merge, send 1 USDC to B's old address on the emulator. The survivor's balance becomes 6, and its socket receives `deposit:credited`.
    - `"running the migration again changes nothing"`: call `mergeAccountsByPerson` a second time. The report is `{ rekeyed: 0, merged: 0 }`, and the ledger count is unchanged.
    - `"a merge cut short by a restart completes once"`: commit the first merge of a three-account person by hand, leaving one to go, then start. One account remains, the balance is the sum, and no merge is counted twice.
    - `"one person can't end up with two accounts"`: after startup, inserting a second account with the same `privyUserId` throws a duplicate-key error.
    - `"two first-time opens at once make one account"`: two sockets of a new user emit `account:open` together. Both get the same `depositAddress`, and there's one doc.
- [ ] **Step 2: Run them and confirm they fail.** `cd server && npx vitest run test/integration/migration.test.ts`. Expected: FAIL. Two accounts remain, and `mergeAccountsByPerson` isn't defined.
- [ ] **Step 3: Implement** the migration by the merge rules above, along with the registry, ledger and report changes for former addresses, and the index changes.
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`, then the whole e2e suite in the isolated copy. Expected: all pass.
- [ ] **Step 5: Commit** the files above, with the message "Merge each person's accounts, and keep their old deposit addresses crediting".
