# Withdrawals: design

## Goal

People withdraw USDC from their account balance to one of their own wallets on Arc. The balance drops the moment they press Withdraw, and the USDC arrives a second later.

## Decisions (the product owner's, 2026-10-13)

| Topic          | Decision                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination    | USDC on Arc only. Other chains can come later.                                                                                                 |
| Recipient      | A linked EVM wallet only (through Privy). A stolen session can't send money to a stranger. A Solana-only person must link an EVM wallet first. |
| Source         | One treasury wallet on Arc. Every credited deposit is swept from its deposit address into it, and withdrawals are paid from it.                |
| Treasury key   | Index 0 of `DEPOSIT_MNEMONIC`, already reserved for the operator. It adds no exposure: that mnemonic already controls every deposit address.   |
| Short treasury | Refuse up front. The amount field's maximum is the smaller of the balance and what the treasury can pay now. Nothing is ever stuck.            |
| Limits         | None beyond the balance and a minimum of $0.01.                                                                                                |
| Fees           | 0%. We absorb Arc gas (about $0.0004 per transfer).                                                                                            |

## Why the money must be pooled

An account's balance lives in the ledger. Its USDC sits at its own deposit address on Arc, but the two drift apart:

- Predictions move balances through the ledger without moving any USDC on chain.
- Account merges move balances between accounts.

So a withdrawal can't simply be paid from the person's own deposit address. Sweeping every deposit into one treasury gives one source that always reflects the money we hold.

## The treasury and the sweeper

- **The treasury** is `keyring.operator()`, the HD account at index 0. The server logs its address at startup, so the owner can watch it and fund it.
- **Sweep on credit.** When `deposit:credited` fires, the sweeper sends that deposit address's whole native USDC balance, minus gas, to the treasury. It signs with that address's own key (`keyring.signerAt(index)`).
- **The catch-up pass.** Every 10 minutes it reads every derived address from index 1 up to the highest index ever assigned, and sweeps any whose balance is above the dust floor. This covers former deposit addresses kept by merges, deposits below the minimum, and sweeps lost to a restart.
- **Dust floor.** A sweep runs only when the balance is over 10 times its gas cost.
- **Gas.**
    - Every transaction from the server sets `maxFeePerGas` to at least 20 gwei (Arc drops lower bids) and uses a 21,000 gas limit.
    - The sweep pays its gas from the swept amount. The account was credited in full, so the operator absorbs the gas.
- **One sweep per address at a time.** Two sweeps of the same address in flight would clash on its nonce.
- **The watcher is unchanged.** A sweep moves USDC from a deposit address to the treasury. The treasury isn't a deposit address, so nothing is credited.
- **Don't send from the treasury key by hand while the server runs.** It would take a nonce the payout worker expects. To move money out, stop the server first.

## A withdrawal, end to end

1. **Limits.** Opening Withdraw sends `withdraw:limits`. The server answers `{ max, min }`, where `max` is the smaller of the account's balance and the treasury's free balance.
    - The treasury's free balance is its native USDC on chain, minus the withdrawals debited but not yet sent, minus a gas reserve of 0.01 USDC. It is never below 0.
2. **Create.** `withdraw:create { requestId, amount, to }` runs in this order:
    1. Validate the input:
        - `requestId` is a UUID from the client.
        - `amount` is a decimal string of at most 6 places, from `min` upwards.
        - `to` must be an EVM address. A Solana address is `bad_request` "USDC on Arc can't go to a Solana wallet. Link an EVM wallet to withdraw."
    2. `authorizeWallet(identity, to)` requires a wallet linked to the signed-in person. An unlinked wallet is `forbidden`.
    3. Under the server's single withdrawal lock (one server instance), check the treasury's free balance. If it can't cover the amount, refuse with `insufficient_funds` "Withdrawals can pay at most $X right now. Nothing was taken." and log a warning.
    4. In one Mongo transaction, debit the ledger (kind `withdrawal`, refId the withdrawal's id) and insert the withdrawal in state `sending`. A repeat `requestId` for the same account returns the existing withdrawal instead.
    5. Ack with the withdrawal, and push `withdrawal:update` to the account's room.
3. **Pay.** One payout worker handles `sending` withdrawals oldest first, one at a time:
    1. Take the treasury's next nonce, and sign a native transfer of the amount to `to`.
    2. Store `nonce`, `rawTx` and `txHash` on the withdrawal **before** broadcasting it.
    3. Broadcast it and wait for the receipt (Arc finalizes at once).
    4. On success, move to `sent` with the hash.
    5. On a revert, or a broadcast refused for good (for example insufficient funds), move to `failed` and refund in one Mongo transaction (ledger kind `withdrawal_refund`, refId the withdrawal's id, unique).
4. **Restart.** On start the worker resumes:
    - A `sending` withdrawal with a stored `rawTx` is broadcast again (the same hash, so it can't pay twice), and its receipt decides.
    - A `sending` withdrawal without one is signed fresh.
5. **Pushes.** Every state change emits `withdrawal:updated` on the bus. Sockets push `withdrawal:update` through the account's existing ordered push chain.

## Protocol (additive; `protocol.ts` stays import-free)

```ts
export type WithdrawalState = "sending" | "sent" | "failed";
export type WithdrawalView = {
    id: string;
    requestId: string;
    amount: UsdcAmount;
    to: string;
    state: WithdrawalState;
    txHash: Hex | null;
    createdAt: string;
    updatedAt: string;
};
export type WithdrawLimits = { max: UsdcAmount; min: UsdcAmount };
// ClientToServerEvents
"withdraw:limits": (payload: Record<string, never>, ack: (r: Ack<WithdrawLimits>) => void) => void;
"withdraw:create": (payload: { requestId: string; amount: string; to: string }, ack: (r: Ack<WithdrawalView>) => void) => void;
// ServerToClientEvents
"withdrawal:update": (payload: { withdrawal: WithdrawalView }) => void;
// WalletSession gains: withdrawals: WithdrawalView[] (the 50 newest, newest first)
```

## Data

- **The `withdrawals` collection.**
    - Fields: `{ _id, accountId, requestId, amount: Decimal128, to, state, nonce: number | null, rawTx: Hex | null, txHash: Hex | null, failure: string | null, createdAt, updatedAt }`.
    - Indexes: `{ accountId: 1, _id: -1 }`, unique `{ accountId: 1, requestId: 1 }`, and `{ state: 1, createdAt: 1 }`.
- **Ledger kinds** gain `withdrawal` (a debit) and `withdrawal_refund` (a credit). `debitInSession` and `creditInSession` accept them, and the existing `ref_unique` index keeps each refund to one.
- **Account merges** re-point withdrawals to the surviving account, as they do for deposit orders and predictions.
- **Config.** `WITHDRAW_MIN_USDC` defaults to 0.01.
- **Rate limit.** `withdraw:create` allows 10 per minute per user.

## The app

- **Withdraw button.** It sits beside Deposit in the sidebar. `DepositButton` keeps its name "Deposit", its `data-phase` and its `aria-busy`.
- **Withdraw form.** It reuses the deposit form's look: one amount field and a Withdraw button.
    - The field's maximum is `limits.max`. Going over it turns the amount red and shakes it.
    - With two or more linked EVM wallets, a wallet picker shows the short address. It defaults to the wallet in use (`depositWalletAddress`).
    - A Solana-only person sees a "Connect an EVM wallet" row instead, which runs `useLinkOtherWallet()("evm")`.
- **Optimistic.** Pressing Withdraw:
    - drops the shown balance at once
    - adds a history row "−$50.00 · to 0x12…ab" in "Sending"
    - then "Sent" on the push
- **Refusals and failures.** A refusal or a `failed` withdrawal puts the balance back and shows a notice in the status line:
    - "Didn't go through. Your balance is back."
    - or the server's message for a refusal.
- **State.** `lib/account/state.ts` gains `withdrawals` (upserted by id, ignoring an update older than the stored one) and an optimistic pending list keyed by `requestId`. `useAccount()` gains `withdrawals`, `withdrawLimits()` and `withdraw(amount, to)`. `history` keeps its shape.
- **PnL.**
    - The activity feed gains withdrawal rows (`kind: "withdrawal"`, change −amount).
    - The daily balance series counts them as money moved, like deposits, not as PnL.
    - The "Deposits" filter includes them.

## Testing

**Server (vitest, anvil Arc):**

- A withdrawal debits once, pays the linked wallet, and ends `sent`. The ledger has one `withdrawal` entry.
- The same `requestId` twice makes one withdrawal.
- An unlinked wallet is `forbidden`. A Solana address is `bad_request`. An amount under the minimum is `bad_request`.
- A treasury that can't cover the amount refuses it, and nothing is debited.
- A send that reverts or is refused ends `failed`, with exactly one refund.
- A restart with a signed but unconfirmed payout re-broadcasts the same transaction and pays once.
- A credited deposit is swept into the treasury. The catch-up pass sweeps a former deposit address and leaves dust alone.
- An account merge carries withdrawals over.
- Pushes arrive in order: `sending`, then `sent`.

**Browser (Playwright, the e2e backend):**

- Withdraw: the balance drops at once, the row shows "Sending" then "Sent", and the linked wallet's Arc balance rises.
- Over the maximum, the amount turns red and shakes. A treasury short of funds lowers the maximum.
- With two EVM wallets, the picked one receives the USDC.
- A Solana-only person sees "Connect an EVM wallet".
- A failed payout puts the balance back and shows the notice.
- The PnL feed lists the withdrawal, and the balance chart drops by it.

## Out of scope

- withdrawing to other chains or coins
- per-withdrawal or daily limits
- the vault (instant deposit credit)
- an operator tool for moving treasury funds while the server runs
