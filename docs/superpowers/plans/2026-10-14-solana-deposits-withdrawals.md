# Solana Deposits and Withdrawals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People deposit SOL or USDC from a linked Solana wallet and have it credited as USDC on Arc, and withdraw USDC to a linked Solana wallet, both behind switches that default off.

**Architecture:** Deposits add a Solana branch to the existing bridge flow: Relay returns instructions, the browser builds, signs and sends a v0 transaction, and the tracker follows the signature and then Relay's status. Crediting stays with the Arc watcher. Withdrawals extend the serial `Payouts` worker: the treasury approves and burns with CCTP v2 `depositForBurnWithHook`, Circle's Forwarding Service mints on Solana, and the worker follows Iris until the Solana hash is known. A CCTP deposit fallback comes last, gated on the spec's open questions.

**Tech Stack:** Node 24 + TypeScript, Express/socket.io, MongoDB replica set, viem, vitest (anvil Arc, fakes in `server/test/support`), Next.js 16 + React 19, `@solana/kit`, Privy, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-solana-deposits-withdrawals-design.md`. Research: `.superpowers/research/2026-10-14/solana-inout.md`. Section numbers below (1.2, 2.3 ...) are the spec's.

## Global Constraints

- **Commits:** no Co-Authored-By trailer. Commit by path (`git commit -- <paths>`) with only your own hunks. The working tree already has unrelated changes (`next.config.ts`, `deploy/`, `.superpowers/`); never stage them.
- **Comments** are one line each and describe the code as it is.
- Never read or print any `.env` file.
- **No real external service, no real transaction in any test.** Use the fakes in `server/test/support/`. The owner runs the real-money live checks (spec section 5, checks 1 to 5); this plan builds none of them.
- **Browser tests** only from an isolated copy of the repo, on ports 3650 (app), 4650 (API), 4651 (control), via `E2E_PORT`, `E2E_API_PORT`, `E2E_CONTROL_PORT`. Never 3000, 4500 or 27018.
- **Checks:** server `cd server && npm test && npx tsc --noEmit`; logic `npm run test:logic`; app types `npx tsc --noEmit -p .`. Run all that apply before each commit.
- **Feature switches default off:** `SOLANA_DEPOSITS` and `SOLANA_WITHDRAWALS` are `"on" | "off"`, default `"off"`. While off, every Solana path answers `unavailable`: "Solana isn't open yet."
- **Spec values, verbatim:**
    - Relay Solana chain id `792703809`; SOL `originCurrency` `11111111111111111111111111111111`; USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; request adds `includeComputeUnitLimit: true`.
    - Allowlist default (`SOLANA_ALLOWED_PROGRAMS`): `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` (Relay depository), System, Token, Associated Token, Compute Budget.
    - `SOLANA_DEPOSIT_MIN_USD` 2; `SOLANA_WITHDRAW_MIN_USDC` 1; `SOLANA_WITHDRAW_FEE_TOLERANCE` 0.05; `CIRCLE_IRIS_URL` default `https://iris-api.circle.com`.
    - Rate limits: `withdraw:quote` 30 per minute per user, `solana:blockhash` 30 per minute.
    - CCTP: Solana domain 5, Arc domain 26, TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, Arc USDC ERC-20 view `0x3600000000000000000000000000000000000000`, `minFinalityThreshold` 2000. Fee endpoint `GET /v2/burn/USDC/fees/26/5?forward=true` (`&includeRecipientSetup=true` when `setup`); the shown fee is the `med` figure, `maxFee` is `high`.
    - Stall: "Taking longer than expected" after 15 minutes in `forwarding`; `logger.error` "Solana withdrawal stalled" once an hour. Iris: one request per tick, at most 5 per second in total.
    - Copy, exact: "Solana isn't open yet." / "That wallet isn't linked to your account." / "The smallest deposit from Solana is $2." / "No route for this deposit right now." / "This deposit can't be sent from Solana right now. Try a smaller route." / "You need a little SOL to send from Solana." / "That address can't receive USDC." / "The smallest withdrawal to Solana is $1." / "Couldn't price this right now. Nothing was taken." / "Didn't go through. Your balance is back." / "Sending to Solana" / "Includes 0.16 USDC to set up your USDC account." / "Fee 0.13 USDC · you receive 9.87 USDC".
- **Open questions stay open.** Spec open questions 1 to 11 are not decided here. Where a task depends on one it names it, writes the code to the spec's stated assumption, and stops at a marked gate rather than guessing.
- **Money rules:** the ledger moves only in the existing Mongo transactions (`Ledger.runInTransaction`, `debitInSession`, `creditInSession`). A withdrawal is refunded only from `sending`, once. Nothing is credited on a provider's "done"; only the Arc watcher credits.

## Review Focus

1. **Relay says filled but no USDC reached the deposit address.** The order stays `bridging`; nothing is credited from the status alone. (Task 3 test.)
2. **A top-level System or Token instruction that moves more than the person asked to send**, from an allowlisted program. A program-id allowlist alone can't see it. (Task 2 test; this rule is an addition to the spec, see "Spec findings".)
3. **The burn was mined and the node restarts, or Iris is down for hours.** The withdrawal stays `forwarding`, nothing is re-sent, nothing is refunded. (Task 6 tests.)
4. **A recipient wallet owned by a program, or an address whose derived USDC account differs from the address itself.** The `mintRecipient` is always the derived account; a program-owned wallet is refused before any debit. (Task 5 tests.)
5. **A withdrawal at the minimum where the fee eats the amount** (amount 1, `maxFee` above 1), and a deposit of a SOL amount under $2. Both refused with nothing opened or debited. (Tasks 3 and 5 tests.)

---

### Task 1: Switches, config, Solana RPC reads, protocol types

**Files:**
- Modify: `server/package.json`, `server/src/config.ts`, `server/src/crosschain/solana.ts`, `server/src/protocol.ts`, `server/src/errors.ts`, `server/src/sessions.ts`, `server/src/server.ts` (rules and switches wiring only), `server/test/support/fake-solana-rpc.ts`
- Create: `server/src/crosschain/solana-switch.ts`
- Test: `server/test/unit/config.test.ts`, `server/test/integration/crosschain-solana.test.ts`

**Interfaces:**
- Produces config keys: `SOLANA_DEPOSITS`, `SOLANA_WITHDRAWALS` (`"on"|"off"`, default off), `SOLANA_DEPOSIT_MIN_USD` (number, 2), `SOLANA_WITHDRAW_MIN_USDC` (usdc wei, 1), `SOLANA_WITHDRAW_FEE_TOLERANCE` (wei, 0.05), `SOLANA_ALLOWED_PROGRAMS` (list), `CIRCLE_IRIS_URL`.
- Produces `SolanaRpc` additions: `getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>`, `getSignatureStatuses(signatures: string[]): Promise<({ confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null)[]>`, `getAddressLookupTables(addresses: string[]): Promise<{ address: string; addresses: string[] }[]>`, `getAccountInfo(address: string): Promise<{ owner: string; lamports: bigint } | null>`.
- Produces `solana-switch.ts`: `solanaOpen(config, direction: "deposits" | "withdrawals"): void`, which throws `AppError("unavailable", "Solana isn't open yet.")` when off.
- Produces protocol: `WalletSession.solana: { deposits: boolean; withdrawals: boolean }`; `ErrorCode` gains `"quote_changed"` (HTTP 409 in `errors.ts`).
- Adds `@solana/kit` `5.5.1` and `@solana-program/token` `0.9.0` to `server/package.json` (exact, as the root has them): `deploy/server.Dockerfile` installs only the server's own dependencies.

- [ ] **Step 1: Write the failing tests.**
    - `config.test.ts`: `"Solana switches are off by default"`, `"SOLANA_WITHDRAW_MIN_USDC defaults to 1 USDC in wei"`, `"SOLANA_ALLOWED_PROGRAMS defaults to the five programs"`, `"CIRCLE_IRIS_URL defaults to https://iris-api.circle.com"`.
    - `crosschain-solana.test.ts` with the fake RPC: `"getLatestBlockhash returns blockhash and lastValidBlockHeight"`, `"getSignatureStatuses returns null for an unknown signature"`, `"getAddressLookupTables decodes the address list after the 56-byte header"`, `"getAccountInfo returns null for a missing account and the owner for an existing one"`, `"a second URL is tried when the first fails"` (existing behaviour, new methods).
    - An integration assertion on the account-open ack: `"the session carries solana: { deposits: false, withdrawals: false } by default"`.
- [ ] **Step 2: Run them; expect FAIL** (`cd server && npx vitest run test/unit/config.test.ts test/integration/crosschain-solana.test.ts`).
- [ ] **Step 3: Implement** the config keys, the four `SolanaRpc` methods (all through the existing multi-URL `call`; `getAddressLookupTables` is hand-written with `getMultipleAccounts` base64 and a 56-byte header then 32-byte entries, which settles open question 9 for this plan), the fake RPC controls (`setBlockhash`, `setSignatureStatus`, `setLookupTable`, `setAccount`), `solana-switch.ts`, and the `Sessions` rules field. `Sessions.describe` returns the switches.
- [ ] **Step 4: Run the new tests, then the full checks** (`npm test && npx tsc --noEmit`). Expect PASS.
- [ ] **Step 5: Commit** "Add the Solana switches, config and the RPC reads deposits and withdrawals need"

---

### Task 2: Relay on Solana, the `SourceTx` union, the quote check, provider tiers (1.2)

**Files:**
- Modify: `server/src/crosschain/providers/types.ts`, `server/src/crosschain/providers/relay.ts`, `server/src/crosschain/quotes.ts`, `server/src/crosschain/providers/across.ts` (type widening only), `server/test/support/fake-bridge.ts`
- Create: `server/test/fixtures/relay/quote-solana-usdc.json`, `server/test/fixtures/relay/quote-solana-sol.json`
- Test: `server/test/unit/crosschain-relay.test.ts`, `server/test/unit/crosschain-quotes.test.ts`

**Interfaces:**
- Consumes `SolanaRpc` types from Task 1 (none directly); config `SOLANA_ALLOWED_PROGRAMS` passed in as `allowedPrograms: readonly string[]`.
- Produces:
    - `SourceTx = { kind: "evm"; chainId: number; to: Address; data: Hex; value: bigint } | { kind: "solana"; instructions: SolanaInstruction[]; lookupTables: string[] }`
    - `SolanaInstruction = { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: Hex }`
    - `QuoteRequest.sender` and `refundTo` become `string`; `Quote.refundTo` and `recipient` stay as they are (recipient is the Arc address).
    - `checkQuote(quote: Quote, request: QuoteRequest, allowedPrograms: readonly string[]): boolean`; `bestQuote(providers, request, { timeoutMs, tiers?, allowedPrograms })` where `tiers?: readonly (readonly string[])[]` is provider names per tier; omitted means one tier of everyone, so EVM keeps best-price.
- The two Relay fixtures are hand-built from the response shape recorded in the research (`steps[0].items[].data.instructions` and `addressLookupTableAddresses`, depository program `99vQ...JSrN2`). The owner replaces them with a recorded response at live check 1. They are not fetched by any test.

- [ ] **Step 1: Write the failing tests.**
    - `crosschain-relay.test.ts`:
        - `"a Solana USDC request uses chain 792703809, the USDC mint, includeComputeUnitLimit true and the wallet as user and refundTo"`
        - `"a SOL request uses 11111111111111111111111111111111 as originCurrency"`
        - `"the Solana fixture parses into one kind: solana transaction with its instructions and lookup tables"`
        - `"supports accepts solana:SOL and solana:USDC"`
        - `"SOLANA_TX_TOO_LARGE becomes unavailable with the 'Try a smaller route' message"`
        - `"status needs only the requestId for a Solana order"`
    - `crosschain-quotes.test.ts`:
        - `"a Solana quote passes with every program on the allowlist"`
        - `"an instruction from an unlisted program drops the quote"` and the error-level log is asserted
        - `"a Solana transaction in an EVM quote, or an EVM one in a Solana quote, is refused"`
        - `"a System transfer out of the wallet above the quoted amount is refused"` and `"a Token transfer above the quoted amount is refused"` (decode System tag 2 lamports and Token tags 3 and 12 amounts; other instructions are not decoded)
        - `"Solana addresses compare exactly, not case-insensitively"` (a refundTo differing only in case is refused)
        - `"tiers: Relay's quote wins over a higher-paying CCTP quote"`, `"tiers: CCTP is asked only when Relay gives no usable quote"`, `"no tiers: EVM best price is unchanged"`
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** the union and widening (every existing producer adds `kind: "evm"`), the Relay Solana branch (second item shape parsed with zod; the `COINS.find` lookup compares Solana mints exactly, SOL by the system id), `checkQuote` per the spec plus the amount rules above, and `bestQuote` tiers. `FakeBridge.supports` also accepts Solana coins when it has a rate for the symbol and returns one `kind: "solana"` tx whose single instruction targets the allowlisted depository program, with `ref` as its data.
- [ ] **Step 4: Run the new tests, then full checks.** Expect PASS, including all existing EVM quote tests.
- [ ] **Step 5: Commit** "Quote Solana deposits through Relay, and refuse a quote whose instructions we can't account for"

---

### Task 3: Solana deposit orders, tracker, blockhash event, sockets (1.1 to 1.2, 1.5)

**Files:**
- Modify: `server/src/crosschain/orders.ts`, `server/src/crosschain/tracker.ts`, `server/src/crosschain/views.ts`, `server/src/db/mongo.ts` (`DepositOrderDoc` comments only), `server/src/protocol.ts`, `server/src/validation.ts`, `server/src/socket/sockets.ts`, `server/src/server.ts`, `server/test/support/stack.ts` (if it builds the services)
- Test: `server/test/integration/deposit-orders.test.ts`, `server/test/integration/deposit-tracker.test.ts`, `server/test/integration/socket.test.ts`

**Interfaces:**
- Consumes: Task 1 `solanaOpen`, `SolanaRpc`; Task 2 `SourceTx`, `bestQuote`.
- Produces protocol:
    - `SourceTxView = EvmSourceTxView | { kind: "solana"; instructions: SolanaInstruction[]; lookupTables: { address: string; addresses: string[] }[] }`, where the EVM view gains `kind: "evm"`.
    - Socket `"solana:blockhash": (payload: Record<string, never>, ack: Ack<{ blockhash: string; lastValidBlockHeight: number }>)`.
    - `DepositOrderView.sourceTxHashes: string[]` (hex for EVM, base58 for Solana).
- `DepositOrders` constructor gains `solana: SolanaRpc`, `prices: PriceFeed`, `switches` and `minSolanaUsd`. `preview` and `create` take `wallet: string`.
- `OrderTracker` deps gain `solana: SolanaRpc`.

- [ ] **Step 1: Write the failing tests.**
    - `deposit-orders.test.ts` (fake bridge, fake RPC):
        - `"a Solana quote is refused while SOLANA_DEPOSITS is off"` (`unavailable`, "Solana isn't open yet.")
        - `"a Solana wallet that isn't linked is forbidden"` ("That wallet isn't linked to your account.")
        - `"under $2 in USDC is refused"` and `"0.01 SOL priced at $150 is refused with 'The smallest deposit from Solana is $2.'"`
        - `"no route from Relay or CCTP is 'No route for this deposit right now.'"`
        - `"create stores the base58 wallet as given and returns instructions with the lookup tables' contents"`
        - `"the order doc keeps refundTo exactly as the wallet, not lowercased"`
        - `"deposit:source takes a base58 signature for a Solana order and refuses a 0x hash for it, and the reverse for an EVM order"`
    - `deposit-tracker.test.ts`:
        - `"a finalized signature without error moves sent to in_block"`
        - `"confirmed counts as in_block"`
        - `"a signature with an error moves to failed"`
        - `"an unknown signature past expiryMs moves to failed"`
        - `"Relay filled with no USDC at the deposit address leaves the order bridging and credits nothing"` (Review Focus 1)
        - `"Relay filled and the watcher credits the fill: delivered, one credit, linked to the order"`
        - `"Relay refunded moves the order to refunded"`
    - `socket.test.ts`: `"solana:blockhash answers the fake RPC's blockhash and is limited to 30 per minute"`, `"deposit:order for a Solana coin returns a kind: solana tx"`.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.** In `DepositOrders.#quote` replace the Solana refusal with the switch, the minimum (`SOLANA_DEPOSIT_MIN_USD`; SOL valued with `PriceFeed.usd`) and `tiers: [["relay"], ["cctp"]]` for Solana coins only. In `create`, store `wallet`/`refundTo` untouched for Solana and the existing lowercase for EVM; read the lookup tables through `getAddressLookupTables` and return them in the tx view. `OrderTracker.#checkSource` branches on `chain === "solana"` with `getSignatureStatuses`. `sockets.ts`: `authorizedWallet` drops the `BASE58_ADDRESS` refusal and returns the base58 address as given for Solana; add `solana:blockhash` with its own `RateLimiterMemory`. `sourceReport` accepts either shape and `reportSource` checks the shape against the order's coin.
- [ ] **Step 4: Run the new tests, then full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Open, follow and credit Solana deposit orders, with the order never credited from the bridge's word alone"

---

### Task 4: Client Solana deposit and deposit UI (1.3, 1.5, 1.6)

**Files:**
- Modify: `components/account-client.ts`, `components/account-provider.tsx`, `components/deposit-coins.tsx`, `components/deposit-form.tsx`, `components/deposit-progress.tsx`, `lib/account/state.ts` (session switches), `server/test/e2e/serve.ts` (switches on, Solana rates for the fake bridge, fake RPC controls)
- Create: `lib/account/solana-tx.ts`
- Test: `e2e/solana-deposit.logic.spec.ts`, `e2e/solana-deposit.spec.ts`

**Interfaces:**
- Consumes: Task 3 `SourceTxView` (kind solana), `solana:blockhash`, session `solana.deposits`; `SwapSigner["solana"]` (`signAndSend(bytes): Promise<string>`) from `components/account-client.ts`.
- Produces `lib/account/solana-tx.ts`: `buildDepositTransaction(input: { payer: string; blockhash: { blockhash: string; lastValidBlockHeight: number }; instructions: SolanaInstruction[]; lookupTables: { address: string; addresses: string[] }[] }): Uint8Array`. It builds a v0 message with `@solana/kit` (payer, lifetime, instructions as given, `compressTransactionMessageUsingAddressLookupTables`), adds a compute-unit-limit instruction only when none is present, and returns compiled bytes.
- Produces `AccountClient.solanaDeposit(coin: string, amount: string, wallet: { address: string; signer: SwapSigner["solana"]; solBalance: bigint | null }): Promise<DepositResult>`.

- [ ] **Step 1: Write the failing tests.**
    - Logic (`solana-deposit.logic.spec.ts`, no browser):
        - `"the built message's fee payer is the wallet and its lifetime is the given blockhash"`
        - `"instructions come out in the given order, compressed against the given tables"`
        - `"a compute-unit-limit instruction is added only when the quote has none"`
        - `"a rejected wallet prompt is 'cancelled'"` and `"a wallet with 0 SOL gets 'You need a little SOL to send from Solana.' and no order is opened"`
        - `"the signature is reported with deposit:source and the shown balance drops"`
        - `"isOpen follows the session switch: Solana rows are open when deposits are on, and stay under 'Not open yet' when off"`
    - Browser (`solana-deposit.spec.ts`, fake bridge, fake Solana wallet from `installSolanaWallet`): `"Solana rows are open and a Solana deposit shows the 'You get about' line"`, `"confirming shows sent, in a block, bridging, delivered, and the explorer link is a Solana explorer"`.
- [ ] **Step 2: Run them; expect FAIL** (`npm run test:logic`; browser from the isolated copy on 3650/4650/4651).
- [ ] **Step 3: Implement** `buildDepositTransaction`, `solanaDeposit` (order, then `solana:blockhash` right before signing, then sign, then `deposit:source`), `isOpen` reading the session switch, the form's confirm branch, the fee line from `usdcOut` against the amount sent, and the progress link. The e2e backend turns both switches on and gives the fake bridge SOL and USDC rates.
- [ ] **Step 4: Run logic tests, `npx tsc --noEmit -p .`, then the browser spec from the isolated copy.** Expect PASS.
- [ ] **Step 5: Commit** "Sign and send Solana deposits from the person's own wallet"

---

### Task 5: Withdrawal recipient checks, Iris fee client, `withdraw:quote`, create (2.1, 2.2, 2.6, 3)

**Files:**
- Create: `server/src/crosschain/iris.ts`, `server/src/withdrawals/solana-recipient.ts`, `server/test/support/fake-iris.ts`
- Modify: `server/src/withdrawals/withdrawals.ts`, `server/src/withdrawals/views.ts`, `server/src/withdrawals/payouts.ts` (skip Solana docs in `#pass` only), `server/src/db/mongo.ts`, `server/src/protocol.ts`, `server/src/validation.ts`, `server/src/socket/sockets.ts`, `server/src/server.ts`
- Test: `server/test/unit/solana-recipient.test.ts`, `server/test/unit/iris.test.ts`, `server/test/integration/withdrawals-solana.test.ts`, `server/test/integration/withdraw-socket.test.ts`

**Interfaces:**
- Consumes: Task 1 `SolanaRpc.getAccountInfo`, `solanaOpen`, `quote_changed`.
- Produces `iris.ts`: `createIris(options: { baseUrl: string; fetch?: typeof fetch }): Iris` with
    - `forwardFee(input: { from: 26; to: 5; setup: boolean }): Promise<{ med: bigint; high: bigint }>` (USDC wei, 18 decimals)
    - `message(input: { domain: number; burnTxHash: Hex }): Promise<IrisMessage | null>` where `IrisMessage = { status: "pending" | "complete" | "failed"; forwardTxHash: string | null; raw: unknown }`.
    - Both throw `IrisError { kind: "rate_limited" | "unavailable" }`; a 429 is `rate_limited`.
- Produces `solana-recipient.ts`:
    - `solanaBytes32(address: string): Hex` (base58 to 32 bytes, 0x-prefixed)
    - `usdcAccountOf(wallet: string): Promise<string>` (`findAssociatedTokenPda` for the USDC mint)
    - `checkRecipient(rpc: SolanaRpc, wallet: string): Promise<{ usdcAccount: string; setup: boolean }>` throws `AppError("bad_request", "That address can't receive USDC.")` for a program-owned wallet; a missing wallet account is fine.
- Produces `Withdrawals`:
    - `quoteSolana(account, input: { amount: string; to: string }): Promise<{ fee: bigint; receive: bigint; setup: boolean }>`
    - `create(account, input: { requestId: string; amount: string; to: string; reviewedFee?: string })` now handles `network: "solana"` (the socket passes it when `to` is base58).
- Produces protocol: `WithdrawalState` gains `"forwarding"`; `WithdrawalView` gains `network: "arc" | "solana"`, `fee: UsdcAmount | null`, `receive: UsdcAmount | null`, `forwardTxHash: string | null`; socket `"withdraw:quote": (payload: { amount: string; to: string }, ack: Ack<{ fee: UsdcAmount; receive: UsdcAmount; setup: boolean }>)`; `withdrawRequest` gains optional `reviewedFee`.
- `WithdrawalDoc` gains `network?: "arc" | "solana"` and `solana?: { wallet, usdcAccount, setup, fee, maxFee, approveNonce, approveRawTx, approveTxHash, burnNonce, burnRawTx, burnTxHash, forwardTxHash, irisCheckedAt }` as spec section 3 lists them (amounts as `Decimal128`, nullable until set).

- [ ] **Step 1: Write the failing tests.**
    - `solana-recipient.test.ts`: `"solanaBytes32 matches a known vector"` (use a fixed address and its independently computed 32 bytes; the vector is checked into the test, per spec 2.2), `"the USDC account is derived, never the wallet"`, `"a missing wallet account is accepted with setup true when the USDC account is also missing"`, `"a wallet owned by a program is refused"`, `"an existing USDC account gives setup false"`.
    - `iris.test.ts`: `"forwardFee reads med and high for 26 to 5 with forward=true"`, `"includeRecipientSetup=true is added only when setup"`, `"a 429 is rate_limited"`, `"message maps a missing message to null and complete with forwardTxHash"`.
    - `withdrawals-solana.test.ts` (real Mongo stack, anvil, fake Iris and RPC):
        - `"create debits once and inserts a sending Solana withdrawal with fee, maxFee and setup"`
        - `"the same requestId twice makes one withdrawal"`
        - `"an unlinked wallet is forbidden and nothing is debited"`, `"a program-owned wallet is refused and nothing is debited"`
        - `"under 1 USDC is refused with 'The smallest withdrawal to Solana is $1.'"`
        - `"an amount where amount minus maxFee is zero or less is refused"` (Review Focus 5)
        - `"a fee above reviewedFee plus 0.05 gives quote_changed with the new fee and nothing debited"`; `"a fee within the tolerance proceeds"`
        - `"an Iris fee failure is 'Couldn't price this right now. Nothing was taken.'"`
        - `"the treasury short is insufficient_funds"`
        - `"an account missing at the quote and present at create takes the cheaper path; present then gone turns setup on"`
        - `"switch off is 'Solana isn't open yet.'"`
        - `"Payouts leaves a Solana sending withdrawal alone"`
    - `withdraw-socket.test.ts`: `"withdraw:quote answers fee, receive and setup and is limited to 30 per minute"`, `"withdraw:create accepts a linked Solana wallet"`.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.** Reuse the existing `#lock`, `#treasuryFree` and the single Mongo transaction in `#create`. The fee shown is `med`; `maxFee` is `high`. `receive = amount - fee`. `views.ts` maps the new fields; `receive` and `fee` stay null for Arc. `sockets.ts` removes the `BASE58_ADDRESS` refusal in `withdraw:create` and routes a base58 `to` to the Solana path after `authorizeWallet`. `Payouts.#pass` selects `{ state: "sending", network: { $ne: "solana" } }`.
- [ ] **Step 4: Run the new tests, then full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Quote and create Solana withdrawals, checking the recipient and the fee before anything is debited"

---

### Task 6: Paying a Solana withdrawal: approve, burn, forward (2.3 to 2.5)

**Files:**
- Modify: `server/src/withdrawals/payouts.ts`, `server/src/server.ts` (Payouts deps), `server/test/support/fake-iris.ts`, `server/test/e2e/serve.ts`
- Create: `server/src/withdrawals/cctp-burn.ts`, `server/test/support/stub-token-messenger.ts`
- Test: `server/test/integration/payouts-solana.test.ts`, `server/test/unit/cctp-burn.test.ts`

**Interfaces:**
- Consumes: Task 5 `Iris`, `WithdrawalDoc.solana`, `solanaBytes32`; `WithdrawalState "forwarding"`.
- Produces `cctp-burn.ts`:
    - `encodeApprove(amount6: bigint): Hex` (USDC ERC-20 view `approve(TokenMessengerV2, amount)`)
    - `encodeBurn(input: { amount6: bigint; usdcAccount: string; wallet: string; setup: boolean; maxFee6: bigint }): Hex` for `depositForBurnWithHook(amount, 5, mintRecipient, burnToken, destinationCaller, maxFee, 2000, hookData)`. `mintRecipient` is `solanaBytes32(usdcAccount)`. `destinationCaller` and `hookData` (the extended layout when `setup`, with the wallet's 32 bytes) are copied from Circle's forwarding how-to by the implementer, not from this plan or the spec (open question 3).
    - `weiToUsdc6(wei: bigint): bigint` (exact; throws if not a multiple of 10^12).
- `Payouts` deps gain `iris: Iris`, `tokenMessenger?: Address` (default the mainnet address; tests pass the stub's).
- The stub TokenMessenger is deployed on anvil with the emulator's pattern in `arc-emulator.ts`; it records the arguments of every `depositForBurnWithHook` and `approve` call, and can be told to revert.

- [ ] **Step 1: Write the failing tests.**
    - `cctp-burn.test.ts`: `"encodeBurn passes domain 5, minFinalityThreshold 2000 and the derived account as mintRecipient"`, `"weiToUsdc6 converts 12.5 USDC wei exactly and rejects dust"`.
    - `payouts-solana.test.ts` (anvil, real Mongo, fake Iris):
        - `"approve then burn go out in nonce order, the stub records the right domain, mintRecipient, maxFee and hook data, with and without setup"`
        - `"both raw transactions and hashes are stored before either is broadcast"`
        - `"the state goes sending to forwarding when the burn is mined, then to sent when Iris returns forwardTxHash, which is stored"`
        - `"a refused approve ends failed with exactly one withdrawal_refund"`; `"a reverted burn ends failed with one refund"`
        - `"a burn mined and then Iris down for a long time never refunds and stays forwarding"` (Review Focus 3)
        - `"Iris answering 429 backs off and leaves the state unchanged"`
        - `"restart in sending with stored raw transactions re-sends the same bytes and the person is paid once"`
        - `"restart in forwarding resumes polling from the stored burn hash and sends nothing"`
        - `"Arc and Solana withdrawals interleaved take distinct nonces"` (the `#sign` highest-nonce lookup also reads `approveNonce`/`burnNonce`)
        - `"forwarding for 15 minutes shows the delayed flag and logs 'Solana withdrawal stalled' once an hour"` (fake clock)
        - `"Iris reporting the forward failed logs the full response at error and does not refund"`
        - `"Iris is asked at most once per tick and at most 5 times per second in total"`
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** `#paySolana` in the same serial queue: sign and store both transactions (guarded `findOneAndUpdate` on `solana.approveRawTx: null`), broadcast approve and wait for its receipt, then broadcast burn and wait. On burn success move guarded `sending` to `forwarding` with `burnTxHash`. A separate step in `#pass` polls `forwarding` withdrawals oldest first, one Iris call per tick, and moves to `sent` with `forwardTxHash`. Reuse `alreadySent`, `refused`, `unreachable` and `#fail` unchanged. `WithdrawalView` carries a `delayed: boolean` derived from `updatedAt`; add it to the protocol type.
- [ ] **Step 4: Run the new tests, then full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Pay Solana withdrawals by burning from the treasury, and never refund once the burn is mined"

---

### Task 7: Withdraw form, wallet picker and history (2.7)

**Files:**
- Modify: `components/withdraw-form.tsx`, `components/wallet-sidebar.tsx`, `components/account-provider.tsx`, `components/account-client.ts`, `components/history-entries.ts`, `lib/account/state.ts`, `server/test/e2e/serve.ts` (fake Iris, switches on)
- Test: `e2e/withdraw-solana.logic.spec.ts`, `e2e/withdraw-solana.spec.ts`

**Interfaces:**
- Consumes: Task 5 protocol (`withdraw:quote`, `reviewedFee`, view fields, `quote_changed`), Task 6 `forwarding` and `delayed`.
- Produces `WithdrawFormProps.wallets: { kind: "evm" | "solana"; address: string }[]`; `AccountClient.withdrawQuote(amount: string, to: string): Promise<{ fee: string; receive: string; setup: boolean } | ApiError>`; `withdraw(amount, to, reviewedFee?)`.

- [ ] **Step 1: Write the failing tests.**
    - Logic: `"the picker lists every linked wallet with its network and short address, default the wallet in use"`, `"picking Solana asks withdraw:quote debounced and shows 'Fee 0.13 USDC · you receive 9.87 USDC'"`, `"setup shows 'Includes 0.16 USDC to set up your USDC account.'"`, `"the Solana minimum of 1 replaces the floor for that wallet and below it the field shakes"`, `"quote_changed shows the new line and sends nothing until Withdraw is pressed again"`, `"'Connect an EVM wallet' shows only with no wallet of either kind"`, `"history reads Sending, 'Sending to Solana' for forwarding, then Sent, and an old push can't undo a newer one"` (state upserts by `updatedAt`, already so; the test pins it for `forwarding`).
    - Browser: `"a Solana-only person withdraws with no EVM wallet"`, `"the balance drops at once and the row goes Sending, Sending to Solana, Sent"`, `"a failed burn puts the balance back with 'Didn't go through. Your balance is back.'"`, `"the setup line shows for a wallet with no USDC account"`.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** the form changes, the history labels, and the client method. The reviewed fee sent is the figure last shown.
- [ ] **Step 4: Run `npm run test:logic`, `npx tsc --noEmit -p .`, then the browser spec from the isolated copy on 3650/4650/4651.** Expect PASS.
- [ ] **Step 5: Commit** "Withdraw to a Solana wallet from the form, with the fee shown before pressing Withdraw"

---

### Task 8: CCTP deposit fallback, USDC only (1.4)

**Gate before any code (open questions 1 and 2):** confirm, with read-only requests the owner runs or approves, that Iris answers `GET /v2/burn/USDC/fees/5/26?forward=true`, that Arc is a forwarding destination from Solana, and which of the two Solana program ids is the TokenMessengerMinter on an explorer. If Arc isn't a forwarding destination, stop and report: the fallback then needs our own `receiveMessage` on Arc and a second signer, which the spec doesn't design. Do not guess the instruction layout; build it from Circle's IDL or docs.

**Files:**
- Create: `server/src/crosschain/providers/cctp.ts`
- Modify: `server/src/server.ts` (register the provider after Relay), `server/test/support/fake-iris.ts`
- Test: `server/test/unit/crosschain-cctp.test.ts`, `server/test/integration/deposit-orders.test.ts`

**Interfaces:**
- Consumes: Task 2 `BridgeProvider`, `SourceTx` (solana), tiers; Task 5 `Iris` (adds `depositFee()` for 5/26 and `message({ domain: 5, burnTxHash })` taking a signature string).
- Produces `createCctp(options: { iris: Iris; arcDomain: 26; solanaDomain: 5 }): BridgeProvider` with `name: "cctp"`, `supports` true only for `solana:USDC`.

- [ ] **Step 1: Write the failing tests.**
    - `"supports only solana:USDC"`; `"quote usdcOut is the amount less the Iris fee, ref is the order id until a burn exists"`
    - `"the transaction burns with destination domain 26, a left-padded 32-byte mintRecipient equal to the Arc deposit address, forwarding hook data and the quoted maxFee"`
    - `"status: no message is waiting; complete with forwardTxHash is filled; the tracker doesn't poll faster than its own schedule"`
    - `"a burned message that never mints is logged at error with the signature and the order expires"`
    - integration: `"Relay gives no quote, so a Solana USDC deposit goes through CCTP and is credited once by the watcher"`
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** `createCctp`. The instruction's program id, accounts and Anchor discriminator come from the confirmed IDL (gate above).
- [ ] **Step 4: Run the new tests, then full checks.** Expect PASS.
- [ ] **Step 5: Commit** "Fall back to CCTP for Solana USDC deposits when Relay can't quote"

---

## Handoff to the owner (not tasks)

Spec "What the owner provides", and live checks 1, 2, 4, 5 after Task 7 and check 3 after Task 8, each at 1 USDC with the two minimums lowered to 1 for the check only. Before check 1, replace the two hand-built Relay fixtures with a recorded response. Switch on only after the checks pass; watch for "Solana withdrawal stalled".

## Spec findings

- **Server dependencies.** `server/package.json` has neither `@solana/kit` nor `@solana-program/token`; they resolve today only from the repo root. `deploy/server.Dockerfile` installs the server's own dependencies, so the spec's recipient derivation would fail in the image. Task 1 adds both.
- **`quote_changed` is not an `ErrorCode`.** The spec uses it; `protocol.ts` and `errors.ts` have no such code. Task 1 adds it (409).
- **`fee` used for `maxFee` disagrees within the spec.** 2.3 says `maxFee` is "the quoted fee"; 2.6 says the `high` tier. The plan follows 2.6 (the figure shown is `med`).
- **The program-id allowlist can't bound what System and Token instructions do** (1.2). A bad quote could include a top-level System transfer from the person's wallet to anyone. Task 2 adds amount ceilings for those two program types, which the spec doesn't ask for. Needs the owner's OK.
- **Solana coins have `chainId: null`** in the catalog, so the spec's "EVM requires `tx.chainId === coin.chainId`" works, but Relay's id 792703809 lives only in the request; the plan keeps it a Relay constant.
- **`lib/account/state.ts` has no state ordering** to extend with `forwarding` (spec 2.7): upserts compare `updatedAt`. Task 7 only pins it with a test.
- **`SourceTxView`, `sourceTxHashes` and `sourceReport` assume 0x hex.** The spec mentions the order doc but not these wire types or the validator; Tasks 2 and 3 widen them.
- **Relay's recorded Solana fixture can't be recorded in a test** (no real calls, and Relay needs an API key since 2026-10-02). The plan hand-builds the fixtures from the research's recorded shape and leaves a recording to live check 1.
- **Task 8 may be impossible as specified** if Arc isn't a forwarding destination from Solana (open question 1); the gate stops there.
