# Coin List, Instant Balances and Bridged Deposits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking Deposit opens a list of every supported coin in every wallet the person has linked, zero balances included. The list shows balances the server pushed at sign-in, with no loading state. A coin on Ethereum or BNB Chain then deposits into the Arc account through a bridge, step by step.

**Architecture:** This plan supersedes Tasks 6–11 of `docs/superpowers/plans/2026-10-09-multichain-deposits-phase-1.md`. Tasks 1–5 of that plan are built: the catalog, source chains, `readBalances`, the bridge contract with `FakeBridge`, and Relay and Across.

This plan works in two halves:

- **Tasks 1–6** are step 3 of the accounts design. The server reads every catalog coin in every linked EVM and Solana wallet. It pushes them when the socket binds, and again on a Deposit click, at most once every 30 seconds. The browser caches the last snapshot, and Deposit opens the coin list.
- **Tasks 7–11** carry the bridged deposit flow over to one account per Privy user: orders, the tracker, the client flow, the e2e bridge harness and the UI.

**Tech Stack:**

- Server: Node ≥ 24.12 running TypeScript directly, Express 5, socket.io 4.8, MongoDB 7, viem 2.56, zod 4, vitest with anvil.
- App: Next.js 16 and React 19, Privy 3.48, motion.
- Tests: Playwright.

**Specs:**

- `docs/superpowers/specs/2026-10-09-wallets-accounts-instant-balances-design.md` (sections 4 and 5)
- `docs/superpowers/specs/2026-10-09-multichain-deposits-design.md`

## Global Constraints

### Commits and tests

- **Shared `main`.** Commit by path (`git commit -- <paths>`) with only your task's files. Commits carry no `Co-Authored-By` trailer. Other sessions commit to `main` too: never reset, stash or rebase.
- **Running tests.** Always run tests from an isolated copy, never the main directory, because peers share ports and `.next`.
    - Build the copy: `git archive HEAD | tar -x` into a scratch directory, then `cp -cR` both `node_modules` and `server/node_modules`, then overlay your changed files.
    - Server: `cd server && npx vitest run <files>` and `npx tsc --noEmit`.
    - E2E: `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test`. Ports 3640, 4640 and 4641 belong to a peer.
- **Comments and style.** One line each. Match each file's 4-space indentation and Prettier style. Server imports use `.ts` extensions.

### Accounts and wallets

- An account is keyed by `privyUserId`. The socket binds with `account:open`, by token only.
- Solana addresses are base58 and case-sensitive: compare them exactly, never lowercase them. EVM addresses are compared case-insensitively.
- `depositWalletAddress(user, active)` in `components/arc-wallet.ts` stays the single pick for both the deposit and the balance the form shows. Picking a coin row makes that row's wallet active (`setActive`).

### Things other sessions depend on

- `components/deposit-button.tsx` keeps its accessible name exactly "Deposit", its `data-phase` (`idle`, `running`, `done`, `error`), and `aria-busy` while running.
- `useAccount().history` keeps its shape (`components/pnl/use-activity.ts` reads it); only additive fields are allowed.
- `server/src/protocol.ts` stays import-free, because the client imports it as types.

### Balances

The product owner's words: "server push at login BUT update it everytime user clicks on deposit. Update silently, there is also a silent rate limit where nothing happens. Set it to 30 seconds. No loading needed."

- **Push.** The server reads and pushes when `account:open` binds.
- **Refresh.** On a Deposit click the client sends `balances:refresh`. Within 30 s of the account's last read, nothing happens. The client skips sending, and the server enforces the limit itself.
- **New wallets.** A wallet the server hasn't read yet is read at once, regardless of the limit.
- **Display.** No spinner and no loading text. A coin that has never been read shows no amount, never $0. A network that fails to read keeps its last values.
- **Cache.** The browser keeps the last snapshot in `localStorage` under `balances:<privyUserId>`, wrapped in try/catch. A reload shows it at once.
- **After a deposit.** The sent coin's shown balance drops by the sent amount at once. The next read corrects it.

### Coins and money

| Coin           | Address or mint                                     | Decimals |
| -------------- | --------------------------------------------------- | -------- |
| Ethereum ETH   | native                                              | 18       |
| Ethereum USDC  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`        | 6        |
| Ethereum USDT  | `0xdAC17F958D2ee523a2206206994597C13D831ec7`        | 6        |
| BNB Chain BNB  | native                                              | 18       |
| BNB Chain USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`        | 18       |
| BNB Chain USDT | `0x55d398326f99059fF775485246999027B3197955`        | 18       |
| Arc USDC       | native                                              | 18       |
| Solana SOL     | native                                              | 9        |
| Solana USDC    | mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6        |

- There is no USDT on Arc.
- **Bridging.** A quote is accepted only if it pays native USDC on Arc, checked by address (`0x3600000000000000000000000000000000000000` or the zero address), never by symbol. Quotes run in parallel with a 3 s timeout, and the best USDC output wins.
- **No fees of ours (0%).** Never send app-fee, referral or affiliate parameters.
- **Crediting.** The existing Arc watcher stays the only code that credits a balance. Arc USDC on the wire is an 18-decimal `UsdcAmount` string.
- **Deposits from Solana are not in this plan.** Solana coins are listed with their balances but can't be deposited yet.

### Copy

- The coin list: `aria-label="Coins to deposit"`.
- A coin row is a button named `"{symbol} on {chainName}"`, then `", {amount} {symbol}"` when the amount is known, then `", {usd}"` when the price is known. When the person has two wallets of the same kind, `" · {short wallet}"` is added.
- The rows for a missing wallet kind: "Connect a Solana wallet" and "Connect an EVM wallet".
- A row that can't be deposited from yet has the title "Deposits from {chainName} aren't open yet." and `aria-disabled`.
- A row whose known amount is zero is dimmed and `aria-disabled`, with the title "Nothing to deposit".
- Bridge steps: "Sending", "In a block", "Bridging to Arc", "Added". Outcomes: "Didn't go through", "Refunded to your wallet".
- A bridged history row reads "+$300.00 · 0.1 ETH on Ethereum".

## Review Focus

1. **Two linked wallets of the same kind.** Each wallet gets its own rows, which show the short address. Picking a row deposits from that wallet and shows that wallet's balance. Task 6.
2. **One network fails or rate-limits (429)**, for example the Solana RPC. That network's rows keep their last values, and the other networks still update. Tasks 1, 2 and 4.
3. **Deposit clicked in a burst, or from two tabs.** The account gets at most one read per 30 s, and every bound socket of the account receives the push. Task 4.
4. **A private window where `localStorage` throws.** The list still works, just without a cache. Task 5.
5. **A wallet is relinked to another Privy user.** The old account stops getting that wallet's balances on its next click read, because linked wallets are fetched fresh on a click. Task 4.

---

### Task 1: Catalog grows Solana coins; one failed network no longer sinks the read

**Files:**

- Modify: `server/src/crosschain/catalog.ts`, `server/src/crosschain/balances.ts`, `server/src/crosschain/providers/relay.ts`, `server/src/crosschain/providers/across.ts`, `server/src/protocol.ts`
- Test: `server/test/unit/crosschain-catalog.test.ts`, `server/test/integration/crosschain-balances.test.ts`, `server/test/unit/crosschain-relay.test.ts`, `server/test/unit/crosschain-across.test.ts`

**Interfaces:**

- Produces in `catalog.ts`:

```ts
export type ChainKey = "ethereum" | "bnb" | "arc" | "solana";
export type Coin = {
    key: string;
    chain: ChainKey;
    chainId: number | null; // null for Solana
    chainName: string; // "Ethereum" | "BNB Chain" | "Arc" | "Solana"
    symbol: string;
    token: Address | null; // EVM token contract; null for native coins and for Solana
    mint: string | null; // Solana SPL mint; null elsewhere
    decimals: number;
    gasReserve: bigint;
};
// COINS gains, after "arc:USDC":
//   "solana:SOL" (native, 9 decimals, gasReserve 0.01 SOL)
//   "solana:USDC" (mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, 6 decimals)
export const EVM_COINS: readonly Coin[]; // chain !== "solana"
export const SOLANA_COINS: readonly Coin[]; // chain === "solana"
```

- Produces in `protocol.ts`, replacing today's `CoinBalance`:

```ts
export type CoinBalance = {
    coin: string;
    chain: "ethereum" | "bnb" | "arc" | "solana";
    chainId: number | null;
    chainName: string;
    symbol: string;
    decimals: number;
    wallet: string; // the address it was read for: EVM checksummed, Solana as given
    amount: string | null; // null when this read failed or never happened
    spendable: string | null;
    usd: number | null;
};
```

- `readBalances` (EVM) reads `EVM_COINS` only and returns the new shape.
    - Reads settle per chain (`Promise.allSettled`). A chain whose read fails returns its rows with `amount`, `spendable` and `usd` set to `null`.
    - `readBalances` never throws for an RPC failure.
- Relay's and Across's `supports(coin)` become true only for `coin.chain === "ethereum" || coin.chain === "bnb"`.

- [ ] **Step 1: Write the failing tests:**
    - The catalog lists both Solana coins with `chainId: null`, `token: null` and the mint. `EVM_COINS` has 7 coins and `SOLANA_COINS` has 2.
    - `parseCoinAmount(coinByKey("solana:SOL"), "1.5")` returns `1_500_000_000n`.
    - `"a chain that fails to read comes back with null amounts and the rest still read"`: point the BNB client at a closed port (`http://127.0.0.1:1`). The Ethereum and Arc rows have amounts, and every `bnb:*` row has `amount: null`.
    - Both providers' `supports` is false for `solana:SOL`.
- [ ] **Step 2: Run them in the isolated copy:** `cd server && npx vitest run test/unit/crosschain-catalog.test.ts test/integration/crosschain-balances.test.ts test/unit/crosschain-relay.test.ts test/unit/crosschain-across.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the catalog, protocol, `readBalances` and `supports` changes. Update existing assertions only where the shape changed, for example `wallet` and `chain` appearing on each row.
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit` (server). Expected: all pass.
- [ ] **Step 5: Commit** with the message "List Solana's coins, and let one failed network leave the others' balances standing".

### Task 2: Read a Solana wallet's balances

**Files:**

- Create: `server/src/crosschain/solana.ts`, `server/test/support/fake-solana-rpc.ts`
- Modify: `server/src/config.ts`, `server/.env.example`, `server/src/crosschain/prices.ts`
- Test: `server/test/integration/crosschain-solana.test.ts`, `server/test/unit/config.test.ts`, `server/test/unit/crosschain-prices.test.ts`

**Interfaces:**

- Consumes: `SOLANA_COINS` and `CoinBalance` (Task 1), `PriceFeed` (existing).
- Produces:

```ts
// config: SOLANA_RPC_URLS: string[], default ["https://api.mainnet-beta.solana.com"]
export type SolanaRpc = {
    getBalance(owner: string): Promise<bigint>; // lamports
    getTokenBalance(owner: string, mint: string): Promise<bigint>; // sum over getTokenAccountsByOwner { mint }
};
export function createSolanaRpc(
    urls: readonly string[],
    options?: { fetch?: typeof fetch; timeoutMs?: number },
): SolanaRpc;
// plain JSON-RPC over fetch, no new dependency; tries each URL in order; 10 s timeout by default
export async function readSolanaBalances(
    deps: { solana: SolanaRpc; prices: PriceFeed },
    owner: string,
): Promise<CoinBalance[]>;
// same row rules as readBalances; a failed read gives null amounts; owner kept exactly as given
```

- Test support:

```ts
export async function startFakeSolanaRpc(): Promise<{
    url: string;
    setBalance(owner: string, lamports: bigint): void;
    setTokenBalance(owner: string, mint: string, units: bigint): void;
    failNext(count: number, status?: number): void; // e.g. 429
    stop(): Promise<void>;
}>;
```

- `lifiPrices` prices Solana coins with LI.FI chain `1151111081099710`. The token is the mint, or `11111111111111111111111111111111` for SOL. Confirm that with one live read-only GET. If LI.FI rejects it, leave the Solana coins unpriced and report DONE_WITH_CONCERNS.

- [ ] **Step 1: Write the failing tests:**
    - `"SOL and USDC are read with their own decimals, and the owner's case is kept"`: 2.5 SOL reads as `amount "2.5"`, 40 USDC reads as `"40"`, and `wallet` equals the mixed-case owner.
    - `"a wallet with nothing still lists both coins at 0"`.
    - `"a 429 from the first URL falls back to the second"`.
    - `"both URLs failing gives null amounts, not an error"`.
    - The `SOLANA_RPC_URLS` default and override parse.
    - The LI.FI request for `solana:USDC` carries chain `1151111081099710` and the mint.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/crosschain-solana.test.ts test/unit/config.test.ts test/unit/crosschain-prices.test.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement** `solana.ts`, the fake RPC, the config entry and the prices mapping.
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Read a Solana wallet's SOL and USDC".

### Task 3: Know every wallet linked to a person, Solana included

**Files:**

- Modify: `server/src/auth/identity.ts`
- Test: `server/test/integration/linked-wallets.test.ts`

**Interfaces:**

- Produces in `IdentityProvider`:

```ts
linkedWallets(identity: Identity, options?: { fresh?: boolean }): Promise<{ evm: Address[]; solana: string[] }>;
authorizeWallet(identity: Identity, address: string): Promise<string>; // now also accepts a linked Solana address, compared exactly
```

- `#fetchWallets` keeps `chain_type` `ethereum` (lowercased, then checksummed on the way out) and `solana` (exactly as given).
- The 60 s cache and the dedup of concurrent fetches stay. `fresh: true` bypasses the cache.
- A string that is neither an EVM address nor base58 of 32–44 characters is `bad_request` "That isn't a wallet address."
- An unlinked address is `forbidden`.

- [ ] **Step 1: Write the failing tests**, against the fake Privy with `setUser(userId, [{ address, chain: "ethereum" }, { address, chain: "solana" }])`:
    - both lists come back, and the Solana address keeps its case
    - a linked Solana address is authorized
    - the same address lowercased is `forbidden`
    - garbage is `bad_request`
    - `fresh: true` sees a wallet linked after the first read
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/linked-wallets.test.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Know every wallet linked to a person, Solana included".

### Task 4: Push balances at sign-in, refresh them silently on Deposit

**Files:**

- Create: `server/src/balances/wallet-balances.ts`
- Modify: `server/src/protocol.ts`, `server/src/events.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/socket/sockets.ts`, `server/README.md`, `server/test/support/stack.ts`, `server/test/e2e/serve.ts`
- Test: `server/test/integration/balances-push.test.ts`

**Interfaces:**

- Consumes: `readBalances`, `readSolanaBalances`, `createSourceClients`, `createSolanaRpc`, `lifiPrices` and `fixedPrices` (Tasks 1–3 and the existing code), and `linkedWallets` (Task 3).
- Produces in `protocol.ts`:

```ts
export type BalancesView = { readAt: string /* ISO */; rows: CoinBalance[] };
// ClientToServerEvents:
"balances:refresh": (payload: Record<string, never>, ack: (r: Ack<{ read: boolean }>) => void) => void;
// ServerToClientEvents:
"balances": (payload: BalancesView) => void;
```

- Produces in `events.ts`: `"balances:updated": [{ accountId: ObjectId; privyUserId: string; view: BalancesView }]`.
- Produces in `wallet-balances.ts`:

```ts
export const REFRESH_INTERVAL_MS = 30_000;
export class WalletBalances {
    constructor(deps: {
        identity: IdentityProvider;
        bus: Bus;
        logger: Logger;
        readEvm(owner: Address): Promise<CoinBalance[]>;
        readSolana(owner: string): Promise<CoinBalance[]>;
        now?: () => number;
    });
    /** "bind": always reads. "click": reads only past REFRESH_INTERVAL_MS, or at once when a linked wallet hasn't been read yet. */
    refresh(account: AccountDoc, identity: Identity, reason: "bind" | "click"): Promise<{ read: boolean }>;
    last(accountId: ObjectId): BalancesView | null;
}
```

**Rules:**

- A `"click"` fetches linked wallets with `fresh: true`.
- Reads for one account are de-duplicated while a read is in flight.
- The new rows merge over the last ones: a `null` amount keeps the last known row for the same `(wallet, coin)`. Rows of wallets no longer linked are dropped.
- Each completed read emits `balances:updated`.
- State lives in memory, per account. The server runs one instance.

**Wiring:**

- `Overrides` gains `sources?: SourceClients`, `solana?: SolanaRpc` and `prices?: PriceFeed`. The defaults come from the config, plus `lifiPrices()`.
- `Services` gains `balances: WalletBalances`.
- Sockets:
    - After `account:open` acks, the socket calls `services.balances.refresh(account, identity, "bind")` without awaiting.
    - The new `balances:refresh` handler acks `{ read }`.
    - `balances:updated` pushes `balances` to the account's room with the same owner check as `deposit:credited`.
- `startStack` and `serve.ts` always pass local fakes, so no test reaches a public RPC:
    - sources on the chain-1 and chain-56 anvils (`inject("ethereumUrl")` and `inject("bnbUrl")` in vitest; new anvils in `serve.ts`)
    - a `startFakeSolanaRpc()`
    - `fixedPrices({ ETH: 3000, BNB: 600, SOL: 150, USDC: 1, USDT: 1 })`
    - `stack` exposes `solanaRpc`

- [ ] **Step 1: Write the failing tests**, with an injected `now`:
    - `"binding pushes every coin in every linked wallet"`: one EVM and one Solana wallet give 9 rows, with Solana amounts from the fake RPC and zeros included.
    - `"a click inside 30 s reads nothing, and after 30 s reads again"`: the ack is `{ read: false }` and nothing is pushed; then `{ read: true }` and a push.
    - `"a newly linked wallet is read at once, inside the 30 s"`.
    - `"a network that fails keeps its last values"`: `failNext` on the Solana fake; the Solana rows keep their previous amounts.
    - `"every socket of the account gets the push; another person's doesn't"`.
    - `"a burst of clicks reads once"`: five concurrent clicks give one read.
    - `"a wallet unlinked from the person drops out on the next click read"`: remove it with `setUser`, then click after 30 s; its rows are gone.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/balances-push.test.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement** the service, the protocol, the wiring, and the fakes in `stack.ts` and `serve.ts`. Document the events and `SOLANA_RPC_URLS` in `server/README.md`.
- [ ] **Step 4: Run** the whole server suite, `npx tsc --noEmit`, and the whole e2e suite in the isolated copy. Expected: all pass, with no test reaching a public RPC.
- [ ] **Step 5: Commit** with the message "Push balances at sign-in, and refresh them silently on Deposit".

### Task 5: Balances in the browser: state, cache, refresh, and the drop after a deposit

**Files:**

- Create: `lib/account/balances.ts`
- Modify: `components/account-client.ts`, `components/account-provider.tsx`
- Test: `e2e/balances.logic.spec.ts`

**Interfaces:**

- Consumes: `BalancesView`, `CoinBalance` and the `balances` / `balances:refresh` events (Task 4).
- Produces in `lib/account/balances.ts`:

```ts
export const REFRESH_INTERVAL_MS = 30_000;
export function loadCachedBalances(userId: string): BalancesView | null; // try/catch → null
export function saveCachedBalances(userId: string, view: BalancesView): void; // try/catch → no-op
export function dropAfterSend(view: BalancesView, coin: string, wallet: string, amount: string): BalancesView;
// lowers amount and spendable (never below 0); wallet compared exactly for Solana, case-insensitively for EVM
```

- `AccountClient`:
    - `AccountSnapshot` gains `balances: BalancesView | null`.
    - `connect(userId, …)` shows `loadCachedBalances(userId)` at once.
    - A `balances` push replaces the view and saves it.
    - `refreshBalances(): void` sends `balances:refresh` unless the view's `readAt` is under 30 s old.
    - After `deposit()` returns `"sent"`, it applies `dropAfterSend(view, "arc:USDC", from, amount)`.
- `Account` (provider) gains `balances: CoinBalance[] | null` and `refreshBalances(): void`. `history` is unchanged.

- [ ] **Step 1: Write the failing logic tests:**
    - The cache round-trips.
    - A throwing `localStorage` returns null and doesn't throw.
    - `dropAfterSend` lowers the right row only; it matches a Solana wallet case-sensitively and an EVM wallet case-insensitively.
    - `dropAfterSend` never goes below 0.
    - The refresh is skipped inside 30 s, using an injected clock.
- [ ] **Step 2: Run** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/balances.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the relevant guide under `node_modules/next/dist/docs/` before Next-specific code (AGENTS.md).
- [ ] **Step 4: Run** all logic tests and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Keep balances in the browser, cached, refreshed and lowered after a deposit".

### Task 6: Deposit opens the coin list

**Files:**

- Create: `components/deposit-coins.tsx`
- Modify: `components/wallet-sidebar.tsx`, `components/wallet-sidebar.module.css`, `components/deposit-button.tsx`, `components/coin-icons.tsx`
- Test: `e2e/deposit-coins.spec.ts`; also update `e2e/deposit.spec.ts` and `e2e/solana.spec.ts`, where Deposit used to open the amount field or the EVM link flow directly

**Interfaces:**

- Consumes: `Account.balances` and `refreshBalances` (Task 5), and `linkedWallets`, `useActiveWallet` and `useLinkOtherWallet` (`components/arc-wallet.ts`).
- Produces:

```ts
export function DepositCoins(props: {
    rows: CoinBalance[] | null; // null before any read: every catalog coin of every linked wallet, without amounts
    wallets: { kind: "evm" | "solana"; address: string }[];
    onPick(row: CoinBalance): void;
    onConnect(kind: "evm" | "solana"): void;
    onClose(): void;
}): JSX.Element;
```

**The list:**

- It is a list labeled "Coins to deposit". Rows are sorted by `usd` (highest first); rows without a known value go last, in catalog order.
- When rows are `null`, every catalog coin of every linked wallet shows without amounts. Use a client-side mirror of the coin keys, symbols and chain names; keep it beside the component, with a comment naming `server/src/crosschain/catalog.ts` as the source.
- Rows follow the Global Constraints copy.
- Clickable for now: `arc:USDC` rows with a non-zero or unknown amount.
    - Every other EVM coin and both Solana coins are `aria-disabled`, with the title "Deposits from {chainName} aren't open yet."
    - A known-zero row is dimmed, with the title "Nothing to deposit".
- When the person has no Solana wallet, one "Connect a Solana wallet" row stands in for the Solana coins. "Connect an EVM wallet" works the same way. These rows call `onConnect(kind)`, which runs `useLinkOtherWallet()(kind)` followed by `refreshBalances()`.
- Escape or a close button returns to the Deposit button.

**The flow:**

1. A Deposit click calls `refreshBalances()` and opens the list. The `needsEvm` branch and its title are removed from `DepositButton`; its name, `data-phase` and `aria-busy` stay.
2. Picking an `arc:USDC` row sets that wallet active (`setActive`) and opens today's `DepositForm`.
3. The form's balance comes from that wallet, through `depositWalletAddress`.

**Icons:** `coin-icons.tsx` gains BNB and USDT marks. Rows show `CoinIcon` with a small `NetworkLogo` badge.

- [ ] **Step 1: Write the failing e2e tests** in `e2e/deposit-coins.spec.ts`:
    - `"Deposit lists every supported coin, even at zero"`: for an EVM-only user, the list shows the 7 EVM rows, then "Connect a Solana wallet". "ETH on Ethereum" is `aria-disabled` with the title "Deposits from Ethereum aren't open yet." There is no loading text anywhere (`/checking|loading/i` is absent).
    - `"USDC on Arc opens the amount field for that wallet"`.
    - `"a Solana-only user sees SOL and USDC on Solana, plus Connect an EVM wallet"`.
    - `"a reload shows the cached balances before the push"`: delay the socket and assert that the amounts from the previous visit appear.
    - `"a second Deposit click within 30 s sends nothing"`: use Playwright's clock and `walletRequests`, or socket frame inspection.
    - `"two EVM wallets show the short address on their rows"`.
    - Update `e2e/deposit.spec.ts` and `e2e/solana.spec.ts` to open the list and pick "USDC on Arc" where they used to type straight into the field.
- [ ] **Step 2: Run** `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/deposit-coins.spec.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the relevant guide under `node_modules/next/dist/docs/` before Next-specific code.
- [ ] **Step 4: Run** the whole e2e suite in the isolated copy. Take screenshots of the open list on desktop and on mobile and look at them. Expected: all pass, and the list looks right.
- [ ] **Step 5: Commit** with the message "Open a list of every supported coin on Deposit".

### Task 7: Deposit orders over the socket (for one account per person)

**Files:**

- Create: `server/src/crosschain/orders.ts`, `server/src/crosschain/views.ts`
- Modify: `server/src/protocol.ts`, `server/src/db/mongo.ts`, `server/src/events.ts`, `server/src/validation.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/sessions.ts`, `server/src/socket/sockets.ts`, `server/README.md`, `server/test/support/stack.ts`
- Test: `server/test/integration/deposit-orders.test.ts`, `server/test/unit/validation.test.ts`

**Interfaces:**

- Consumes: `bestQuote`, `QuoteRequest`, `SourceTx` and `FakeBridge` (built), `authorizeWallet` (Task 3), `coinByKey` and `parseCoinAmount` (built).
- Produces, in protocol:

```ts
export type OrderState = "created" | "sent" | "in_block" | "bridging" | "delivered" | "refunded" | "failed" | "expired";
export type DepositQuoteView = { coin: string; amount: string; usdcOut: UsdcAmount; etaSeconds: number; provider: string };
export type SourceTxView = { chainId: number; to: Hex; data: Hex; value: Hex };
export type DepositOrderView = {
    id: string; coin: string; amount: string; wallet: string; usdcOut: UsdcAmount; etaSeconds: number; state: OrderState;
    sourceTxHashes: Hex[]; depositId: string | null; createdAt: string; updatedAt: string;
};
export type DepositOrigin = { coin: string; amount: string; txHash: Hex };
// DepositView gains `origin?: DepositOrigin`; WalletSession gains `orders: DepositOrderView[]` (open ones, newest first)
"deposit:quote": (payload: { coin: string; amount: string; wallet: string }, ack: (r: Ack<DepositQuoteView>) => void) => void;
"deposit:order": (payload: { coin: string; amount: string; wallet: string }, ack: (r: Ack<{ order: DepositOrderView; txs: SourceTxView[] }>) => void) => void;
"deposit:source": (payload: { orderId: string; txHashes: string[] }, ack: (r: Ack<DepositOrderView>) => void) => void;
"deposit:progress": (payload: { order: DepositOrderView }) => void; // server → client
```

- Produces, in Mongo and the bus:
    - `DepositOrderDoc`: `{ _id, accountId, coin, amount, wallet, provider, ref, usdcOut: Decimal128, etaSeconds, recipient, refundTo, state, sourceTxHashes: string[], fillTxHash: string | null, depositId: ObjectId | null, createdAt, updatedAt }`.
    - Collection `depositOrders`, named `"deposit_orders"`, with indexes `{ accountId: 1, _id: -1 }` and `{ state: 1, updatedAt: 1 }`.
    - `DepositDoc` gains `origin?: { coin; amount; txHash; orderId: ObjectId }`.
    - The bus gains `"order:updated": [{ order: DepositOrderDoc }]`.
- Produces, the service:

```ts
export class DepositOrders {
    constructor(deps: { collections: Collections; providers: readonly BridgeProvider[]; bus: Bus });
    preview(account: AccountDoc, wallet: Address, coin: string, amount: string): Promise<DepositQuoteView>;
    create(
        account: AccountDoc,
        wallet: Address,
        coin: string,
        amount: string,
    ): Promise<{ order: DepositOrderDoc; txs: SourceTx[] }>;
    reportSource(account: AccountDoc, orderId: string, txHashes: Hex[]): Promise<DepositOrderDoc>;
    open(accountId: ObjectId): Promise<DepositOrderDoc[]>;
}
```

**Rules:**

- The socket handlers call `authorizeWallet(identity, wallet)` first, which requires a linked EVM wallet. A Solana wallet is `bad_request` "Deposits from Solana aren't open yet."
- The recipient is `account.depositAddress`, and `refundTo` is that wallet.
- `"arc:USDC"` is refused with "USDC on Arc goes straight to your deposit address."
- `reportSource` only moves `created` to `sent`, idempotently. It emits `order:updated`. Another account's order is `not_found`.
- Validation:
    - `coinWalletAmount = z.object({ coin: z.string().min(3).max(32), amount: z.string().regex(/^\d+(\.\d+)?$/, "an amount such as 0.5"), wallet: z.string().trim().min(32).max(64) })`
    - `sourceReport = z.object({ orderId: /^[0-9a-f]{24}$/i, txHashes: z.array(<the existing tx hash schema>).min(1).max(4) })`
- `Overrides` gains `bridges?`. The default is Relay and Across from the config.
- `deposit:quote` gets its own limiter: 30 per minute per user.
- `startStack` passes a `FakeBridge` (rates ETH 3000, BNB 600, USDC 1, USDT 1) and exposes `stack.bridge`.

- [ ] **Step 1: Write the failing tests:**
    - `"a preview quotes without creating an order"`: 0.1 ETH gives `usdcOut "300"`.
    - `"an order pays the account's Arc address and refunds the sending wallet"`.
    - `"a wallet that isn't linked is refused"`: `forbidden`.
    - `"a Solana wallet is refused for now"`.
    - `"reporting the source sends the order once"`.
    - `"an amount with more decimals than the coin is refused"`.
    - `"USDC on Arc isn't bridged"`.
    - `"the session hands back open orders"`.
    - The validation cases for `coinWalletAmount` and `sourceReport`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/deposit-orders.test.ts test/unit/validation.test.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Open deposit orders for coins on other chains, over the socket".

### Task 8: Order tracker and progress pushes

**Files:**

- Create: `server/src/crosschain/tracker.ts`
- Modify: `server/src/server.ts`, `server/src/socket/sockets.ts`, `server/src/deposits/views.ts`
- Test: `server/test/integration/deposit-tracker.test.ts`

**Interfaces:**

- Consumes: `DepositOrders`, `DepositOrderDoc` and `order:updated` (Task 7), and `FakeBridge` and `sourceChain` (built).
- Produces:

```ts
export class OrderTracker {
    constructor(deps: {
        collections: Collections;
        providers: readonly BridgeProvider[];
        sources: SourceClients;
        bus: Bus;
        logger: Logger;
        pollMs: number;
        expiryMs?: number; /* 600_000 */
    });
    start(): void;
    stop(): Promise<void>;
    tick(): Promise<void>;
}
```

**What one pass does:**

| Order state              | What happens                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`                | `status({ ref }, null, coin)`: any stage other than `waiting` counts as `bridging`. Past `expiryMs` with no hash, the order moves to `expired`.                         |
| `sent`                   | The source receipt of the last hash decides: success moves to `in_block`, a revert moves to `failed`, and no receipt within `expiryMs` of the report moves to `failed`. |
| `in_block` or `bridging` | `status({ ref }, lastHash, coin)` decides, as below.                                                                                                                    |

| Provider stage | What happens                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`      | Moves to `bridging`.                                                                                                                                  |
| `filled`       | Stores `fillTxHash`. Once a `deposits` document with that hash exists, it sets that deposit's `origin`, stores `depositId`, and moves to `delivered`. |
| `refunded`     | Moves to `refunded`.                                                                                                                                  |
| `failed`       | Moves to `failed`.                                                                                                                                    |

- Every change is a conditional update on `{ _id, state }`, and only a successful one emits `order:updated`. A provider or RPC error leaves the order unchanged.
- Sockets push `deposit:progress` to the account's room with the owner check.
- `depositView` includes `origin`.
- `startServer` starts the tracker with `ORDER_POLL_MS` and stops it in `close()`.

- [ ] **Step 1: Write the failing tests**, with `pollMs` 100:
    - `"a bridged deposit goes through every step and is credited once"`: pushes come in the order `in_block`, `bridging`, `delivered`; the balance is 300; `origin` is `{ coin: "ethereum:ETH", amount: "0.1" }`; the ledger has one entry.
    - `"a fill credited before the provider says filled is linked once"`.
    - `"a refund ends refunded, and nothing is credited"`.
    - `"a reverted source transaction fails the order"`: code `0xfe` at `FAKE_BRIDGE_ADDRESS`.
    - `"an order nobody reported still completes when the provider knows it"`.
    - `"an unreported order expires"`.
    - `"a source transaction that never lands fails the order"`.
    - `"a failing status call leaves the order as it was"`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/deposit-tracker.test.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole server suite and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Follow each deposit order across the bridge and push its progress".

### Task 9: The bridged deposit in the client

**Files:**

- Modify: `lib/account/state.ts`, `components/account-client.ts`, `components/account-provider.tsx`
- Test: `e2e/account.logic.spec.ts`

**Interfaces:**

- Consumes: the protocol from Task 7, `ensureNetwork(wallet, chainId)` (`lib/wallet/network.ts`), and `dropAfterSend` (Task 5).
- Produces:
    - The ready state gains `orders: DepositOrderView[]` (newest first).
        - The action `{ type: "order"; order }` upserts by id and removes `expired` orders.
        - `session` takes `session.orders`.
        - `HistoryRow` gains an optional `origin`, which is additive.
    - The client methods:

    ```ts
    quote(coin: string, amount: string, wallet: string): Promise<DepositQuoteView | ApiError>;
    bridgeDeposit(coin: string, amount: string, wallet: { provider: WalletProvider; from: string; ensure(chainId: number): Promise<"ready" | "declined" | "switch_failed" | "wrong_network"> }): Promise<DepositResult>;
    ```

    - **`bridgeDeposit`** does the following:
        1. Creates the order.
        2. For each tx, runs `ensure(tx.chainId)`. `"declined"` returns `"cancelled"`; the other non-ready results are returned as they are.
        3. Sends `eth_sendTransaction` with `chainId: toHex(tx.chainId)`.
        4. Before the next tx, waits for the receipt through the wallet, polling every 1 s and giving up after 120 s with `"failed"`.
        5. Reports the hashes with `deposit:source`.
        6. Applies `dropAfterSend`.
        - A 4001 code anywhere returns `"cancelled"`.
    - `deposit:progress` dispatches `order`.
    - `Account` gains `orders`, `quote(coin, amount)` and `depositCoin(coin, amount)`.
        - Both use the wallet from `depositWalletAddress(user, active)`.
        - `depositCoin` finds the Privy wallet and passes `ensure: (id) => ensureNetwork(wallet, id)`.

- [ ] **Step 1: Write the failing logic tests:**
    - `"an order upserts by id, newest first"`
    - `"an expired order leaves the list"`
    - `"the session restores open orders"`
    - `"a bridged deposit's history row keeps its origin"`
- [ ] **Step 2: Run** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/account.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all logic tests and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "Let the app open bridged deposits and follow their progress".

### Task 10: E2E backend: source chains and a bridge the tests can step

**Files:**

- Modify: `server/test/e2e/serve.ts`, `e2e/privy-mock.ts`, `e2e/backend.ts`
- Create: `e2e/bridged-deposit.spec.ts`

**Interfaces:**

- Consumes: the sources and fakes `serve.ts` already starts (Task 4), `FakeBridge`, `sourceChain`, and the `startServer` `bridges` override (Task 7).
- Produces, in the control routes:
    - `/users` also funds 1 ETH on chain 1 and 1 BNB on chain 56 for an EVM wallet, and impersonates it there.
    - `/source/fund { address, coin, amount }`:
        - native EVM coins via `fund`
        - EVM tokens via `installToken` plus `setTokenBalance`
        - Solana coins on the fake Solana RPC
    - `/bridge/advance { address, stage }` advances the newest order of that person's account.
    - `/rpc` takes an optional `chainId` (1, 56, or Arc by default).
- Produces, in `e2e/backend.ts`:

    ```ts
    fundSource(address, coin, amount): Promise<void>;
    advanceBridge(address, stage): Promise<void>;
    chainRpc(method, params?, chainId?)
    ```

- Produces, in the mock EVM wallet: `eth_sendTransaction` and `eth_getTransactionReceipt` go to the chain the wallet is on (`0x1`, `0x38` or `0x13b2`). Any other chain still fails as today, and today's `chainId` mismatch check stays.

- [ ] **Step 1: Write the failing test:** `"the test backend funds wallets on Ethereum, BNB Chain and Solana"`. Fund `bnb:USDT` with 250 and assert `balanceOf` on chain 56 returns 250 × 10¹⁸. Fund `solana:SOL` with 2 and see it on the next balances push.
- [ ] **Step 2: Run** `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/bridged-deposit.spec.ts --project=desktop` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command, plus the whole e2e suite.** Expected: all pass.
- [ ] **Step 5: Commit** with the message "Give the browser tests source chains and a bridge they can step".

### Task 11: Bridged deposits in the UI, end to end

**Files:**

- Create: `components/deposit-progress.tsx`
- Modify: `components/deposit-coins.tsx`, `components/deposit-form.tsx`, `components/wallet-sidebar.tsx`, `components/wallet-sidebar.module.css`
- Test: `e2e/bridged-deposit.spec.ts`

**Interfaces:**

- Consumes: `Account.orders`, `quote` and `depositCoin` (Task 9), the backend helpers (Task 10), and `DepositCoins` (Task 6).
- Produces:
    - **The coin list:** EVM rows on Ethereum and BNB Chain become clickable when their amount is non-zero or unknown. Solana rows keep the title "Deposits from Solana aren't open yet."
    - **`DepositForm`** gains `coin: CoinBalance` and `preview?: (amount: string) => Promise<DepositQuoteView | ApiError>`.
        - The red-and-shake check runs against `coin.spendable`, and typed decimals are capped at `coin.decimals`.
        - With `preview`, the hint reads "≈ $300.00 in about 2 s" (debounced 400 ms).
        - `arc:USDC` keeps today's path and text.
    - **`DepositProgress({ order })`:**
        - It shows the four steps, each done, active or waiting. The active bridging step adds "about {eta}".
        - The outcomes replace the steps. It sits in the status line under the button, with `role="status"`.
    - **`DepositButton`** shows `data-phase="running"` while an order is open, keeps its name "Deposit", and moves to `done` or `error` with the outcome.
    - **History:** a row with `origin` reads "+$300.00 · 0.1 ETH on Ethereum".

- [ ] **Step 1: Write the failing e2e tests:**
    - `"a bridged deposit shows each step and lands in the balance"`:
        - Pick "ETH on Ethereum" and type 0.1. The hint reads "≈ $300.00 in about 2 s".
        - Press Deposit. The wallet is asked to switch to `0x1`, and "In a block" is shown done.
        - `advanceBridge(…, "pending")` makes "Bridging to Arc" active. `"filled"` shows "Added".
        - The balance reads $300.00, and the history row reads "+$300.00 · 0.1 ETH on Ethereum".
    - `"a USDT deposit from BNB Chain approves, then sends"`: two sends on `0x38`, and the first one's `to` is the BNB USDT address.
    - `"a refunded bridge says so and adds nothing"`.
    - `"turning down the second wallet prompt cancels quietly"`.
    - `"a reload mid-deposit picks the progress back up"`.
    - `"more than the coin's balance turns the amount red and shakes it"`.
    - `"the sent coin's balance drops at once"`.
- [ ] **Step 2: Run** `E2E_PORT=3700 E2E_API_PORT=4700 E2E_CONTROL_PORT=4701 npx playwright test e2e/bridged-deposit.spec.ts` in the isolated copy. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole e2e suite. Take screenshots of a bridged deposit in progress on desktop and on mobile and look at them. Expected: all pass, and the flow looks right.
- [ ] **Step 5: Commit** with the message "Bridge a coin from Ethereum or BNB Chain, and watch it arrive".

### Task 12: A live check with real keys (the product owner)

No agent runs this task. It spends real funds and needs the owner's wallet and keys.

1. Put these in `server/.env`: `RELAY_API_KEY`, `ACROSS_INTEGRATOR_ID`, `ETHEREUM_RPC_URLS`, `BNB_RPC_URLS`, and `SOLANA_RPC_URLS` (Alchemy and Helius).
2. Sign in. Deposit lists every coin with real balances, with no loading text.
3. Deposit 5 USDT from BNB Chain and 0.002 ETH from Ethereum. Each runs through its steps and lands in the balance, and history shows where it came from.
