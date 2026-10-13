# Solana deposits and withdrawals: design

## Goal

People deposit SOL or USDC from their own Solana wallet and have it credited as USDC on their Arc account. People withdraw USDC from their balance to their own Solana wallet. Today Solana is refused in both directions (`DepositOrders.#quote` in `server/src/crosschain/orders.ts`, `authorizedWallet` and `withdraw:create` in `server/src/socket/sockets.ts`).

Research: `.superpowers/research/2026-10-14/solana-inout.md` (facts marked V were checked live on 2026-10-14). It supersedes the Solana routes planned in `2026-10-09-multichain-deposits-design.md`, which assumed Across and Privy server wallets.

## Decisions (the product owner's, 2026-10-14)

| Topic                | Decision                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deposit coins        | SOL and USDC from a linked Solana wallet.                                                                                                                    |
| Deposit route        | Relay first. CCTP v2 (Solana to Arc) is the USDC-only fallback, used only when Relay can't quote. Across is dropped for Solana until it supports the route. |
| Crediting            | Only on USDC observed at the Arc deposit address, through the existing watcher. A provider's "done" never credits.                                           |
| Withdrawal coin      | USDC on Solana, to a linked Solana wallet only (checked with `authorizeWallet`).                                                                             |
| Withdrawal route     | The Arc treasury burns with CCTP v2 `depositForBurnWithHook`; Circle's Forwarding Service mints on Solana. We hold no Solana key and no SOL.                 |
| Missing USDC account | Created by the forwarder (`includeRecipientSetup`) when the recipient has none.                                                                              |
| Withdrawal fee       | The forward fee is quoted right before burning and shown. The person receives the net amount.                                                                |
| Self-relay           | Not built. See "Not included".                                                                                                                               |
| Alerting             | None. Escalation is `logger.error`.                                                                                                                          |
| Launch               | Both directions ship behind config switches that default off, until the owner's live checks pass.                                                            |

## 1. Deposits

### 1.1 Flow

The EVM flow is unchanged: `deposit:quote`, `deposit:order`, the wallet signs, `deposit:source`, the tracker follows. Solana joins it.

1. **Quote.** `deposit:quote { coin: "solana:SOL" | "solana:USDC", amount, wallet }`. `wallet` is a base58 address, checked with `identity.authorizeWallet`. The server asks Relay, which fills straight to the account's Arc deposit address (`recipient`) and refunds to the Solana wallet (`refundTo`).
2. **Order.** `deposit:order` opens the order (`DepositOrders.create`) and returns the Solana transaction parts, not a built transaction: Relay returns instructions plus address lookup table (ALT) addresses (V).
3. **Sign.** The client builds a v0 transaction and has the wallet sign and send it (1.3). It reports the base58 signature with `deposit:source`.
4. **Follow.** The tracker checks the signature on Solana, then Relay's status by `requestId`. When Relay says filled, `#deliver` links the order to the deposit the watcher credits. Crediting itself is untouched.

### 1.2 Server changes

- **Relay provider** (`providers/relay.ts`).
    - `supports` also accepts `coin.chain === "solana"`.
    - The request uses Relay's Solana chain id 792703809, `originCurrency` `11111111111111111111111111111111` for SOL or the USDC mint, and adds `includeComputeUnitLimit: true` (documented flag).
    - `transactionStep` parses a second item shape: `data.instructions[]` (`programId`, `keys[]`, hex `data`) and `data.addressLookupTableAddresses`.
    - `status` is unchanged; it needs only `requestId`.
- **Types** (`providers/types.ts`). `SourceTx` becomes a union: the existing EVM shape with `kind: "evm"`, and `{ kind: "solana", instructions, lookupTables }`. `QuoteRequest.sender` and `refundTo` widen from `Address` to `string`.
- **Quote check** (`quotes.ts`). `checkQuote` requires `tx.chainId === coin.chainId` for EVM transactions. For Solana it requires `kind: "solana"` instead, and also that every instruction's `programId` is on an allowlist: Relay's depository program (`99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` in the live response), plus System, Token, Associated Token and Compute Budget. The allowlist is config (`SOLANA_ALLOWED_PROGRAMS`), because the server is relaying instructions the person will sign.
- **Order doc** (`DepositOrderDoc` in `db/mongo.ts`). `wallet`, `refundTo` become plain strings (base58 kept as given; EVM stay lowercase or checksummed as today). `sourceTxHashes` holds the base58 signature. No new fields.
- **Provider order, not best price.** `bestQuote` picks the highest `usdcOut`. For Solana USDC, CCTP would nearly always win and the owner wants Relay first. `bestQuote` gains a `tiers` option: providers are asked tier by tier, and a later tier is asked only when the earlier one gave no usable quote. EVM coins have one tier, so their behaviour is the same.
- **Solana RPC** (`crosschain/solana.ts`). `SolanaRpc` gains `getLatestBlockhash`, `getSignatureStatuses`, and `getAddressLookupTables` (fetch and decode the ALT accounts into address lists). All use the existing multi-URL `call`.
- **Tracker** (`tracker.ts`). `#checkSource` handles `chain === "solana"`: the signature's status is `finalized`/`confirmed` without an error (move to `in_block`), has an error (`failed`), or is unknown past `expiryMs` (`failed`; a Solana transaction past its blockhash never lands). `#checkBridge` is unchanged.
- **Blockhash.** The client has no Solana RPC. New event `solana:blockhash` (ack: `{ blockhash, lastValidBlockHeight }`), rate limited, called right before signing so the prompt time doesn't age it. The server also returns the ALT contents (`{ address, addresses[] }`) in the `deposit:order` ack, so the client doesn't need an RPC for those either.

### 1.3 How the client signs a Relay transaction

In `components/account-client.ts`, a new `solanaDeposit(coin, amount, wallet)` next to `bridgeDeposit`, using the `SwapSigner["solana"]` shape that `components/solana-signer.ts` already provides (`signAndSend(bytes)` returns the base58 signature through Privy's `useSignAndSendTransaction`).

1. Open the order; receive `instructions`, `lookupTables`.
2. Ask `solana:blockhash`.
3. Build a v0 message with `@solana/kit` (already a dependency): fee payer is the person's wallet, the blockhash, the instructions as given, compressed against the lookup tables. If the quote carried no compute-unit-limit instruction, it adds one.
4. Compile and serialize, and hand the bytes to `signAndSend`. A rejected prompt is "cancelled", as for swaps.
5. Report the signature with `deposit:source`, and drop the shown wallet balance, as `bridgeDeposit` does.

If the transaction exceeds 1232 bytes, Relay returns `SOLANA_TX_TOO_LARGE` at quote time (V); the server maps it to `unavailable` "This deposit can't be sent from Solana right now. Try a smaller route." No retry with `useV1Transaction`, which needs wallet support we haven't confirmed.

### 1.4 The CCTP fallback (USDC only)

A second `BridgeProvider`, `cctp`, supporting only `solana:USDC`, in `providers/cctp.ts`.

- **Quote.** Fee from Iris `GET /v2/burn/USDC/fees/5/26?forward=true` (to be confirmed, see Open questions). `usdcOut` is the amount less that fee. `ref` is the order id until a burn exists.
- **Transaction.** The person's wallet burns on Solana with CCTP v2 `deposit_for_burn_with_hook`: destination domain 26, `mintRecipient` the account's Arc deposit address (32 bytes, left-padded), forwarding hook data, `maxFee` from the quote. Circle mints on Arc; our servers send nothing on Arc, and no sweep is needed (the deposit address is the recipient, so the watcher credits it as for any deposit).
- **Status.** Iris `GET /v2/messages/5?transactionHash=<signature>`: no message yet is `waiting`/`pending`; `complete` with a `forwardTxHash` is `filled`. Poll no faster than the tracker already does; Iris blocks for 5 minutes past 35 requests per second.
- **Failure.** A burn that never lands expires like any other order. A burned message that never mints is not refundable by us; it is logged at `error` with the signature (see 2.5, the same reasoning applies).

### 1.5 Minimums and fees shown

- **Minimum.** `SOLANA_DEPOSIT_MIN_USD`, default 2. Relay's fixed cost is about $0.02 to $0.04 (V), so under 2 USDC the fee eats more than 1%. For SOL it is checked on the dollar value from `PriceFeed`.
- **Fee display.** The deposit form shows the quote's `usdcOut` ("You get about 9.97 USDC") and the gap to the amount sent as the fee. `DepositQuoteView` already carries `usdcOut`, `etaSeconds`, `provider`.
- **SOL for the fee.** A USDC-only wallet with no SOL can't sign (Solana fees are paid by the wallet, about 0.00001 SOL quoted). The form checks the SOL balance it already reads and says "You need a little SOL to send from Solana." before asking for the signature. Sponsoring the fee is not included.

### 1.6 Client UI

- `components/deposit-coins.tsx`: `isOpen` stops excluding Solana. The "Not open yet" group disappears for it. When the server says Solana deposits are off (the session switch below), the rows stay in "Not open yet".
- `components/deposit-form.tsx`: for a Solana coin the confirm button calls `solanaDeposit`. The wallet check "linked to the signed-in person" is the existing one.
- `components/deposit-progress.tsx`: the steps are the same (sent, in a block, bridging, delivered). The explorer link for a Solana signature points to a Solana explorer.
- The server's `WalletSession` gains `solana: { deposits: boolean; withdrawals: boolean }` from config.

## 2. Withdrawals

### 2.1 Flow

1. **Limits.** `withdraw:limits` is unchanged: `max` is the smaller of the balance and the treasury's free balance.
2. **Quote.** New `withdraw:quote { amount, to }` for a Solana `to`. The server validates the wallet (2.2), reads the fee, and answers `{ fee, receive, setup }`: `fee` is the forward fee, `receive` is `amount - fee`, `setup` is true when the recipient's USDC account will be created. The form shows it under the amount.
3. **Create.** `withdraw:create { requestId, amount, to, reviewedFee }`. Under the same single lock as Arc withdrawals: validate, re-read the fee, refuse if it rose above `reviewedFee` by more than `SOLANA_WITHDRAW_FEE_TOLERANCE` (default 0.05 USDC) with `quote_changed` and the new figures (the form shows them again, nothing taken), check the treasury, then debit the ledger and insert the withdrawal in `sending` in one Mongo transaction. A repeat `requestId` returns the existing one.
4. **Burn.** The payout worker (2.3) approves and burns from the treasury.
5. **Forward.** Circle attests and mints on Solana. The worker follows Iris until the Solana transaction is reported, then marks `sent`.

### 2.2 Validating the recipient

All before the debit:

- `to` is base58, 32 bytes, and linked to the signed-in person (`authorizeWallet`). Anything else is `forbidden` or `bad_request`.
- The wallet account (`getAccountInfo`, new on `SolanaRpc`) is either missing (a wallet never funded is fine) or owned by the System program. A program-owned account is refused: "That address can't receive USDC."
- The USDC account is derived with `findAssociatedTokenPda` from `@solana-program/token` (already a dependency). Its existence decides `setup`. The `mintRecipient` is always that derived account, never the wallet address; the base58 to 32-byte conversion has a unit test with a known vector, because a wrong `mintRecipient` is unrecoverable.
- Re-checked at create. If the account was missing at the quote and exists at create, the cheaper path is used; if it was present and is gone, `setup` is turned on. The hook creates the account idempotently, so a race between the check and the mint is harmless (to be confirmed on the live check).

### 2.3 Paying: extend `Payouts`

The treasury has one nonce sequence, and `server/src/withdrawals/payouts.ts` already owns it (`#sign` takes the next nonce above both the chain's pending count and the highest stored one). A second worker would clash with it. So Solana withdrawals go through the same serial worker.

- A withdrawal with `network: "solana"` takes two Arc transactions from the treasury: the USDC `approve` of the amount to TokenMessengerV2 (`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`), then `depositForBurnWithHook` (destination domain 5, `mintRecipient` the derived USDC account, `burnToken` the Arc USDC ERC-20 view `0x3600…0000`, `destinationCaller` and hook data as Circle's forwarding how-to specifies, `maxFee` the quoted fee, `minFinalityThreshold` 2000).
- Both are signed and stored (`approveRawTx`, `burnRawTx` with hashes and nonces) before either is broadcast, so a restart re-broadcasts the same bytes, as for Arc payouts. The worker waits for the approve receipt before broadcasting the burn.
- The ERC-20 view has 6 decimals, the ledger 18; the amount is validated to 6 places already, so it converts exactly.
- The existing refusal, "already known" and unreachable-node handling in `payouts.ts` apply to both transactions unchanged.
- The Arc `sweeper.ts` doesn't change.

### 2.4 States

```
sending ──burn mined──▶ forwarding ──Iris reports forwardTxHash──▶ sent
   │
   └─ refused / reverted before any burn ──▶ failed (refunded)
```

- `sending`: debited; the approve and burn are not both mined yet.
- `forwarding`: the burn is mined. The money is on Circle's side and can't come back to the ledger. Stored: `burnTxHash`.
- `sent`: Iris returned the Solana `forwardTxHash` for the message, and it is stored. Optionally verified with `getSignatureStatuses` (open question: whether this adds anything beyond Iris).
- `failed`: refunded once, only from `sending`. The refund is the existing `#fail`: one Mongo transaction, ledger kind `withdrawal_refund`, refId the withdrawal id, unique.

`WithdrawalState` gains `forwarding`. `WithdrawalView` gains `network: "arc" | "solana"`, `fee: UsdcAmount | null`, `receive: UsdcAmount | null`, `forwardTxHash: string | null`; `to` is the base58 address, and `txHash` stays the Arc burn hash.

### 2.5 Failure handling

- **Before submission (refund).** The fee read fails or exceeds the amount, the approve is refused or reverts, the burn is refused by the network or reverts. A reverted burn burned nothing, so the refund is safe. A burn whose broadcast got no clear answer is re-sent (same bytes) and decided by its receipt, as today.
- **After the burn is mined (never refund).** The tokens are burned. Refunding the ledger would pay twice if the mint later lands. So `forwarding` only ends in `sent`.
- **Iris unreachable or 429.** The worker backs off and keeps the state. One Iris request per tick, never more than 5 per second in total.
- **Forwarding stalls.** The worker keeps polling. At 15 minutes in `forwarding`, the view shows "Taking longer than expected" (derived from `updatedAt`, no new state), and the server logs `error` ("Solana withdrawal stalled", withdrawal id, burn hash, Iris response) once an hour until it settles. If Iris reports the forward failed, the same error is logged with the full response. There is no automatic remedy: recovery is manual with Circle's support or by retrying the mint, and is an owner action. The ledger stays debited.
- **Restart.** `forwarding` withdrawals resume polling Iris from the stored burn hash. Nothing is re-sent.
- **Treasury short.** As for Arc withdrawals: refused up front, nothing debited.

### 2.6 Fees and minimum

- **Fee.** Iris `GET /v2/burn/USDC/fees/26/5?forward=true`, plus `includeRecipientSetup=true` when `setup`. Live figures today: about 0.127 USDC (account exists) and 0.286 USDC (account created), "med" tier. The server uses the `high` tier as `maxFee` to survive a small rise, and shows the person the quoted `med` figure as the fee (V live; the endpoint is the source of truth).
- **Minimum.** `SOLANA_WITHDRAW_MIN_USDC`, default 1. It must stay well above the highest fee so the net is always positive. The server also refuses when `amount - maxFee <= 0`.
- **The person receives** `amount` minus the fee actually charged, which is at most `maxFee`. Whether the difference between `maxFee` and the actual fee is returned or retained is open (see below); the view's `receive` is recomputed from Iris when it reports the final amount.
- **Our cost.** The Arc gas for the two transactions (a few thousandths of a cent, paid in USDC from the treasury). No Solana cost.

### 2.7 Client UI: the withdraw form

`components/withdraw-form.tsx` takes `wallets: { kind: "evm" | "solana"; address: string }[]` instead of EVM addresses.

- The picker lists every linked wallet, each with its network logo and short address. The default is the wallet in use (`depositWalletAddress`).
- Picking a Solana wallet calls `withdraw:quote` as the amount changes (debounced) and shows one line under the field: "Fee 0.13 USDC · you receive 9.87 USDC". When `setup` is true: "Includes 0.16 USDC to set up your USDC account."
- The Solana minimum replaces the amount floor for that wallet. Below it the field shakes, as over the maximum.
- `quote_changed` shows the new line and asks to press Withdraw again.
- The "Connect an EVM wallet" row is shown only when the person has no wallet at all of either kind. A Solana-only person no longer needs an EVM wallet.
- History: "−$50.00 · to 7xK…9fQ" in Sending, then Forwarding ("Sending to Solana"), then Sent. `lib/account/state.ts` upserts by id as for Arc withdrawals, and gains the `forwarding` state in its ordering so an old push can't undo a new one.
- Line removed: the `BASE58_ADDRESS` refusal in `sockets.ts` `withdraw:create`.

## 3. Data

- **`withdrawals`** gains: `network: "arc" | "solana"` (missing means `arc`, so no migration), and for Solana `solana: { wallet, usdcAccount, setup, fee, maxFee, approveNonce, approveRawTx, approveTxHash, burnNonce, burnRawTx, burnTxHash, forwardTxHash, irisCheckedAt }`. `rawTx`, `nonce`, `txHash` are not used for Solana. The `{ state: 1, createdAt: 1 }` index already serves the worker.
- **`depositOrders`**: no new fields (2.1 above).
- **Ledger kinds**: no new kinds.
- **Account merges** already re-point withdrawals and orders.
- **Config** (`server/src/config.ts`): `SOLANA_DEPOSITS` and `SOLANA_WITHDRAWALS` (off by default), `SOLANA_DEPOSIT_MIN_USD` (2), `SOLANA_WITHDRAW_MIN_USDC` (1), `SOLANA_WITHDRAW_FEE_TOLERANCE` (0.05), `SOLANA_ALLOWED_PROGRAMS`, `CIRCLE_IRIS_URL` (default `https://iris-api.circle.com`). The existing `SOLANA_RPC_URLS` and Relay options are used. The default public Solana RPC is rate limited; the owner sets a paid one (below).
- **Rate limits**: `withdraw:quote` 30 per minute per user, `solana:blockhash` 30 per minute.

## 4. Errors

| Case                                              | Result                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Solana deposits or withdrawals switched off        | `unavailable`: "Solana isn't open yet."                                                          |
| Solana wallet not linked                          | `forbidden`: "That wallet isn't linked to your account."                                         |
| Deposit under the minimum                         | `bad_request`: "The smallest deposit from Solana is $2."                                          |
| Relay and CCTP both give no quote                 | `unavailable`: "No route for this deposit right now."                                            |
| Quote has an instruction from an unlisted program | The quote is dropped; if none is left, as above. Logged at `error`.                              |
| `SOLANA_TX_TOO_LARGE`                             | `unavailable`, message in 1.3                                                                    |
| Wallet has no SOL for the fee                     | Client notice before signing; nothing opened                                                     |
| Wallet prompt turned down                         | "cancelled"; the order expires on its own                                                        |
| Signature never lands                             | Order `failed` after `expiryMs`                                                                  |
| Relay refunds a deposit                           | Order `refunded`; the money returns to the Solana wallet                                         |
| Withdrawal to a program-owned address             | `bad_request`: "That address can't receive USDC."                                                |
| Withdrawal under the minimum                      | `bad_request`: "The smallest withdrawal to Solana is $1."                                         |
| Fee rose past the reviewed one                    | `quote_changed` with the new fee; nothing debited                                                |
| Treasury can't cover it                           | `insufficient_funds`, as for Arc                                                                 |
| Iris fee read fails                               | `unavailable`: "Couldn't price this right now. Nothing was taken."                               |
| Approve or burn refused or reverted               | `failed`, refunded once; the form shows "Didn't go through. Your balance is back."                |
| Forwarding stalls                                 | Stays `forwarding`; view says delayed after 15 min; `error` log hourly; no refund                |

## 5. Testing

**Server (vitest, anvil Arc):**

- *Fakes.* `FakeBridge` (`server/test/support/fake-bridge.ts`) supports Solana coins and returns the Solana step shape; `fake-solana-rpc.ts` gains blockhash, signature status, ALTs and account info; a new `fake-iris.ts` serves fees and `messages` with controllable `status`/`forwardTxHash`; a stub TokenMessenger on anvil records `depositForBurnWithHook` arguments (set up as `arc-emulator.ts` does for other contracts).
- Relay parse: a recorded live Solana response in `test/fixtures/relay` (unit test beside `crosschain-relay.test.ts`).
- Quote check: an instruction from an unlisted program is refused.
- A Solana order: created, signature reported, `in_block`, filled, delivered once the watcher credits the deposit; credited exactly once; no credit from Relay's status alone.
- Provider tiers: Relay quote fails, CCTP is used; both work, Relay wins even when CCTP pays more; EVM coins keep best-price.
- Withdrawal: debit once; the stub records the right domain, `mintRecipient` (a known base58 to bytes vector), `maxFee` and hook data, with and without `setup`; approve then burn in order; `forwarding` then `sent` with `forwardTxHash`.
- Same `requestId` twice makes one withdrawal. Unlinked wallet, program-owned wallet, under minimum: refused with nothing debited. A fee over `reviewedFee` plus tolerance gives `quote_changed`.
- A refused or reverted approve or burn ends `failed` with exactly one refund. A burn mined and then a stalled Iris never refunds.
- Restart in `sending` with stored raw transactions re-sends the same bytes and pays once; restart in `forwarding` resumes polling.
- Arc and Solana withdrawals interleaved take distinct nonces.
- Iris 429 backs off without changing state.

**Browser (Playwright, the e2e backend):**

- Solana rows are open; a Solana deposit shows the fee line and the progress steps.
- The withdraw picker lists EVM and Solana wallets; picking Solana shows the fee line and the account-setup line; a Solana-only person can withdraw with no EVM wallet.
- The balance drops at once, the row goes Sending, Sending to Solana, Sent; a failed burn puts the balance back.
- `quote_changed` re-shows the fee.

**Owner's live checks on mainnet, 1 USDC each** (set `SOLANA_DEPOSIT_MIN_USD` and `SOLANA_WITHDRAW_MIN_USDC` to 1 for the checks only; the server logs every step):

1. Relay deposit of 1 USDC from a funded Solana wallet. Check the quote, the signature, delivery, one credit.
2. Relay deposit of a small SOL amount (about $1 to $2).
3. CCTP deposit of 1 USDC (switch Relay off in config to force the fallback).
4. Withdraw 1 USDC to a Solana wallet that has a USDC account. Check `maxFee` versus the amount minted, and the final `forwardTxHash`.
5. Withdraw 1 USDC to a fresh wallet with no USDC account. Check the account is created and the amount minted.

## 6. Order of work

1. Config, `SolanaRpc` additions, the protocol types, the session switch. All Solana paths refuse while switched off.
2. Relay Solana quote and parse, the `SourceTx` union, `checkQuote` and the allowlist, tracker support for a Solana source, `bestQuote` tiers. Tests with fakes.
3. Client: `solana:blockhash`, `solanaDeposit`, deposit UI. Playwright.
4. Withdrawal: recipient checks, Iris client, `withdraw:quote`, create with `reviewedFee`, the `Payouts` extension, the `forwarding` state, views, tests with fakes.
5. Withdraw form with the wallet picker, fee line, history states. Playwright.
6. The owner's live checks 1, 2, 4, 5. Switch on after they pass.
7. CCTP deposit fallback (1.4), then live check 3.

## What the owner provides

- A paid Solana RPC URL in `SOLANA_RPC_URLS` (the public one is rate limited and unsafe for signature and ALT reads).
- A Relay API key (Relay requires one on `quote/v2` from 2026-10-02; the provider already takes `apiKey`).
- The treasury (HD index 0) funded with enough USDC on Arc for withdrawals and gas. No Solana funding is needed.
- Solana wallets holding a few USDC and some SOL for the live checks, one of them without a USDC account.
- Turning the switches on once the live checks pass, and watching the error logs for "Solana withdrawal stalled".
- Contact with Circle's support if a forward ever stalls.

## Not included

- A self-relay fallback with our own Solana payer key (minting with `receive_message` ourselves). It needs a funded hot key and monitoring, and it may be impossible for forwarded messages (see Open questions). Add it only if forwarding proves unreliable.
- Across for Solana. The route was `ROUTE_NOT_ENABLED` and `/available-routes` was empty on 2026-10-14. Re-check before reviving it.
- Alerting beyond error logs.
- Withdrawing SOL, or any coin but USDC, or to a Solana wallet that isn't linked.
- Sponsoring the Solana fee for deposits.
- Automatic refunds of a burn that Circle never mints.
- Solana-side Fast Transfer for deposits as a user choice; Relay is fast enough and the fallback uses the cheapest quoted option.

## Open questions

1. **CCTP deposit fee and forwarding from Solana.** The research verified the forward fee for Arc to Solana (`26/5`), not Solana to Arc (`5/26?forward=true`). Is Arc a supported forwarding destination from Solana, and at what fee? If not, the fallback needs our own `receiveMessage` on Arc, which means a signer other than the treasury (nonce clash with the payout worker).
2. **Building the CCTP burn instruction in the browser.** No Circle client library was confirmed for `deposit_for_burn_with_hook` on Solana that works with Privy signing. The program ids in the research may be swapped in Circle's docs (`CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` vs `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`); verify on an explorer before use.
3. **Forwarding from an Arc source.** Arc is listed with the Forwarding Service and the fee endpoint answers, but no Arc to Solana walkthrough exists. Live check 4 settles it. Also unknown: the exact `hookData` layout for `depositForBurnWithHook` from Arc with `includeRecipientSetup` (the research cites Circle's how-to; the implementer must copy it from there, not from this spec).
4. **`maxFee` versus the actual fee.** Is the unspent part of `maxFee` left in the mint (the person gets more) or retained by Circle? The spec assumes the first; check on the live check and fix the displayed "you receive" line if not.
5. **What Iris says when a forward fails or stalls.** The research found `forwardTxHash` on success but not a documented failure field or an expiry for attestations. The stall handling is time-based because of this.
6. **Can a forwarded message be minted by anyone else** (`destinationCaller`)? It decides whether a self-relay fallback is possible at all.
7. **Relay depository program id stability.** The allowlist pins `99vQ…nJSrN2` from one live response. Is it fixed, or should the allowlist be fetched from Relay?
8. **Relay Solana fee payer.** The research notes a `depositFeePayer` option that might let us sponsor the fee. Unverified; not used.
9. **ALT decoding helper.** Whether `@solana/kit` 5.x offers a ready function to fetch and decode lookup tables, or whether `getAddressLookupTables` is hand-written.
10. **Priority fee.** Whether Relay's instructions need a compute-unit price for reliable landing during congestion. Not specified; start with none and watch `failed` orders.
11. **Recorded amount.** Whether Iris's message exposes the minted amount in a form the server can store as the final `receive`, or only the signature.
