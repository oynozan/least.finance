# Multichain deposits: design

2026-10-09. Agreed in conversation; this is the written version for review.

## Goal

Users fund their Arc account from the wallets they already use:

- **Ethereum:** ETH, USDT and USDC
- **Solana:** SOL and USDC
- **BNB Chain:** BNB, USDT and USDC
- **Arc:** USDC

Everything lands as USDC in the account on Arc.

- If the vault can cover a deposit, it is credited the moment the source transaction is in a block.
- If it can't, the deposit goes straight through a bridge to the user, who watches each step.

## Decisions

|                       |                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Routing               | Bridges first: Relay and Across, Circle CCTP for USDC, LI.FI as fallback. A vault sits on top for instant credit. |
| When the vault pays   | When the source transaction is in a block                                                                         |
| Vault                 | A Privy server wallet on Arc holding about $50 USDC (demo)                                                        |
| What the vault fronts | Any deposit whose USDC output fits the vault's free balance. The rest go straight to the user through the bridge. |
| Fees                  | None of ours (0%). The user gets the bridge's quoted output and pays their own network gas.                       |
| Solana                | Users connect Phantom or Solflare through Privy, linked to the same Privy user as their EVM wallet                |
| Custody               | Privy server wallets for the vault and the treasuries                                                             |
| Not included          | USDT on Arc (it doesn't exist), deposits from exchanges, withdrawals                                              |

## What exists today

- There is one account per EVM wallet. Each account has its own Arc deposit address, derived from `DEPOSIT_MNEMONIC`.
- The watcher credits any native USDC that reaches a deposit address. It reads EIP-7708 logs and credits exactly once per `(chainId, txHash, logIndex)`.
- The ledger is the only place a balance changes.
- USDC on Arc is deposited by sending it to the deposit address. That stays as it is.

## How a deposit flows

1. **Pick.** Deposit opens a list of every accepted coin on its chain.
    - Each row shows the connected wallets' balance and its USD value. The largest come first, and empty rows are dimmed.
    - If no Solana wallet is linked, the Solana rows offer to connect one.
2. **Amount.** The user types an amount. Going over the balance turns the amount red and shakes it, as today. A preview quote shows the USDC they will get and how long it takes.
3. **Order.** On Deposit, the server creates a deposit order. It quotes again with the final recipient and picks the route:
    - **Fronted**, when the quoted USDC output fits the vault's free balance. The amount is reserved. The bridge's recipient is the vault, and its refund address is our treasury on the source chain.
    - **Direct**, otherwise. The bridge's recipient is the account's Arc deposit address, and refunds go back to the user's wallet.

    The server returns the transactions to sign. For ERC-20s on EVM chains, an approval comes first.

4. **Send.** The app switches the wallet to the source chain, or uses the Solana wallet. It sends the transactions and reports the hash. The server also polls the provider's status, so a lost report still completes.
5. **Credit.**
    - **Fronted:** the server checks that the source transaction is in a block and matches the order. The vault then sends the quoted USDC to the account's Arc deposit address, and the watcher credits it.
        - The user sees Sending → Confirming → Added, and nothing about bridges.
        - The bridge refills the vault later.
    - **Direct:** the bridge delivers to the account's Arc deposit address, and the watcher credits it.
        - The user sees Sending → In a block → Bridging to Arc → Added, with the provider's time estimate.

## Exactly once, and the vault's money

- **The watcher stays the only path that credits a balance.** A vault payout and a direct bridge delivery are both just USDC arriving at a deposit address. Bridge deliveries to the vault credit nobody.
- **The vault pays an order routed through it exactly once.**
    - It pays at once if its free balance covers the order.
    - Otherwise it pays as soon as that order's own bridge delivery refills it.
    - The payout's nonce and hash are stored before it is broadcast, so a restart resumes the payout instead of repeating it.
- **Free balance** is the vault's USDC on Arc minus the reservations of unpaid fronted orders.
    - The USDC is read as the native balance (18 decimals), not the 6-decimal ERC-20 view.
    - A reservation is made atomically when the order is created. It lapses after 2 minutes if no source transaction has been seen.
- **The vault pays the quoted output it showed the user.** It absorbs the small slippage between quote and fill.
- **Payouts set `maxFeePerGas` to at least 20 gwei.** Arc silently drops transactions that bid lower.
- **An alert fires when the vault's free balance falls below 25% of its target size.**

## Failures

| What happens                                  | Fronted                                                                                                  | Direct                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The source transaction reverts or never lands | The reservation is released. The user sees "Didn't go through".                                          | The user sees "Didn't go through".                                                |
| The bridge fails and refunds                  | The refund lands in our treasury, since the user was already paid. It is logged for re-bridging by hand. | The refund returns to the user's wallet. The user sees "Refunded to your wallet". |
| The bridge is slow                            | The user doesn't see it.                                                                                 | The steps stay up with the provider's estimate.                                   |
| The source chain reorganizes after we paid    | An accepted risk for the demo. It is logged.                                                             | Nothing is credited before delivery.                                              |

## Bridge providers

All providers sit behind one interface with three operations: quote, build the transactions to sign, and report status. Quotes are requested in parallel with a 3-second timeout, and the best USDC output wins.

| Route                          | Relay | Across | CCTP                              | LI.FI    |
| ------------------------------ | ----- | ------ | --------------------------------- | -------- |
| ETH or USDT on Ethereum        | yes   | yes    | no                                | fallback |
| USDC on Ethereum               | yes   | yes    | Fast, about 20 s                  | fallback |
| SOL                            | yes   | no     | no                                | fallback |
| USDC on Solana                 | yes   | yes    | Standard, about 25 s              | fallback |
| BNB, USDT or USDC on BNB Chain | yes   | yes    | no (BNB Chain has no Circle USDC) | fallback |

Notes:

- **CCTP transfers use Circle's Forwarding Service,** which submits the mint on Arc, so we hold no Arc gas for them.
- **A quote is accepted only if its destination is native USDC on Arc.** That is checked by address, never by symbol, because Arc has lookalike "USDC" tokens.
- **Each provider's quote is checked before signing.** Its recipient and refund address must match the order.

## Balances

A server endpoint reads balances using our RPC keys:

- Ethereum and BNB Chain: one multicall for the native coin and the ERC-20s.
- Arc: the native balance.
- Solana: `getBalance` plus the wallet's token accounts.

It reads only addresses linked to the signed-in Privy user.

Token addresses and decimals live in one server catalog:

| Chain     | Token              | Address or mint                                                             | Decimals                 |
| --------- | ------------------ | --------------------------------------------------------------------------- | ------------------------ |
| Ethereum  | USDC               | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`                                | 6                        |
| Ethereum  | USDT               | `0xdAC17F958D2ee523a2206206994597C13D831ec7`                                | 6                        |
| BNB Chain | USDC (Binance-Peg) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`                                | 18                       |
| BNB Chain | USDT               | `0x55d398326f99059fF775485246999027B3197955`                                | 18                       |
| Solana    | USDC               | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`                              | 6                        |
| Arc       | USDC               | native, with an ERC-20 view at `0x3600000000000000000000000000000000000000` | 18 native, 6 in the view |

USD values come from LI.FI's token prices, cached for 60 seconds.

## Custody

- **Wallets:** the vault on Arc and two treasuries are Privy server wallets controlled by our server's authorization key. One treasury is an EVM wallet for Ethereum and BNB Chain; the other is a Solana wallet.
- **Vault limits:** a Privy policy limits the vault to plain USDC transfers on Arc of at most $100 each.
- **Treasuries:** in this phase they only receive refunds, and re-bridging those is a manual step.

## Changes by area

**Server:**

- The chain and token catalog, and the balances endpoint.
- The provider interface, with clients for Relay, Across, CCTP and LI.FI.
- Deposit orders: a Mongo collection holding each order's state machine.
- The vault service: reservations, and payouts through Privy.
- Identity accepts a Solana sender only if that wallet is linked to the same Privy user as the account's EVM wallet.
- Socket events: `deposit:quote`, `deposit:order` and `deposit:source`, plus a pushed `deposit:progress`.
- Deposit history records each deposit's source: chain, coin, amount and hash.

**App:**

- Privy configured for Solana as well as EVM.
- The coin list, and the amount step with its preview.
- Chain switching and Solana signing.
- The progress steps.
- History rows such as "+$1,604.20 · 0.5 ETH on Ethereum".

## Testing

Both scenarios (the vault covers the deposit, and the vault is short) are tested at every level.

**Server integration** runs on the existing anvil and Mongo harness. It adds:

- anvil instances for Ethereum and BNB Chain beside the Arc emulator
- a fake bridge provider that a test can advance one step at a time
- a fake Privy signer
- a mocked Solana adapter

Cases:

- The vault covers a deposit: it pays when the source transaction is in a block, and the bridge's refill restores the vault.
- The vault is short: the deposit goes direct, the steps arrive in order, and the account is credited on delivery.
- Two concurrent deposits together exceed the vault: the first is fronted and the second goes direct.
- The server restarts mid-payout: there is still exactly one payout.
- The bridge fails, on both routes.
- A reverted source transaction releases its reservation.
- Duplicate reports and late status polls change nothing.

**Browser (Playwright):** new test-backend controls set the vault's balance, mine the source transaction, and advance the bridge. That tests both "credited the moment it lands" and "waits for the bridge, step by step" in the real UI. The coin list and Solana linking are tested too.

**Live:**

- First, Sepolia and Solana devnet to Arc testnet through Circle's sandbox (USDC). The vault is a Privy server wallet funded from Circle's faucet.
- Then one small mainnet deposit per route, gated behind keys like today's live test.
- The third-party bridges are unreliable on testnets, so only CCTP runs there.

## Order of work

1. The direct path for EVM chains (Relay and Across), the coin list, the progress steps, and their tests.
2. Solana: Privy Solana wallets, Solana balances, and the Solana routes.
3. The vault on top: Privy server wallets, reservations, the fronted path, refunds, and the tests for both scenarios.
4. The CCTP and LI.FI fallbacks, then the testnet and mainnet runs.

## Provided by the product owner

- a Relay API key
- an Across integrator ID
- a LI.FI key (optional)
- RPC keys: Alchemy for Ethereum, BNB Chain and Arc, and Helius for Solana
- in the Privy dashboard: Solana enabled, server wallets, and an authorization key
- about $50 USDC on Arc for the vault
