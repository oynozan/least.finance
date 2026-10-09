# Any-network wallets, one account per person, instant balances: design

2026-10-09. Agreed in conversation; this is the written version for review. It amends [the multichain deposit design](2026-10-09-multichain-deposits-design.md).

## Goal

- **The network doesn't matter.** Users connect a wallet on any network. The app never asks them to switch until they deposit, and the header shows the network their wallet is on.
- **Solana is a way in.** A user can sign in with a Solana wallet or an EVM wallet, and add the other kind whenever they like. All of a person's wallets share one account.
- **Balances are instant.** The deposit list shows every catalog coin in the user's linked wallets, read when they sign in, without any loading state.

## Decisions

|                       |                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network at connect    | Not enforced. Privy's `defaultChain` is removed, so connecting no longer prompts a switch.                                                        |
| Network at deposit    | The wallet is switched to the chosen coin's network when the deposit is confirmed, then checked again right before sending.                       |
| Header logo           | The network of the wallet in use. With several wallets, that's the most recently connected one.                                                   |
| Off-Arc warnings      | Removed: the red dot, the "on another network" label, the "Switch to Arc" button and its message.                                                 |
| Sign-in               | EVM or Solana wallets, through Privy                                                                                                              |
| Second wallet         | The user's choice: a "Connect another wallet" action in the sidebar, plus one row in the deposit list for the missing kind. Never prompted.       |
| Account               | One per Privy user. Every wallet linked to that user, EVM or Solana, deposits into the same balance.                                              |
| Existing accounts     | Re-keyed by Privy user. A user with several EVM-wallet accounts gets them merged.                                                                 |
| Balances: when        | Pushed by the server at sign-in. Refreshed on each Deposit click, unless the last read was under 30 seconds ago, in which case nothing happens. |
| Balances: display     | No spinner or loading text. New values replace old ones in place.                                                                                 |
| Balances: cache       | The browser keeps the last snapshot per user, so a reload shows it at once                                                                        |

## 1. The network doesn't matter

**Privy.** `defaultChain` goes. That option is what makes Privy prompt a switch on connect. `supportedChains` lists every network a deposit can be sent from: Arc, Ethereum and BNB Chain. Privy only switches wallets to networks on that list.

**Header.** The fixed Arc mark in the wallet header becomes the logo of the active wallet's network, with the network's name as its accessible label. The logos are inline SVGs, like the Arc mark today:

- Arc, Ethereum, BNB Chain and Solana, the catalog's networks
- Base, Arbitrum, Optimism, Polygon and Avalanche, common networks users are likely to be on
- any other network: a neutral icon labeled "Chain 1234"

**Removed.** The off-Arc warnings no longer make sense:

- the red dot and "on another network" label on the wallet button
- the "Switch to Arc" variant of the deposit button
- the "This wallet couldn't switch to Arc" message

`useArcNetwork` becomes a hook for the active wallet's network: its chain ID and a way to switch it.

**Deposit.** When the user confirms a deposit from an EVM wallet:

1. If the wallet isn't on the coin's network, the app asks it to switch.
2. Right before sending, the app reads `eth_chainId` again. If it still isn't the coin's network, the deposit stops with "Your wallet is on another network" and nothing is sent.

Step 2 closes a real risk. An Arc USDC deposit is a native-value transfer, so on Ethereum the same request would send ETH.

- Declining the switch ends the deposit quietly, as a cancel.
- A wallet that can't switch gets a message in the status line under the button.

## 2. One account per person

**The account belongs to the Privy user.**

- Accounts are keyed by `privyUserId` (unique) instead of by EVM `wallet`.
- Each account keeps one Arc deposit address, derived as today.
- The ledger, deposits and history stay attached to the account.

**Proving a wallet.** Privy verifies every wallet when it's linked: SIWE for EVM, SIWS for Solana. So a wallet linked to the signed-in user is theirs, and the app never asks for a signature of its own.

- `authorizeWallet` accepts linked wallets of `chain_type` `ethereum` and `solana`.
- Solana addresses are base58 and case-sensitive. They are compared exactly, never lowercased.

**Binding.** The socket binds to the signed-in user's account as soon as the token is verified, opening it on first use. It no longer needs a wallet address to know whose account it is. Wallet addresses matter only where a specific wallet does: reading balances, and checking a deposit's sender.

**Migration.**

- **A user with one account:** the account is re-keyed by its `privyUserId`.
- **A user with several accounts (several EVM wallets):**
    - The oldest becomes the account.
    - The others' balances move into it through the ledger, which stays the only place a balance changes.
    - Their deposit records are re-pointed to it, so one history shows them all.
    - The deposit registry maps their deposit addresses to it, so those addresses stay watched and anything sent to them credits the surviving account.
- The migration runs once at startup. It is idempotent, and logs each merge.

**A wallet moving between users.** Privy links a wallet to one user at a time. The account belongs to the user, not to any wallet, so a wallet relinked elsewhere takes nothing with it.

## 3. Signing in and adding wallets

**Login.** Privy shows EVM and Solana wallets (`walletChainType: "ethereum-and-solana"`).

| Kind   | Wallets                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| EVM    | detected extensions, MetaMask, Rainbow, Coinbase Wallet (extension and app), WalletConnect |
| Solana | detected extensions, Phantom, Solflare, Backpack                                            |

Phantom also returns for EVM, since its Ethereum side no longer needs Arc. Base stays out.

Solana external wallets need Privy's Solana connectors and their peer packages. Solana must also be enabled in the Privy dashboard, which the multichain design already lists.

**Adding the other kind.**

- **Sidebar:** a "Connect another wallet" action runs Privy's link-wallet flow for an EVM or Solana wallet.
- **Deposit list:** when the user has no Solana wallet, a single "Connect a Solana wallet" row stands in for the Solana coins. The same goes for EVM. Linking from either place reads the new wallet's balances at once.

Nothing prompts for a second wallet otherwise.

## 4. Instant balances

**What.** Every catalog coin in every linked wallet:

- each EVM address on Ethereum (ETH, USDT, USDC), BNB Chain (BNB, USDT, USDC) and Arc (USDC)
- each Solana address on Solana (SOL, USDC)

A row is a coin in one wallet, because a deposit is sent from one wallet. The wallet's short address shows only when the user has two wallets of the same kind.

Reads use `readBalances` from the multichain design (task 3 of its phase 1), with our RPC keys. Prices come from LI.FI, cached for 60 seconds.

**When.**

1. **Sign-in.** As soon as the socket binds the account, the server reads every balance in parallel and pushes `balances` to the client. No request is needed.
2. **Deposit click.** The client sends `balances:refresh`. If the account's last read is under 30 seconds old, nothing happens. The client also skips sending, and the server enforces the limit itself, which protects the RPC keys.
3. **A newly linked wallet** is read at once, outside the 30-second limit.

**Display.**

- No spinner, no "Checking your wallets…". Pushed values replace the shown ones in place.
- On a user's very first sign-in, rows show without amounts for about a second.
- A network that fails to read keeps its last values. A coin never read shows no amount, never $0.

**Cache.**

- The client stores the last snapshot in `localStorage`, keyed by Privy user.
- After a reload it shows that snapshot at once, then replaces it with the server's push.
- It is wrapped in try/catch, so private windows still work.

**After a deposit.** The sent coin's shown balance drops by the sent amount at once. The next read corrects it. Without this, a second deposit inside the 30 seconds could offer money that has already left.

## 5. Amendments to the multichain deposit design

- **Balances are pushed at sign-in.** The phase 1 plan's `deposit:balances` request is replaced by the push and `balances:refresh` above.
- **No loading text.** Its "Checking your wallets…" goes.
- **Identity.** "Accept a Solana sender only if it is linked to the same Privy user as the account's EVM wallet" becomes "accept any sender linked to the account's Privy user".
- **Solana linking** moves from a deposit-list-only step to sign-in or the sidebar, as above.
- **Order of work.** Sections 1 to 3 of this design come before the multichain phases continue, because they change the account model those phases build on.

## Testing

**Server integration** runs on the existing anvil and Mongo harness:

- an account is opened per Privy user, and binding needs no wallet address
- linked Solana wallets are accepted, with their case preserved; unlinked wallets are refused
- the migration:
    - re-keys a single account
    - merges two accounts through the ledger
    - leaves an old deposit address still crediting the merged account
    - is idempotent
- balances:
    - are pushed when the socket binds
    - ignore a refresh inside 30 seconds and re-read after
    - keep a failed network's last values
    - read a linked Solana wallet's coins only once it is linked

**Browser (Playwright):**

- The header logo follows the mock wallet's network: Arc, Ethereum, BNB Chain, Base, and an unknown chain.
- Connecting doesn't prompt a switch.
- A deposit switches the network at send time. It stops cleanly when the switch is declined or fails, and sends nothing if the network check fails.
- Signing in with a mock Solana wallet. The mock implements the Wallet Standard and is answered by mocked SIWS endpoints.
- Linking a second wallet from the sidebar and from the deposit list.
- Balances:
    - present in the deposit list right after sign-in, with no loading text
    - Deposit clicks inside and after the 30 seconds, using Playwright's clock
    - a reload shows the cached snapshot first
    - the drop after a deposit
- Existing tests of the off-Arc behavior are rewritten for switch-at-deposit.

## Order of work

1. **The network doesn't matter (section 1).** Independent of the rest; it can go first.
2. **One account per person, and Solana sign-in and linking (sections 2 and 3).** The new foundation.
3. **Instant balances (section 4).** Builds on `readBalances` from the multichain plan's task 3.
4. **The multichain deposit phases continue,** amended as in section 5.

Who builds which step is agreed between the sessions working in this repo before step 2 starts.

## Not included

- unlinking wallets
- more than one account per person
- coins beyond the multichain catalog
- withdrawals
