# Solana Sign-in and Linking Implementation Plan (spec step 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can sign in with a Solana wallet or an EVM wallet, and add the other kind whenever they choose. Either way they reach the same per-person account. The header shows the wallet in use: its network logo and its address.

**Architecture:** Privy shows EVM and Solana wallets (`walletChainType: "ethereum-and-solana"`), with Privy's Solana connectors. After plan 2a, the account is keyed by the Privy user, so a Solana-first user binds like anyone else and needs no server change for sign-in.
- **The active wallet.** "The wallet in use" is the one the user signed in with, until they link another; then it's the linked one. It's remembered per person. Privy's Solana wallets carry no `connectedAt`, so Privy can't order wallets across kinds and the app has to track this itself.
- **Adding a wallet.** "Connect another wallet" in the sidebar uses Privy's `linkWallet` with a chain-type filter. Today's deposit path needs an EVM wallet, so for a Solana-only user the Deposit button opens the EVM link flow instead of the form.

**Deferred, on purpose:**
- **The deposit list's "Connect a Solana wallet" / "Connect an EVM wallet" rows** belong to the multi-coin deposit list, built in `tradeeverything-00`'s amended Task 10. Until then, Deposit itself offers the EVM link.
- **The server accepting linked Solana wallets** (`authorizeWallet` and the linked-wallet list with `chain_type: "solana"`, compared case-sensitively) lands with its first user, the step 3 balances plan.

**Tech Stack:** Privy `@privy-io/react-auth` 3.48 and its `./solana` entry, Wallet Standard (`@wallet-standard/app`), viem, Next.js 16, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-wallets-accounts-instant-balances-design.md`, section 3, plus the header rule from section 1. It depends on plan 2a (`docs/superpowers/plans/2026-10-09-one-account-per-person.md`) being complete.

## Global Constraints

- **Commits:** commit by path (`git commit -- <paths>`), with no `Co-Authored-By` trailer. Don't touch `tradeeverything-00`'s files (`server/src/crosschain/*`, `server/src/config.ts`, `server/test/support/{anvil,global-setup,source-chains}.ts`).
- **Running tests:** run everything from an isolated copy with its own ports, as in plan 2a: `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641`.
- **Packages:**
    - `@privy-io/react-auth/solana` statically imports `@solana-program/memo`, which isn't installed. Add it with `npm install @solana-program/memo@^0.8.0`, or whatever version satisfies react-auth's peer range `>=0.8.0`.
    - Declare `@solana/kit`, `@solana-program/system` and `@solana-program/token` as direct dependencies at the versions already in `node_modules`: 5.5.1, 0.10.0 and 0.9.0.
- **Login wallet list**, exactly: `["detected_ethereum_wallets", "metamask", "rainbow", "coinbase_wallet", "wallet_connect", "detected_solana_wallets", "phantom", "solflare", "backpack"]`. Coinbase keeps `eoaOnly`.
- **Copy:**
    - The sidebar action: "Connect another wallet".
    - The Deposit button's accessible name stays exactly "Deposit", which a peer spec relies on. Its `title` for a user with no EVM wallet is "Deposits need an EVM wallet for now. Connect one."
- **The dashboard:** Solana sign-in must also be enabled in the Privy dashboard. That's the product owner's step, and the e2e mock turns `solana_wallet_auth` on.

## Review Focus

1. **A Solana-only user clicks Deposit.** They're offered to connect an EVM wallet, never a dead or failing form. Test in Task 2.
2. **A Solana address shown or used where an EVM one is expected.** The base58 address is case-sensitive, so it's never lowercased or checksummed. The Arc balance read (`useUsdcBalance`) skips it, with no error and no request. Test in Task 1.
3. **A person who links a second wallet, then reloads.** The header still shows the linked wallet, because the active wallet is remembered. Test in Task 2.
4. **The user dismisses the link modal.** Nothing changes, the active wallet stays, and no error shows. Test in Task 2.
5. **The same Phantom extension exposes both EVM and Solana.** Signing in with Phantom on Solana binds the same per-person account as any other wallet. Covered by plan 2a's binding plus Task 1's sign-in test.

---

### Task 1: Sign in with a Solana wallet

**Files:**
- Modify:
    - `package.json` and `package-lock.json`: the Solana packages above
    - `components/wallet-provider.tsx`:
        - `walletChainType: "ethereum-and-solana"`
        - `externalWallets.solana.connectors: toSolanaWalletConnectors()`
        - the wallet list above
    - `components/arc-wallet.ts`: `useActiveWallet`
    - `components/wallet-sidebar.tsx` and `components/connect-wallet.tsx`: the header and the wallet button use the active wallet
    - `e2e/privy-mock.ts`
    - `server/test/support/fake-privy.ts`: `setUser` takes typed wallets
    - `server/test/e2e/serve.ts`: `/users` and `/seed` accept a Solana address
    - `e2e/backend.ts` if its address check rejects base58
- Test: `e2e/solana.spec.ts` (new)

**Interfaces:**
- Consumes, from plan 2a: `account:open`, accounts keyed by `privyUserId`, and `AccountClient.connect(userId, …)`.
- Produces, in `components/arc-wallet.ts`:
    - `export type ActiveWallet = { kind: "evm" | "solana"; address: string } | undefined`
    - `export function useActiveWallet(): ActiveWallet`
        - Returns the stored active wallet for this Privy user (localStorage key `active-wallet:<userId>`, read in try/catch) if it's still linked. Otherwise it's `user.wallet`, with `chainType` `"solana"` giving `kind: "solana"`.
        - Task 2 adds the setter.
    - The header passes `network = kind === "solana" ? "solana" : useWalletNetwork(address)` to `NetworkLogo`, and `shortenAddress(address)` without changing its case.
- Produces, in `e2e/privy-mock.ts`:
    - `installSolanaWallet(page, address: string)`: a Wallet Standard wallet named "Phantom" with chains `["solana:mainnet"]` and the features `standard:connect`, `standard:events` and `solana:signMessage` (returning 64 bytes). It registers through the `wallet-standard:register-wallet` event and again on `wallet-standard:app-ready`.
    - `mockPrivy` gains:
        - `/siws/init`, returning `{ nonce }`
        - `/siws/authenticate`, the same shape as SIWE's, with the user's `linked_accounts` holding `{ type: "wallet", chain_type: "solana", address, wallet_client_type: "phantom", connector_type: "solana_adapter", … }`
        - `solana_wallet_auth: true` in `appConfig`
    - The mocked user is built from the address kind that signed in.
- Produces, in `server/test/support/fake-privy.ts`:
    - `setUser(userId: string, wallets: Array<string | { address: string; chain: "ethereum" | "solana" }>)`. Plain strings stay Ethereum, so existing callers are unchanged.

- [ ] **Step 1: Write the failing test** in `e2e/solana.spec.ts`. The page uses a Solana address and `installSolanaWallet`, with no EVM wallet.
    - `"signing in with a Solana wallet opens the account, with Solana in the header"`:
        - Click Connect wallet, then "Phantom".
        - The sidebar opens and the balance loads, so the account is bound.
        - The header image is named "Solana".
        - The header text shows the first 6 and last 4 characters of the base58 address, in their original case.
        - No request went to the Arc RPC for `balanceOf`: record `ARC_RPC` requests with `page.route`.
- [ ] **Step 2: Run it and confirm it fails.** Expected: the modal offers no Solana wallet, so "Phantom" isn't found.
- [ ] **Step 3: Implement** the files above. If `npm run build` reports any other missing Solana package, add it at a version in react-auth's peer range, and record a ruling.
- [ ] **Step 4: Run** `e2e/solana.spec.ts`, then the whole e2e suite and `npx tsc --noEmit -p .` and `npx eslint`. Expected: all pass. The EVM specs are unchanged, since the EVM wallets are still listed.
- [ ] **Step 5: Commit** the files above, with the message "Let people sign in with a Solana wallet".

### Task 2: Add the other kind of wallet

**Files:**
- Modify:
    - `components/arc-wallet.ts`: `useActiveWallet` gains `setActive`
    - `components/wallet-sidebar.tsx`: "Connect another wallet", and Deposit for a user with no EVM wallet
    - `components/account-provider.tsx`: deposit uses the EVM wallet even when the active one is Solana
    - `e2e/privy-mock.ts`: `/siwe/link`, `/siws/link`, `/siwe/init` and `/siws/init` during a link
- Test: `e2e/solana.spec.ts`, `e2e/wallet-sidebar.spec.ts`

**Interfaces:**
- Consumes `useActiveWallet` and `installSolanaWallet` (Task 1).
- Produces, in `components/arc-wallet.ts`:
    - `useActiveWallet()` returns `ActiveWallet & { setActive(wallet: { kind: "evm" | "solana"; address: string }): void }`
    - `export function useLinkOtherWallet(): (kind: "evm" | "solana") => void`. It calls Privy's `useLinkAccount({ onSuccess })`, whose `linkWallet({ walletChainType: kind === "evm" ? "ethereum-only" : "solana-only" })`. On success it sets the linked wallet active. On `onError` or a dismiss it does nothing.
- The sidebar's "Connect another wallet" opens the link flow for the kind the user doesn't have yet. If they have both kinds, it offers EVM.
- Deposit for a user with no linked EVM wallet calls `linkOther("evm")` instead of opening the form. It keeps the name "Deposit" and gains the title from Global Constraints.

- [ ] **Step 1: Write the failing tests:**
    - `solana.spec.ts`, `"a Solana-first user connects an EVM wallet from Deposit, then deposits"`:
        - Sign in with Solana and click Deposit.
        - Privy's modal shows "MetaMask"; choose it.
        - The header now shows the EVM network's logo (Ethereum, from the mock wallet).
        - Deposit now opens the amount form.
    - `solana.spec.ts`, `"the linked wallet is still the one in use after a reload"`: after linking as above, `page.reload()`. The header still names the EVM network.
    - `solana.spec.ts`, `"dismissing the link modal changes nothing"`: sign in with Solana, click Deposit, then close Privy's modal. The header is still "Solana", no `role=status` text appears, and Deposit still offers to connect.
    - `wallet-sidebar.spec.ts`, `"an EVM-first user connects a Solana wallet from the sidebar"`:
        - `installSolanaWallet` too, then connect with MetaMask.
        - Click "Connect another wallet" and choose "Phantom".
        - The header shows "Solana", and the balance still loads, from the same account.
- [ ] **Step 2: Run them and confirm they fail.** Expected: "Connect another wallet" isn't found, and Deposit for a Solana-only user opens the form.
- [ ] **Step 3: Implement** the interfaces above. `deposit` in `account-provider.tsx` picks the EVM `ConnectedWallet` linked to the user (as today), whatever the active wallet is.
- [ ] **Step 4: Run** both specs, then the whole e2e suite, `tsc` and `eslint`. Expected: all pass.
- [ ] **Step 5: Commit**, with the message "Let people add the other kind of wallet, from the sidebar or from Deposit".
