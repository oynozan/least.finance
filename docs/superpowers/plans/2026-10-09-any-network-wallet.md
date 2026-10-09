# Any-Network Wallet Implementation Plan (spec step 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wallet works on any network. The header shows the wallet's network logo, nothing asks the user to switch until they deposit, and a deposit switches to Arc and then checks the network once more before sending.

**Architecture:** The pure network logic lives in `lib/wallet/network.ts`, where the logic tests can reach it: CAIP-2 parsing, network names and `ensureNetwork`. The logos live in `components/network-icons.tsx`. The deposit path calls `ensureNetwork` right before `AccountClient.deposit`. The off-Arc UI and Privy's `defaultChain` are removed.

**Tech Stack:** Next.js 16, React 19, Privy `@privy-io/react-auth` 3.48, viem 2.56, Playwright (e2e and `*.logic.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-wallets-accounts-instant-balances-design.md`, section 1. This plan covers only that section; steps 2 and 3 get their own plans.

## Global Constraints

- **Commits:**
    - Commit by path (`git commit -- <paths>`), since peer sessions leave their own changes staged.
    - No `Co-Authored-By` trailer.
- **Don't touch** the other sessions' files: `server/src/crosschain/*`, `server/src/config.ts` and `server/test/support/{anvil,global-setup,source-chains}.ts`.
- **Keep working for peer specs:**
    - `DepositButton`'s accessible name stays exactly "Deposit", with its `data-phase` and `aria-busy`.
    - `ConnectWallet` stays top-centered, named `/^(Wallet|Connect wallet)/`.
    - `TrendIcon` and `BarsIcon` stay in `components/icons.tsx`.
- **Running e2e:**
    - Run it from an isolated copy (scratchpad), never in the main directory. Build the copy with `git archive HEAD | tar -x`, then clone `node_modules` and `server/node_modules` with `cp -cR`, and overlay the changed files.
    - Run it with `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641 npx playwright test …`.
- **Logic tests:** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/network.logic.spec.ts`.
- **Comments:** one line each, no change narration. Match the files' 4-space indentation.
- **Network names**, by chain ID:

  | Chain ID | Name      |
  | -------- | --------- |
  | 5042     | Arc       |
  | 1        | Ethereum  |
  | 56       | BNB Chain |
  | 8453     | Base      |
  | 42161    | Arbitrum  |
  | 10       | Optimism  |
  | 137      | Polygon   |
  | 43114    | Avalanche |

  Solana is named "Solana". Any other chain ID is "Chain <id>", and no network at all is "Unknown network".
- **Deposit form copy**, exactly:
    - switch failed: "Your wallet couldn't switch to Arc. Add Arc (chain ID 5042) in its network settings, or connect another wallet."
    - wrong network: "Your wallet is on another network. Switch it to Arc and try again."

## Review Focus

1. **A session restored with the wallet locked**, or not connected in this browser. The header shows "Unknown network", and nothing crashes. Test in Task 1.
2. **`wallet.chainId` is stale** because `chainChanged` arrived after `switchChain` resolved. `ensureNetwork` trusts `eth_chainId`, not `wallet.chainId`. Logic test in Task 2.
3. **A wallet that "switches" without moving.** Nothing is sent, and the form says the wallet is on another network. Test in Task 2.
4. **Privy wrapping a decline** so its code 4001 is lost, which would turn a cancel into an error. The decline e2e test in Task 2 pins the quiet cancel.
5. **A non-EVM CAIP-2 ID** (`solana:…`) or garbage in `wallet.chainId`. It parses to `undefined`, and the header shows "Unknown network". Logic test in Task 1.

---

### Task 1: Network logos in the wallet header

**Files:**
- Create: `lib/wallet/network.ts`, `components/network-icons.tsx`, `e2e/network.logic.spec.ts`
- Modify:
    - `components/arc-wallet.ts`: add `useWalletNetwork`
    - `components/wallet-sidebar.tsx:133-137`: the header's `ArcLogo` becomes `NetworkLogo`
    - `components/wallet-sidebar.module.css`: `.arcLogo` becomes `.networkLogo`
    - `e2e/privy-mock.ts`: add `moveWalletTo` and `lockWallet`
    - `e2e/wallet-sidebar.spec.ts`

**Interfaces:**
- Produces, in `lib/wallet/network.ts`:
    - `export type Network = number | "solana"`
    - `export function chainIdOf(caip2: string): number | undefined`: `"eip155:56"` gives `56`, and anything else gives `undefined`.
    - `export function networkName(network: Network | undefined): string`: the names table above.
- Produces, in `components/network-icons.tsx`:
    - `export function NetworkLogo({ network, className }: { network: Network | undefined; className?: string })`, an inline `<svg role="img" aria-label={networkName(network)}>`.
- Produces, in `components/arc-wallet.ts`:
    - `export function useWalletNetwork(address: string | undefined): number | undefined`: the chain of the useWallets entry matching `address`, else of `wallets[0]`, else `undefined`.
- Produces, in `e2e/privy-mock.ts`:
    - `moveWalletTo(page, chainId: string)`: sets the mock's chain directly, marks it known and emits `chainChanged`, the way a user picking a network in the wallet would.
    - `lockWallet(page)`: `eth_accounts` returns `[]`, and the mock emits `accountsChanged([])`.

- [ ] **Step 1: Write the failing tests**
    - `e2e/network.logic.spec.ts`:
        - `chainIdOf("eip155:1") === 1`, `chainIdOf("eip155:42161") === 42161`
        - `chainIdOf("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")`, `chainIdOf("")` and `chainIdOf("eip155:")` are all `undefined`
        - `networkName(5042) === "Arc"`, `networkName(56) === "BNB Chain"`, `networkName("solana") === "Solana"`, `networkName(999) === "Chain 999"`, `networkName(undefined) === "Unknown network"`
    - `e2e/wallet-sidebar.spec.ts`, `"the header shows the network the wallet is on"`: connect. Then, for each of `["0x1","Ethereum"]`, `["0x38","BNB Chain"]`, `["0x2105","Base"]`, `["0x13b2","Arc"]` and `["0x3e7","Chain 999"]`, call `moveWalletTo`. After each, expect `sidebar(page).locator("header").getByRole("img", { name })` to be visible.
    - `e2e/wallet-sidebar.spec.ts`, `"a locked wallet leaves the header with an unknown network"`: connect, then `lockWallet(page)`. The header image is named "Unknown network", and the sidebar stays open.
- [ ] **Step 2: Run them and confirm they fail.** Logic: the module is not found. E2E: the header image is still named "Arc".
- [ ] **Step 3: Implement.**
    - The logos are simplified inline SVGs of each network's mark in its brand color, at the Arc mark's size. Reuse `ArcLogo` for Arc.
    - Any other chain ID, and `undefined`, get one neutral glyph.
    - The header passes `useWalletNetwork(address)` to `NetworkLogo`.
- [ ] **Step 4: Run them and confirm they pass,** together with the rest of `wallet-sidebar.spec.ts` and `pnl.spec.ts`.
- [ ] **Step 5: Commit** `lib/wallet/network.ts`, `components/network-icons.tsx`, `components/arc-wallet.ts`, `components/wallet-sidebar.tsx`, `components/wallet-sidebar.module.css`, `e2e/privy-mock.ts`, `e2e/wallet-sidebar.spec.ts` and `e2e/network.logic.spec.ts`, with the message "Show the wallet's network logo in the header".

### Task 2: Switch to Arc at deposit, and check again before sending

**Files:**
- Modify:
    - `lib/wallet/network.ts`: add `ensureNetwork`
    - `components/account-provider.tsx:59-70`: `deposit` uses it
    - `components/account-client.ts:28`: `DepositResult`
    - `components/deposit-form.tsx:84-85`: the new results' copy
    - `e2e/privy-mock.ts`: add `failNextChainSwitch` and `ignoreNextChainSwitch`
- Test: `e2e/network.logic.spec.ts`, `e2e/deposit.spec.ts`

**Interfaces:**
- Consumes `moveWalletTo` (Task 1).
- Produces, in `lib/wallet/network.ts`:
    - `export type SwitchableWallet = { chainId: string; switchChain(chainId: number): Promise<void>; getEthereumProvider(): Promise<{ request(args: { method: string }): Promise<unknown> }> }`
    - `export type NetworkCheck = "ready" | "declined" | "switch_failed" | "wrong_network"`
    - `export async function ensureNetwork(wallet: SwitchableWallet, chainId: number): Promise<NetworkCheck>`. It switches only when `chainIdOf(wallet.chainId) !== chainId`. A rejection with `code === 4001` is `"declined"`, and any other rejection is `"switch_failed"`. It then reads `eth_chainId` from the provider and returns `"wrong_network"` unless that equals `chainId`.
- Produces, in `components/account-client.ts`:
    - `export type DepositResult = "cancelled" | "failed" | "sent" | "switch_failed" | "wrong_network"`
- Produces, in `e2e/privy-mock.ts`:
    - `failNextChainSwitch(page)`: the next switch throws an `Error` with no code.
    - `ignoreNextChainSwitch(page)`: the next switch returns `null` and leaves the chain unchanged.

- [ ] **Step 1: Write the failing tests**
    - `network.logic.spec.ts` uses a fake wallet that records its `switchChain` calls and has a scripted `eth_chainId`:
        - already on 5042, and the provider says `"0x13b2"`: `"ready"`, with no switch
        - on `"eip155:1"`, the switch resolves, and the provider says `"0x13b2"`: `"ready"`, switched with `5042`
        - the switch rejects with `{ code: 4001 }`: `"declined"`
        - the switch rejects with `new Error("nope")`: `"switch_failed"`
        - the switch resolves, but the provider says `"0x1"`: `"wrong_network"`
        - `wallet.chainId` still says `"eip155:1"`, but the provider says `"0x13b2"`: `"ready"`
    - `deposit.spec.ts`. In each test, after `start(page, 1_000)`, call `moveWalletTo(page, "0x1")`.
        - `"a deposit from another network switches the wallet to Arc first"`: `submit(page, "5")`. A `wallet_switchEthereumChain` to `0x13b2` comes before exactly one `eth_sendTransaction`, and `walletChainId` is `"0x13b2"`.
        - `"declining the network switch keeps the form and sends nothing"`: `rejectNextChainSwitch`, then `submit(page, "5")`. The amount field still reads "5", `hint(page)` has no text, and no transaction is sent. Clicking Deposit again sends one.
        - `"a wallet that can't switch to Arc is told so in the form"`: `failNextChainSwitch`, then submit. The hint contains "couldn't switch to Arc", and nothing is sent.
        - `"a wallet that ignores the switch sends nothing"`: `ignoreNextChainSwitch`, then submit. The hint contains "on another network", and nothing is sent.
- [ ] **Step 2: Run them and confirm they fail.** Logic: `ensureNetwork` isn't exported. E2E: the "can't switch" hint reads "couldn't send", and the "ignores" test sends nothing but shows the generic copy.
- [ ] **Step 3: Implement.** `deposit` in `account-provider.tsx` maps the check as follows, then sends:
    - `"declined"` returns `"cancelled"`.
    - `"switch_failed"` and `"wrong_network"` are returned as they are.
    - `"ready"` gets the provider and calls `client.deposit`.

  `deposit-form.tsx` shows the two new results' copy in the existing `walletProblem` slot.
- [ ] **Step 4: Run them and confirm they pass,** together with the whole of `deposit.spec.ts`.
- [ ] **Step 5: Commit** `lib/wallet/network.ts`, `components/account-provider.tsx`, `components/account-client.ts`, `components/deposit-form.tsx`, `e2e/privy-mock.ts`, `e2e/network.logic.spec.ts` and `e2e/deposit.spec.ts`, with the message "Switch to Arc when depositing, and check the network again before sending".

### Task 3: Stop forcing Arc, and remove the off-Arc UI

**Files:**
- Modify:
    - `components/wallet-provider.tsx`: drop `defaultChain`; `supportedChains: [arc, mainnet, bsc]`, with `mainnet` and `bsc` from `viem/chains`
    - `components/connect-wallet.tsx` and `.module.css`: drop `useArcNetwork`, the `offArc` prop and `.dotOffArc`
    - `components/deposit-button.tsx`: drop `variant`; `disabled` means only that the account hasn't loaded
    - `components/wallet-sidebar.tsx`: drop the `offArc`, `switching`, `cantSwitch` and `onSwitchToArc` props and `SWITCH_FAILED`
    - `components/arc-wallet.ts`: delete `useArcNetwork`
    - `README.md`: the lines about switching on connect and "Switch to Arc"
    - `e2e/wallet-sidebar.spec.ts`
    - `e2e/privy-mock.ts`: delete helpers no test uses any more

**Interfaces:**
- Consumes `useWalletNetwork` (Task 1) and `ensureNetwork` (Task 2), which is unchanged here.

- [ ] **Step 1: Write the failing test** `"connecting leaves the wallet on its own network"` in `wallet-sidebar.spec.ts`. After connecting:
    - The wallet requests include no `wallet_switchEthereumChain` and no `wallet_addEthereumChain`.
    - `walletChainId` is `"0x1"`.
    - The header image is named "Ethereum".
    - The Deposit button is visible.
    - `dock(page)` has the accessible name exactly `` `Wallet ${ADDRESS}` ``, and its dot's background is `GAIN`.
- [ ] **Step 2: Run it and confirm it fails.** Privy still switches the wallet on connect.
- [ ] **Step 3: Implement the removals listed under Files.** Then delete the seven off-Arc tests that no longer describe the product:
    - "connecting adds Arc to the wallet and switches to it"
    - "a wallet kept off Arc is offered a switch instead of a deposit"
    - "declining the switch keeps the button ready and focused for another try"
    - "a wallet that can't add Arc is told so instead of failing silently"
    - "the dock's dot turns red while the wallet is off Arc"
    - "switching accounts in the wallet still checks its network"
    - "moving the wallet off Arc brings the switch back"
- [ ] **Step 4: Run the whole e2e suite** in the isolated copy, along with `npx tsc --noEmit -p .` and `npx eslint`. Expected: everything passes. `deposit.spec.ts` now connects on Ethereum, so every deposit in it goes through switch-at-deposit.
- [ ] **Step 5: Commit** the files listed above, with the message "Let the wallet stay on any network, and drop the off-Arc warnings".
