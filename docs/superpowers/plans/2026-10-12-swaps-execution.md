# Multichain Swaps Phase B Implementation Plan: real swaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirming a Swap, Buy or Sell signs the swap LI.FI built from the person's own wallet. The server checks the transaction first and follows it to the end. The app shows what arrived, optimistically.

**Architecture:**

- **Server.** Three pieces under `server/src/swaps/`:
    - LI.FI's `/v1/quote`, `/v1/status` and `/v1/chains`, behind the phase A client
    - `SwapOrders`: quote, re-quote at confirm, the checks, approvals, a `swap_orders` record
    - `SwapTracker`: polls status and pushes `swap:update`
- **Client.** It signs the returned transactions:
    - EVM: the deposit path (`ensureNetwork`, then `eth_sendTransaction`)
    - Solana: the wallet's sign-and-send
- **Review panel.** It gets a live swap branch: quote rows, progress and messages.

**Tech Stack:** Node 24 + Express 5 + socket.io + zod + viem + MongoDB (server), vitest, Next.js 16 + React 19, Privy, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-multichain-swaps-design.md`, sections 6 and 7, the phase B parts of Testing, and "Order of work" step 2. Builds on `docs/superpowers/plans/2026-10-12-swaps-networks-balances.md` (phase A).

## Global Constraints

- **Phase A's Global Constraints all apply**: commits by path with no trailer; no edits to `server/src/crosschain/*` or `server/src/balances/*`; never read `.env`; tests and isolated browser runs on 3640/4640/4641; official logos only; one-line comments; the sentence and picker invariants.
- **LI.FI requests:**
    - `GET {LIFI_URL}/v1/quote` with:
        - `fromChain`, `toChain`, `fromToken`, `toToken`, `fromAddress`, `toAddress`, `fromAmount`
        - `slippage=0.005`, `integrator={LIFI_INTEGRATOR}`
        - `fee={LIFI_FEE}` only when it is above 0
        - header `x-lifi-api-key` when set
    - `GET {LIFI_URL}/v1/status?txHash=&fromChain=&toChain=&bridge={tool}`
    - `GET {LIFI_URL}/v1/chains?chainTypes=EVM,SVM`, cached for an hour, for `diamondAddress`
- **Numbers:**
    - Quote refresh while the review is open: every 15 000 ms. The server caches the same request for 10 000 ms.
    - Price moved: the new `toAmountMin` is more than 0.5% below the reviewed `toAmountMin`.
    - Unsettled orders per account: 5.
    - An order never reported sent expires after 15 minutes.
    - Status polling: every 10 s for the first minute, every 30 s to 4 minutes, then every 60 s. Give up after 24 hours.
    - Socket limits per user: `swap:quote` 60/min, `swap:order` 10/min.
    - IPs are kept 30 days, in their own collection with a TTL index.
    - On Arc the client sets `maxFeePerGas` and `maxPriorityFeePerGas` itself (`MAX_FEE_PER_GAS = parseGwei("40")`, as `deposit()` does), never LI.FI's `gasPrice`.
- **Copy, verbatim** (spec section 7):
    - "There's no route for this swap right now."
    - "The price moved. Check the new amount and confirm again."
    - `Switch your wallet to {Network} and try again.`
    - `Connect a Solana wallet to receive {SYMBOL} on Solana.` (or `an EVM wallet`, for an EVM receiving network)
    - `The swap failed, so your {SYMBOL} stayed in your wallet. Only the network fee was spent.`
    - `The swap didn't go through. Your {amount} {SYMBOL} is back on {Network}.`
    - `Received {amount} {SYMBOL} on {Network} instead of {SYMBOL}.`
    - "Swaps aren't available right now."
    - "Swap sent."
    - `Approve {SYMBOL} in your wallet, then confirm the swap.`
    - `Received {amount} {SYMBOL}.`
    - A wallet rejection shows nothing, and the button goes back to "Confirm swap".
- **Buy and Sell are swaps:**
    - Buy pays USDC on `buyPayNetwork` (phase A) for the coin on its network.
    - Sell pays the coin on its network for USDC on the same network.
    - Long, Short and Predict are unchanged.
- **Real swaps never go through `confirmedTrades`.** PnL realized still counts only `kind "close"`. The deposit history stays deposits only.

## Review Focus

1. **The socket drops between the wallet's send and `swap:sent`.** The order stays `created` with hashes only in the client. On reconnect the client must report them again, and the server must take them while the order is `created` or `expired` (with its hashes). (Task 4 test.)
2. **Two tabs confirm the same review.** Each gets its own order; neither double-drops the balance. (Task 4 test.)
3. **A quote that answers after the person changed the amount.** It must never be shown or confirmed for the new amount. (Task 5 test.)
4. **An approval lands but the swap is rejected in the wallet.** The order stays `created` and expires, no balance drops, and the button returns to "Confirm swap". (Task 5 test.)
5. **LI.FI's status says DONE while the receiving token's address differs from the order's.** It is `partial` with the received token's symbol, or its address when the symbol is unknown. It is never `done`. (Task 3 test.)

---

### Task 1: LI.FI quote, status and chains; the transaction checks

**Files:**
- Modify: `server/src/swaps/lifi.ts`, `server/test/support/fake-lifi.ts`, `server/scripts/record-lifi-fixtures.ts`
- Create: `server/src/swaps/check.ts`, `server/src/swaps/solana-tx.ts`, `server/test/fixtures/lifi/chains.json`, `server/test/fixtures/lifi/solana-tx.txt`
- Test: `server/test/unit/lifi.test.ts`, `server/test/unit/swap-check.test.ts`

**Interfaces:**
- Produces, `Lifi`:
    - `chains(): Promise<{ id: number; diamondAddress: string | null }[]>`
    - `quote(req: LifiQuoteRequest): Promise<LifiQuote>`
    - `status(req: { txHash: string; fromChain: number; toChain: number; bridge: string }): Promise<LifiStatus>`
- `LifiQuoteRequest`:
    - `{ fromChain: number; toChain: number; fromToken: string; toToken: string; fromAddress: string; toAddress: string; fromAmount: string; slippage: number; integrator: string; fee?: number }`
- `LifiQuote`:
    - `{ id: string; tool: string; toolName: string; fromChainId: number; toChainId: number; fromToken: string; toToken: string; fromAddress: string; toAddress: string; fromAmount: string; toAmount: string; toAmountMin: string; approvalAddress: string | null; skipApproval: boolean; etaSeconds: number; fees: { name: string; amountUSD: number; included: boolean }[]; gasUSD: number; tx: EvmTxRequest | SolanaTxRequest }`
    - `EvmTxRequest = { kind: "evm"; chainId: number; from: string; to: string; data: string; value: string }`
    - `SolanaTxRequest = { kind: "solana"; data: string }`
- `LifiStatus`:
    - `{ status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED"; substatus: string | null; sendingTxHash: string | null; fromAddress: string | null; toAddress: string | null; receiving: { txHash: string | null; amount: string; tokenAddress: string; tokenSymbol: string; decimals: number; chainId: number } | null }`
    - A 404 counts as `NOT_FOUND`.
- Errors: `class LifiError extends Error { kind: "no_route" | "rate_limited" | "unavailable" }`. A 404 on quote, or a 400 whose body code is 1002 or 1011, is `no_route`. A 429 is `rate_limited`. Anything else, or a timeout, is `unavailable`.
- Produces, `check.ts`: `checkQuote(quote: LifiQuote, want: { fromNetwork: NetworkId; from: CoinEntry; toNetwork: NetworkId; to: CoinEntry; fromAddress: string; toAddress: string; fromUnits: bigint; diamond: string | null }): void`.
    - It throws `AppError("unavailable", "Swaps aren't available right now.")`, and logs which rule failed.
    - Rules (spec section 6):
        - chain ids match the networks, and the tokens match the entries (EVM lowercase)
        - `fromAddress` and `toAddress` match
        - `fromAmount` equals `fromUnits`
        - EVM: `tx.chainId` is the from-network, `tx.from` is the wallet, and `tx.to` is the diamond
        - `value` is 0 for a token input, and at most `fromUnits` for a native one. On Arc, `fromUnits × 10^12` compares to the 18-decimal `value`.
        - Solana: the decoded fee payer is the wallet
- Produces, `solana-tx.ts`: `solanaFeePayer(base64: string): string`. It reads the first static account key of a legacy or v0 wire transaction, base58 via `@scure/base`.
- Produces, fake LI.FI routes and controls:
    - `/v1/chains` from the fixture.
    - `/v1/quote`, computed from the fixture prices. It applies the 0.25% fee and sets `toAmountMin = toAmount × 0.995`. It returns `tool` "fakebridge", the chain's diamond as `tx.to`, `estimate.approvalAddress` = the diamond, `skipApproval` for native inputs, and the recorded Solana transaction (with the fee payer swapped in) for Solana inputs.
    - `/v1/status`: per-hash state that tests set.
    - Controls: `quotes: LifiQuoteRequest[]`, `nextQuote(patch: Partial<raw quote>)`, `noRoute()`, `setStatus(txHash, raw status)`, `failNext("/v1/quote" | "/v1/status")`.

- [ ] **Step 1: Record the fixtures.** Extend the recorder to write `chains.json` (the nine chains' `id`, `key`, `diamondAddress`). For `solana-tx.txt`, record one real Solana `transactionRequest.data`: a keyless $10 SOL to USDC quote on Solana. Run it.
- [ ] **Step 2: Write the failing tests.**
    - In `lifi.test.ts`:
        - `"a quote parses into LifiQuote"`
        - `"no route is LifiError no_route"`
        - `"a 429 is rate_limited"`
        - `"status DONE with receiving parses, and a 404 is NOT_FOUND"`
    - In `swap-check.test.ts`, one test per rule, each with the passing quote altered in one field:
        - `"a wrong diamond is refused"`, and likewise for chain, sender, receiver, from token, to token, amount and value
        - `"Arc USDC's 18-decimal value is compared in 6 decimals"`: a value of 50e18 for 50 USDC passes, and 50e18 + 1 fails
        - `"a Solana transaction paid by someone else is refused"`
        - `"solanaFeePayer reads the recorded transaction"`
- [ ] **Step 3: Run them and watch them fail.** Then implement, then run them and watch them pass.
- [ ] **Step 4: Commit.** Message: `Quote and track swaps with LI.FI, and check every transaction it builds`.

### Task 2: Swap orders: quote, confirm, approvals, record

**Files:**
- Create: `server/src/swaps/orders.ts`, `server/src/swaps/views.ts`
- Modify: `server/src/protocol.ts`, `server/src/errors.ts`, `server/src/db/mongo.ts`, `server/src/db/migrations.ts` (account merge re-points `swapOrders`), `server/src/validation.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/socket/sockets.ts`
- Test: `server/test/integration/swap-orders.test.ts`, `server/test/unit/errors.test.ts`

**Interfaces:**
- Consumes: Task 1, plus phase A: `COINS`, `SwapCatalog.priceOf`, `SwapHoldings.last`, `createSwapClients`.
- Produces, protocol:
    - `SwapSide = { token: string; network: SwapNetworkId }`
    - `SwapRequest = { from: SwapSide; to: SwapSide; amountUSD: string; wallet: string; receiver: string }`. `wallet` pays and signs. `receiver` is the person's own wallet on the receiving network's kind.
    - `SwapQuoteView = { request: SwapRequest; fromAmount: string; toAmount: string; toAmountMin: string; fees: { name: string; usd: number }[]; gasUSD: number; etaSeconds: number; tool: string; needsApproval: boolean }`. Amounts are decimal coin units.
    - `SwapTxView = { kind: "evm"; purpose: "reset" | "approve" | "swap"; chainId: number; to: string; data: string; value: string } | { kind: "solana"; data: string }`
    - `SwapOrderView = { id: string; state: "created" | "sent" | "done" | "partial" | "refunded" | "failed" | "expired"; from: SwapSide & { amount: string }; to: SwapSide & { amount: string; received: string | null; receivedSymbol: string | null }; wallet: string; txHashes: string[]; createdAt: string; updatedAt: string }`
    - Client to server:
        - `"swap:quote": (req: SwapRequest, ack: (r: Ack<SwapQuoteView>) => void) => void`
        - `"swap:order": (req: SwapRequest & { reviewedMin: string }, ack: (r: Ack<{ order: SwapOrderView; txs: SwapTxView[] }>) => void) => void`
        - `"swap:sent": (p: { orderId: string; txHashes: string[] }, ack: (r: Ack<SwapOrderView>) => void) => void`
    - Server to client: `"swap:update": (p: { order: SwapOrderView }) => void`, and `"swaps": (p: { orders: SwapOrderView[] }) => void`, pushed at `account:open` with open orders and those settled in the last 7 days, newest first, at most 50.
- Error codes:
    - `no_route` (status 422)
    - `price_moved` already exists, and is reused
    - `unavailable` for LI.FI down or rate limited
    - `forbidden` for a wallet that isn't the account's
- Mongo:
    - `swapOrders` (`swap_orders`): indexes `(accountId, createdAt desc)` and `(state, updatedAt)`
    - `swapIps` (`swap_ips`): `{ orderId, ip, expiresAt }`, with a TTL index on `expiresAt`
- `class SwapOrders`:
    - `constructor(deps: { collections; lifi: Lifi; catalog: SwapCatalog; holdings: SwapHoldings; clients: Record<EvmNetworkId, PublicClient>; identity: IdentityProvider; bus: Bus; integrator: string; fee: number; now?: () => number })`
    - `quote(account, identity, req): Promise<SwapQuoteView>`
    - `create(account, identity, req & { reviewedMin }, ip: string): Promise<{ order: SwapOrderDoc; txs: SwapTxView[] }>`
    - `reportSent(account, orderId, hashes): Promise<SwapOrderDoc>`
    - `recent(accountId): Promise<SwapOrderDoc[]>`
- Rules:
    - **Wallets.** Both `wallet` and `receiver` must pass `identity.authorizeWallet`. The wallet's kind must match the from-network's, and the receiver's must match the to-network's.
    - **Units.** `fromUnits` is `floor(amountUSD / price × 10^decimals)`, capped at the wallet's last-read balance there when one is known.
    - **Cache.** Quotes are cached 10 s per request key; `create` always re-quotes.
    - **Approvals.** For a token input without `skipApproval`, read `allowance(wallet, approvalAddress)` on the from-network.
        - If the allowance is short, add `approve(approvalAddress, fromUnits)`.
        - First, USDT on Ethereum with a non-zero allowance gets an `approve(approvalAddress, 0)` (`purpose: "reset"`).
        - The order is approvals, then the swap.
    - **Limits.** With 5 unsettled orders (`created` or `sent`), refuse `rate_limited` with "Too many swaps are still waiting. Try again in a few minutes."
    - **`reportSent`.** It moves `created` to `sent`, or takes an `expired` order that has no hashes. It is idempotent, and every move emits `swap:update` on the bus.

- [ ] **Step 1: Write the failing integration tests** (stack with fake LI.FI and anvils):
    - `"a quote shows LI.FI's amounts, fees and time"`
    - `"confirming USDC on Ethereum adds an exact approval before the swap"`
    - `"enough allowance means only the swap"`
    - `"USDT on Ethereum with an old allowance is reset to 0 first"`
    - `"a native coin needs no approval"`
    - `"the price moved"`: the fake's next `toAmountMin` is 1% lower, so `create` is refused with `price_moved`
    - `"no route"`: `no_route`, with the verbatim copy
    - `"someone else's wallet is refused"`
    - `"an EVM receiver for Solana is refused"`
    - `"the IP is kept apart and expires"`: a `swap_ips` row exists, and its TTL index is `expireAfterSeconds: 0` on `expiresAt` (30 days out)
    - `"a sixth unsettled swap is refused"`
    - `"sent is reported once, and again is harmless"`
    - `"a merged account keeps its swaps"`
    - `"swaps are pushed at sign-in"`
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Sockets copy the `deposit:order` handler shape with their own limiters. Pushes use the per-account `enqueue` chain and the owner check.
- [ ] **Step 4: Run the tests and the whole server suite.** Expected: PASS and green.
- [ ] **Step 5: Commit.** Message: `Open swap orders from checked LI.FI quotes, with exact approvals`.

### Task 3: Following a swap to the end

**Files:**
- Create: `server/src/swaps/tracker.ts`
- Modify: `server/src/server.ts`, `server/src/events.ts`, `server/test/e2e/serve.ts` (control routes), `e2e/backend.ts`
- Test: `server/test/integration/swap-tracker.test.ts`

**Interfaces:**
- Produces: `class SwapTracker`.
    - `constructor(deps: { collections; lifi: Lifi; clients; bus: Bus; holdings: SwapHoldings; identity: IdentityProvider; accounts: AccountService; logger; pollMs: number; now?: () => number })`
    - `start()`, `stop()`, and a public `tick()`
    - `SWAPS_POLL_MS` is a new config value: default 2000, min 100.
- Produces, e2e control routes:
    - `POST /lifi/status { txHash, status, substatus?, receiving? }`
    - `POST /lifi/quote { patch }` and `POST /lifi/no-route`
    - Matching helpers `setSwapStatus`, `nextSwapQuote` and `noSwapRoute` in `e2e/backend.ts`
- Rules:
    - **Due orders.** Each tick reads open orders (`sent`) that are due by their age schedule (Global Constraints).
    - **Same-chain EVM swaps** read the last hash's receipt. A revert is `failed`.
    - **Status calls** use the last hash, both chain ids and the tool.
    - **Mismatch.** If `sendingTxHash`, `fromAddress` or `toAddress` doesn't match the order, the status is ignored, with a warning log.
    - **Mapping:**
        - `DONE` + `COMPLETED`, with the receiving token equal to the order's, is `done`, with `received`.
        - `DONE` + `PARTIAL`, or a receiving token that differs, is `partial`, with `received` and `receivedSymbol`.
        - `REFUNDED` under either status is `refunded`.
        - `FAILED` is `failed`.
        - `NOT_FOUND`, `INVALID` and `PENDING` mean no change.
    - **Expiry.** `created` orders older than 15 min are `expired`. `sent` orders older than 24 h are `expired`.
    - **Moves.** Every move is conditional on the state and emits `swap:update`. Settled orders call `holdings.refresh(account, identity, "settled")`. The identity comes from `identity` by the account's `privyUserId`; skip the refresh if it can't be built.

- [ ] **Step 1: Write the failing tests**, with injected `now` and direct `tick()`:
    - `"done with the asked token"`
    - `"partial when another token arrived"` (Review Focus 5)
    - `"refunded"`
    - `"failed"`
    - `"not found keeps it pending"`
    - `"a status for someone else's transaction is ignored"`
    - `"a reverted same-chain swap fails"`: send a tx to a reverting contract on the anvil
    - `"unreported orders expire after 15 minutes"`
    - `"polling slows down with age"`: the fake's request log spacing
    - `"settling refreshes holdings"`
- [ ] **Step 2: Run them and watch them fail.** Then implement, then run them and watch them pass. Then run the suite.
- [ ] **Step 3: Commit.** Message: `Follow each swap to done, partial, refunded or failed`.

### Task 4: Signing swaps in the browser

**Files:**
- Modify: `components/account-client.ts`, `components/account-provider.tsx`, `lib/account/state.ts` (if the optimistic list needs a swap kind), `e2e/privy-mock.ts`
- Create: `lib/account/swaps.ts` (pure helpers), `components/solana-signer.ts`
- Test: `e2e/swaps.logic.spec.ts`, `e2e/account.logic.spec.ts`

**Interfaces:**
- Produces, `AccountClient`:
    - `quoteSwap(req: SwapRequest): Promise<SwapQuoteView | { error: ApiError }>`
    - `placeSwap(req: SwapRequest & { reviewedMin: string }, signer: SwapSigner): Promise<SwapResult>`
    - `SwapResult = { status: "sent"; order: SwapOrderView } | { status: "cancelled" } | { status: "failed"; message: string } | { status: "switch_failed"; network: string }`
    - `SwapSigner = { evm?: { from: string; provider: WalletProvider; ensure(chainId: number): Promise<NetworkCheck> }; solana?: { address: string; signAndSend(tx: Uint8Array): Promise<string> } }`
    - Snapshot: `swaps: SwapOrderView[]`, from `swaps` and `swap:update`.
- **Optimistic:**
    - After the last hash, `#dropHolding(wallet, network, symbol, amount)` lowers the cached `swapHoldings` row.
    - `done` and `partial` raise the received row.
    - `refunded` and `failed` restore the paid row.
    - Restoring only touches rows that came from this order. A fresh `swap:holdings` push replaces all of them.
- **Lost connection** (Review Focus 1): hashes not yet acknowledged are kept in `localStorage["swap-sent:{userId}"]` and reported again on bind. The server accepts them while the order is `created` or `expired` without hashes.
- **Arc:** each EVM tx on chain 5042 gets `maxFeePerGas` and `maxPriorityFeePerGas` from the deposit constants.
- **Solana:**
    - `components/solana-signer.ts` exports `useSolanaSigner(address): SwapSigner["solana"] | undefined`.
    - First, try Privy's `useSignAndSendTransaction` from `@privy-io/react-auth/solana`, with the linked external wallet.
    - If Privy's hook can't drive an external Wallet Standard wallet, use that wallet's `solana:signAndSendTransaction` feature directly.
    - Record which one, with the evidence, as a `Ruling:`.
- **Privy mock:**
    - `installWallet` learns chains 0xa4b1, 0x2105, 0xa, 0x89 and 0xa86a. `wallet_addEthereumChain` already adds them.
    - `installSolanaWallet` gains `solana:signAndSendTransaction`. It records the transaction and returns a fixed base58 signature.

- [ ] **Step 1: Write the failing logic tests** for the pure helpers in `lib/account/swaps.ts`:
    - `"dropping and restoring a holding touches only that row"`
    - `"a done swap raises the received coin"`
    - `"unreported hashes survive a reload and are reported once"`
    - `"two orders from two tabs each drop their own amount"` (Review Focus 2)
- [ ] **Step 2: Run them and watch them fail.** Then implement the client, provider, signer and mock, then run them and watch them pass. Run `npx tsc --noEmit`.
- [ ] **Step 3: Commit.** Message: `Sign swaps from the person's own EVM or Solana wallet`.

### Task 5: The live swap review, errors and activity

**Files:**
- Modify: `components/trade/review-panel.tsx`, `lib/trade/activity.ts`, `components/pnl/*` (only where the activity list is built), `lib/trade/execute.ts` (if the simulated stub needs a guard)
- Create: `lib/trade/swap-quote.ts` (rows from a `SwapQuoteView`), `lib/trade/swap-request.ts` (intent to `SwapRequest`)
- Test: `e2e/swaps.spec.ts` (new), `e2e/swaps.logic.spec.ts`, `e2e/pnl.spec.ts`

**Interfaces:**
- Produces:
    - `toSwapRequest(intent, ctx, signers: { evm?: string; solana?: string }): SwapRequest | { missing: "evm" | "solana" }`. Swap maps directly. Buy goes from USDC on `buyPayNetwork` to the coin. Sell goes from the coin to USDC on its network.
    - `swapQuoteRows(quote: SwapQuoteView, ctx): PreviewRow[]`. The rows are:
        - "You pay": units, dollars and "on {Network}"
        - "You get": "≈ {toAmount}"
        - "At least": `toAmountMin`
        - "Fees": each fee, with LI.FI's labelled "LI.FI 0.25%"
        - "Network gas"
        - "Time": "about 20 s" or "about 18 min"
        - "Route": the tool name
    - `swapActivity(order: SwapOrderView): Activity`. Its title is `Swap {from} to {to}` (also for Buy and Sell). The networks go in the detail, the state shows, and there is no balance change.
- **Review panel:**
    - A swap, buy or sell intent is live once signed in.
    - It quotes on open and every 15 s.
    - It shows only a quote whose request equals the current one (Review Focus 3).
    - "Confirm swap" calls `placeSwap`.
    - Done shows "Swap sent." then follows `swap:update`: `Received {amount} {SYMBOL}.`, or the matching spec message.
    - Errors use the copy in Global Constraints.
    - A missing receiving wallet shows the connect message and a "Connect" button using `useLinkOtherWallet`.
    - The simulated path remains only for demo mode.

- [ ] **Step 1: Write the failing browser tests** in `swaps.spec.ts`, signed in with the e2e wallet, using the fake LI.FI through the control routes:
    - `"a swap shows LI.FI's quote and refreshes it"`
    - `"confirming sends from the wallet, then shows what arrived"`: ETH on Ethereum to USDC on Ethereum, `setSwapStatus` DONE, then `Received {n} USDC.`
    - `"a token swap approves first"`: USDC to ETH. The wallet gets two sends, and the review shows the approve line.
    - `"rejecting in the wallet changes nothing"`: `rejectNextSend`. The button goes back to "Confirm swap", and the holdings are unchanged (Review Focus 4).
    - `"no route says so"`
    - `"the price moved says so and shows the new quote"`
    - `"refunded and partial say what happened"`
    - `"receiving on Solana without a Solana wallet asks to connect one"`
    - `"a stale quote is never shown for a new amount"` (Review Focus 3)
    - `"buy and sell are swaps through USDC"`
    - `"a real swap is listed on PnL without changing the balance"`
- [ ] **Step 2: Run them in the isolated copy and watch them fail.** Then implement, then run all browser specs on desktop and mobile and watch them pass.
- [ ] **Step 3: Commit.** Message: `Review, confirm and follow real swaps in the app`.

### Task 6: Live check and README

**Files:**
- Create: `server/scripts/swaps-live-check.ts`
- Modify: `README.md` (a "Swaps" section next to "Prediction trading"), `server/.env.example`

**Interfaces:**
- **Default (read-only).** For every `COINS` entry, it gets a real quote of about $10 to USDC on the same network (USDT for USDC entries, WETH on Arc), using `LIFI_API_KEY` and `LIFI_INTEGRATOR`. It runs `checkQuote` on each, and prints one line per entry plus a summary. It exits 1 if any entry fails.
- **`--yes-spend-real-money`.** With the key in `SWAP_CHECK_KEY` (0x + 64 hex; documented, never printed), it swaps $2 of USDC to USDT on Base from that wallet. It sends the approval and the swap, polls `/v1/status` to DONE, and prints the hashes.
- **README.** Owner steps:
    - LI.FI key and integrator id
    - accepting the terms
    - RPC URLs
    - the live check
    - sanctions screening is a launch blocker

- [ ] **Step 1: Write the script.** Run the read-only mode: `cd server && node --env-file=.env scripts/swaps-live-check.ts`. Expected: every entry passes, or each failure is explained in the report and ruled on.
- [ ] **Step 2: Write the README section, and add `SWAP_CHECK_KEY` to `.env.example`.** Commit with the message `Add the swaps live check and owner runbook`.
