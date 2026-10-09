# Multichain Deposits, Phase 1: Bridges from Ethereum and BNB Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user picks a coin from a list of their balances on Ethereum, BNB Chain and Arc, signs the bridge's transactions in their wallet, and watches the deposit arrive in their Arc account step by step.

**Architecture:** A new `server/src/crosschain/` module holds four parts:

- the coin catalog
- balance reads
- the bridge providers (Relay, Across) behind one interface
- deposit orders

An order asks every provider for a quote that pays the account's existing Arc deposit address. The app signs the winning quote's transactions on the source chain. An order tracker then follows the provider until its fill arrives. The existing Arc watcher credits the fill like any other deposit, and the tracker links it to the order so history shows where it came from.

**Tech Stack:**

- **Server:** Node ≥ 24.12 running TypeScript directly, Express 5, socket.io 4.8, MongoDB 7, viem 2.56, zod 4, vitest with anvil
- **App:** Next.js 16 and React 19, Privy (`@privy-io/react-auth`) 3.48, motion
- **Browser tests:** Playwright

**Spec:** `docs/superpowers/specs/2026-10-09-multichain-deposits-design.md`. This plan covers step 1 of the spec's "Order of work". Solana, the vault, and the CCTP and LI.FI fallbacks get their own plans, written against the interfaces this one creates.

## Global Constraints

- **Accepted destinations.** A quote is accepted only if its destination token is native USDC on Arc, checked by address: `0x3600000000000000000000000000000000000000` or `0x0000000000000000000000000000000000000000`. Never by symbol.
- **Choosing a quote.** Quotes from every provider that supports the coin run in parallel with a 3-second timeout. The highest USDC output wins, and ties go to the shorter ETA.
- **No fees of ours (0%).** Never send app-fee, referral-fee or affiliate parameters to a provider.
- **One crediting path.** The existing Arc watcher stays the only code that credits a balance. Orders never call `Ledger`.
- **Arc USDC on the wire.** Amounts are `UsdcAmount` strings with 18 decimals. Convert 6-decimal provider amounts up with `toArcWei`. Never credit or compare from the 6-decimal view.
- **Coin catalog.** No USDT on Arc.

    | Coin           | Address                                      | Decimals |
    | -------------- | -------------------------------------------- | -------- |
    | Ethereum ETH   | native                                       | 18       |
    | Ethereum USDC  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6        |
    | Ethereum USDT  | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6        |
    | BNB Chain BNB  | native                                       | 18       |
    | BNB Chain USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18       |
    | BNB Chain USDT | `0x55d398326f99059fF775485246999027B3197955` | 18       |
    | Arc USDC       | native                                       | 18       |

- **Whose balances.** Balances are read only for the signed-in account's own wallet.
- **Bridged deposits pay the account's Arc deposit address.** Refunds go to the account's wallet on the source chain.
- **UI copy:**
    - steps: "Sending", "In a block", "Bridging to Arc", "Added"
    - outcomes: "Didn't go through", "Refunded to your wallet"
    - a bridged history row reads "+$1,604.20 · 0.5 ETH on Ethereum"
- **Commits** carry no `Co-Authored-By` trailer.
- **Test ports.** Playwright runs need free ports: prefix `E2E_PORT=3110 E2E_API_PORT=4110 E2E_CONTROL_PORT=4111`. Port 3100 is taken on this machine.
- **Plain calls instead of Multicall3.** The spec mentions a multicall for balances. Use plain parallel `eth_call`s instead, so fresh anvil chains (which have no Multicall3) work. The result is the same.

## Review Focus

1. **The second wallet prompt is turned down after the approval went through.** The deposit returns `"cancelled"`, the form stays, no progress shows, and the unreported order expires after 10 minutes. Tested in Task 7 and Task 10.
2. **An amount has more decimals than the coin.** For example, "1.1234567" USDT on Ethereum is refused with `bad_request` naming `amount`. BNB Chain's 18-decimal stablecoins parse with 18 decimals. Tested in Task 1 and Task 6.
3. **The watcher credits the fill before the provider reports it filled.** The deposit is still linked to the order exactly once, and the balance is credited once. Tested in Task 7.
4. **A provider's status call fails or hangs.** The tracker leaves the order where it was and tries again on the next pass. Tested in Task 7.
5. **The page reloads mid-deposit.** The session hands back open orders, and the progress picks up where it was. Tested in Task 6 and Task 10.
6. **A source transaction is dropped and never lands.** Its order ends as "Didn't go through" after the expiry, instead of hanging on "Sending". Tested in Task 7.

---

### Task 1: Coin catalog and amounts

**Files:**

- Create: `server/src/crosschain/catalog.ts`
- Test: `server/test/unit/crosschain-catalog.test.ts`

**Interfaces:**

- Produces:

```ts
export type ChainKey = "ethereum" | "bnb" | "arc";
export type Coin = {
    key: string; // "ethereum:ETH", "bnb:USDT", "arc:USDC"
    chain: ChainKey;
    chainId: number; // 1, 56, 5042
    chainName: string; // "Ethereum", "BNB Chain", "Arc"
    symbol: string;
    token: Address | null; // null for the native coin
    decimals: number;
    gasReserve: bigint; // units left for gas; 0n for tokens
};
export const COINS: readonly Coin[];
export const ARC_USDC: Coin;
export const ARC_USDC_TOKENS: readonly Address[];
export function coinByKey(key: string): Coin; // AppError("bad_request", "Invalid coin: …")
export function parseCoinAmount(coin: Coin, amount: string): bigint; // AppError("bad_request", "Invalid amount: …")
export function formatCoinAmount(coin: Coin, units: bigint): string;
export function toArcWei(amount: bigint, decimals: number): bigint;
```

Gas reserves are 0.002 ETH, 0.002 BNB and 0.01 USDC on Arc. The Arc figure matches the app's existing `GAS_RESERVE`. `COINS` is in the order shown in the test below.

- [ ] **Step 1: Write the failing test**

```ts
test("the catalog holds the spec's coins, and no USDT on Arc", () => {
    expect(COINS.map((c) => c.key)).toEqual([
        "ethereum:ETH",
        "ethereum:USDC",
        "ethereum:USDT",
        "bnb:BNB",
        "bnb:USDC",
        "bnb:USDT",
        "arc:USDC",
    ]);
    expect(coinByKey("bnb:USDT")).toMatchObject({
        chainId: 56,
        token: "0x55d398326f99059fF775485246999027B3197955",
        decimals: 18,
    });
    expect(() => coinByKey("arc:USDT")).toThrow(/coin/);
});

test("amounts parse with the coin's own decimals", () => {
    expect(parseCoinAmount(coinByKey("bnb:USDT"), "1.5")).toBe(1_500_000_000_000_000_000n);
    expect(parseCoinAmount(coinByKey("ethereum:USDC"), "1.5")).toBe(1_500_000n);
    expect(() => parseCoinAmount(coinByKey("ethereum:USDT"), "1.1234567")).toThrow(/amount/);
    expect(() => parseCoinAmount(coinByKey("ethereum:ETH"), "0")).toThrow(/amount/);
    expect(formatCoinAmount(coinByKey("ethereum:ETH"), 500_000_000_000_000_000n)).toBe("0.5");
});

test("6-decimal USDC becomes 18-decimal Arc wei", () => {
    expect(toArcWei(1_500_000n, 6)).toBe(1_500_000_000_000_000_000n);
    expect(toArcWei(7n, 18)).toBe(7n);
});
```

- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/crosschain-catalog.test.ts`. Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Implement `catalog.ts`.** Use viem's `parseUnits` and `formatUnits`. Reject zero, negative and over-precise amounts with `AppError("bad_request", …)` from `server/src/errors.ts`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/src/crosschain/catalog.ts server/test/unit/crosschain-catalog.test.ts
git commit -m "Add the coin catalog for deposits from other chains"
```

### Task 2: Config, source-chain clients, and test chains for Ethereum and BNB Chain

**Files:**

- Modify: `server/src/config.ts`, `server/.env.example`, `server/test/unit/config.test.ts`
- Create: `server/src/crosschain/chains.ts`
- Modify: `server/test/support/anvil.ts`, `server/test/support/global-setup.ts`
- Create: `server/test/support/source-chains.ts`

**Interfaces:**

- Produces, in config:
    - `ETHEREUM_RPC_URLS: string[]`, default `["https://ethereum-rpc.publicnode.com"]`
    - `BNB_RPC_URLS: string[]`, default `["https://bsc-dataseed.bnbchain.org"]`
    - `RELAY_API_KEY?: string`
    - `ACROSS_INTEGRATOR_ID?: string`
    - `ORDER_POLL_MS: number`, default 1500, minimum 100
- Produces, in `chains.ts`:

```ts
export type SourceChainKey = "ethereum" | "bnb";
export type SourceClients = Record<SourceChainKey, PublicClient>;
export function createSourceClients(urls: Record<SourceChainKey, readonly string[]>): SourceClients;
// viem `fallback` of `http(url, { timeout: 10_000 })`, chains `mainnet` and `bsc` from viem/chains
```

- Produces, test support:
    - `startAnvil(port?: number, options?: { chainId?: number })`, with chain ID 5042 by default.
    - Global setup provides `ethereumUrl` (chain 1) and `bnbUrl` (chain 56) beside `anvilUrl`.
    - `source-chains.ts`:

```ts
export function sourceChain(
    url: string,
    chainId: 1 | 56,
): {
    client: TestClient & PublicActions & WalletActions;
    fund(address: Address, native: string): Promise<void>; // setBalance + impersonate
    installToken(token: Address): Promise<void>; // anvil_setCode 0x6004355460005260206000f3
    setTokenBalance(token: Address, owner: Address, units: bigint): Promise<void>; // slot = uint256(owner)
    sendTxs(from: Address, txs: { to: Address; data: Hex; value: bigint }[]): Promise<Hex[]>; // gas 200_000 each, waits for receipts
};
```

The token code returns `sload(calldataload(4))`. That answers `balanceOf` from the owner's slot and accepts any other call, which is enough for balances and approvals.

- [ ] **Step 1: Write the failing test** in `config.test.ts`. It checks the default URLs for both chains, that comma lists override them, that `RELAY_API_KEY` and `ACROSS_INTEGRATOR_ID` stay undefined when unset, and that `ORDER_POLL_MS=50` is rejected.
- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the config fields, `chains.ts`, the anvil `chainId` option, the global-setup provides and `source-chains.ts`. Document the five new variables in `server/.env.example`.
- [ ] **Step 4: Run** `cd server && npx vitest run test/unit/config.test.ts && npx tsc --noEmit`. Expected: PASS, with no type errors.
- [ ] **Step 5: Commit** with the message "Configure Ethereum and BNB Chain, and give the tests chains for both".

### Task 3: Balances and prices

**Files:**

- Create: `server/src/crosschain/prices.ts`, `server/src/crosschain/balances.ts`
- Modify: `server/src/protocol.ts` (adds `CoinBalance`)
- Test: `server/test/unit/crosschain-prices.test.ts`, `server/test/integration/crosschain-balances.test.ts`

**Interfaces:**

- Consumes: `COINS`, `Coin` (Task 1); `SourceClients`, `sourceChain` (Task 2).
- Produces:

```ts
// protocol.ts
export type CoinBalance = {
    coin: string;
    symbol: string;
    chainName: string;
    chainId: number;
    decimals: number;
    amount: string; // in the coin's units, decimal
    spendable: string; // amount − gasReserve, floored at 0
    usd: number | null; // null when the price is unknown
};
// prices.ts
export interface PriceFeed {
    usd(coins: readonly Coin[]): Promise<Map<string, number>>;
} // keyed by coin.key
export function lifiPrices(options?: { fetch?: typeof fetch; ttlMs?: number }): PriceFeed;
export function fixedPrices(table: Record<string, number>): PriceFeed; // keyed by symbol
// balances.ts
export async function readBalances(
    deps: { sources: SourceClients; arc: PublicClient; prices: PriceFeed },
    owner: Address,
): Promise<CoinBalance[]>;
```

`lifiPrices` makes one request per coin: `GET https://li.quest/v1/token?chain={chainId}&token={token ?? zeroAddress}`. It reads `priceUSD` and caches each coin for `ttlMs`, 60 000 by default. A failed lookup leaves that coin out of the map. Rows are sorted by `usd`, highest first. Unknown USD values go last, in catalog order.

- [ ] **Step 1: Write the failing tests**
    - In `crosschain-prices.test.ts`, with a fetch stub:
        - two reads within the TTL make one request per coin
        - a 500 response leaves the coin out
        - the URL carries `chain=56` and the BNB USDT address
    - In `crosschain-balances.test.ts`, on the chain-1 and chain-56 anvils plus the Arc anvil:
        - the wallet holds 0.5 ETH, 250 USDT on BNB Chain (`250n * 10n**18n`) and 12.5 USDC on Arc, with `fixedPrices({ ETH: 3000, BNB: 600, USDC: 1, USDT: 1 })`
        - expect the first three rows to be `ethereum:ETH` (usd 1500, spendable "0.498"), `bnb:USDT` (usd 250, amount "250") and `arc:USDC` (usd 12.5)
        - every other row has amount "0"
- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/crosschain-prices.test.ts test/integration/crosschain-balances.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `prices.ts` and `balances.ts`.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** with the message "Read a wallet's coins on Ethereum, BNB Chain and Arc, with their dollar value".

### Task 4: The bridge provider contract, quote selection, and a fake bridge

**Files:**

- Create: `server/src/crosschain/providers/types.ts`, `server/src/crosschain/quotes.ts`, `server/test/support/fake-bridge.ts`
- Test: `server/test/unit/crosschain-quotes.test.ts`

**Interfaces:**

- Consumes: `Coin`, `ARC_USDC_TOKENS` (Task 1).
- Produces:

```ts
export type QuoteRequest = { coin: Coin; amount: bigint; sender: Address; recipient: Address; refundTo: Address };
export type SourceTx = { chainId: number; to: Address; data: Hex; value: bigint };
export type Quote = {
    provider: string;
    ref: string;
    coin: string;
    amountIn: bigint;
    usdcOut: bigint; // Arc wei (18 decimals)
    etaSeconds: number;
    destinationToken: Address;
    recipient: Address;
    refundTo: Address;
    txs: SourceTx[]; // in signing order: approval first
};
export type BridgeStage = "waiting" | "pending" | "filled" | "refunded" | "failed";
export type BridgeStatus = { stage: BridgeStage; fillTxHash?: Hex };
export interface BridgeProvider {
    readonly name: string;
    supports(coin: Coin): boolean;
    quote(request: QuoteRequest, signal: AbortSignal): Promise<Quote>;
    /** `sourceTxHash` is null before the app reports it; providers that can't look up without it return "waiting". */
    status(quote: { ref: string }, sourceTxHash: Hex | null, coin: Coin): Promise<BridgeStatus>;
}
export function checkQuote(quote: Quote, request: QuoteRequest): boolean;
export async function bestQuote(
    providers: readonly BridgeProvider[],
    request: QuoteRequest,
    options?: { timeoutMs?: number },
): Promise<Quote>;
// throws AppError("unavailable", "No route for this deposit right now.")
```

`checkQuote` returns false when any of these holds:

- the destination is not in `ARC_USDC_TOKENS`
- `recipient` or `refundTo` differs from the request
- any tx is on a chain other than `coin.chainId`
- `usdcOut <= 0n`

`FakeBridge` is test support, used by the integration tests and the e2e backend:

```ts
export const FAKE_BRIDGE_ADDRESS = "0x000000000000000000000000000000000000bEEF";
export class FakeBridge implements BridgeProvider {
    constructor(options: { arcRpcUrl: string; rates: Record<string, number> }); // USD per coin symbol
    quote(...): Promise<Quote>;  // usdcOut = amount × rate, eta 2 s; tokens: approve tx to the token + deposit tx to FAKE_BRIDGE_ADDRESS (data = ref); native: one deposit tx with value
    status(...): Promise<BridgeStatus>;  // works with a null hash
    advance(ref: string, stage: "pending" | "filled" | "refunded" | "failed"): Promise<void>; // "filled" sends usdcOut on Arc to the recipient from a funded solver
    failNextStatus(ref: string): void;   // the next status() for ref throws
    readonly refs: string[];             // every quote it issued, newest last
}
```

- [ ] **Step 1: Write the failing tests** with stub providers:
    - `"the best USDC output wins, and a tie goes to the faster route"`
    - `"a provider slower than the timeout is left out"` (with `timeoutMs: 50`)
    - `"a quote paying a lookalike USDC is dropped even when it pays the most"` (destination `0x1111111111111111111111111111111111111111`)
    - `"a quote paying someone else, or refunding someone else, is dropped"`
    - `"a transaction on another chain is dropped"`
    - `"no usable quote is an unavailable error"`, which expects `{ code: "unavailable" }`
- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/crosschain-quotes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `types.ts`, `quotes.ts` and `fake-bridge.ts`.** Abort each provider with its own `AbortController` at the timeout, and use `Promise.allSettled`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** with the message "Pick the best bridge quote, and only one that pays native USDC to the account".

### Task 5: Relay and Across clients

**Files:**

- Create: `server/src/crosschain/providers/relay.ts`, `server/src/crosschain/providers/across.ts`, `server/scripts/record-bridge-fixtures.ts`
- Create: `server/test/fixtures/relay/{quote-eth.json,quote-bnb-usdt.json,status-filled.json}` and the same three names under `server/test/fixtures/across/`
- Test: `server/test/unit/crosschain-relay.test.ts`, `server/test/unit/crosschain-across.test.ts`

**Interfaces:**

- Consumes: `BridgeProvider`, `Quote`, `QuoteRequest` (Task 4); `toArcWei` (Task 1).
- Produces:
    - `createRelay(options: { apiKey?: string; fetch?: typeof fetch; baseUrl?: string }): BridgeProvider`, named `"relay"`, supporting all six non-Arc coins.
    - `createAcross(options: { integratorId?: string; fetch?: typeof fetch; baseUrl?: string }): BridgeProvider`, named `"across"`, supporting the same six coins.

**Relay:**

- Quote: `POST {baseUrl ?? "https://api.relay.link"}/quote/v2`, with header `x-api-key` when set. Body:

    ```
    { user: sender, recipient, refundTo, originChainId, destinationChainId: 5042,
      originCurrency: token ?? zeroAddress,
      destinationCurrency: "0x3600000000000000000000000000000000000000",
      amount: String(amount), tradeType: "EXACT_INPUT" }
    ```

- `txs`: every step item of kind `"transaction"`, in order.
- `usdcOut`: `details.currencyOut.amount`, converted with `toArcWei` at `currencyOut.currency.decimals`.
- `ref`: the step's `requestId`.
- Status: `GET /intents/status/v3?requestId=`. Map `waiting` to `waiting`, `pending` to `pending`, `success` to `filled` (the fill hash is the destination `txHashes` entry), `refund` to `refunded`, and `failure` to `failed`.

**Across:**

- Quote: `GET {baseUrl ?? "https://app.across.to"}/api/swap/approval` with `tradeType=exactInput`, `amount`, `inputToken`, `outputToken=0x3600…`, `originChainId`, `destinationChainId=5042`, `depositor=sender`, `recipient`, `refundAddress=refundTo`, and `integratorId` when set.
- `txs`: `approvalTxns`, then `swapTx`.
- `usdcOut`: `expectedOutputAmount`, at the output token's decimals.
- `ref`: the response `id`.
- Status: `GET /api/deposit/status?originChainId=&depositTxHash=`. With a null hash, return `waiting`. Map `pending` to `pending`, `filled` to `filled` (`fillTx`), `refunded` to `refunded`, and `expired` to `failed`.

Neither client sends any fee parameter. If a recorded response names a field differently from the above, follow the fixture and say so in the commit message.

- [ ] **Step 1: Write the recording script.** `record-bridge-fixtures.ts` reads `RELAY_API_KEY` and `ACROSS_INTEGRATOR_ID`. For each provider it quotes 0.01 ETH from Ethereum and 10 USDT from BNB Chain to Arc, using fixed throwaway sender and recipient addresses, and fetches one status response for a filled request. It writes the six fixture files. Run it once with the product owner's keys: `cd server && node --env-file-if-exists=.env scripts/record-bridge-fixtures.ts`.
- [ ] **Step 2: Write the failing tests** with a fetch stub serving the fixtures:
    - `"the request pays the account on Arc, refunds the wallet, and carries no fee"`: assert the recipient, refund, chain 5042, destination `0x3600…`, and that no key matches `/fee|referr|affiliate/i`.
    - `"the quote is in Arc wei, with transactions in signing order"`: the `usdcOut` magnitude is about 10 × 10¹⁸ for 10 USDT, and every tx `chainId` is 56 for the BNB fixture.
    - `"each status maps to a stage"`.
- [ ] **Step 3: Run** `cd server && npx vitest run test/unit/crosschain-relay.test.ts test/unit/crosschain-across.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `relay.ts` and `across.ts`**, then run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Quote and track deposits through Relay and Across".

### Task 6: Deposit orders over the socket

**Files:**

- Create: `server/src/crosschain/orders.ts`, `server/src/crosschain/views.ts`
- Modify: `server/src/protocol.ts`, `server/src/db/mongo.ts`, `server/src/validation.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/sessions.ts`, `server/src/socket/sockets.ts`, `server/README.md`, `server/test/support/stack.ts`
- Test: `server/test/integration/deposit-orders.test.ts`, `server/test/unit/validation.test.ts`

**Interfaces:**

- Consumes: Tasks 1–5.
- Produces, in protocol:

```ts
export type OrderState = "created" | "sent" | "in_block" | "bridging" | "delivered" | "refunded" | "failed" | "expired";
export type DepositQuoteView = { coin: string; amount: string; usdcOut: UsdcAmount; etaSeconds: number; provider: string };
export type SourceTxView = { chainId: number; to: Hex; data: Hex; value: Hex };
export type DepositOrderView = {
    id: string; coin: string; amount: string; usdcOut: UsdcAmount; etaSeconds: number; state: OrderState;
    sourceTxHashes: Hex[]; depositId: string | null; createdAt: string; updatedAt: string;
};
export type DepositOrigin = { coin: string; amount: string; txHash: Hex };
// DepositView gains `origin?: DepositOrigin`; WalletSession gains `orders: DepositOrderView[]` (open ones, newest first)
// ClientToServerEvents gains:
"deposit:balances": (payload: Record<string, never>, ack: (r: Ack<CoinBalance[]>) => void) => void;
"deposit:quote": (payload: { coin: string; amount: string }, ack: (r: Ack<DepositQuoteView>) => void) => void;
"deposit:order": (payload: { coin: string; amount: string }, ack: (r: Ack<{ order: DepositOrderView; txs: SourceTxView[] }>) => void) => void;
"deposit:source": (payload: { orderId: string; txHashes: string[] }, ack: (r: Ack<DepositOrderView>) => void) => void;
// ServerToClientEvents gains:
"deposit:progress": (payload: { order: DepositOrderView }) => void;
```

- Produces, in Mongo:
    - `DepositOrderDoc`: `{ _id, accountId, coin, amount, provider, ref, usdcOut: Decimal128, etaSeconds, recipient, refundTo, state: OrderState, sourceTxHashes: string[], fillTxHash: string | null, depositId: ObjectId | null, createdAt, updatedAt }`.
    - Collection `depositOrders`, named `"deposit_orders"`, with indexes `{ accountId: 1, _id: -1 }` and `{ state: 1, updatedAt: 1 }`.
    - `DepositDoc` gains `origin?: { coin: string; amount: string; txHash: string; orderId: ObjectId }`.
- Produces, the service:

```ts
export class DepositOrders {
    constructor(deps: {
        collections: Collections;
        providers: readonly BridgeProvider[];
        sources: SourceClients;
        arc: PublicClient;
        prices: PriceFeed;
        bus: Bus;
    });
    balances(account: AccountDoc): Promise<CoinBalance[]>;
    preview(account: AccountDoc, coin: string, amount: string): Promise<DepositQuoteView>;
    create(account: AccountDoc, coin: string, amount: string): Promise<{ order: DepositOrderDoc; txs: SourceTx[] }>;
    reportSource(account: AccountDoc, orderId: string, txHashes: Hex[]): Promise<DepositOrderDoc>;
    open(accountId: ObjectId): Promise<DepositOrderDoc[]>; // created, sent, in_block, bridging
}
```

**Rules:**

- `"arc:USDC"` is refused by `preview` and `create` with `bad_request`: "USDC on Arc goes straight to your deposit address."
- The recipient is `account.depositAddress` and the refund address is `account.wallet`.
- `create` always fetches a fresh quote.
- `reportSource` only moves `created` to `sent`, stores the hashes, and emits `order:updated`.
    - Reporting the same hashes again returns the order unchanged.
    - Another account's order returns `not_found`.

**Wiring:**

- `Overrides` in `server.ts` gains `bridges?`, `sources?` and `prices?`. The defaults are:
    - `createRelay({ apiKey: config.RELAY_API_KEY })` and `createAcross({ integratorId: config.ACROSS_INTEGRATOR_ID })`
    - `createSourceClients` built from the config
    - `lifiPrices()`
- Validation:
    - `coinAmount = z.object({ coin: z.string().min(3).max(32), amount: z.string().regex(/^\d+(\.\d+)?$/, "an amount such as 0.5") })`
    - `sourceReport = z.object({ orderId: /^[0-9a-f]{24}$/i, txHashes: z.array(<the existing tx hash schema>).min(1).max(4) })`
- Sockets: `deposit:quote` gets its own limiter of 30 per minute per user. `Sessions.describe` adds `orders`.
- `startStack` gains `sources?: { ethereumUrl: string; bnbUrl: string }`. When given, it builds `sourceChain` clients, a `FakeBridge` (rates ETH 3000, BNB 600, USDC 1, USDT 1) and `fixedPrices` with the same table, and passes them as overrides. It exposes `stack.bridge` and `stack.sources`.

- [ ] **Step 1: Write the failing tests**
    - `validation.test.ts`: `coinAmount` and `sourceReport` reject a bad amount, a bad order id and five hashes.
    - Integration, with the `FakeBridge`:
        - `"balances need a bound wallet"`: `wallet_not_connected` before `wallet:connect`, rows after.
        - `"a preview quotes without creating an order"`: 0.1 ETH gives `usdcOut "300"`, and the collection stays empty.
        - `"an order hands back the transactions, paying the account's Arc address"`: the txs are on chain 1, and the stored order has `recipient === depositAddress` and `refundTo === wallet`.
        - `"reporting the source sends the order once"`: repeated hashes return the same order; another user gets `not_found`.
        - `"an amount with more decimals than the coin is refused"`: USDT `"1.1234567"` gives `bad_request` matching `/amount/`.
        - `"USDC on Arc isn't bridged"`: `bad_request`.
        - `"the session hands back open orders"`: after reconnecting, `session.orders[0].id` is the order.
- [ ] **Step 2: Run** `cd server && npx vitest run test/unit/validation.test.ts test/integration/deposit-orders.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, views, protocol, collection, validation, wiring, socket handlers and stack overrides. Add the four events and the five env vars to `server/README.md`.
- [ ] **Step 4: Run** `cd server && npm test`. Expected: the whole server suite passes, with the old tests unchanged.
- [ ] **Step 5: Commit** with the message "Open deposit orders for coins on other chains, over the socket".

### Task 7: Order tracker and progress pushes

**Files:**

- Create: `server/src/crosschain/tracker.ts`
- Modify: `server/src/events.ts`, `server/src/server.ts`, `server/src/socket/sockets.ts`, `server/src/deposits/views.ts`
- Test: `server/test/integration/deposit-tracker.test.ts`

**Interfaces:**

- Consumes: `DepositOrders`, `DepositOrderDoc` (Task 6); `BridgeProvider` (Task 4); `FakeBridge`, `sourceChain` (Tasks 2 and 4).
- Produces:
    - In `events.ts`: `"order:updated": [{ order: DepositOrderDoc }]`.
    - The tracker:

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

    - `depositView` includes `origin` when it is set.
    - Sockets push `deposit:progress` with `orderView` to the account's room, using the same owner check as `deposit:credited`.

**What one pass does**, in order:

| Order state              | What the pass does                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`                | Asks `provider.status({ ref }, null, coin)` and treats any stage other than `waiting` like `bridging`. Past `expiryMs` with no source hash, it moves to `expired`.                           |
| `sent`                   | Reads the receipt of the last source hash on its chain. Success moves it to `in_block`; a revert moves it to `failed`. No receipt within `expiryMs` of the report also moves it to `failed`. |
| `in_block` or `bridging` | Asks `provider.status({ ref }, lastHash, coin)`, then acts on the stage below.                                                                                                               |

| Provider stage | What happens to the order                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`      | Moves to `bridging`.                                                                                                                                   |
| `filled`       | Stores `fillTxHash`. Once a `deposits` document with that `txHash` exists, sets that deposit's `origin`, stores `depositId`, and moves to `delivered`. |
| `refunded`     | Moves to `refunded`.                                                                                                                                   |
| `failed`       | Moves to `failed`.                                                                                                                                     |

**How changes are applied:**

- Every change is a conditional `updateOne` on `{ _id, state: <current> }`, and only a successful update emits `order:updated`.
- A thrown provider or RPC error is logged and leaves the order as it was.
- `startServer` starts the tracker with `config.ORDER_POLL_MS` and stops it in `close()`.

- [ ] **Step 1: Write the failing tests.** The tracker runs with `pollMs: 100`; the stack's watcher credits the fills.
    - `"a bridged deposit goes through every step and is credited once"`:
        - Create a 0.1 ETH order, `sendTxs` on the chain-1 anvil, then report.
        - Expect pushes in the order `in_block`, `bridging`, `delivered` after `advance(ref, "pending")` and then `"filled"`.
        - The balance is 300.
        - The history deposit has `origin: { coin: "ethereum:ETH", amount: "0.1" }`.
        - The ledger has one entry.
    - `"a fill credited before the provider says filled is linked once"`:
        - Send the fill on Arc first: `advance` to `"filled"` while the order is still `sent`.
        - The order ends `delivered`, and the balance moves once.
    - `"a refund ends refunded, and nothing is credited"`.
    - `"a reverted source transaction fails the order"`: set the code at `FAKE_BRIDGE_ADDRESS` to `0xfe` before sending.
    - `"an order nobody reported still completes when the provider knows it"`: never report, then advance to `"filled"`.
    - `"an unreported order expires"`: use `expiryMs: 200`.
    - `"a source transaction that never lands fails the order"`: report a random hash, use `expiryMs: 200`, and expect `failed`.
    - `"a failing status call leaves the order as it was"`: `failNextStatus(ref)`; the state is unchanged after one pass and moves after the next.
- [ ] **Step 2: Run** `cd server && npx vitest run test/integration/deposit-tracker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `tracker.ts`**, the event, the push, `origin` in views, and the start and stop wiring.
- [ ] **Step 4: Run** `cd server && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Follow each deposit order across the bridge and push its progress".

### Task 8: Client state and socket client

**Files:**

- Modify: `lib/account/state.ts`, `components/account-client.ts`, `components/account-provider.tsx`, `components/wallet-provider.tsx`
- Test: `e2e/account.logic.spec.ts`

**Interfaces:**

- Consumes: the protocol additions from Task 6.
- Produces:
    - **State.** The ready state gains `orders: DepositOrderView[]`, newest first.
        - The new action `{ type: "order"; order: DepositOrderView }` upserts by id and removes `expired` orders.
        - `session` takes `session.orders`.
        - `HistoryRow` gains `origin?: DepositOrigin`, copied from the deposit.
    - **Client methods:**

        ```ts
        export type SourceWallet = { provider: WalletProvider; from: string; switchChain(chainId: number): Promise<void> };
        balances(): Promise<CoinBalance[] | null>;
        quote(coin: string, amount: string): Promise<DepositQuoteView | ApiError>;
        bridgeDeposit(coin: string, amount: string, wallet: SourceWallet): Promise<DepositResult>;
        ```

    - **`bridgeDeposit`** does the following:
        1. Emits `deposit:order`.
        2. For each tx: calls `switchChain(tx.chainId)` when needed, then `eth_sendTransaction({ from, to, data, value })`.
        3. Before sending the next tx, polls `eth_getTransactionReceipt` through the wallet every second. A failed receipt, or 120 s with none, returns `"failed"`.
        4. Emits `deposit:source` and dispatches the order.
        - A 4001 code at any point returns `"cancelled"`.
        - It does not switch the wallet back to Arc, because that would cost another prompt.
    - **Progress pushes.** `deposit:progress` dispatches `order`.
    - **Provider.** `Account` gains `orders`, `balances()`, `quote()` and `depositCoin(coin, amount)`. `depositCoin` builds a `SourceWallet` from the Privy wallet, using `wallet.switchChain`.
    - **Privy config.** `supportedChains: [arc, mainnet, bsc]`, with `mainnet` and `bsc` from `viem/chains`. `defaultChain` stays `arc`.

- [ ] **Step 1: Write the failing logic tests**
    - `"an order upserts by id, newest first"`
    - `"an expired order leaves the list"`
    - `"the session restores open orders"`
    - `"a bridged deposit's history row keeps its origin"`
- [ ] **Step 2: Run** `LOGIC_ONLY=1 npx playwright test --project=logic e2e/account.logic.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the state, the client, the provider and the Privy chains.
- [ ] **Step 4: Run the same command, then `npx tsc --noEmit`.** Expected: PASS, with no type errors.
- [ ] **Step 5: Commit** with the message "Let the app open bridged deposits and follow their progress".

### Task 9: E2E backend: source chains and the fake bridge

**Files:**

- Modify: `server/test/e2e/serve.ts`, `e2e/privy-mock.ts`, `e2e/backend.ts`
- Create: `e2e/crosschain-deposit.spec.ts`

**Interfaces:**

- Consumes: `startAnvil({ chainId })`, `sourceChain`, `FakeBridge`, `fixedPrices`, and the `startServer` overrides.
- Produces, control routes:
    - `/users` also funds 1 ETH on chain 1 and 1 BNB on chain 56, and impersonates the wallet there.
    - `/source/fund { address, coin, amount }`: native coins via `fund`, tokens via `installToken` plus `setTokenBalance`.
    - `/bridge/advance { address, stage }`: advances the newest order of that wallet's account.
    - `/rpc` takes an optional `chainId` (1, 56, or Arc by default).
- Produces, in `e2e/backend.ts`:

    ```ts
    fundSource(address: string, coin: string, amount: string): Promise<void>;
    advanceBridge(address: string, stage: "pending" | "filled" | "refunded" | "failed"): Promise<void>;
    chainRpc(method: string, params?: unknown[], chainId?: number)
    ```

- Produces, the mock wallet: `eth_sendTransaction` and `eth_getTransactionReceipt` go to the chain the wallet is on (`0x1`, `0x38` or `0x13b2`). Any other chain still fails as today.

- [ ] **Step 1: Write the failing test** in the new spec: `"the test backend funds wallets on Ethereum and BNB Chain"`. Call `fundSource(address, "bnb:USDT", "250")`. Then `chainRpc("eth_call", [{ to: BNB_USDT, data: balanceOf(address) }, "latest"], 56)` returns 250 × 10¹⁸.
- [ ] **Step 2: Run** `E2E_PORT=3110 E2E_API_PORT=4110 E2E_CONTROL_PORT=4111 npx playwright test e2e/crosschain-deposit.spec.ts --project=desktop`. Expected: FAIL.
- [ ] **Step 3: Implement** the backend routes, the helpers and the mock wallet's chain routing.
- [ ] **Step 4: Run the same command.** Expected: PASS. Also run `e2e/deposit.spec.ts` and `e2e/wallet-sidebar.spec.ts`; both still pass.
- [ ] **Step 5: Commit** with the message "Give the browser tests Ethereum, BNB Chain and a bridge they can step".

### Task 10: The deposit UI, end to end

**Files:**

- Create: `components/deposit-coins.tsx`, `components/deposit-progress.tsx`
- Modify: `components/deposit-form.tsx`, `components/wallet-sidebar.tsx`, `components/wallet-sidebar.module.css`, `components/coin-icons.tsx`
- Test: `e2e/crosschain-deposit.spec.ts`

**Interfaces:**

- Consumes: `Account.balances`, `quote`, `depositCoin` and `orders` (Task 8); the backend helpers (Task 9).
- Produces:
    - **`DepositCoins({ balances, onPick, onClose })`:**
        - `balances` is `CoinBalance[] | null | undefined`, `onPick` receives a `CoinBalance`, and `onClose` takes nothing.
        - It renders a list with `aria-label="Coins to deposit"`.
        - Each row is a button named `"{symbol} on {chainName}, {amount} {symbol}, {usd}"`, for example "ETH on Ethereum, 0.5 ETH, $1,500.00". Without a price the `, {usd}` part is left out.
        - Empty rows are dimmed and `aria-disabled`.
        - While loading it says "Checking your wallets…". On failure it says "Couldn't read your balances.".
    - **`DepositForm` gains `coin: CoinBalance` and an optional `preview`:**
        - `preview` is `(amount: string) => Promise<DepositQuoteView | ApiError>`.
        - The red and shake check runs against `coin.spendable`, and typed decimals are capped at `coin.decimals`.
        - With `preview`, the hint reads "≈ $300.00 in about 2 s", debounced by 400 ms.
        - Arc USDC keeps today's path and text.
    - **`DepositProgress({ order })`:**
        - It shows four steps, "Sending", "In a block", "Bridging to Arc" and "Added", each done, active or waiting. The active bridging step adds "about {eta}".
        - The outcomes "Didn't go through" and "Refunded to your wallet" replace the steps. It has `role="status"`.
    - **Icons.** `coin-icons.tsx` adds BNB and USDT marks and a `ChainBadge({ chain })` on the coin icon.
    - **Sidebar flow:**
        - Deposit opens the coin list. Picking a coin opens the form.
        - Once the deposit is sent, the newest open order's progress takes the status line's place. A finished order stays for 5 s.
        - A history row with an `origin` reads "+$300.00 · 0.1 ETH on Ethereum".

- [ ] **Step 1: Write the failing e2e tests** in `e2e/crosschain-deposit.spec.ts`:
    - `"the coin list shows the wallet's coins on every chain, largest first"`:
        - Fund 0.5 ETH and 250 USDT on BNB Chain.
        - The first two rows are "ETH on Ethereum, 0.5 ETH, $1,500.00" and "USDT on BNB Chain, 250 USDT, $250.00".
        - "BNB on BNB Chain" is `aria-disabled`.
    - `"a bridged deposit shows each step and lands in the balance"`:
        - Pick ETH and type 0.1. The hint reads "≈ $300.00 in about 2 s".
        - Press Deposit. The wallet is asked to switch to `0x1`, and "In a block" becomes done.
        - `advanceBridge(…, "pending")` makes "Bridging to Arc" active. `"filled"` shows "Added".
        - The balance reads $300.00, and the history row reads "+$300.00 · 0.1 ETH on Ethereum".
    - `"a USDT deposit from BNB Chain approves, then sends"`: two `eth_sendTransaction` calls on `0x38`, and the first one's `to` is the BNB USDT address.
    - `"a refunded bridge says so and adds nothing"`.
    - `"turning down the second wallet prompt cancels quietly"`:
        - Wait for the first send, then `rejectNextSend`.
        - The form stays, there is no `role=status` progress, and the balance is unchanged.
    - `"a reload mid-deposit picks the progress back up"`: send and reload, and "In a block" is still shown done.
    - `"more than the coin's balance turns the amount red and shakes it"`, reusing the `shakes` helper pattern from `e2e/deposit.spec.ts`.
- [ ] **Step 2: Run** `E2E_PORT=3110 E2E_API_PORT=4110 E2E_CONTROL_PORT=4111 npx playwright test e2e/crosschain-deposit.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the components and the sidebar flow.
- [ ] **Step 4: Run the same command, then the whole browser suite** (`npx playwright test` with the same prefix). Expected: everything passes. Look at the screenshots on desktop and on a phone.
- [ ] **Step 5: Commit** with the message "Pick a coin on any chain and watch the deposit arrive".

### Task 11: A live check with real keys

**Files:** none. This is an acceptance step before phase 2.

- [ ] **Step 1:** Put the product owner's keys in `server/.env`:
    - `RELAY_API_KEY`
    - `ACROSS_INTEGRATOR_ID`
    - `ETHEREUM_RPC_URLS` and `BNB_RPC_URLS`, pointing at Alchemy
- [ ] **Step 2:** Run `cd server && npm run dev` and `npm run dev` at the root. Connect a real wallet.
- [ ] **Step 3:** Deposit 5 USDT from BNB Chain. Expected:
    - the steps run from Sending to Added within about a minute
    - the balance rises by the quoted amount, within the quote's slippage
    - history reads "+$4.9x · 5 USDT on BNB Chain"
- [ ] **Step 4:** Deposit 0.002 ETH from Ethereum. Expected: the same, with the provider named in the server log.
- [ ] **Step 5:** Note any provider field differences in the plan's Task 5 section, and commit any fixture updates with the message "Record what the live bridges answered".
