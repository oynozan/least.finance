# Instant credit for bridged deposits (the vault): design

## Goal

A person who deposits ETH, USDT, USDC or BNB from Ethereum or BNB Chain, or SOL or USDC from Solana, sees the USDC on their Arc account when the source transaction is in a block, not when the bridge delivers. Today a bridged deposit credits only when the bridge pays the account's Arc deposit address (`OrderTracker.#deliver` in `server/src/crosschain/tracker.ts` links a deposit the watcher already credited). That is seconds with Relay and about 20 minutes for the CCTP fallback.

The idea is the one approved in `2026-10-09-multichain-deposits-design.md`: a vault holding USDC on Arc pays the person at once, and the bridge pays the vault back later. That design assumed Privy server wallets, a Privy policy and treasuries on the source chains. The code has none of those: every key is an HD key from `DEPOSIT_MNEMONIC` (`server/src/accounts/keyring.ts`), and nothing signs on Ethereum or BNB Chain. This spec restates the vault for the code as it is.

Solana is in this release (SOL and USDC through Relay; the owner's decision of 2026-10-14). Sections 1 to 13 are written once for all three source chains and name the chain only where it differs. Section 14 is the Solana part: what a live Relay quote showed, the transaction checks, the refund address and the RPC it needs.

Read the code end to end: `server/src/crosschain/*` (orders, tracker, quotes, providers), `deposits/*` (watcher, ledger, report), `withdrawals/sweeper.ts` and `payouts.ts`, `lib/account/state.ts`, `components/account-client.ts`, `deposit-progress.tsx`. The progress ledgers under `.superpowers/sdd/` for the bridged-deposit plan supplied the open item in section 11. The first revision answered `.superpowers/specs-review/vault-critique.md`; where I checked a finding against the code, the result is in that file under "Drafter's response". The second revision (2026-10-14) applied the owner's decisions: no limit on the size of a deposit (the vault's free balance is the only gate) and Solana in this release. The second review, `.superpowers/specs-review/vault-critique-2.md`, found that with no caps the breaker and the free balance needed more than that revision gave them. This revision answers it: the wallet-balance check (1.1), the committed and owed money in the free balance (2.3, 2.4), the shorter window with a re-price (3.3), the exposure and drift kinds of the breaker, which the payer also reads (5, 7.3), the amount checks (1.3, 14.3), nonce handling (3.6, 4) and the Solana signature checks (14.4). Each finding I rejected or changed is in that file under "Drafter's response".

## Decisions (the product owner's earlier ones, and the ones made here)

| Topic                  | Decision                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When the vault pays    | When the source transaction is in a block, matches the order, and the block is inside the quote window (3.3). Earlier approved, with the window added here.                                                               |
| Quote window           | A fronted quote asks Relay for a `ttl` equal to the window (which Relay's order deadline did not follow in a live check, 3.3) and a 1% slippage tolerance. The window is 180 seconds. The vault pays only a transaction whose block is inside it, and re-prices a volatile coin whose block is later than 60 seconds after the quote. A person can't hold a quote and send it later (1.3, 3.3).            |
| Fees                   | None of ours. The person gets the quoted output. Earlier approved.                                                                                                                                                        |
| Custody                | The vault is an HD key on its own path, `m/44'/60'/2'/0/0`, from `DEPOSIT_MNEMONIC`. Its own path gives it its own nonce sequence; the treasury's belongs to `Payouts`.                                                    |
| Refund addresses       | Two owner-supplied addresses: `VAULT_REFUND_EVM` (Ethereum and BNB Chain) and `VAULT_REFUND_SOLANA`. The server holds no key on any source chain. |
| Which bridges front    | Relay only. Across and CCTP deposits stay direct (1.4 gives the reason).                                                                                                                                                  |
| Which chains front     | Ethereum, BNB Chain and Solana (SOL and USDC), all in this release (section 14). |
| Crediting              | Only through `Ledger.credit`, reached by the watcher's scan (or the existing `report` call, which hits the same unique key). Nothing in the vault writes a balance.                                                       |
| Slippage               | The vault pays the output it quoted and absorbs the gap to the fill. The quote's tolerance is set by us at 1%, so the gap is at most that; a quote whose guaranteed minimum is more than 3% under its output is not fronted. |
| An order the vault won't pay | It is never dropped. It is held, logged, followed by the settler, and the owner resolves it with a guarded command (3.4, 6.3). Never paid automatically at a price the vault can't check.                            |
| Limits                 | None on amounts: no cap per deposit, per account or in total. The vault's free balance is the only gate (7.1). One safety net, the breaker, in three kinds (realised loss, unfilled exposure, unexplained drift). It pauses fronting, and for the last two also payments; it caps no amount (7.3). |
| Vault size             | Whatever the owner funds it with. `VAULT_TARGET_USDC` is only the figure the "vault is low" warning is measured against. |
| Alerting               | None. Escalation is `logger.error`, as for Solana withdrawals and the prediction float.                                                                                                                                   |
| Launch                 | `VAULT_FRONTING` defaults off. All three chains front together once the live checks pass.                                                                                                                           |
| Not fronted            | Anything the vault can't verify or cover goes the direct way, exactly as today. The person never sees the difference except in speed.                                                                                     |

## 1. How a deposit routes

### 1.1 Fronted or direct

`DepositOrders.create` (and `preview`) call one planning function, `#plan`. An order is **fronted** only when all of these hold; otherwise it is **direct**, the code path that exists today.

1. `VAULT_FRONTING` is `on`, and no breaker (7.3) is tripped.
2. The coin is on Ethereum, BNB Chain or Solana, and that chain's refund address (`VAULT_REFUND_EVM` or `VAULT_REFUND_SOLANA`) is set.
3. Relay gives a usable quote with the **vault** as the recipient (1.2, 1.3, and 14.3 for Solana).
4. The quoted USDC output is at least `DEPOSIT_MIN_USDC`, the dust floor the watcher already applies to every deposit. It is not a vault limit.
5. **The source wallet holds the amount.** One balance read on the source chain (`SourceClients` for Ethereum and BNB Chain, `getBalance` / `getTokenBalance` on `SolanaRpc` for Solana). Reason: Relay does not check the wallet when it quotes (a live $1,000,000 USDC quote from a Solana wallet with a zero balance answered 200, 2026-10-14), and `DepositOrders.create` checks only that the wallet is linked. Without this an empty wallet could reserve the whole free balance again and again. It is not a vault limit on size: any amount the wallet really holds passes. A read that fails plans direct.
6. The vault's free balance (2.3) covers the quoted output, and the reservation (2.4) is made in the same step.

**The free balance is the only gate.** There is no cap on one deposit, none per account and none on the total outstanding (the owner's decision, 7.1). If the free balance covers the quoted output the deposit is fronted; if it does not, it goes direct, exactly as today. The amount of money does not matter.

Decision: preview and order use the same planning function, so the form's number is the one a fronted order pays. It is not a promise that the order will be fronted: at `create` the vault can have run short, and the order is then direct with its own quote (1.2 step 3). The `deposit:order` answer carries the final `usdcOut` and `instant`, and the form shows it before the wallet opens (section 10).

### 1.2 Planning

1. A cheap check without the network: switch, refund address, breaker, and the monitor's cached free balance (at most 3 seconds old) above the dust floor. If it fails, plan direct at once.
2. Ask Relay alone (`tiers: [["relay"]]`) for a quote with `recipient` the vault address, `refundTo` the owner's refund address, `ttl` and `slippageTolerance` (1.3). This is the existing `bestQuote` with one tier. A preview therefore costs a second Relay call. In parallel, read the source wallet's balance (1.1 item 5).
3. In `create` only, under the vault lock (one in-process lock, the `Withdrawals.#lock` pattern, which every writer of a reservation and the payer's check-and-store step also takes, 2.4): count the account's open orders against `UNSETTLED_LIMIT`, check the breaker again, read the vault's balance with a 1.5-second timeout (pinned to a block, 2.3), compute the free balance and insert the order with its reservation. If it doesn't fit, or the read times out, drop the quote (nothing is on the bridge until the person signs) and plan direct. The lock is never held across a read that can take longer than 1.5 seconds, so a hung RPC cannot queue every deposit behind it. The count and the breaker are inside the lock because a count taken before an awaited quote lets concurrent `deposit:order` events from one account all pass it.
4. Direct planning is today's `#quote`: all tiers, the deposit address as recipient, the person's wallet as refund address, and a request body with no `ttl` and no `slippageTolerance`, as now.

The worst case is two quote round trips of at most 3 seconds each. With no size cap it happens whenever a deposit is larger than the free balance, not only when the vault is nearly empty. It costs that deposit up to 3 seconds before it takes the slow way it was going to take anyway.

### 1.3 What a fronted quote must satisfy (`checkQuote`)

All the existing checks, with `request.recipient` set to the vault, so a quote paying anyone else is dropped. `QuoteRequest` gains an optional `fronted: { ttlSeconds, slippageBps }`; only a request that has it sends `ttl` and `slippageTolerance` (both documented request fields of `POST /quote/v2`: `ttl` is an integer in seconds "measured from when the quote was generated", and a request not filled within it "is refunded instead of filled"; `slippageTolerance` is a string of basis points from 0 to 10000; source: `https://docs.relay.link/references/api/get-quote-v2`, read 2026-10-14). Added for fronted quotes, all failing closed:

- **The order is Relay's v2 order.** `Quote` gains `relayOrder`, parsed from `protocol.v2` (`orderId`, `orderData`, `paymentDetails`). If `protocol.v2` is missing, or its `orderData.version` is not the `"v1"` the recorded fixtures show, the quote is not fronted.
- **The calldata names that order.** The last EVM transaction's `data` ends with the 32-byte `protocol.v2.orderId`, and its `to` equals `paymentDetails.depository`. The recorded fixtures (`quote-bnb-usdt.json`, `quote-eth.json`) satisfy both. This is what ties the transaction the person will sign to the order whose recipients we check next.
- **Every refund and payment names the right address.** In `orderData`: every `inputs[].refunds[]` entry on the source chain has `recipient` equal to the configured refund address; every refund entry on Arc has the vault as `recipient`; every `output.payments[]` entry has the vault as `recipient` and Arc USDC as `currency`; `output.calls` is empty. The fixtures show two refund entries per input (source chain and Arc); checking only the first is what the earlier draft did. This also closes the open minor from the first deposit plan ("the Relay refundTo check is tautological": `relay.ts` copies `refundTo` from the request today).
- **The deadline.** `Quote` gains `deadline` (`orderData.output.deadline`, unix seconds). The quote's own `ttl` is Relay's side of the limit; ours is in 3.3 and does not depend on Relay honouring it (a live check showed Relay does not, 3.3).
- **Guaranteed minimum.** `Quote` gains `minimumOut` (`details.currencyOut.minimumAmount`, converted with `toArcWei`). A quote with `usdcOut - minimumOut` over 3% of `usdcOut` is not fronted. With the 1% tolerance in the request this is a sanity check; it can only trip if Relay ignores the tolerance.
- **Expected input.** The last transaction's `to`, `data` and `value` are stored on the order as `vault.expect` (section 9). They are what 3.2 compares against the chain.
- **The amounts agree.** `orderData.inputs` has exactly one entry, and its `payment.amount`, `paymentDetails.amount` and the request amount are equal; `output.payments` has exactly one entry, whose `expectedAmount` equals `usdcOut` and whose `minimumAmount` equals `minimumOut`. The five live quotes and both fixtures agree on all of these, so the checks cost nothing and catch a Relay-side inconsistency, the one case where the vault would overpay by a whole order. The transaction carries the same amount, as equality (not "at most"): for the native coin the transaction's `value` equals the request amount and `data` is the selector `0x49290c1c`, the wallet as a 32-byte word and the order id (68 bytes); for a token `value` is 0 and `data` is the selector `0xe8017952`, then the wallet, the token contract, the amount and the order id as four 32-byte words (132 bytes), with the wallet, token and amount equal to the request's. These are the two shapes in `quote-eth.json` and `quote-bnb-usdt.json`; any other selector or length means the quote is not fronted. The Solana form is in 14.3.
- **`extraData` is the known value.** `output.extraData` and the Arc refund's `extraData` equal one constant, `RELAY_EXTRA_DATA` (`0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`), which is what every recorded and live body carried, and which is none of the user, recipient or refund addresses. Another value drops the fronted quote and logs `error` once, so a change on Relay's side is seen.
- **Solana.** The calldata, depository and expected-input bullets have a Solana form in 14.3 and 14.5. The order, refund, payment, deadline and guaranteed-minimum bullets apply unchanged; the live Solana quote has all of them (14.1).

### 1.4 If a route can't target the vault

Nothing breaks, because the vault is only a recipient address and the fallback is the current flow.

- If Relay refuses the quote, answers slowly, names another recipient, or fails a check above, the order is planned direct, with Across and CCTP in the pool as today.
- **Across and CCTP are never fronted.** Decision, with the reason: a fronted order depends on the server noticing the person's source transaction even when the app never reports it (the tab closed between the wallet's "sent" and the report). Relay's status by `requestId` returns the source hash (`inTxHashes`, checked live 2026-10-14 on `https://api.relay.link/intents/status/v3?requestId=<id>`), so the server can find it. Across's status needs the deposit hash and Iris's needs the burn signature, so for those two an unreported transaction would leave the money in the vault and the person unpaid. With a direct order the same slip is harmless, because the bridge pays the person's own address. Widening to Across is "Not included"; the one cheap check that would unblock it is in "Not included".
- CCTP has a second reason: a burn can't be refunded, and a forwarded mint that fails is only recoverable by hand.

## 2. The vault

### 2.1 Custody

- **Key.** `Keyring` gains `vault(): HDAccount` at `hdKeyToAccount(root, { accountIndex: 2, addressIndex: 0 })`. Deposits use account 0', perps use account 1' (`perpSignerAt`), the treasury is account 0' index 0. A unit test pins the vault address for a test mnemonic and checks it differs from `operator()`, `signerAt(1)` and `perpSignerAt(0)`.
- **Why its own path.** `Payouts` owns one nonce sequence on the treasury, and `perps-rebalance.ts` also signs from it ("never while the server is paying a withdrawal"). A vault paying from the treasury would clash with both. On its own key, `VaultPayer` is the only signer, plus one guarded script command (6.3).
- **Never swept.** `Sweeper` moves indices 1 and up into the treasury, so the vault is not touched. The vault's address is not in `DepositRegistry`, so a bridge fill to the vault credits nobody, and USDC someone sends to the vault by mistake is just float.
- **What this does not give.** The vault key comes from the same mnemonic as everything else, so a leaked mnemonic loses everything, not only the float. The path separation is about nonces and sweeping, not secrecy. The approved design's Privy policy ("plain USDC transfers of at most $100") is replaced by the limits in code (section 7) and by how little the vault holds.
- **Solvency.** The vault is left out of `arcHoldings` in `perps/reconciler.ts` (which counts the treasury and the deposit addresses). Reason: when the vault pays, the money reaches a deposit address and then the treasury, so every credited dollar is backed there. A vault loss reduces the owner's float, never the people's balances. Counting the vault as an asset behind balances would hide exactly that.

### 2.2 Refund addresses, and who holds the keys

`VAULT_REFUND_EVM` (one address for Ethereum and BNB Chain) and `VAULT_REFUND_SOLANA` (one Solana address). The **owner** holds both, ideally on a hardware wallet. The server signs nothing on a source chain, ever.

Decision, with the reason: a refund is rare, and a hot key on each source chain would need gas, monitoring and a way to move funds out. An owner address needs none of that. The cost is stated plainly in section 6: a refunded coin lands with the owner, never with the person, so the person's remedy for any order the vault does not pay is the owner's hand (Owner's decisions, 4).

Constraints, stated in `.env.example`:

- The address is an ordinary wallet (an EOA), because a bridge refund of the native coin to a contract can fail.
- The Solana address is an ordinary wallet (System-owned, not a program account or an exchange deposit address) that already holds a USDC token account (14.6).
- The config check refuses to start when `VAULT_FRONTING=on` and either address is not set (the Solana one only when `SOLANA_DEPOSITS=on`).

### 2.3 Free balance

`free = balance - gas reserve - committed - owed`

- **balance** is the native balance (`client.getBalance`, 18 decimals), not the 6-decimal ERC-20 view, read **pinned to a block**: `h = max(head, the highest minedBlock among payouts mined in the last 10 minutes)` and `getBalance({ blockNumber: h })`. Reason: `createArcClient` uses a `fallback` transport over three public RPCs with `rank: false` (`chain/arc.ts`), so the receipt that marked a payout mined and the balance read can come from different nodes, and the watcher's own comment says a node can be a block or two behind. Without the pin the balance can still include money a mined payout has spent, and `free` would count it twice. A node that doesn't have block `h` errors, the fallback tries the next, and if none has it the read fails and the plan is direct.
- **gas reserve** is 0.05 USDC plus 0.001 USDC for each order counted in `committed`. A payout costs about 0.0005 USDC at Arc's 20 gwei floor, so a burst of open orders cannot run the vault out of gas money (a flat 0.05 would cover about a hundred).
- **committed** is the money the vault is out for, or is about to be (2.4).
- **owed** is the sum of `vault.received` over fronted orders that have a fill in the vault, no payout and are not `returned`. That money belongs to a person (a late, mismatched or `payout_failed` order whose fill reached the vault, 3.4), so it neither fronts another deposit nor can be withdrawn (6.3).
- This is the figure that decides fronted or direct (1.1, 7.1). Nothing else is compared with the size of a deposit.

### 2.4 Reservations

- A reservation is a field on the order (`vault.reserved`, wei, and `vault.reservedUntil`), written in the same insert that creates the order. The server is a single instance, and an in-process lock makes "read the balance, sum what is committed, insert" one step. **Every writer takes that lock and computes `free` with the same function:** `create`'s insert, any change of `reservedUntil`, and the payer's step that checks the money and stores a payout (3.2 item 4). The payer never compares the raw balance.
- **Committed** is the amount of every fronted order that is not terminal and meets any one of these:
    1. It has a stored payout that is not yet `mined` or `failed`. This holds whatever `reservedUntil` says and **even when the order is held**: a payout that is signed but slow to mine, or parked (`payout_unclear`), can still be mined by a node that has it.
    2. It is `in_block`, unpaid and not held. A source transaction really is in a block, so the bridge already has the person's coin; its claim on the vault does not lapse with the reservation. Such orders are paid oldest first (by when the payer verified the transaction), and a new order cannot jump them.
    3. It has no payout and `reservedUntil` is in the future (the person is still at the wallet).
- `reservedUntil` starts at created + 60 seconds, so an abandoned prompt frees its capacity quickly. When the app reports a hash (`deposit:source`, in `reportSource`) it becomes the end of the quote window (3.3), and again when the tracker sees a hash from Relay. A reservation that lapses before any hash is seen leaves the order alive: a transaction that lands inside the window is committed at `in_block` (item 2), and if `free` is short then, the order waits at the head of the queue (3.5).
- The reservation ends when the payout is **mined** (from then on the pinned balance shows it, 2.3), or when the order is failed or expired, or held with no stored payout. A reservation counted a moment too long only makes `free` too small, which is the safe direction.
- Griefing: a reservation now needs a wallet that holds the amount (1.1 item 5), so reserving a lot costs real capital, and a reservation with no reported hash lasts 60 seconds. `UNSETTLED_LIMIT` of 5 open orders bounds the count, not the amount, so each `create` also logs at `info` the account's open reserved total, which makes repeated large unsent quotes visible. While money is reserved other deposits are planned direct, which costs them speed and nothing else.

## 3. Paying

### 3.1 Following a fronted order (the tracker)

Fronted orders have their own step in `OrderTracker` (`#stepFronted`). Direct orders keep today's code path unchanged.

The reason is in the current tracker: `tracker.ts:146` moves a `created` order to `bridging` on any Relay status past `waiting`, `:152-153` moves any open order to `refunded` or `failed` on Relay's say, and `:164-168` moves an `in_block` order to `bridging` when Relay says filled and no matching deposit exists. On a fronted order the fill goes to the vault, so no deposit ever matches. Left alone, a fast fill (Relay often answers in seconds) or a refund could take the order out of `in_block` before the payer runs, and the person would get nothing while the coin went to the vault or the owner.

For a fronted order the tracker:

- **Never calls `#checkBridge`.** It never sets `bridging` or `refunded`, never moves an order out of `in_block` on bridge status, and sets `failed` only for a source transaction that reverted. What the bridge did is the settler's business (section 5).
- **`created`.** Asks Relay's status by request id on every pass. If it lists `inTxHashes`, they are stored as `sourceTxHashes` (lowercase) and the order moves to `sent`. This finds a transaction the app never reported. With no hash by `quotedAt + window + 2 minutes` the order is `expired`.
- **`sent`.** Reads the receipt of every hash it knows (on Solana, the signature status of every known signature in one call, 14.4): the reported ones and any `inTxHashes` Relay lists. A hash Relay lists that the app didn't report (a speed-up or a replacement, which the direct tracker misses because it reads only `sourceTxHashes.at(-1)`) is added. The first successful receipt moves the order to `in_block` with `sourceTxHashes` set to that hash. If every known hash has a reverted receipt the order is `failed`. With no receipt by `quotedAt + window + 2 minutes` the order is `expired`; a transaction that lands after that is a late one (3.4).
- **`in_block`.** Untouched by the tracker. The payer takes it from here. Delivery is the payer's too (section 4).
- **Cadence.** Fronted orders are checked on every pass (`ORDER_POLL_MS`, 1.5 seconds) for 2 minutes after the order was created or last changed, then every 15 seconds. The direct cadence is by the order's age since creation, so a person who takes 90 seconds to approve in the wallet would fall into the 15-second band just as the report arrives; this is why fronted orders count from the last change.
- **Relay lookups have their own loop.** The status call for `inTxHashes` (in `created`, `sent`, and `mismatch` holds) runs in a separate loop with a 3-second timeout (the status call's own is 10 s, `STATUS_TIMEOUT_MS`), so a slow or throttled Relay never delays the chain checks, which need no Relay. The chain checks keep the 1.5-second pass.
- **`UNSETTLED_LIMIT`.** Fronted orders count in `created` and `sent` as direct ones do, and leave that count within about 5 minutes (the window plus 2 minutes) by `expired`, so a day-long wait can't pile up and block a person's deposits.

`GIVE_UP_MS` (24 hours) is not a rule for `created` or `sent` orders in the code today: it only bounds which `bridging` and `in_block` orders are listed and followed (`tracker.ts:89`). The earlier draft's "expires after `GIVE_UP_MS`" for these states did not exist; the rule above replaces it.

### 3.2 What the payer checks

`VaultPayer` is a loop (every second, and woken by `order:updated`) that takes fronted orders in `in_block` with no payout and no hold, oldest first, one at a time, plus orders the owner released (6.3). `in_block` is the tracker's existing word for "the source transaction is in a block". The payer verifies the transaction itself; it does not trust the order's state or the hash the client reported.

All of these must hold:

1. **The transaction is the one we asked for.** `getTransaction` and `getTransactionReceipt` on the source chain's client (`SourceClients`). The receipt succeeded; `from` is the order's wallet; `to`, `input` and `value` equal the stored `vault.expect` for the last transaction (the bridge call, not the approval); the chain is the coin's.
   - Why a match on the calldata is enough, stated correctly: the calldata carries the depositor, the token, the amount and Relay's order id. It does **not** carry the recipient or the refund address (see the two fixtures). Those live in Relay's order, which the order id names. `checkQuote` (1.3) already required that the calldata's order id equals `protocol.v2.orderId` and that the order's recipients are the vault and the refund address. So a transaction that equals the stored calldata is the deposit of that order. That the depository can pay only as the order says is a property of Relay's contract that I could not check (Open question 6).
   - Solana orders take the Solana form of items 1 and 3 (14.5).
2. **The hash is used once.** The matched hash is written to `vault.sourceTx` behind a unique index (4, layer 3). A second order citing the same transaction fails the write.
3. **The block is inside the window** (3.3), and for a volatile coin whose block is later than 60 seconds after `quotedAt`, the amount is re-priced (3.3).
4. **The vault can pay, under the lock.** `balance (pinned, 2.3) - gas reserve - committed of the orders ahead of this one - owed >= amount`, where "ahead" means orders with a stored unmined payout and `in_block` orders verified earlier. It is `free`, never the raw balance, and the check and the write of `vault.payout` are one step under the lock that `create` takes (2.4).
5. **The account exists** and its current `depositAddress` is read at signing time. An account merged later keeps its old address in `formerDepositAddresses`, which the ledger still credits.
6. **No exposure or drift breaker is tripped** (7.3). Those two kinds stop payments as well as planning; the order waits at "Confirming" meanwhile. The realised-loss kind stops planning only.

If the hash isn't on the chain yet, or an RPC is down, the order waits and is looked at again. If check 1 or 3 fails, the order is **held**, not failed (3.4). A reverted receipt never reaches the payer: the tracker has already set `failed` (3.1).

### 3.3 When, and the quote window

At `in_block`, which for Relay deposits is the Ethereum or BNB Chain inclusion. Decision: no extra confirmations. Reason: the approved design says "in a block", the owner's rule is to skip reorg risk, and what the vault holds bounds anything else. On Solana "in a block" is `confirmed` (14.4).

The vault pays only if the source block's timestamp (`getBlock(receipt.blockNumber).timestamp`; on Solana the transaction's `blockTime`, 14.5) is at most `min(vault.quotedAt + VAULT_QUOTE_WINDOW_SECONDS, vault.deadline)`. `quotedAt` is the server's clock when the quote request was sent, so it is the earlier of the two possible readings. The window defaults to 180 seconds, enough for a normal wallet prompt. The wait for funds in 3.5 is not part of this: the block time decides, not the time of payment.

Why this exists. A Relay quote carries a deadline: both recorded fixtures have 604,800 seconds (7 days) from the quote to the deadline, and Relay fills at the live price with only a floor under it. An order that could be paid at any time would let a person hold a quote, send only if the coin falls, and keep the old price while the vault is refunded the cheaper coin days later. With no cap this price option is as large as the free balance, so the window alone (the earlier 10 minutes) is not enough. Two things shrink it:

- The window is 180 seconds. A person who leaves the prompt open longer and sends anyway gets a held order (3.4); the form can quote again.
- **A re-price for volatile coins.** For ETH, BNB and SOL, when the source block is later than 60 seconds after `quotedAt`, the payer asks Relay for a fresh quote with the same coin, amount and wallet and the vault as recipient (3-second timeout, the same `checkQuote`) and pays `min(vault.usdcOut, fresh usdcOut)`. A re-quote that fails or times out leaves the order waiting and is tried again on the next pass; the block time, not the time of payment, decides eligibility. USDC and USDT are not re-priced. The person is therefore paid the quoted output, or less if the coin fell after the first minute; a rise stays with the vault. The preview's number is a ceiling for these coins, and the pending entry in the app carries the amount actually paid (10).

What remains is the coin's move in about 60 seconds, up to the 1% tolerance on a fill, in dollars as large as the float. A refund after the tolerance is breached is the only larger case, and the breaker counts it at its full amount (7.3). The exposure is float-sized, as the owner's rule implies.

Asking Relay for a short `ttl` was meant as a second layer. It does not work as one. Live check, 2026-10-14: quotes asked with `ttl` 600 and 120 from Solana, and with `ttl` 600 from Ethereum, all came back with `orderData.output.deadline` exactly 604,800 seconds (7 days) after the quote, the same as a quote with no `ttl`. The request still sends the field, because it is documented and costs nothing, but nothing here relies on it: the window above is the only guard. Open question 1 is now only what the depository does with a deposit after the deadline.

### 3.4 Held orders

The payer never fails an order whose coin the bridge may have taken. It sets `vault.hold = { reason, at }`, logs `error` once with the order id, account, hash and what differed, and leaves the state as it is. It releases the reservation, except that a stored payout that is still unmined stays committed (2.4). The reasons:

- `late`: the block is outside the window, or the order was `expired` and Relay later shows a deposit.
- `mismatch`: the receipt succeeded but `to`, `input`, `value` or sender differ. Cause: a smart-account or batched wallet whose outer transaction isn't the plain call, a wrong hash reported, or a double send of the same calldata. Privy-linked wallets reach the app as an EIP-1193 provider (`components/account-client.ts`), so the app can't rule smart-account wallets out. On Solana the same cause is a wallet or multisig that doesn't send Relay's depository instruction as a top-level instruction, or doesn't pay the fee itself (14.5).
- `payout_failed` and `payout_unclear`: from section 4.

A held order is followed by the settler (section 5), which learns what Relay did with it, and resolved by the owner (6.3). The person sees "We're checking this deposit" (section 10). If Relay never shows a deposit for it by its deadline plus a day, the settler marks `settle: "none"` and moves the order to `failed`: nothing was taken.

While an order is held `mismatch` and has no payout, the fronted tracker keeps reading Relay's `inTxHashes` and runs the match again on any hash it has not tried, so a person who reported a wrong hash and then sent the right one is paid when the right one is found (a block outside the window is still `late`).

### 3.5 Lapsed reservation and a vault that is short

- A source transaction that lands inside the window is committed from `in_block` (2.4 item 2), whether or not its reservation lapsed. If `free` is short when the payer reaches it, the order waits at the head of the queue and is paid as soon as it fits, oldest first. Later orders see its amount as committed, so they are planned direct and cannot jump it. It can't be redirected, because its bridge already names the vault.
- A waiting order is paid as soon as `free` covers it, which happens when any fill (including its own) refills the vault. It shows "Confirming" meanwhile (section 10). If the money that would refill the vault is itself waiting on an unfilled order, the wait lasts until that order fills or the owner funds the vault; the exposure kind of the breaker (7.3) logs it.
- The same applies if the owner draws the vault down by hand while orders are open. `logger.error` once an hour names the waiting order ids and the shortfall.

### 3.6 How it pays

A native USDC transfer on Arc from the vault to the account's deposit address, 21,000 gas, `maxFeePerGas` the larger of twice the base fee and 20 gwei (Arc drops lower bids silently, `MIN_BASE_FEE`), priority fee 1 gwei. This is the same shape as `Sweeper.#sweepNow` and `Payouts.#sign`. The amount is the order's `usdcOut`, or the owner's released amount (6.3).

Decision: `Payouts` stays as it is. It has just been fixed several times, and what the vault can share is three small pure predicates: `alreadySent`, `refused` and `unreachable` (`payouts.ts`, near the top). They get an `export`, and `VaultPayer` has its own short loop next to them. The other parts (`#seen`, `#mined`, the absent-pass counter) are bound to `WithdrawalDoc` and `Payouts`' state and are not extracted. The nonce is the lowest value at or above the vault's mined transaction count that no stored, unmined payout (or nonce filler, 4) holds, over the vault's own transactions only. It is not `Payouts`' `max(pending, highest stored + 1)`: with overlapping payouts that rule leaves a gap behind a cleared one (4). A payout that is signed again reuses its own `lastNonce`.

## 4. Exactly once

Each layer stops a double payment in its own failure mode:

1. **One document, one conditional write.** The payout is `vault.payout` on the order. It is set by `findOneAndUpdate({ _id, route: "fronted", "vault.payout": null, "vault.hold": null }, ...)`. Two passes, or a pass racing a restart, can't both win it.
2. **Stored before sent.** `vault.payout` holds `{ nonce, rawTx, txHash, to, amount, state }`, written with `state: "signed"` before any broadcast. A restart re-broadcasts the same bytes; it never signs a second transaction for an order that has one.
3. **One source transaction, one order.** The unique partial index on `vault.sourceTx` (3.2); EVM hashes are stored lowercase and Solana signatures as given in base58, so the two kinds can't collide. The write is `{ sourceTx: null or equal to this hash }`, so a crash after the write and before the payout re-verifies the same order and hash without failing on its own earlier write.
4. **One credit per log.** The transfer lands at the deposit address as an Arc native transfer log. `Ledger.credit` keys on `(chainId, txHash, logIndex)` (the existing unique `log_unique` index), so the scan and the `report` call can't both credit it.
5. **Never re-signed by itself.** `Payouts` re-signs with a fresh nonce when a node says "nonce too low" and the stored hash has no receipt (`payouts.ts`, in `#pay` and `#settle`). For withdrawals that is accepted. For the vault it is not: Arc clients use `fallback` over public RPCs by default (`config.ts`), so a receipt can be missing from a lagging node even though the first transfer was mined. A second signed transfer would be a second log, and `Ledger.credit` would credit both; layers 1 to 4 don't stop that, because they all hold for the same order. So the vault does not re-sign on its own. On "nonce too low" with no receipt it parks the order (`hold: payout_unclear`), logs `error` with the stored hash and nonce, and waits for the owner (6.3, `pay`).

The payer never changes a balance. After the receipt it may call `DepositService.report(account, payoutTxHash)` to credit within the same second instead of waiting for the scan's few blocks; that is the call the app already makes for an Arc deposit, and it ends in the same `Ledger.credit`. If it errors, the scan credits it anyway.

**A payout that fails.** Three cases, each with a defined end:

- *Refused* (`refused()`: insufficient funds, underpriced): the network never accepted it. If the stored hash also has no receipt on any single configured Arc RPC URL, the payer clears `vault.payout` (conditional on the stored hash), keeps its nonce as `vault.payout.lastNonce`, adds one to `vault.attempts`, logs `error`, and tries again after a minute with a new signature **on the same nonce** (with a higher fee if the first was only underpriced). The same nonce does two jobs. At most one of the two transactions can ever be mined, so a node that did accept the first cannot cause a second payment. And no later payout's nonce leaves a gap: re-signing with `max(pending, highest stored + 1)` would, whenever a later payout is already stored, skip the cleared nonce and leave every later payout unmined behind it. After 5 attempts the order is held as `payout_failed`. If the nonce is still unmined and later payouts wait behind it, the payer fills it with a zero-value transfer from the vault to itself, recorded in `vaultEvents` before it is sent; a later `pay` (6.3) signs on a fresh nonce.
- *Reverted receipt:* `payout.state: "failed"`, held as `payout_failed`, `error` log. A native transfer to an ordinary address does not normally revert; if it does, the owner looks.
- *RPC unreachable or receipt late:* nothing changes; the same bytes are re-sent next pass (the crash table).

Crash windows:

| Where the server stops                  | On restart                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the raw transaction is stored    | Nothing was sent; the order is picked up again and signs once.                                                                                          |
| After storing, before the broadcast     | The stored bytes are broadcast.                                                                                                                         |
| After the broadcast, before the receipt | The same bytes are re-sent; "already known" or "nonce too low", then the receipt decides. "Nonce too low" with no receipt anywhere parks the order (layer 5). |
| After the receipt, before the credit    | The scan credits it; `Ledger.credit` is idempotent. The payer then links the deposit and delivers.                                                      |

A fronted order is **delivered** by the payer: once its payout is mined and the watcher has credited the transfer (`deposits.findOne({ accountId, txHash: payout.txHash })`), it sets the deposit's `origin` (coin, amount, source hash, order id), moves the order to `delivered` and emits `order:updated`. The bridge's fill is never looked for as a deposit on a fronted order.

## 5. Refills and unpaid orders

The bridge's fill goes to the vault. `VaultSettler` follows **every fronted order** that has a Relay request id, paid or not, from creation until Relay's deadline plus a day (`vault.deadline + 86,400`). This is the change that stops an unpaid order being invisible: the earlier draft followed only paid ones.

`vault.settle` starts as `watching` when the order is created, and is one of:

| Value       | Meaning                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `watching`  | Relay has shown no deposit yet.                                                                                      |
| `open`      | Relay has shown a deposit (`inTxHashes`) and not finished.                                                           |
| `refilled`  | The fill reached the vault.                                                                                          |
| `refunded`  | Relay refunded the deposit, to the owner's address.                                                                  |
| `failed`    | Relay said failure. Kept apart from `refunded`: the owner may be expecting a refund that never comes (`relay.ts` maps `failure` to a failed stage). |
| `stale`     | Paid, and Relay neither filled nor refunded by its deadline plus a day.                                              |
| `none`      | Relay never showed a deposit.                                                                                        |
| `recovered`, `lost`, `returned` | Set by the owner (6.3).                                                                          |

How it asks, using the existing `RelayProvider.status` (extended with `inTxHashes`): every 15 seconds for the first 10 minutes of an order, then every 10 minutes while nothing has happened (an abandoned prompt costs about 150 calls a day, not 1,440) or every minute once a deposit is seen, then hourly after 24 hours. Relay's own deadline is 7 days; it is also where asking stops.

- **A deposit appears** (`inTxHashes`): `settle: "open"`. If the order is `expired` or `failed` and has no payout, it is held as `late` (3.4) and `error` is logged with order id, account and amount. If the order is `sent` or `in_block` the payer decides. If `inTxHashes` holds more than one hash for an order, `error` logs "More than one deposit for an order" with the hashes (a double send); nothing is paid twice, because only one hash can match (4, layer 3).
- **Filled with a fill hash.** It reads the Arc receipt of that hash (`transfersInReceipt`, the function the watcher uses) and takes the transfer **to the vault** whose amount is between `minimumOut` and 1.05 × `usdcOut`, the nearest to `usdcOut`. It stores `vault.received`, `vault.refillTx`, `vault.refilledAt`, sets `settle: "refilled"`, and logs the gap `paid - received` at `info` (a gap above zero is slippage). If the receipt has no such transfer, it logs `error` ("Relay says filled, nothing reached the vault") and stays `open`. Limit: if a solver batches two same-sized orders into one fill, the amounts may be assigned to the wrong one of the two; the total is right, and only the per-order slippage figure and the `received` of an unpaid order are affected (6.3 shows the receipt before it pays).
- **Filled and the order has no payout.** `error`: "Unpaid fronted order: fill reached the vault" with order id, account and `received`. The order is held if it isn't already. The owner uses `pay` (6.3).
- **Refunded.** `settle: "refunded"` and `logger.error` with the order, amount, coin and the refund address it went to. For a paid order the vault is out the payout until the owner recovers it (6.1). For an unpaid order it says "Unpaid fronted order: refunded to the owner" and the owner returns the coin to the person (6.3).
- **Failed.** `settle: "failed"`, same error log.
- **Stale.** Handled in 7.3.
- A fill that arrives before the payout needs no special code: the vault's balance is higher, so `free` covers the waiting order.

Solana changes nothing in this section: the fill is an Arc transaction and Relay's status is the same endpoint (14.7).

Alert at 25%: a monitor (every 60 seconds, the `PerpFloat` pattern) computes `free`, and when it falls below 25% of `VAULT_TARGET_USDC` logs `error` ("Vault is low"), again hourly while it stays low, and `info` when it recovers. It also records the balance and the reserved amount for the preview's cheap check. `VAULT_TARGET_USDC` is used for this warning and for nothing else.

**Drift check.** The same monitor, every 60 seconds, reads the Arc native-transfer logs whose sender is the vault (`NATIVE_TRANSFER_EMITTER`, `from` = the vault) from the position stored in `cursors` (`_id: "vault-drift"`, starting at the head the first time and staying a few blocks behind it like the watcher's `lagBlocks`). Each outflow must be explained: its transaction hash equals a stored `vault.payout.txHash` whose `to` is the order's current or a former deposit address and whose `amount` equals the log's value, or a hash in `vaultEvents` (a script withdrawal or a nonce filler). Anything else, whether a second transfer for one order, a wrong address, a wrong amount or a stranger with the key, is **drift**: `error` log with the hash, amount and `to`, and the drift breaker trips (7.3). This is what detects the bugs section 4 is meant to prevent, if it fails; without it the payer's layers are the only defence and nothing would show a failure. The monitor also checks the Solana refund address every hour (14.6).

## 6. When the bridge fails or refunds

### 6.1 What the vault loses, and who is made whole

| What happens                                      | Person                                                       | Vault                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Source transaction reverts or never lands         | "Didn't go through". No payout.                              | Reservation released. Nothing lost.                                                                     |
| Source transaction lands after the window         | Held. Not paid by the vault.                                 | Nothing paid. If Relay fills to the vault, the owner pays the person the amount received (`pay`). If Relay refunds, the coin is with the owner, who returns it (`returned`). |
| Source transaction succeeded but doesn't match    | Held. Not paid by the vault.                                 | Same as the row above, decided after the settler shows what Relay did.                                  |
| Same calldata sent twice                          | First one paid. The second is held.                          | The second deposit is refunded to the owner, who returns it (`returned`). `error` log.                  |
| Bridge refunds before the payout (inside the window) | Paid anyway: their coin was taken.                        | The refund lands at the owner's address; the vault is out the payout until the owner recovers it.       |
| Bridge refunds after the payout                   | Already paid.                                                | The same: `settle: "refunded"`, an `error` log, the vault is out `usdcOut`.                             |
| Fill is lower than the quote                      | Paid the quoted output.                                      | Loses the gap, at most the 1% tolerance. Counted by the breaker (7.3).                                  |
| Bridge neither fills nor refunds                  | Already paid.                                                | Seen after `VAULT_UNFILLED_MINUTES` (10) by the exposure breaker, which pauses fronting and payments once the unfilled total reaches the threshold (7.3); `stale` after Relay's deadline plus a day; `error` log; listed by the script. |
| Vault drained by hand with orders waiting         | Order waits at "Confirming".                                 | Paid as soon as a fill refills it (3.5).                                                                |
| The payout fails                                  | Held ("We're checking this deposit").                        | Retried up to 5 times if refused; otherwise held (section 4).                                           |

A person whose transaction is verified inside the window is paid whatever the bridge does next. Every other order is held and visible to the owner, never dropped, and the owner has a command for each outcome. This replaces the earlier draft's "the person is never the one who loses", which was false for late, mismatched and double-sent orders.

### 6.2 Operator recovery

A refund lands at the owner's refund address as the coin the person sent (ETH, USDT, USDC or BNB at `VAULT_REFUND_EVM`; SOL or USDC at `VAULT_REFUND_SOLANA`). For a **paid** order the owner brings it back to the vault by any bridge, or sells it and sends USDC to the vault address on Arc, then marks the order `recovered`. For an **unpaid** order the owner sends the coin back to the person's wallet (`order.wallet` is on the order) and marks it `returned`; the vault is out nothing.

### 6.3 `server/scripts/vault.ts`

Written like `perps-rebalance.ts`: run from `server/` with `node --env-file=.env`, prints what it would do, changes nothing without `--yes-send-real-money`.

- `status`: the vault address, balance, reserved, free, the 24-hour loss, the settings, both refund addresses (for the Solana one: whether it is System-owned and holds a USDC token account), and counts of orders by `settle` state and by hold reason.
- `open`: unsettled paid orders with age, coin, amount, bridge, request id and the refund address; and held orders with their reason.
- `refunds`: orders in `refunded`. With `RELAY_API_KEY` it also asks `GET /requests/v3?term=<requestId>` for the refund transaction (see section 11).
- `settle <orderId> recovered|lost|returned [--note ...]`: marks a `refunded`, `stale` or `open` order. `recovered` takes it out of the loss; `lost [--amount <usdc>]` records it as a realised loss of that amount (default: the payout less anything already recovered); `returned` closes an unpaid order whose coin the owner sent back to the person.
- `pay <orderId> [--amount <usdc>]`: pays the person for a held order. It does not sign; it writes `vault.release = { amount, note, at }` and clears the hold, and the server's payer pays through the same stored-before-sent path as every other payout, so there is one signer and one exactly-once machine. It refuses unless all of these hold: the order is fronted, held, and has no payout, or has one that is `failed` or parked with no receipt (the script prints the stored hash and nonce, the vault's nonce and whether the deposit address received it, and refuses if the database shows a credited deposit with that hash); the settler has recorded a fill into the vault (`vault.received` above zero) or the hold is `payout_failed` or `payout_unclear`; and the amount is at most `vault.received` (default: `vault.received`) or, for the two payout holds, at most `usdcOut`. Paying the amount the vault actually received is the point: it carries no price risk for the vault. It does not run the window check; the owner has looked.
- `withdraw <usdc> <to>`: moves float out of the vault. It refuses while any fronted order is `created`, `sent` or `in_block`, or has a payout that is `signed` or `sent`, and while `owed` (2.3) is above zero unless given `--ignore-owed`; it prints the vault balance, `owed` and the open orders first. It writes the transfer's hash and amount to `vaultEvents` before broadcasting, so the drift check (5) knows it. What this promises: it won't start a transfer while an order is open, so the usual case can't share a nonce with the payer. It does not promise a lock: a person can start a deposit in the same second. If that happens one of two transactions with the same nonce is mined; the payer then sees "nonce too low", parks the order (section 4, layer 5) and logs `error`, and the owner runs `pay`. No money is lost. To remove the race, turn `VAULT_FRONTING` off and restart the server before a withdrawal.
- `clear-drift <txHash> --note ...`: acknowledges an unexplained outflow after the owner has looked at it, writes it to `vaultEvents` and lets the drift breaker clear.

Funding the vault needs no command: the owner sends USDC to the address `status` prints.

## 7. The only gate, the settings and the breaker

### 7.1 The free balance is the only gate

The owner's decision (2026-10-14): "If we have money just give it instantly, if we don't, make them wait. Simple as that. Money amount shouldn't matter." So:

- There is **no cap per deposit, none per account and none on the total outstanding.** The earlier draft's `VAULT_MAX_DEPOSIT_USD`, `VAULT_MAX_ACCOUNT_USD` and `VAULT_MAX_OUTSTANDING_USD` do not exist.
- A deposit is fronted when the free balance (2.3: the vault's USDC on Arc, minus the gas reserve, minus the money committed to fronted orders that are unpaid or paid but not yet mined, minus the money owed to people for fills already in the vault) covers the quoted USDC output, and direct otherwise. The same rule holds at preview, at order and at payout (3.5).
- The vault's size is whatever the owner sends to its address. Nothing in the code limits it or tops it up.
- The breaker (7.3) is the one safety net. It pauses fronting after a refunded or unrecovered order, a paid order that stays unfilled, or an outflow nothing explains. It never limits an amount.

In plain terms: one large deposit can use the whole free balance, and a deposit larger than the free balance goes the slow way. Because every dollar of float is reachable by a single order, the most one bridge failure can cost is that order's amount until the owner recovers it (6.1, 6.2). The breaker bounds how fast new exposure is added once something has gone wrong; it does not bound the size of any one loss or of a bug. The owner's real bound is the amount they fund the vault with (7.3).

### 7.2 Settings

| Setting                        | Default | Meaning                                                                                                                                 |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_TARGET_USDC`            | 100     | Only the figure the "Vault is low" warning is measured against (section 5). It limits nothing and funds nothing.                        |
| `VAULT_LOSS_STOP_USD`          | 5       | The breaker (7.3).                                                                                                                      |
| `VAULT_QUOTE_WINDOW_SECONDS`   | 180     | The `ttl` asked of Relay, and the window inside which a source block may be paid (3.3). Enough for a wallet prompt; slower approvals are held. |
| `VAULT_UNFILLED_MINUTES`       | 10      | How long a paid order may go unfilled before it counts as exposure in the breaker (7.3).                                                |
| `VAULT_SLIPPAGE_BPS`           | 100     | The `slippageTolerance` asked of Relay: 1%. Relay honoured it in the live quotes (minimum output 1% under, 14.1).                       |

Also, per account: the existing `UNSETTLED_LIMIT` of 5 orders waiting on a wallet (3.1 says how fronted orders leave it). It is an existing rule on open orders, not a money limit, and the vault adds no rate beyond it.

### 7.3 The breaker

Three kinds, each computed from the order documents and the chain, checked at plan time (inside the `create` lock) and, for the last two, by the payer (3.2 item 6). Each logs `error` once when it trips.

| Kind | What it counts | Trips at | Stops | Clears |
| ---- | -------------- | -------- | ----- | ------ |
| **loss** | Per order, `max(0, paid - received)` for orders refilled in the last 24 hours (a gain on one order does not cancel a loss on another); plus the full amount of orders in `refunded` or `stale` until recovered or marked; plus the amount marked `lost` in the last 24 hours. | `VAULT_LOSS_STOP_USD` | New fronted orders. Orders already fronted are still paid and settled. | As the window moves on, or when the owner marks refunds `recovered`. |
| **exposure** | The sum of `vault.payout.amount` over paid orders whose `settle` is still `watching` or `open` and whose payout was mined more than `VAULT_UNFILLED_MINUTES` (10) ago. | `VAULT_LOSS_STOP_USD` | New fronted orders **and payments**: an `in_block` order waits at "Confirming". | As fills arrive, or when the owner settles the orders. |
| **drift** | An outflow from the vault that no stored payout or withdrawal explains (5). | Any amount above 0.01 USDC | New fronted orders **and payments**. | Only when the owner runs `clear-drift`. |

Why the exposure kind exists. The loss kind sees only outcomes, and a paid order that Relay never fills is not an outcome until `stale`, which is Relay's deadline plus a day, about 8 days (the deadline is 7 days whatever `ttl` says, 3.3). Over those days every deposit that fits the free balance would be fronted. Counting paid-but-unfilled money older than 10 minutes turns that blind spot into minutes. The window is generous on Solana (47 of 47 sampled requests filled within 0 to 2 s, 14.9) and unmeasured on EVM (Open question 14); a slow route trips it, which is a pause and not a loss. A refund is fast (the 3 sampled were stamped 1 s after the input), so the slow case is the non-fill.

Why the drift kind exists. A payer bug (a double payout, a wrong decimal scale, a wrong address) lowers the vault's balance without any refund, stale or slippage record. Only a comparison of what left the vault with what the database says was paid sees it.

What the breaker does not do. It bounds how fast new exposure is added after something has gone wrong; it does not bound the size of a bug or of one loss. Until an unfilled paid order is 10 minutes old, and until the next drift scan, payments continue. The owner's real bound is the amount they fund the vault with.

A refunded order counts at its **full amount**, because until the owner has recovered it the vault is out that much. With no limit on deposit size, **one refunded deposit above the threshold (default $5) stops instant credit until the owner marks it `recovered`**, whatever its size. That is deliberate: a refund means the bridge misbehaved, and the owner should look before more is fronted. The breaker is a dollar threshold, so with no size cap a large deposit's ordinary slippage (the gap to the fill, up to the 1% tolerance) can also trip it: 1% of a $600 deposit is $6. A trip is a pause, not a loss; the owner raises `VAULT_LOSS_STOP_USD` if it pauses too often.

## 8. Config

Added to `server/src/config.ts` and `server/.env.example`; everything off or empty by default.

- `VAULT_FRONTING`: `on` or `off`, default `off`.
- `VAULT_REFUND_EVM`: an address; with fronting on and this blank, startup is refused, naming the variable.
- `VAULT_REFUND_SOLANA`: a base58 address of 32 bytes; with fronting on, `SOLANA_DEPOSITS=on` and this blank, startup is refused, naming the variable. Startup is also refused when `SOLANA_DEPOSITS=on`, fronting is on and `SOLANA_RPC_URLS` is still only the public default (14.8).
- `VAULT_TARGET_USDC`, `VAULT_LOSS_STOP_USD`, `VAULT_UNFILLED_MINUTES`, `VAULT_QUOTE_WINDOW_SECONDS`, `VAULT_SLIPPAGE_BPS` as in 7.2.
- There is no setting for a deposit, account or total limit.

Turning `VAULT_FRONTING` off only stops new fronted orders. The tracker, the payer and the settler keep running for orders already fronted, so the switch can never strand one. `RELAY_API_KEY` stays optional for the server (`config.ts` reads it with `optionalKey`; quotes and status work keyless today), but is advised for fronting: the quote and the status lookup that finds an unreported transaction are the calls the Solana deposits spec says Relay key-gates from 2026-10-02. It is required only by the script's `refunds` command, because `GET /requests/v3` answers 400 without it; `.env.example` says so.

## 9. Data

- **`depositOrders`** gains, all optional (a missing `route` means `direct`, so no migration):
    - `route: "direct" | "fronted"`.
    - `vault`: `{ relayOrderId, quotedAt, deadline, minimumOut, reserved, reservedUntil, expect, sourceTx, verifiedAt, payout, paidAt, attempts, hold, release, settle, received, refillTx, refilledAt, settledNote }`.
        - `expect`: `{ kind: "evm", chainId, to, data, value }` of the money-moving transaction, or `{ kind: "solana", wallet, programId, keys: [pubkey, ...], data }` of Relay's depository instruction: public keys in order only, data as lowercase hex (14.3, 14.5).
        - `payout`: `{ nonce, lastNonce, rawTx, txHash, to, amount, minedBlock, state: "signed" | "sent" | "mined" | "failed" }`. `minedBlock` is the receipt's block number, which pins the balance read in 2.3; `lastNonce` is the nonce of a cleared attempt, reused by the next one (4).
        - `hold`: `{ reason: "late" | "mismatch" | "payout_failed" | "payout_unclear", at }`, or null.
        - `release`: `{ amount, note, at }`, written by the script.
        - `settle`: as in the table in section 5; set to `watching` when the order is created.
- **Indexes**: unique partial on `vault.sourceTx`; `{ route: 1, state: 1 }` for the payer and the tracker; `{ "vault.settle": 1, updatedAt: 1 }` for the settler.
- **No new ledger kind.** The ledger already has `deposit`, which is all a vault payout is to the account. One small new collection, `vaultEvents`, holds what is not an order: the script's withdrawals and the payer's nonce fillers (each written before it is sent, 4, 6.3) and the owner's drift acknowledgements. The drift scan's position is a document in `cursors` (`_id: "vault-drift"`).
- **Types**: `Quote` gains `minimumOut`, `deadline` and `relayOrder`; `QuoteRequest` gains `fronted?`; `BridgeStatus` gains `sourceTxHashes?: string[]` (Relay's `inTxHashes`, parsed as plain strings and validated per chain afterwards, because the existing `statusResponse` types `txHashes` with the 0x-hex validator and its `.parse` would throw on a Solana signature; the recorded `status-filled.json` has it, a second recorded body `status-solana-filled.json` is the finished Solana request of 14.1 and lists a base58 signature); `SolanaRpc` gains `getTransaction` (14.5) and `getBlockHeight` (14.4); `DepositOrderView` gains `instant`, `paying` and `held`; `DepositQuoteView` gains `instant`. `OrderState` gains no value: a held order keeps its state, so the client's types and the direct path are untouched.
- **Tracker changes**: the fronted step in 3.1 only. Direct orders are untouched. The direct tracker's own weaknesses (it reads only the last reported hash; a `created` order is dropped to `expired` after 10 minutes only when Relay still says `waiting`) are left as they are.

## 10. The app

- **Preview** (`deposit:quote`): `DepositQuoteView.instant` true when the plan is fronted. `previewText` in `lib/account/deposit-preview.ts` says "≈ $300.00, added right away" instead of "in about 2 min". The word is advisory; the order decides.
- **The final number.** The `deposit:order` answer carries `usdcOut` and `instant`. If the order came out direct (the vault ran short between preview and order) and the output is lower than previewed, the form stops at the new number and waits for another press before it opens the wallet. If it is equal or higher it goes on.
- **Steps** (`components/deposit-progress.tsx`): a fronted order shows three steps, **Sending, Confirming, Added**, and nothing about bridging. `DONE` becomes `sent: 1, in_block: 2, delivered: 3` for a fronted order. The existing four-step list stays for direct orders.
- **Optimistic credit.** Decision: the balance rises when the server says it is paying, not when the wallet sends. Reason: a source transaction can still revert or sit unmined for minutes, and the app has never counted bridged coins before. The server's order push carries `paying: true` once the payout is stored, with the payout's amount, which for a volatile coin can be below the previewed one (3.3). On that push the reducer adds a pending entry `{ txHash: "order:<id>", amount }` to `pending` (the list the Arc deposit already uses), so the balance and the history row show the amount. The entry stays **as long as `paying` stays true**. It is removed when the order is `delivered` (the credited deposit takes its place, linked by `withOrigins`), when the order is `failed` or `held`, when a push says `paying: false` (a payout cleared or parked), or, as a backstop for a lost socket, after 2 minutes with no push at all, quietly; the next order list restores the truth. A slow payer (vault short) therefore doesn't make the balance rise and fall: `paying` is false until the payout exists. `settle` and the pending total in `lib/account/state.ts` need a rule for this key.
- **Copy.** "Confirming" stays on while the order waits for the source block, and after 2 minutes in that step the line adds "Taking longer than expected" (derived from `updatedAt`, no new state). A reverted transaction: "Didn't go through". A held order: "We're checking this deposit." A fronted order never shows "Refunded to your wallet". A fronted order that expired shows the existing expired copy.
- **History** rows keep "+$300.00 · 0.1 ETH on Ethereum": `origin` is set at delivery (section 4).
- **Solana** deposits use the same three steps and the same pending rule. The wallet flow (`solanaDeposit`, the `solana:blockhash` event, the v0 transaction from `lib/account/solana-tx.ts`) is the one in the Solana deposits spec. Fronting changes one thing: the `solana:blockhash` request also carries the order id (14.4). The explorer link of the "Sending" step points to a Solana explorer.
- **Not changed:** the Arc-USDC deposit path, the wallet signing, `deposit:source`. The app should still report its hashes at once; the server no longer depends on it for Relay orders.

## 11. Relay request-list deadline

**What retires.** Relay's request list, `GET /requests/v2`, is deprecated since 2026-07-22 and fully retired on **2026-11-24**. Checked 2026-10-14 against the live API: it answers 200 with `deprecation: @1784678400` (2026-07-22), `sunset: Tue, 24 Nov 2026 00:00:00 GMT`, and a `successor-version` link to `https://api.relay.link/requests/v3`. Relay's migration guide: `https://docs.relay.link/references/api/api_guides/migrating-to-requests-v3` (v2 limits tighten from 2026-09-01, retirement 2026-11-24). `GET /requests/v3` answers 400 without an `x-api-key` header.

**What the code depends on.** Nothing at run time. A search of `server/src`, `server/scripts`, `server/test`, the app and `e2e` finds no call to `/requests`. The server uses only `POST /quote/v2` and `GET /intents/status/v3` (`server/src/crosschain/providers/relay.ts`). The status endpoint answers 200 keyless and carries no deprecation header (checked the same day). The one trace is a sentence in `.superpowers/sdd/2026-10-09-multichain-deposits-phase-1/task-5-report.md`: the fixture recorder `server/scripts/record-bridge-fixtures.ts` pins one filled Relay request id because `requests/v2` was rate limited keyless. It still works after 2026-11-24 because it asks the status endpoint for that id, not the list.

**Does the vault touch it.** Yes, in one place. The vault needs the **refund transaction** of a refunded order (6.3 `refunds`), and the status endpoint gives only `status`, `inTxHashes`, `txHashes`, `failReason` and `refundFailReason`. The list is where a refund transaction is.

**The replacement, designed here:**

- `RelayProvider` gains `requestDetail(ref)`: `GET /requests/v3?term=<requestId>` with `x-api-key: RELAY_API_KEY`, returning the request's status, `refundTo` and refund transaction hash. v3 needs the key, so it is used only by the operator script, never in the server's loops. Runtime tracking stays on `intents/status/v3`, which needs no list. (Docs: `term` searches ids, wallets and hashes; `depositTxHash`, `fillTxHash`, `refundTxHash` are exact filters; `limit` is capped at 50; v3 renames `inTxs[].hash` to `txHash` and drops the `"N/A"` strings for `null`.)
- The recorder script keeps its pinned ids and uses `/requests/v3` with the key only if it ever has to find a new one.
- **Guard.** A unit test reads the source of `server/src` and `server/scripts`, comments included, and fails if the text `requests/v2` appears anywhere, so the code's own notes about the deadline say "the old request list" and not the path. The same test asserts that `requestDetail` builds its URL from one constant that equals `/requests/v3`, so a path assembled in pieces can't hide a v2 call. This turns the deadline into something a test enforces, not a note in a ledger.
- **Nothing else to do before 2026-11-24.** Because the code never calls the list, the retirement needs no change to run. The `requestDetail` method is new work for the vault's script, and is built in the order of work (step 5).

## 12. Errors

| Case                                         | Result                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Fronting off, or no refund address           | The order is direct. No error; the form just doesn't say "right away".                           |
| Vault short at order time                    | The order is direct; the form shows the final number (section 10).                               |
| Relay can't quote to the vault               | The order is direct (1.4).                                                                       |
| Quote's order, refund or payment addresses aren't as required, or `protocol.v2` is missing | The fronted quote is dropped; the order is direct. Logged at `error`.   |
| Quote's guaranteed minimum is over 3% under  | Not fronted; direct.                                                                             |
| No source transaction in time                | Order `expired` after the window plus 2 minutes; the settler keeps watching for a late one.       |
| Source transaction after the window          | Order held (`late`), `error` log; owner resolves (6.3).                                          |
| Source transaction doesn't match             | Order held (`mismatch`), `error` log with the differences; owner resolves.                       |
| Same source transaction on two orders        | The second fails the unique write and is held; one payout.                                       |
| Solana transaction found, depository instruction differs, not top level, or fee payer isn't the wallet | Order held (`mismatch`), `error` log with the differences; owner resolves (14.5). |
| Solana RPC down, throttled, or `getTransaction` empty or `blockTime` null | Order waits and is looked at again; nothing is paid on a partial read (14.5, 14.8).    |
| Quote's Solana refund isn't `VAULT_REFUND_SOLANA` | The fronted quote is dropped; the order is direct. Logged at `error`.                       |
| Source transaction reverts                   | Order `failed`; reservation released.                                                            |
| Source wallet doesn't hold the amount, or its balance can't be read | The order is direct; no reservation (1.1).                                  |
| Vault balance read times out (1.5 s) or no node serves the pinned block | The order is direct (1.2, 2.3).                                       |
| Exposure or drift breaker tripped            | New orders direct; the payer pays nothing; `in_block` orders wait at "Confirming"; `error` log once (7.3). |
| Volatile coin lands after 60 s and the re-quote fails | The order waits and is re-quoted on the next pass (3.3).                                |
| A reported signature that isn't 64 bytes of base58, or a Relay-listed one | Refused at report (`bad_request`); a Relay-listed one is ignored and logged (14.4). |
| Blockhash expired and no signature has a status | Order `failed` at once (14.4).                                                            |
| Vault short at payout time                   | Order waits at "Confirming"; paid when refilled; hourly `error` naming it.                       |
| Payout refused by the network                | Cleared and retried up to 5 times, then held (`payout_failed`).                                  |
| "Nonce too low" with no receipt              | Never re-signed; held (`payout_unclear`); `error` log.                                           |
| Bridge refunds                               | `settle: "refunded"`, `error` log, owner recovers or returns (6.2).                              |
| Relay says filled, nothing reached the vault | `error` log, order stays `open`.                                                                 |
| Unpaid order, fill reached the vault         | `error` log; owner runs `pay` (6.3).                                                             |
| Vault low                                    | `error` log below 25% of target, hourly while low.                                               |
| Loss breaker trips                           | New orders direct; `error` log once.                                                             |

## 13. Testing

**Server unit (vitest):**

- `keyring`: the vault path vector, distinct from the treasury, deposit index 1 and perp index 0.
- `config`: defaults off; fronting on with no refund address is refused, naming the variable (each of the two; the Solana one only with `SOLANA_DEPOSITS=on`); fronting with Solana deposits on and `SOLANA_RPC_URLS` left at the public default is refused; no `VAULT_MAX_*` variable is read.
- Free balance and reservations: lapse, extension on a seen hash, a signed-but-unmined payout still reserved after `reservedUntil` has passed, release on mined, 18-decimal arithmetic.
- Source-transaction matching (EVM): right transaction; wrong `to`, `data`, `value`, sender, chain; reverted receipt. The window: a block at the edge, one second past, and the Relay deadline earlier than the window.
- Relay parse: `minimumAmount`, `protocol.v2.orderId`, `orderData`, `deadline`, `inTxHashes` in a status.
- Solana (fixtures: the two live bodies of 2026-10-14 recorded with placeholder addresses, 14.1; the hand-built ones have no `protocol`): both parse; `checkQuote` accepts them for a fronted request; and drops a quote whose Solana refund recipient is another address, whose Arc refund is not the vault, whose payment recipient is not the vault, whose `calls` is not empty, whose `protocol.v2` is missing or another version, whose instruction data does not end with `protocol.v2.orderId`, whose `programId` is not `paymentDetails.depository`, with two depository instructions, or with an amount that is not the request's. The fronted request body has `includeComputeUnitLimit`, `ttl`, `slippageTolerance`, and `refundTo` the owner's Solana address.
- Solana source matching with a fake `getTransaction`: the right transaction (keys from static and from `loadedAddresses`); error set; another fee payer; no depository instruction; the instruction only as an inner instruction; one key swapped; data differing in the amount or in the order id; extra instructions around the right one (accepted); `blockTime` at the edge, one second past, and null (waits).
- `checkQuote` for fronted quotes: a quote with another recipient; a refund entry with another address (each of the two entries in the fixtures, in turn); an Arc refund that isn't the vault; `output.calls` not empty; `protocol.v2` missing or another version; calldata whose last 32 bytes aren't the order id; `to` not the depository. All dropped.
- The fronted request body has `ttl` and `slippageTolerance`; the direct request body is unchanged byte for byte; both always carry `refundTo`.
- Loss breaker window arithmetic, including one refunded order above the threshold tripping it whatever its size, a refunded order below it not tripping, and stale orders counted.
- Planning has one money rule: a deposit equal to the free balance is fronted, one wei more is direct, and neither a $5 nor a $5,000 deposit is refused for its size.
- Wallet check: a source wallet with a zero balance (fake client) is planned direct and reserves nothing; a balance read that fails is direct; a wallet that holds the amount is fronted whatever the amount.
- Free balance: the pinned read with a fake Arc client whose balance lags one block after a payout is mined (`free` does not count the spent money; a node without the block makes the plan direct); `committed` counts an `in_block` order whose reservation lapsed, a held order with an unmined payout and a payout slow to mine; `owed` is subtracted and `withdraw` refuses on it; the gas reserve grows with the open orders.
- Amount ties: for each of EVM native, EVM token and Solana, a quote whose input amount, `paymentDetails.amount`, calldata or instruction amount, `value`, `expectedAmount` or `minimumAmount` differs from the request or from `usdcOut` and `minimumOut` is dropped (a Solana deposit smaller than requested is dropped, which the existing ceiling check would accept); an unknown calldata selector or length; an `extraData` that is not the constant.
- Re-price: a volatile coin whose block is 61 seconds after `quotedAt` is paid `min(quoted, fresh)`; a rise pays the quoted amount; a stablecoin is not re-quoted; a failed re-quote waits and is retried; a block 181 seconds after is held `late`.
- Nonces: two overlapping payouts where the first is refused: the retry reuses the first's nonce and the second is neither skipped nor stuck; a payout held as `payout_failed` with a later payout stored gets its nonce filled by the zero-value transfer; the allocator takes the lowest free nonce at or above the mined count.
- Breaker: the loss kind sums `max(0, paid - received)` per order; the exposure kind trips when a paid order stays `watching` more than `VAULT_UNFILLED_MINUTES`, stops the payer too, and clears when the fill arrives; the drift kind trips on a second transfer for one order, a wrong `to`, a wrong amount and a stranger's transfer, ignores a recorded withdrawal and nonce filler, is sticky until `clear-drift`, and resumes from the stored cursor after a restart.
- Solana signatures: `reportSource` refuses a base58 string that does not decode to 64 bytes; a Relay-listed junk entry is ignored and logged; a fake RPC that rejects any batch containing a bad entry is bisected and the other orders in the batch are read; an expired blockhash with no status fails the order at once. On the landed transaction: a second depository instruction (held `mismatch`), keys compared by public key only, and instruction data converted from base58 to hex before comparing.
- `payouts.test.ts` and `payouts-solana.test.ts` pass untouched (only three `export`s were added).
- The `/requests/v2` guard and the `requestDetail` constant.

**Server integration (anvil Arc, Ethereum and BNB Chain, Mongo, `FakeBridge`):**

*Fakes.* `FakeBridge` already pays any recipient from a funded solver on `advance(ref, "filled")`; it gains `status.sourceTxHashes`, a `refund` stage, a way to fill less than quoted, and a way to report a replacement source hash. The stack exposes `vaultAddress` and `fundVault(usdc)` (anvil `setBalance`), and a `vaultBroadcast` override beside `payoutBroadcast` to cut a send short.

- A vault with float: the bridge is asked for the vault as recipient and the owner's address as refund; the order is fronted; after the source transaction is mined the vault pays the deposit address once; the account is credited once and the order is `delivered` with `origin` set; the later fill refills the vault; `settle: "refilled"` and `received` are stored; the account is credited exactly the quoted output.
- A fill to the vault credits nobody: no deposit document, no balance change.
- The vault is short, off, breaker tripped, or no refund address: the order is direct, the bridge is asked for the deposit address, and it behaves as today.
- Two concurrent orders that together exceed the vault: the first is fronted, the second direct.
- **The tracker never takes a fronted order out of `in_block`:** with the source transaction in a block and the fake reporting `filled` before the payer runs, then `refunded`, then `failed`, then `pending`, the order stays `in_block` and is paid once. Also for a `created` order whose status moves past `waiting`.
- **A replaced transaction:** the app reports hash A, the fake lists hash B (a speed-up) and only B has a receipt; the order reaches `in_block` on B and is paid.
- **A late transaction:** a block after the window (fake clock and block time): no payout, `hold: late`, `error` logged, reservation released; the fake then fills to the vault; the settler logs "Unpaid fronted order" with `received`; `vault.ts pay` writes the release and the server pays `received` once; the order becomes `delivered`.
- **An abandoned prompt:** no hash by the window plus 2 minutes: `expired`, out of the `UNSETTLED_LIMIT` count; a deposit the fake later reports holds it as `late`.
- A reservation lapses at 60 seconds (fake clock) and is released; the app's report extends it to the end of the window; a late-reported hash inside the window is counted as committed at `in_block` and paid once `free` covers it, oldest first, and a new order racing it for the last dollars is planned direct; a waiting order is paid once a fill refills the vault.
- A transaction with the wrong `to`, `data`, `value` or sender: held (`mismatch`), no payout, `error` logged. One that reverts: `failed`. One transaction cited by two orders: one payout. The same calldata sent twice: one payout and an `error` from the settler.
- An unreported transaction: the app never calls `deposit:source`; the fake's status reports the source hash; the order is paid.
- A restart at each crash window in section 4, using `vaultBroadcast`: one transfer on chain, one credit.
- **Payout failures:** a refused send is cleared and retried and then paid; five refusals hold the order (`payout_failed`); "nonce too low" with no receipt parks it (`payout_unclear`) and nothing is signed a second time even when the receipt RPC answers late; `vault.ts pay` on a parked order refuses while a credited deposit has the stored hash.
- The switch turned off with a fronted order pending: it is still paid and settled.
- A refund after the payout: `settle: "refunded"`, an `error` log, the vault balance unchanged, the account balance unchanged; the breaker trips at the threshold and clears when marked `recovered`. A fill 2% under the quote records the gap. A paid order Relay never settles becomes `stale` and stays in the breaker. A batched fill of two same-sized orders is logged, not crashed.
- A fronted order is never swept: the sweeper leaves the vault's balance alone.
- An account merge between signing and credit: the payout to the old address is still credited to the merged account.
- Direct orders: the existing `deposit-orders`, `deposit-tracker` and `crosschain-solana` suites pass unchanged.
- The vault monitor: a log at the 25% crossing, and one an hour after.
- Cadence: a fronted order reported 90 seconds after creation is checked on every pass, not every 15 seconds.
- **Solana (fake Solana RPC and fake Relay):** a SOL and a USDC order are fronted, paid once after `confirmed`, credited once and `delivered`; a `processed` signature waits; an unreported signature listed in the fake's `inTxHashes` is found and paid; two signatures for one order pay once and log the double send; a signature that errors fails the order; a throttled RPC delays the payout and pays nothing early; a late block time holds the order (`late`); the instruction mismatches in the unit list hold it (`mismatch`); the restart table of section 4 holds with a Solana order; with `SOLANA_DEPOSITS` off nothing Solana is fronted; the existing `crosschain-solana` suites pass unchanged with fronting off.

**Logic and browser (Playwright, the e2e backend):**

- Reducer specs: the pending entry is added on `paying`, stays while `paying` holds, is replaced by the deposit on delivery, removed on `failed`, on `held` and on `paying: false`, removed after the 2-minute backstop, never counted twice when the credit arrives first or late.
- The e2e backend (`server/test/e2e/serve.ts`) gains controls to set the vault's balance and to refund a bridge. Specs: an eligible coin shows "right away", three steps, the balance rises when the payout is made and before the fill; the vault short shows the four direct steps and the final number; a reverted transaction shows "Didn't go through" and no balance change; a held order shows "We're checking this deposit". `bridged-deposit.spec.ts` keeps passing with the vault off.

**Owner's live checks on mainnet,** with the vault funded with $20 only (the free balance is the limit, so a deposit above it goes direct, which check 4 uses). The server logs every step.

1. 3 USDT from BNB Chain (the cheapest EVM route). Check: the quote names the vault and the owner's refund address in every refund and payment entry; its deadline (record whether it is the window or 7 days, 3.3); credited within seconds of the source block; the fill refills the vault; `vault.ts status` shows `refilled` and the gap.
2. About $3 of ETH from Ethereum. Same checks; slippage for a volatile coin at 1%.
3. An unreported deposit: send from the wallet, then close the tab before the app reports. The order is still found through Relay's status and paid.
4. The vault emptied below the order: the order goes direct.
5. Restart the server between the source block and the credit: one payout.
6. `vault.ts status`, `open`, `refunds` (key set), and a `withdraw` of $1 to the owner's wallet.
7. Read a past refunded Relay request through `/requests/v3` to see where its refund went.
8. A late deposit, once, with $2: take a quote, wait past the window (3 minutes), send. Record what Relay does (refund to the owner, or fill to the vault) and that the vault pays nothing and the order is held; then resolve it with `returned` or `pay`.
9. A speed-up: send with a low fee, replace the transaction from the wallet. The order is found on the replacement.
10. About 2 USDC from Solana (set `SOLANA_DEPOSIT_MIN_USD` to 1 for the check). The quote's `refunds[0]` is `VAULT_REFUND_SOLANA` exactly and its last instruction data ends with the order id; the vault pays within seconds of `confirmed`; the fill refills the vault; `vault.ts status` shows `refilled` and the gap.
11. About $2 of SOL from Solana. Same checks, and the depository instruction's amount is the lamports sent.
12. Send from every kind of Solana wallet the owner has (the Privy embedded one, Phantom, Solflare, Backpack). For each, read the landed transaction and record whether the depository instruction is top level and byte-identical, who paid the fee, and which extra instructions the wallet added. Any wallet that fails is held (`mismatch`), so this check tells the owner which wallets will wait.
13. An unreported Solana deposit: send, close the tab before the app reports. The order is found through Relay's `inTxHashes` and paid.
14. Timing, **run first** (15, step 1): with `VAULT_FRONTING=off`, log the time from the source block (the Solana `blockTime`, or the EVM block time) to the credit over a few dozen real deposits per chain; then, with fronting on, the time from the block to the stored payout and to the credit. Relay filled 47 of 47 sampled Solana requests within 0 to 2 s (14.9), so the difference may be nothing. The medians go to the owner before the Solana parts are built.
15. Slow fills: send an Ethereum and a BNB Chain deposit and record the time from inclusion to the Arc fill, and whether Relay's status lists `inTxHashes` while the request is still pending (Open questions 3 and 14). This sets whether 10 minutes (`VAULT_UNFILLED_MINUTES`) is a sane exposure window.
16. One malformed signature against the paid Solana RPC: call `getSignatureStatuses` with a valid and a junk entry and record whether the whole call is rejected (Open question 15). Read-only.

## 14. Solana (SOL and USDC through Relay)

Solana is fronted by the same machine as Ethereum and BNB Chain: the same planning, reservation, tracker step, payer, settler, breaker and exactly-once rules. This section is only what differs, and what a live quote showed. Nothing in it needs a Solana key on the server or any SOL.

### 14.1 What live Relay quotes showed (2026-10-14)

Read-only checks, between 18:42 and 18:46 UTC on 2026-10-14. Nothing was signed or sent.

- **Requests.** `POST https://api.relay.link/quote/v2`, no API key (it answered 200 keyless, although `2026-10-14-solana-deposits-withdrawals-design.md` records that Relay requires a key from 2026-10-02; the server sends its key when it has one). `user`: a public, funded Solana wallet used only as a placeholder. `recipient`: `0x1111111111111111111111111111111111111111`, standing for the vault. `refundTo`: a different placeholder Solana address (`9WzD…AWWM`). `originChainId` 792703809, `destinationChainId` 5042, `originCurrency` the System program id (0.05 SOL) or the USDC mint (20 USDC), `destinationCurrency` `0x3600…0000`, `EXACT_INPUT`, `includeComputeUnitLimit` true, `ttl` 600, `slippageTolerance` "100". Request ids: SOL `0x17920033653f5e4841a6625436f5d676e4689a95ec15472a98874a2a1f62512e`, USDC `0x17920033660af170be5ab450a0b1c77b47fe90054147729de29b416eabbbba0e`.
- Also an Ethereum ETH quote (0.003 ETH, `user` and `refundTo` different placeholders) to compare the refund entry, and two more USDC quotes with and without `ttl`.

| Question | What the quotes showed |
| -------- | ---------------------- |
| **Where does the refund address appear?** | Only in `protocol.v2.orderData.inputs[0].refunds[]`. `refunds[0]` is `{ chainId: "solana", recipient: <refundTo, exactly as sent>, currency: <the input currency>, minimumAmount: "0", deadline }`. `refunds[1]` is `{ chainId: "arc", recipient: <the quote's recipient, the vault>, currency: Arc USDC }`. `details.sender` is the user, and the user is not a refund recipient anywhere. The transaction's instructions carry no refund address: the depository's data is an 8-byte discriminator, a u64 amount and the 32-byte order id, and its accounts are the wallet and Relay's own accounts. So, as on EVM, the recipients live only in Relay's order. The Ethereum quote did the same (`refunds[0]` on `ethereum` was `refundTo`, not `user`), which answers the old Open question 1 for both families. |
| **What is the request / order id?** | Top-level `requestId`, repeated in `steps[0].requestId` (what `relay.ts` reads as `ref`) and in `steps[0].items[0].check.endpoint` (`/intents/status/v3?requestId=<id>`). Status on both fresh ids: `{"status":"waiting","quoteCreatedAt":…}`. The **order id** is `protocol.v2.orderId`, a different 32-byte value, and it is the **last 32 bytes of the depository instruction's data** in both quotes (data = `0d9e0ddf5fd51c06` or `0b9c60da27a3b413`, the amount as u64 little-endian, then the id; 48 bytes, matching `DEPOSIT_DATA_BYTES` in `quotes.ts`). The amount field equalled the request (50,000,000 lamports; 20,000,000 USDC units). |
| **Is there a protocol.v2 order with recipients?** | Yes, in both. `protocol.v2` = `{ orderId, hubType: "onchain", orderData, paymentDetails }`. `orderData` = `{ version: "v1", solverChainId: "base", solver, salt, inputs[], output, fees: [] }`. `inputs[0].payment` = `{ chainId: "solana", currency, amount, weight }`. `output` = `{ chainId: "arc", payments[0] = { recipient: <vault>, currency: Arc USDC, minimumAmount, expectedAmount }, calls: [], deadline, extraData }`. `paymentDetails` = `{ chainId: "solana", depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2", currency, amount }`. Chain ids inside are names (`"solana"`, `"arc"`, `"ethereum"`), not numbers. `expectedAmount` equals `details.currencyOut.amount`; `minimumAmount` equals `currencyOut.minimumAmount`. |
| **Transaction shape** | Relay returns one `transaction` step whose item `data` is `{ instructions[], addressLookupTableAddresses[] }`: instruction parts and lookup table addresses, not a built transaction and not a message version. The app builds the v0 message (`buildDepositTransaction`, `lib/account/solana-tx.ts`). Instructions, in order: (1) Compute Budget SetComputeUnitLimit (`02` + u32 little-endian: 13,401 units for SOL, 25,224 for USDC), and no price instruction; (2) the depository instruction (program `99vQ…nJSrN2`). SOL: 5 accounts (`Dodg2Hif…` read-only, the wallet as signer and writable, the wallet read-only, `7uTT8Xi5…` writable, the System program). USDC: 10 accounts (the same first three, `7uTT8Xi5…` read-only, the USDC mint at index 4, two writable token accounts, then Token, Associated Token and System). No token-account creation, System or Token instruction at top level. One lookup table in both: `Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP`. I did not read the table's contents (that is a Solana RPC call, outside what this check was allowed); at most 11 distinct accounts appear, so the message is well under 1,232 bytes even without the table. The role of the unlabeled accounts is by position, as in the existing check; Relay's own finished-request data shows the deposited tokens arriving at `7uTT8Xi5…`. |
| **Which checks already pass?** | I ran the repo's own parser (`createRelay`, with `fetch` replaced by the saved bodies) and `checkQuote` with `SOLANA_ALLOWED_PROGRAMS` offline against both bodies: both parse, `checkQuote` returns true, nothing is logged. The Solana branch (allowlist, `depositAmount`, compute-budget caps, ATA check) accepts real Relay output. The repo's Solana fixtures `quote-solana-*.json` are hand-built (request id `0x5a5a…`, no `protocol`), so they cannot test the fronted checks. |
| **Is `ttl` honoured?** | No. With `ttl` 600 and with `ttl` 120 (Solana USDC), and with `ttl` 600 (Ethereum), `orderData.output.deadline` was exactly 604,800 seconds (7 days) after the quote, the same as with no `ttl` (3.3). |
| **Is `slippageTolerance` honoured?** | Yes. With "100", `minimumAmount` was 1% under the expected amount (5,098,352 against 5,149,851 for SOL; 19,774,272 against 19,974,012 for USDC). With no field the default was 200 bps. |
| **How fast is a Solana deposit filled?** | Relay's `details.timeEstimate` was 1 second in both quotes. In a finished request read from the deprecated list `GET https://api.relay.link/requests/v2?originChainId=792703809&destinationChainId=5042&limit=3` (read only to look at three finished Solana-to-Arc requests; the code never calls it, section 11) the Solana input transaction is stamped 1792003391 and the Arc fill 1792003392. The status answer for the first of those requests (`GET https://api.relay.link/intents/status/v3?requestId=0x179200338421c7da78fd83975012eb00bcba20192f16bea353ca5e72df909694`) carried `inTxHashes: [<base58 signature>]` and `txHashes: [<Arc fill hash>]`, which is the proof that the server can find an unreported Solana transaction from Relay's status alone. |

Sources and dates: the endpoints above, 2026-10-14; `https://docs.relay.link/references/api/get-quote-v2` (`refundTo`: "Address to send the refund to in the case of failure"; `includeComputeUnitLimit`; `useV1Transaction`), read 2026-10-14; `https://solana.com/docs/rpc/http/gettransaction`, read 2026-10-14.

### 14.2 What is reused

| Existing piece | Use |
| -------------- | --- |
| `relay.ts` Solana branch (chain id 792703809, System id for SOL, `includeComputeUnitLimit`, the `instructions` parse) | Unchanged. A fronted request adds `ttl`, `slippageTolerance`, `recipient` the vault and `refundTo` `VAULT_REFUND_SOLANA`. |
| `checkQuote` Solana branch with `SOLANA_ALLOWED_PROGRAMS` (`server/src/config.ts`: the depository, System, Token, Associated Token and Compute Budget programs), `depositAmount`, `computeBudgetOk`, `createAtaOk` | Unchanged and run first, as the base of 14.3. It already pins the programs, the wallet as signer at `keys[1]`, the deposit amount and the compute caps. It checks nothing about the order or the refund, and it takes `quote.refundTo` from the request (`relay.ts` copies it), so 14.3 is what adds those. |
| `SolanaRpc`: `getSignatureStatuses`, `getAddressLookupTables`, `getLatestBlockhash`, `getAccountInfo` | Used as they are. New: `getTransaction` (14.5) and `getBlockHeight` (14.4). |
| Tracker `#checkSolanaSource` | Its rule (`confirmed` or `finalized` without error is in a block, `processed` waits) is the fronted step's rule (14.4). |
| Client: `solanaDeposit`, `buildDepositTransaction`, `solana:blockhash`, `deposit:source` | Unchanged, except that `solana:blockhash` carries the order id (14.4). The quote already has a compute-unit limit, so the app adds none. |
| `SOLANA_DEPOSITS`, `SOLANA_DEPOSIT_MIN_USD` | Apply first. A Solana deposit these refuse never reaches the planner. |
| CCTP fallback (USDC only) | Stays direct, for the reason in 1.4: a burn can't be refunded. |

### 14.3 What a fronted Solana quote must satisfy

In addition to 1.3 (order, deadline, guaranteed minimum) and everything `checkQuote` already enforces for Solana. All failing closed:

1. **One depository instruction.** Exactly one top-level instruction of the depository program; its `programId` equals `protocol.v2.paymentDetails.depository`; `paymentDetails.chainId` is `"solana"`, its `currency` is the coin's mint (the System id for SOL) and its `amount` equals the request amount. (This is the Solana form of "the calldata's `to` equals the depository".) The instruction's own amount (data bytes 8 to 16, a u64 little-endian) equals the request amount as well, and `orderData.inputs[0].payment.amount` and `paymentDetails.amount` agree with it (1.3). This is equality: the existing `solanaTxsHold` only requires the total not to exceed a ceiling, so a quote for a smaller deposit would pass it.
2. **The instruction names the order.** The last 32 bytes of that instruction's data equal `protocol.v2.orderId`. (The Solana form of "the calldata ends with the order id".)
3. **Refunds and payments name the right address.** The source-chain refund entry has `chainId: "solana"`, `recipient` equal to `VAULT_REFUND_SOLANA` as an exact string (base58 is case-sensitive) and the input's currency; the Arc refund entry has the vault as `recipient`; every `output.payments[]` entry has the vault as `recipient` and Arc USDC as `currency`; `output.calls` is empty.
4. **What is stored.** `vault.expect = { kind: "solana", wallet, programId, keys, data }` from that instruction, with `keys` as the public keys in order and the data in lowercase hex. The accounts other than the wallet are Relay's (the config account, the vault account, the token accounts); the quote check does not know what they should be, so it stores them whole and 14.5 requires the landed instruction to carry exactly the same list of keys. Only the public keys are compared: the quote's per-key `isSigner` and `isWritable` flags are not on a landed instruction, where `getTransaction` gives account indices and the message's merged flags (Relay's own landed record shows the quote's `keys[2]` as read-only and not a signer while the landed instruction has the wallet as signer and writable at both `keys[1]` and `keys[2]`). What the person signs is what the server compared.

### 14.4 How the server sees the person's transaction land

- **The signature** comes from the app (`deposit:source`) or, if the app never reports it, from Relay's status `inTxHashes` (a finished Solana request lists it, 14.1; whether it is listed while the request is pending is Open question 3). It is stored as given, base58, not lowercased. Every signature, reported or listed, is decoded with `@scure/base` and must be 64 bytes. `reportSource` refuses others with `bad_request`, because the regex in `swapTxHash` (base58, 64 to 90 characters) also admits junk strings, and a junk entry in a batched `getSignatureStatuses` is expected to make the RPC reject the whole call, which would hold every Solana fronted order at "Confirming" (Open question 15). A Relay-listed signature that fails the decode is ignored and logged.
- **`created`:** the fronted tracker asks Relay's status on every pass; `inTxHashes` moves the order to `sent` (3.1).
- **`sent`:** one batched `getSignatureStatuses` call per pass with every known signature of every `sent` order (`searchTransactionHistory: true`, as `SolanaRpc` does), in chunks of at most 256. If the node rejects a chunk as invalid, the chunk is bisected until the offending signature is found, that signature is marked bad on its order and the rest is read, so one bad entry can't stall other orders. `confirmed` or `finalized` with no error: `in_block`, with `sourceTxHashes` set to that signature. Every known signature errored: `failed`. Unknown to the cluster, or only `processed`: wait; with nothing by `quotedAt + window + 2 minutes` the order is `expired` (3.1). "In a block" on Solana is `confirmed`, the level the existing tracker already accepts; the owner's rule is not to design for reorgs.
- Solana has no fee-bump replacement. A second signature for the same order is a second send (a double send, section 5); both are listed by Relay and only one can match the unique `vault.sourceTx` write.
- A signature that was never broadcast cannot land after its blockhash expires (about a minute or two). The window check, not the blockhash, is what bounds a late payment, because a person can ask for the blockhash late (the `solana:blockhash` event is called right before signing).
- **A dropped transaction fails fast.** The `solana:blockhash` event carries the order id, and the server stores the `lastValidBlockHeight` it handed out on the order. When `getBlockHeight` is past it and no known signature has a status (history searched), the order is `failed` at once ("Didn't go through") instead of waiting out the window plus 2 minutes and holding an `UNSETTLED_LIMIT` slot. A durable-nonce transaction is not covered by this, so the window rule stays.

### 14.5 What the payer compares before paying

One `getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })` (plus `encoding: "json"`, because `jsonParsed` rewrites the instructions of known programs; documented parameters; it returns `null` when the transaction is not found or not confirmed, and `blockTime` (i64 or null), `slot`, `meta.err`, `meta.loadedAddresses` (`writable` and `readonly`) and `version`; `https://solana.com/docs/rpc/http/gettransaction`, read 2026-10-14). Then, all of:

1. `meta.err` is null; the first signature equals the stored one; account key 0 (the fee payer) is `order.wallet`.
2. The account list is the static keys, then `meta.loadedAddresses.writable`, then `.readonly` (the order Solana defines for a v0 message). This resolves lookup tables from the response, so the payer does not fetch or decode any table.
3. **Exactly one** top-level instruction whose program is `expect.programId`, and that instruction's resolved account list, compared as public keys in order, equals `expect.keys`, its data (base58 in the response, converted to lowercase hex) equals `expect.data` byte for byte, and its `keys[1]` is one of the transaction's signers. A second top-level instruction of the depository program, or of any program with the same keys, is a mismatch: two identical deposits in one transaction would otherwise pass (Open question 12).
4. `blockTime` is at most `min(quotedAt + window, deadline)` (3.3), and the re-price of 3.3 applies to SOL. A null `blockTime` waits and is asked again; it never pays.
5. Then the rest of 3.2: the signature is used once (`vault.sourceTx`), the vault can pay, the account exists.

Why this is enough: the instruction's data carries the amount and Relay's order id, and the order id names the order whose refund and payment addresses 14.3 checked, the same argument as for the EVM calldata (3.2, Open question 6). The accounts are compared whole, so a swapped vault account does not match.

Why only that instruction and not the whole message: some wallets add instructions to what they sign (guard or assertion instructions are the known case; I have not checked which wallets do), and may rewrite the compute-budget instructions. The depository instruction is the part that moves the money, so it is the part compared. Live check 12 records what each wallet does.

When it does not match: an instruction that is only an inner one (a multisig or a program wallet calling the depository), a wallet that does not pay its own fee, or any difference in keys or data is **held** as `mismatch` (3.4); nothing is paid on a read the payer can't explain. A `null` result or an RPC error waits.

### 14.6 The Solana refund address

- `VAULT_REFUND_SOLANA`, supplied by the owner, like `VAULT_REFUND_EVM`. The owner holds the key; the server holds no Solana key and no SOL. The quote's `refunds[0]` must equal it (14.3), so a refund of SOL or USDC lands there. A refund after the vault has already paid the person must not go to the person, or they would be paid twice; the owner returns it for an unpaid order (`returned`, to `order.wallet`, 6.2).
- It is an ordinary wallet: System-owned (not a program account, not an exchange deposit address that needs a tag), already existing, and already holding a USDC token account, because a USDC refund needs one and I could not check what Relay does if it is missing (Open question 9). The server checks it at startup (the paid RPC is required anyway) and the monitor checks it again every hour (`getAccountInfo`, already on `SolanaRpc`, and a new `hasTokenAccount`, since `getTokenBalance` can't tell a missing token account from an empty one): System-owned, and holding a USDC token account. While the check fails, new Solana USDC fronting is planned direct and `error` is logged, so closing the token account later cannot strand a USDC refund. `vault.ts status` prints the same.
- The config check is a base58 string that decodes to 32 bytes.

### 14.7 Settling

Nothing Solana-specific. Relay's status endpoint is the same; the fill is an Arc transaction to the vault, read with `transfersInReceipt` as for the others. For a refund, `requests/v3` (section 11) gives the refund transaction, which on Solana is a base58 signature.

### 14.8 What needs a paid Solana RPC

| Call | When | Per fronted order |
| ---- | ---- | ----------------- |
| `getAddressLookupTables` | At order time, for the app (already built) | 1 |
| `getLatestBlockhash` (`solana:blockhash`) | Right before the wallet signs (already built) | 1 |
| `getSignatureStatuses` | Every pass (1.5 s) until in a block | a few, in one chunked call per pass shared by all orders |
| `getBlockHeight` | Once per pass, only while a `sent` order has no status for any signature | at most one per pass |
| `getTransaction` | Once, at payment (new) | 1 |

The vault itself is on Arc, so no Solana balance is read. The default `SOLANA_RPC_URLS` is `https://api.mainnet-beta.solana.com`, which Solana documents as rate limited and not for production use ("Public endpoint rate limits are subject to change… For production infrastructure, use the RPC provider guide", `https://solana.com/docs/references/clusters`, read 2026-10-14). A throttled read fails closed (the order waits, 14.5), so a public RPC does not make the vault unsafe; it makes "instant" slow and unreliable, which defeats the point. So, with fronting on and `SOLANA_DEPOSITS=on`, startup is refused while `SOLANA_RPC_URLS` is only the public default (8). The Solana deposits spec already asks the owner for a paid RPC; nothing new is asked, but it is now required, not advised. Two URLs from different providers are better than one: `SolanaRpc.call` tries them in order.

### 14.9 What Solana fronting buys

The owner decided Solana is in. This is here so the live measurement is read correctly, and because the second review's measurement says the gain is probably nothing.

- **Fill delay.** Of 47 finished public Solana-to-Arc requests read on 2026-10-14 (`GET https://api.relay.link/requests/v2?originChainId=792703809&destinationChainId=5042&limit=50`, the deprecated list, read only; the code never calls it), the Arc fill came 0 s (10), 1 s (35) or 2 s (2) after the input transaction. The 3 refunds were stamped 1 s after it. Every live quote said `timeEstimate: 1`.
- **Direct path.** The watcher credits when it sees the Arc transfer: `DEPOSIT_CONFIRMATIONS` defaults to 0 and `DEPOSIT_POLL_MS` to 1,000. A direct Solana deposit therefore credits about the Solana block plus 1 to 2 s for the fill plus up to 1 s of polling.
- **Fronted path.** Solana `confirmed`, then up to a 1.5 s tracker poll, `getTransaction`, signing, the broadcast and Arc inclusion, then the same watcher poll or `report`. That is the same or slower. What fronting buys on Solana is protection from the case where Relay is slow, at the cost of everything in this section: a second refund address, a paid RPC, a `getTransaction` path and manual returns for held orders. There is no EVM measurement either (the public list had no Ethereum or BNB requests).
- **What the spec does.** Solana is built, because the owner decided it. Live check 14 and step 1 of section 15 measure the direct path first, and the result goes to the owner before the Solana parts of step 4 are built. There is no code gate. The single switch is `VAULT_FRONTING`; there is no separate Solana switch because the owner asked for one rule.

## 15. Order of work

1. **Measure first.** Log, for every direct bridged deposit, the time from the source block to the credit (one `info` line in `OrderTracker.#deliver`), and with `VAULT_FRONTING` off collect a few dozen real deposits per chain (live check 14, direct half). Report the medians to the owner before the Solana parts of step 4 are built. The decision to include Solana stands; this shows whether the fronted pipeline can beat the direct one at all (14.9).
2. Config, `Keyring.vault()`, the order data, protocol types, the three `export`s in `payouts.ts` with the existing payout tests green. Everything refuses to front while off.
3. Relay: `ttl` and `slippageTolerance` on the fronted request, `minimumAmount`, `protocol.v2` parsing (EVM and Solana), `inTxHashes` as plain strings; `checkQuote` additions for both families (1.3, 14.3); record the two live Solana bodies and a finished Solana status as fixtures; the planning function with `preview` and `create` and the wallet-balance check; reservations, committed money and the free balance with the pinned read. Tests with fakes.
4. The fronted tracker step (3.1), `VaultPayer` with source verification for both families (`SolanaRpc.getTransaction`, `getBlockHeight` and their fakes, 14.5), the window and the re-price, holds, payout failures, the nonce rule and delivery, `VaultSettler`, the monitor with the drift scan, and the three breaker kinds. Integration tests.
5. The app: `instant`, `paying` and `held`, steps, the pending rule, the final number, copy, the order id on `solana:blockhash`. Logic and browser specs.
6. `vault.ts` (including `pay`, `withdraw` with the owed check, `clear-drift`, and the Solana refund-address check in `status`), `requestDetail`, the `/requests/v2` guard. Live checks 1 to 16. Switch on for Ethereum, BNB Chain and Solana.
7. The closing review.

## What the owner provides

- `VAULT_REFUND_EVM`: a wallet the owner controls. `VAULT_REFUND_SOLANA`: a Solana wallet the owner controls, already holding a USDC token account (14.6).
- USDC on Arc sent to the vault address that `vault.ts status` prints, in whatever amount the owner chooses (the vault's size is the owner's; $20 is enough for the live checks). `VAULT_TARGET_USDC` set to that amount, only so the "Vault is low" warning means something.
- Paid RPC URLs for Ethereum, BNB Chain and Solana in `ETHEREUM_RPC_URLS`, `BNB_RPC_URLS` and `SOLANA_RPC_URLS`, because the payer now reads source transactions and block times (14.8). A Relay API key in `RELAY_API_KEY` is advised for fronting (8) and needed for `vault.ts refunds`.
- A look at the logs for "Vault is low", "Unpaid fronted order", "Relay says filled, nothing reached the vault" and refunded orders; recovery and repayment by hand (6.2, 6.3).
- Turning `VAULT_FRONTING` on once the live checks pass.

## Not included

- Fronting a Solana deposit that Relay can't quote (the CCTP fallback stays direct, for the reason in 1.4).
- Fronting Across or CCTP deposits (1.4). Across answers `GET https://across.to/api/deposits?depositor=<address>` with 200 keyless (an empty list for a dummy address, 2026-10-14); whether it lists a real deposit within seconds is unchecked. That one GET, with a real depositor, is the check that would unblock Across.
- Automatic payment of late or mismatched orders (the owner chose the guarded command, "Owner's decisions" 4).
- Confirmation counts before paying, or any reorg handling.
- Keys or treasuries on Ethereum, BNB Chain or Solana, and automatic re-bridging of refunds.
- A fee for instant credit, or a fee-free deposit promise beyond the quoted output.
- Alerting beyond error logs.
- Smart-contract wallets (account abstraction, Safe) as senders of a fronted deposit. Their on-chain transaction isn't the plain call the match expects, so such an order is held (`mismatch`) and resolved by hand. The same holds on Solana for a multisig or program wallet that calls the depository from inside another instruction (14.5).
- Fixing the direct tracker's own weaknesses (last reported hash only; no age bound on `created` and `sent`).
- Fronting the Arc USDC deposit, which is already instant.
- Any limit on the size of a deposit, an account or the total (the owner's decision, 7.1).

## Open questions

Facts that need a live check, because they need a transaction, a key or real money. Not listed: what was verified read-only on 2026-10-14 and is now in the body: where the refund address sits and that it is `refundTo`, not `user`, on Solana and Ethereum (14.1); that `slippageTolerance` is honoured and `ttl` is not (3.3, 14.1); the Solana order id, `protocol.v2` shape, transaction shape and `inTxHashes` (14.1); the `/requests/v2` retirement and the `/requests/v3` key requirement (section 11); the status endpoint's `inTxHashes` in the recorded EVM fixture; the request fields on `https://docs.relay.link/references/api/get-quote-v2`; and `getTransaction`'s fields on `https://solana.com/docs/rpc/http/gettransaction`.

1. **What does the depository do with a deposit that arrives after the order deadline, and does `ttl` change anything at fill time?** The order's deadline is 7 days whatever `ttl` says (3.3). The docs document `latePaymentSlippageTolerance` ("in the event that the deposit occurs after the order deadline"), which suggests a late deposit may still be filled. The vault's safety doesn't depend on the answer, only what the owner does next (6.2). Live check 8.
2. **Does Relay keep accepting 100 bps on large quotes?** Answered up to $1,000,000 on Solana USDC (`minimumAmount` exactly 1% under, 2026-10-14). Relay refuses larger quotes itself (`INSUFFICIENT_LIQUIDITY` at $20M, `AMOUNT_TOO_HIGH` at 5,000 SOL), and a refused or unusable quote fails the checks, so the order goes direct. The server logs `usdcOut - minimumOut` for each fronted quote at `info`.
3. **How soon does Relay's status give `inTxHashes` while a request is still pending, on EVM and on Solana, and does it list a replacement hash?** Not answered. A finished Solana request lists its base58 signature (14.1), which does not show that it is listed promptly while the request is `depositing` or `pending`, the case the unreported-tab path needs. For an unreported transaction, instant credit is as late as Relay's indexing. Live checks 3, 9 and 13.
4. **Does the fill transaction in `txHashes[0]` carry the EIP-7708 native Transfer log to the vault?** The settler reads those logs, for all three source chains because the fill is always on Arc. Live checks 1 and 10 read the receipt; if the fill is a multicall that pays elsewhere first, `received` is read another way.
5. **Where does a Relay refund actually go?** The quotes say `refundTo` on Ethereum and on Solana (14.1). The transaction itself is seen only at the first real refund, or by reading a past one through `/requests/v3` (live check 7).
6. **Is the order id in the calldata (EVM) and in the depository instruction (Solana) a hash of the order, so that the contract can pay only as the order says?** The match in 3.2 and 14.5 rests on it. It is a property of Relay's contracts; the fixtures and the live quotes show the id beside the order, not the hashing.
7. **How long from source block to credited deposit, per chain?** The target is under 5 seconds. Checks 1, 2, 10 and 14 log the timestamps of the block, the payout and the credit.
8. **Does `GET /requests/v3?term=<requestId>` return the refund transaction for a request id?** Taken from Relay's docs only. Live check 6 (`refunds` command) shows it.
9. **Does a USDC refund reach `VAULT_REFUND_SOLANA` if it holds no USDC token account?** The design requires the account to exist (14.6) and the owner creates it first; whether Relay would create it is unchecked, and a failed refund would be worse than a held order. Not testable without a refund; the requirement makes it moot.
10. **Do Solana wallets leave Relay's depository instruction top level and byte-identical, and pay their own fee?** Anything else is held (`mismatch`, 14.5). Live check 12 lists the result per wallet.
11. **Does `getTransaction` at `confirmed` return `blockTime` straight away on the owner's paid RPC?** A null waits and is asked again, so only speed is at stake. Check 10 logs it.
12. **Does the Solana depository reject a second deposit with the same order id?** It decides whether a double send shows as a second `inTxHashes` entry or as a failed transaction. The code handles both (14.4, section 5); the first real case will say.
13. **Are the depository program id and its lookup table stable?** The allowlist pins `99vQ…nJSrN2` (seen in every live quote), and every fronted quote's `paymentDetails.depository` is compared with it, so a change fails closed (the order goes direct) and shows up in the `error` log.
14. **How soon after inclusion does Relay fill an Ethereum or BNB Chain deposit?** The 10-minute default of `VAULT_UNFILLED_MINUTES` rests on Solana, because the public list returned no Ethereum or BNB requests. A slow EVM route trips the exposure breaker (a pause, not a loss). Live checks 1, 2, 14 and 15 measure it.
15. **Does a Solana RPC reject a whole `getSignatureStatuses` batch for one malformed signature?** Expected, not tested (no Solana RPC call was made in the review). Signatures are decoded to 64 bytes before they reach the RPC (14.4) and a rejected chunk is bisected, so the answer decides only whether the bisection is ever used. Live check 16.

## Owner's decisions (2026-10-14)

The owner's words: "If we have money just give it instantly, if we don't, make them wait. Simple as that. Money amount shouldn't matter." What was chosen, and what each replaces in the earlier draft:

1. **The free balance is the only gate.** No cap per deposit, per account or in total; the earlier Decision 2 (vault size and limits) is gone. If the free balance covers the quoted output the deposit is fronted; otherwise it goes direct, exactly as today (7.1).
2. **The vault's size is whatever the owner funds it with.** One setting, `VAULT_TARGET_USDC`, stays as the figure the "Vault is low" log warning is measured against; it limits and funds nothing (7.2, section 5).
3. **Solana is in this release** (SOL and USDC through Relay), not a follow-up; the earlier Decision 4 is settled as option B. It has its own refund address, `VAULT_REFUND_SOLANA`, and needs a paid Solana RPC (section 14).
4. **Orders the vault won't pay** (a late or mismatched transaction, a double send, a failed payout) are held, and the owner resolves them with the guarded `vault.ts` commands: `pay` when the fill reached the vault, `returned` when the coin was refunded to the owner. This is the earlier Decision 1, option A, as recommended (3.4, 6.3).
5. **The breaker stays as the one safety net,** at its recommended threshold of $5 (the earlier Decision 3, option A). It has three kinds: realised loss, unfilled exposure and unexplained drift. It pauses fronting after a refunded or unrecovered order, a paid order that stays unfilled, or an outflow nothing explains; the last two also pause payments. It caps no amount (7.3).
6. **Unchanged from the earlier rounds:** Relay only; fronting at the source block inside a quote window (now 3 minutes, 3.3); 1% slippage tolerance; no fee for instant credit; the vault key on its own HD path; owner-held refund addresses; no alerting beyond error logs; `VAULT_FRONTING` off until the live checks pass.

What follows from choices 1 to 3, stated so the owner is not surprised (none of it is a new question):

- One large deposit can take the whole free balance, and a bridge failure on it costs that order's amount until it is recovered. The breaker pauses fronting after it; nothing limits the first one.
- One person's unsent quotes reserve vault money for 60 seconds each, only while their wallet holds the amount, up to 5 open orders; other deposits go direct meanwhile (2.4).
- With a dollar threshold and no size cap, a large deposit's ordinary slippage can trip the breaker (7.3); raising `VAULT_LOSS_STOP_USD` is the remedy.
- On Solana the gain over a direct deposit is probably nothing (14.9: 47 of 47 sampled requests filled within 0 to 2 s of the input transaction, and direct credit polls every second). Solana is built because the owner decided so; live check 14 is the first step of the work (15) and its result goes to the owner before the Solana parts are built.
- Until a paid order has stayed unfilled for `VAULT_UNFILLED_MINUTES`, nothing in the breaker sees it. The first minutes of a bridge failure are bounded by what the vault holds, not by a limit (7.3).
