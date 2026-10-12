# Multichain Swaps Phase A Implementation Plan: networks, balances, prices

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every coin pill in Swap, Buy and Sell gets a network, picked in a second step of the same picker and shown as a badge. Amounts are capped by the wallet's real balance on that network, and coin prices are live from LI.FI. Execution stays simulated.

**Architecture:**

- **Server.**
    - An import-free coin table (`server/src/swaps/coins.ts`) pins every (coin, network) by address. The client imports the same file.
    - A `SwapCatalog` reads LI.FI's token list every 5 minutes and serves `GET /swaps/catalog` with live prices.
    - A `SwapHoldings` reader reads the account's linked wallets on nine networks (Multicall3 on EVM, the existing Solana RPC client on Solana). It pushes `swap:holdings` over the socket.
- **Engine.** Domain-free additions:
    - `ChoiceSpec.then`: a companion slot that is not in the template
    - `IconRef.badge` and `Choice.subdetail`
    - a two-step picker
- **Trade domain.** Swap, Buy and Sell gain network companion slots, default-network rules, per-network caps and network-carrying intents.

**Tech Stack:** Node 24 + Express 5 + socket.io + zod + viem (server), vitest, Next.js 16 + React 19 + motion, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-multichain-swaps-design.md`, sections 1–5, the phase A parts of Testing, and "Order of work" step 1. Phase B (real swaps) gets its own plan.

## Global Constraints

- **Commits:**
    - Commit by path (`git commit -m "…" -- <paths>`), with no `Co-Authored-By` trailer.
    - Never `git add -A`, `git add .`, stash, reset, or checkout files you didn't write.
    - Leave `.impeccable/hook.cache.json` alone.
- **Don't edit** `server/src/crosschain/*` or `server/src/balances/*` (another session owns them). Importing from them is fine.
- **Never read or print any `.env` file.** Scripts that need `LIFI_API_KEY` run as `node --env-file=.env …` from `server/`.
- **Tests:**
    - Server: `cd server && npm test` (one shared Mongo and anvil; polls have a 10 s default).
    - Logic: `LOGIC_ONLY=1 npx playwright test --project logic`.
    - Browser: only from an isolated copy (`git archive HEAD | tar -x -C <dir>`, `cp -cR node_modules`, `cp -cR server/node_modules`, overlay uncommitted files) with `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641`, projects `desktop` and `mobile`.
- **Next.js 16 differs from your training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code.
- **Official logos only.** Never draw a coin or network mark. Network badges use `NetworkLogo` (`components/network-icons.tsx`) and coins use `CoinIcon`.
- **Comments:** one line each, describing the code as it is; no change narration.
- **The sentence must not change.**
    - Text: `view.text` stays "I want to Swap my ETH to SOL for 10 USD."
    - Pills: names stay bare symbols.
    - Part keys stay `swap:fromToken`, `term:token`, `term:amountUSD`.
    - Companion slots are never in a template.
- **Picker invariant.** One `data-highlight` per list, `-z-10` inside the `relative isolate` listbox. Every new control (Back, step titles) goes outside the listbox.
- **Copy, verbatim:**
    - Network step title: "On which network?"
    - Back control: visible "Back"
    - Companion hints: `fromNetwork` "Network you pay from", `toNetwork` "Network you receive on", Buy/Sell `network` "Network of the coin"
    - Companion missing: message "Pick a network.", button "Pick a network"
    - Disabled rows: "Nothing here" (paying side, wallet holds none there, once balances are known), "Same as the other side" (Swap, the row that makes both pairs identical)
    - Caps: `That's more than your {usd} of {SYMBOL} on {Network}.`, and `You don't hold any {SYMBOL} on {Network}.` when it's 0. Button `Not enough {SYMBOL}`.
    - Pill description: `{hint}, on {Network}` (e.g. "Coin you pay with, on Base")
    - Announcer: `{hint} is now {SYMBOL} on {Network}.`
- **Numbers:**
    - The catalog refreshes every 300 000 ms (`SWAPS_CATALOG_SYNC_MS`, min 10 000). The client refreshes `/swaps/catalog` every 5 min while visible.
    - `/swaps/catalog` is rate limited to 120 per minute per IP.
    - Holdings re-read at most every 15 000 ms per account, unless a swap settled.
    - The badge is about 44% of the coin's size, at its bottom-right, ringed in the surface colour.
    - The fake LI.FI's prices equal the client's built-in prices, so e2e numbers don't move: ETH 3210.4, SOL 147.2, BTC 97300, USDC 1, USDT 1, BNB 600, LINK 18.45, DOGE 0.182, AVAX 32.1, ARB 0.74, OP 1.8.

## Review Focus

1. **Holdings never arrive** (the server's read fails, or the push is lost). The sentence must behave as "not loaded": no caps, no "Nothing here", prices in the coin rows. Never all-zero caps. (Task 7 test.)
2. **The active EVM wallet changes** in the sidebar. Caps and defaults must follow the new signing wallet's rows, not stay on the old one. (Task 7 logic test on `walletHoldings`.)
3. **A carried network that doesn't fit.** For example, Swap receives ETH on Arbitrum, then the verb becomes Sell while the wallet has no ETH on Arbitrum. The network must fall back to the default, never stay on a disabled row. (Task 5 test.)
4. **A catalog from a newer or broken server.** An unknown network id, an unknown coin, or a missing price must be ignored or fall back to the built-in coin. It must never crash or show NaN or $0 prices. (Task 7 test.)
5. **Reopening the picker during its exit animation, or after Back.** The picker must start at step 1 again, with the current coin selected. (Task 6 test.)

---

### Task 1: Coin table, LI.FI client, fake LI.FI and fixtures

**Files:**
- Create: `server/src/swaps/coins.ts`, `server/src/swaps/lifi.ts`, `server/scripts/record-lifi-fixtures.ts`, `server/test/support/fake-lifi.ts`
- Create (recorded by the script): `server/test/fixtures/lifi/tokens.json`, `server/test/fixtures/lifi/quotable.json`
- Test: `server/test/unit/swap-coins.test.ts`, `server/test/unit/lifi.test.ts`

**Interfaces:**
- Produces, `coins.ts` (no imports at all, because the client imports it at runtime):
    - `type NetworkId = "ethereum" | "arbitrum" | "base" | "optimism" | "polygon" | "bnb" | "avalanche" | "arc" | "solana"`
    - `type SwapNetwork = { id: NetworkId; name: string; chainId: number; kind: "evm" | "solana" }`. `chainId` is LI.FI's id, and Solana's is `1151111081099710`.
    - `type CoinEntry = { network: NetworkId; address: string; decimals: number; label?: string; wrapped?: true; reserve?: number }`. `reserve` is in coin units, and only native gas coins have one.
    - `type SwapCoin = { symbol: string; name: string; home: NetworkId; entries: readonly CoinEntry[] }`
    - `NETWORKS: readonly SwapNetwork[]`, in the order ethereum, arbitrum, base, optimism, polygon, bnb, avalanche, arc, solana
    - `COINS: readonly SwapCoin[]`
    - `NATIVE_EVM = "0x0000000000000000000000000000000000000000"`, `NATIVE_SOLANA = "11111111111111111111111111111111"`
- Produces, `lifi.ts`:
    - `type LifiToken = { chainId: number; address: string; symbol: string; decimals: number; priceUSD: number | null }`
    - `type Lifi = { tokens(chainIds: readonly number[]): Promise<LifiToken[]> }`
    - `createLifi(options: { url: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }): Lifi`. It calls `GET {url}/v1/tokens?chains={ids}&chainTypes=EVM,SVM`, sends `x-lifi-api-key` only when a key is set, and times out after 15 s by default. It drops a malformed token instead of failing the list, and a missing or unparsable `priceUSD` becomes `null`.
- Produces, `fake-lifi.ts`: `startFakeLifi(options?: { prices?: Record<string, number> }): Promise<FakeLifi>`.
    - `FakeLifi = { url: string; requests: string[]; keys: (string | null)[]; failNext(path: "/v1/tokens"): void; setPrice(symbol: string, price: number): void; stop(): Promise<void> }`
    - It serves `/v1/tokens` from the fixture, filtered by `chains`.
    - `prices` and `setPrice` override `priceUSD` on every `COINS` entry of that symbol, matched by address, never on decoys.

- [ ] **Step 1: Write `coins.ts` with this table.**

    Addresses are from LI.FI's list of 2026-10-12. EVM natives use `NATIVE_EVM`; SOL on Solana uses `NATIVE_SOLANA`.

    | Coin (name, home) | Entries: network address decimals [label] [wrapped] [reserve] |
    | --- | --- |
    | ETH ("Ethereum", ethereum) | ethereum native 18 reserve 0.002 · arbitrum native 18 reserve 0.0002 · base native 18 reserve 0.0002 · optimism native 18 reserve 0.0002 · polygon `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` 18 "WETH" wrapped · bnb `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` 18 "Binance-Peg ETH" wrapped · avalanche `0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB` 18 "WETH.e" wrapped · arc `0x128cC466B61f542da60c70e3aA11c10e19B84EDB` 18 "WETH" wrapped · solana `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` 8 "Wormhole ETH" wrapped |
    | SOL ("Solana", solana) | solana native 9 reserve 0.01 · ethereum `0xD31a59c85aE9D8edEFeC411D448f90841571b89c` 9 "Wormhole SOL" wrapped · bnb `0x570A5D26f7765Ecb712C0924E4De545B89fD43dF` 18 "Binance-Peg SOL" wrapped · arbitrum `0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07` 9 "Wrapped SOL" wrapped · base `0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82` 9 "Bridged SOL" wrapped · polygon `0xd93f7E271cB87c23AaA73edC008A79646d1F9912` 9 "Wormhole SOL" wrapped |
    | BTC ("Bitcoin", ethereum) | ethereum `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` 8 "WBTC" · arbitrum `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` 8 "WBTC" · optimism `0x68f180fcCe6836688e9084f035309E29Bf0A2095` 8 "WBTC" · polygon `0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6` 8 "WBTC" · base `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` 8 "cbBTC" · bnb `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c` 18 "BTCB" · avalanche `0x152b9d0FdC40C096757F570A51E494bd4b943E50` 8 "BTC.b" · arc `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0` 8 "cirBTC" |
    | USDC ("USD Coin", arc) | arc `0x3600000000000000000000000000000000000000` 6 reserve 0.01 · ethereum `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` 6 · arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` 6 · base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` 6 · optimism `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` 6 · polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` 6 · bnb `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` 18 · avalanche `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` 6 · solana `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` 6 |
    | USDT ("Tether", ethereum) | ethereum `0xdAC17F958D2ee523a2206206994597C13D831ec7` 6 · arbitrum `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` 6 · base `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` 6 · optimism `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` 6 · polygon `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` 6 · bnb `0x55d398326f99059fF775485246999027B3197955` 18 · avalanche `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` 6 · solana `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` 6 |
    | BNB ("BNB", bnb) | bnb native 18 reserve 0.002 |
    | LINK ("Chainlink", ethereum) | ethereum `0x514910771AF9Ca656af840dff83E8264EcF986CA` · arbitrum `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4` · base `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` · optimism `0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6` · polygon `0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39` · bnb `0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD` · avalanche `0x5947BB275c521040051D82396192181b413227A3` (all 18) |
    | DOGE ("Dogecoin", bnb) | bnb `0xbA2aE424d960c26247Dd6c32edC70B295c744C43` 8 "Binance-Peg DOGE" |
    | AVAX ("Avalanche", avalanche) | avalanche native 18 reserve 0.02 |
    | ARB ("Arbitrum", arbitrum) | arbitrum `0x912CE59144191C1204E64559FE8253a0e49E6548` 18 · ethereum `0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1` 18 |
    | OP ("Optimism", optimism) | optimism `0x4200000000000000000000000000000000000042` 18 |

    `COINS` keeps this row order (it is the picker's order). Network names: Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche, Arc, Solana.

- [ ] **Step 2: Write `server/scripts/record-lifi-fixtures.ts`.** It only reads. From `/v1/tokens` for the nine chain ids, it writes `test/fixtures/lifi/tokens.json` as `{ recordedAt, tokens: { [chainId]: RawToken[] } }`. That holds every `COINS` entry, plus up to 3 decoys per (symbol, chain): tokens with the same symbol as an entry but a different address.

    With `--check-quotes` it also does the following, sequentially, with 700 ms between calls:
    1. It asks `GET /v1/quote` for about $10 of each entry, to USDC on the same network. For USDC entries the target is USDT on the same network, or WETH on Arc.
    2. It sets `fromAddress` and `toAddress` to `0x0000000000000000000000000000000000000001` on EVM and `11111111111111111111111111111112` on Solana, and sends `integrator=least-finance` and `x-lifi-api-key` from `process.env.LIFI_API_KEY`.
    3. It writes `quotable.json` as `{ recordedAt, quotable: string[] }`, with `"{network}:{symbol}"` for each 200 answer that has a `transactionRequest`.

    Run: `cd server && node --env-file=.env scripts/record-lifi-fixtures.ts --check-quotes`. Expected: both files are written.

    If an entry isn't quotable, delete it from `COINS` and add a ledger `Ruling:`. The spec says an entry stays only if LI.FI quotes it.

- [ ] **Step 3: Write the failing tests.**
    - `swap-coins.test.ts`:
        - `"every coin lists its home network"`
        - `"an address appears once per network"`
        - `"decimals match LI.FI's list"`: for every entry, find the fixture token by (chainId, address, lowercase for EVM) and `expect(token.decimals).toBe(entry.decimals)`.
        - `"every entry is quotable"`: `expect(quotable).toContain(\`${network}:${symbol}\`)`.
        - `"NetworkId matches the protocol's"`: `expectTypeOf<NetworkId>().toEqualTypeOf<SwapNetworkId>()`. Add `SwapNetworkId` to `server/src/protocol.ts` in this task, with the same nine-member union.
    - `lifi.test.ts` (against `startFakeLifi`):
        - `"reads tokens with prices"`
        - `"drops a malformed token, keeps the rest"`
        - `"sends the key only when set"`: `fake.keys` is `["k"]`, then `[…, null]`.
        - `"a 500 throws"`

- [ ] **Step 4: Run them and watch them fail.** Run: `cd server && npx vitest run test/unit/swap-coins.test.ts test/unit/lifi.test.ts`. Expected: FAIL on missing modules.
- [ ] **Step 5: Implement `lifi.ts` and `fake-lifi.ts`.** The fake follows `fake-polymarket.ts`: one `http.createServer` with `send(status, body)` and a `failing` set.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit.** Paths: the four source files, two fixtures, two tests, `server/src/protocol.ts`. Message: `Pin the swap coins by address and read LI.FI's token list`.

### Task 2: Swap catalog with live prices, `GET /swaps/catalog`, config and wiring

**Files:**
- Create: `server/src/swaps/catalog.ts`
- Modify: `server/src/protocol.ts`, `server/src/config.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/http/app.ts`, `server/.env.example`, `server/test/support/stack.ts`, `server/test/e2e/serve.ts`
- Test: `server/test/integration/swap-catalog.test.ts`, `server/test/unit/config.test.ts`

**Interfaces:**
- Consumes: `COINS`, `NETWORKS`, `createLifi`, `startFakeLifi` (Task 1).
- Produces, protocol:
    - `SwapCoinView = { symbol: string; name: string; priceUSD: number | null; home: SwapNetworkId; networks: { network: SwapNetworkId; label?: string; wrapped?: boolean }[] }`
    - `SwapCatalogView = { coins: SwapCoinView[]; readAt: string | null }`
- Produces, `catalog.ts`: `class SwapCatalog`
    - `constructor(deps: { lifi: Lifi; logger: Logger; syncMs: number; now?: () => number })`
    - `start(): void`, `stop(): Promise<void>`, `tick(): Promise<void>`
    - `view(): SwapCatalogView`, `priceOf(symbol: string): number | null`
- Produces, config:
    - `LIFI_URL`: `z.url()`, default `https://li.quest`
    - `LIFI_API_KEY`: `optionalKey`
    - `LIFI_INTEGRATOR`: `/^[A-Za-z0-9._-]{1,23}$/`, default `least-finance`
    - `LIFI_FEE`: number, at least 0 and under 0.1, default 0
    - `SWAPS_CATALOG_SYNC_MS`: int, min 10 000, default 300 000
- Produces, wiring: `Services.swapCatalog`, and `Stack.lifi: FakeLifi`.

- [ ] **Step 1: Write the failing tests.**
    - `swap-catalog.test.ts`:
        - `"serves every coin with the fake's prices"`: `GET {stack.url}/swaps/catalog` lists 11 coins, ETH has `priceUSD` 3210.4, and SOL's networks include `{ network: "ethereum", label: "Wormhole SOL", wrapped: true }`.
        - `"a look-alike's price never prices a coin"`: set a decoy's price to 999 in the fixture copy the fake serves, then tick. ETH stays 3210.4.
        - `"a failed refresh keeps the last list"`: `failNext("/v1/tokens")` and tick. The view is equal to before, and `readAt` is unchanged.
        - `"the API key goes to LI.FI"`: start the stack with `env: { LIFI_API_KEY: "test-key" }`. `fake.keys` contains `"test-key"`.
    - `config.test.ts`:
        - `LIFI_INTEGRATOR` "least finance" is invalid.
        - `LIFI_FEE` "0.2" is invalid.
        - Defaults: `LIFI_URL` is `https://li.quest`, and `SWAPS_CATALOG_SYNC_MS` is 300000.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd server && npx vitest run test/integration/swap-catalog.test.ts test/unit/config.test.ts`.
- [ ] **Step 3: Implement.**
    - **`SwapCatalog`:**
        - It matches LI.FI tokens to entries by (chainId, address), lowercase on EVM and exact on Solana.
        - A coin's price is its home entry's price, else the first entry with a price, else `null`.
        - `tick` catches and logs at warn.
        - The loop copies `MarketService`'s start/stop shape.
    - **Route:** in `app.ts`, before the `/v1` router: `app.get("/swaps/catalog", noStore, limit(120, 60_000), (_req, res) => { res.json(services.swapCatalog.view()); })`.
    - **Wiring:**
        - Construct it after `MarketService`. Start it with the other loops, and stop it before `markets.stop()`.
        - `stack.ts` and `serve.ts` start `startFakeLifi({ prices: <the Global Constraints prices> })`, set `LIFI_URL`, await `services.swapCatalog.tick()` after start, and stop the fake in teardown.
        - Document the new variables in `.env.example` under the existing `# --- Swaps (LI.FI) ---` block.
- [ ] **Step 4: Run the tests, then the whole server suite.** Expected: PASS, and `npm test` stays green.
- [ ] **Step 5: Commit.** Message: `Serve swap coins with live LI.FI prices`.

### Task 3: Wallet holdings on nine networks, pushed over the socket

**Files:**
- Create: `server/src/swaps/clients.ts`, `server/src/swaps/holdings.ts`, `server/test/fixtures/multicall3.ts`
- Modify: `server/src/protocol.ts`, `server/src/events.ts`, `server/src/config.ts`, `server/src/services.ts`, `server/src/server.ts`, `server/src/socket/sockets.ts`, `server/.env.example`, `server/test/support/stack.ts`, `server/test/e2e/serve.ts`
- Test: `server/test/integration/swap-holdings.test.ts`, `server/test/unit/swap-readers.test.ts`

**Interfaces:**
- Consumes: `COINS`, `NETWORKS`, `CoinEntry` (Task 1); `SwapCatalog.priceOf` (Task 2); `SolanaRpc` and `createSolanaRpc` from `server/src/crosschain/solana.ts` (import only); `arcChain` from `server/src/chain/arc.ts`; `IdentityProvider.linkedWallets`.
- Produces, protocol:
    - `SwapHoldingRow = { wallet: string; network: SwapNetworkId; symbol: string; amount: string; usd: number | null }`. `amount` is a decimal string in coin units, and only non-zero rows are sent.
    - `SwapHoldingsView = { readAt: string; rows: SwapHoldingRow[] }`
    - Client to server: `"swap:holdings:refresh": (payload: Record<string, never>, ack: (r: Ack<{ read: boolean }>) => void) => void`
    - Server to client: `"swap:holdings": (view: SwapHoldingsView) => void`
- Produces, events: `"swap:holdings": [{ accountId: ObjectId; privyUserId: string; view: SwapHoldingsView }]`.
- Produces, `clients.ts`:
    - `type EvmNetworkId = Exclude<NetworkId, "solana">`
    - `createSwapClients(urls: Record<EvmNetworkId, readonly string[]>): Record<EvmNetworkId, PublicClient>`, built from viem's `mainnet`, `arbitrum`, `base`, `optimism`, `polygon`, `bsc` and `avalanche`, plus `arcChain(urls.arc)`. Each uses `fallback(http(url, { timeout: 10_000, retryCount: 0 }))`.
- Produces, `holdings.ts`:
    - `type EvmReader = (network: EvmNetworkId, owner: Address, entries: readonly CoinEntry[]) => Promise<(bigint | null)[]>`
    - `multicallReader(clients): EvmReader`. It makes one `client.multicall({ multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11", allowFailure: true, contracts })`, with `getEthBalance(owner)` for native entries and `balanceOf(owner)` for tokens. A failed call gives `null`, and a failed request throws.
    - `type SolanaReader = (owner: string, entries: readonly CoinEntry[]) => Promise<(bigint | null)[]>`
    - `solanaReader(rpc: SolanaRpc): SolanaReader`
    - `class SwapHoldings`:
        - `constructor(deps: { identity: IdentityProvider; bus: Bus; logger: Logger; catalog: SwapCatalog; readEvm: EvmReader; readSolana: SolanaReader; now?: () => number })`
        - `refresh(account: AccountDoc, identity: Identity, reason: "bind" | "click" | "settled", push?: (view: SwapHoldingsView) => void): Promise<{ read: boolean }>`
        - `last(accountId: ObjectId): SwapHoldingsView | null`
- Produces, config: `ARBITRUM_RPC_URLS` (default `https://arb1.arbitrum.io/rpc`), `BASE_RPC_URLS` (`https://mainnet.base.org`), `OPTIMISM_RPC_URLS` (`https://mainnet.optimism.io`), `POLYGON_RPC_URLS` (`https://polygon.drpc.org`), `AVALANCHE_RPC_URLS` (`https://api.avax.network/ext/bc/C/rpc`). Ethereum, BNB, Arc and Solana reuse their existing lists.

- [ ] **Step 1: Write the Multicall3 fixture.** Write `server/test/fixtures/multicall3.ts` exporting `MULTICALL3_CODE`, the runtime bytecode read once with `eth_getCode(0xcA11bde05977b3631167028862bE2a173976CA11, "latest")` from `https://ethereum-rpc.publicnode.com`. It is 7618 hex characters with the `0x`.
- [ ] **Step 2: Write the failing tests.**
    - `swap-readers.test.ts`, on the shared Ethereum anvil after `setCode(MULTICALL3, MULTICALL3_CODE)`, with the `installToken` stand-in at USDC's address:
        - `"one multicall reads the native coin and tokens, and a missing token is null"`: the result is `[1500000000000000000n, 25000000n, null]` for ETH, USDC, and LINK (which has no code there).
    - `swap-holdings.test.ts`, with stack env `ETHEREUM_RPC_URLS`/`BNB_RPC_URLS` set to the anvils, `ARC_RPC_URLS` set to the emulator, the other five set to `http://127.0.0.1:9`, and Multicall3 set on those three anvils:
        - `"sign-in pushes the wallet's holdings with dollar values"`: fund 1.5 ETH and a 25 USDC stand-in on Ethereum. After `account:open`, `swap:holdings` holds the rows `{ network: "ethereum", symbol: "ETH", amount: "1.5", usd: 4815.6 }` and `{ network: "ethereum", symbol: "USDC", amount: "25", usd: 25 }`.
        - `"a refresh inside 15 s doesn't read again"`: the ack is `{ read: false }`.
        - `"a network that can't be read doesn't hide the others"`: Ethereum rows are present while Arbitrum's RPC refuses.
        - `"a linked Solana wallet's SOL is read"`: fake Solana RPC SOL balance 2e9 gives a row `{ network: "solana", symbol: "SOL", amount: "2" }`.
        - `"holdings go only to the account's owner"`: copy the owner check from the balances push test.
- [ ] **Step 3: Run them and watch them fail.**
- [ ] **Step 4: Implement.**
    - **Throttle:**
        - `refresh` re-reads when the last read is 15 s old or older, or `reason` is `"settled"`. Otherwise it pushes `last()` on `"bind"` and returns `{ read: false }`.
        - Concurrent calls per account share one run, as `WalletBalances` does.
    - **Failures:** a failed (wallet, network) read keeps that pair's last rows.
    - **USD values:** `usd` is the amount times `catalog.priceOf(symbol)`, rounded to cents, or `null` without a price.
    - **Emit:** `"swap:holdings"` on the bus.
    - **Sockets:**
        - At `account:open`, a fire-and-forget `services.swapHoldings.refresh(account, identity, "bind", (view) => socket.emit("swap:holdings", view)).catch(warn)`, next to the balances one.
        - A `swap:holdings:refresh` handler shaped like `balances:refresh`.
        - A bus-to-room push with the owner check, like `balances:updated`.
    - **Wiring:**
        - `server.ts` builds the readers from `createSwapClients` (config lists) and the existing `solana` client.
        - `stack.ts` and `serve.ts` set the env lists above and `setCode` Multicall3 on their Ethereum, BNB and Arc anvils.
- [ ] **Step 5: Run the tests, then the whole server suite.** Expected: PASS and green.
- [ ] **Step 6: Commit.** Message: `Read the wallet's coins on nine networks and push them to the account`.

### Task 4: Engine: companion slots, badges, second detail line

**Files:**
- Modify: `lib/sentence/types.ts`, `lib/sentence/resolve.ts`, `lib/sentence/schema.ts`, `lib/sentence/index.ts`
- Test: `e2e/sentence-then.logic.spec.ts` (new, with a two-operation test registry of its own)

**Interfaces:**
- Produces:
    - `IconRef.badge?: IconRef`
    - `Choice.subdetail?: string`
    - `ChoiceSpec.then?: string`
    - `CompanionView = { id: string; prompt?: string; hint: string; value: string; selected?: Choice; choicesFor(hostValue: string): readonly Choice[] }`
    - `ChoiceSlotView.then?: CompanionView`
- Rules:
    - `resolve` builds `then` for a host slot in the template. `choicesFor(v)` is `companionSpec.choices({ ...values, [hostId]: v }, ctx)`.
    - A missing or disabled companion value adds an `incomplete` issue on the host slot, with the companion's `missing` copy. It only does so when the host itself has a usable value.
    - When the host and companion are both selected and both have icons, the host's `selected.icon` becomes `{ ...icon, badge: companionSelected.icon }`. The `choices` list is untouched.
    - `registry()` throws when `then` names a missing slot, a number slot, a slot with its own `then`, or a slot already followed by another host.

- [ ] **Step 1: Write the failing tests.**
    - `"a companion's view comes with its host"`
    - `"choicesFor answers for any host value"`
    - `"a missing companion is the host's issue"`
    - `"the companion's icon badges the selected host, not the list"`
    - `"companions add no parts and no text"`: parts and `view.text` are equal to a twin registry without `then`.
    - `"a carried companion term the new host value rejects is left to normalize"`
    - `"registry rejects a bad then"`: one `expect(() => registry(...)).toThrow(/then/)` per bad case.
- [ ] **Step 2: Run them and watch them fail.** Run: `LOGIC_ONLY=1 npx playwright test --project logic e2e/sentence-then.logic.spec.ts`.
- [ ] **Step 3: Implement** in the four engine files. The engine stays domain-free.
- [ ] **Step 4: Run the whole logic project.** Expected: all PASS.
- [ ] **Step 5: Commit.** Message: `Let a choice slot carry a companion slot, a badge and a second detail line`.

### Task 5: Networks in the trade domain

**Files:**
- Create: `lib/trade/networks.ts`
- Modify: `lib/trade/catalog.ts`, `lib/trade/context.ts`, `lib/trade/intent.ts`, `lib/trade/operations/shared.ts`, `lib/trade/operations/swap.ts`, `lib/trade/operations/spot.ts`
- Test: `e2e/trade.logic.spec.ts` (update and extend)

**Interfaces:**
- Consumes: `COINS`, `NETWORKS`, `NetworkId` via `@/server/src/swaps/coins` (Task 1); `then`, `badge`, `subdetail` (Task 4).
- Produces, networks: `lib/trade/networks.ts` exports `networkName(id: NetworkId): string`, `logoNetwork(id: NetworkId): number | "solana"` (the `Network` that `NetworkLogo` takes), and re-exports `NetworkId`.
- Produces, catalog:
    - `Token = { symbol: string; name: string; priceUSD: number; home: NetworkId; networks: readonly TokenNetwork[] }`
    - `TokenNetwork = { network: NetworkId; label?: string; wrapped?: true; reserve?: number }`
    - `TOKENS` is built from `COINS` with the built-in prices in Global Constraints. USDT, BNB and OP are new, at 1, 600 and 1.8.
    - `MOCK_HOLDINGS` is unchanged.
- Produces, context:
    - `TradeTerms` gains `tokenNetwork: string`
    - `TradeCtx.wallet?: WalletHoldings | null`, where `WalletHoldings = Readonly<Record<string, Readonly<Partial<Record<NetworkId, number>>>>>` (units)
    - `heldOn(ctx, symbol, network): number | null`
    - `heldTotal(ctx, symbol): number | null`
- Fallback: with `wallet` absent (demo and the existing logic tests), `heldOn` is `ctx.holdings[symbol]` on the coin's home network and 0 elsewhere, or null when `holdings` is null. `wallet === null` means not loaded: every `heldOn` is null.
- Produces, `shared.ts`:
    - `networkChoices(ctx, symbol, side: "pay" | "receive", other?: { token: string; network: string }): Choice[]`. Each row has:
        - value: the network id
        - label: the network name
        - description: the entry label
        - detail: units on that network, and subdetail: dollars, when known
        - icon: `{ set: "coin", id: symbol, badge: { set: "network", id } }`
        - disabled reasons, per Global Constraints copy
    - `defaultPayNetwork(ctx, symbol): NetworkId`: the network with the most units held, else home
    - `defaultReceiveNetwork(ctx, symbol, pay?: { token: string; network: NetworkId }): NetworkId`:
        1. If the coin is the pay coin, the home network unless it's the pay network, else the first other entry in table order.
        2. Otherwise, the pay network if the entry there is not `wrapped`.
        3. Else home.
    - `holdingCapOn(ctx, symbol, network): Bound | undefined`. The cap is units times price. With real wallet holdings (`ctx.wallet` set), the entry's `reserve` comes off the units first, floored at 0. Demo holdings are capped whole, so the existing $4,013.00 test holds.
    - `buyPayNetwork(ctx, network, amountUSD): NetworkId | null`: the coin's network if the wallet's USDC there covers the amount, else the network with the most USDC. Null when holdings are unknown.
    - `usdcCap(ctx): Bound | undefined`: the largest USDC balance on one network, worded with that network.
    - `coinChoice` is updated: detail is total units with dollars as subdetail when known, else the price, as today.
- Produces, intents: swap `{ type, fromToken, fromNetwork, toToken, toNetwork, amountUSD }`; spot `{ type, side, token, network, amountUSD }`.
- Slot order matters, because carry-over walks slots in order:
    - Swap: `fromToken` (then `fromNetwork`), `fromNetwork`, `toToken` (term `token`, then `toNetwork`), `toNetwork` (term `tokenNetwork`), `amountUSD`
    - Spot: `token` (term `token`, then `network`), `network` (term `tokenNetwork`), `amountUSD`
- Companion prompt: "On which network?". Hints and missing copy are in Global Constraints.

- [ ] **Step 1: Update the failing assertions.** Line 51's intent becomes `{ type: "swap", fromToken: "ETH", fromNetwork: "ethereum", toToken: "SOL", toNetwork: "solana", amountUSD: "10" }`. Write the new tests:
    - `"defaults: ETH pays from Ethereum and SOL arrives on Solana, not as Wormhole SOL"`
    - `"the same coin on another network is a bridge, not a flip"`: `toToken` ETH gives `toNetwork` "arbitrum", and `fromToken` stays ETH.
    - `"a coin pick that makes both sides identical flips them"`: picking `fromToken` SOL while receiving SOL on Solana makes the receive side ETH on Ethereum.
    - `"the row that would make both sides identical is disabled"`: its reason is "Same as the other side".
    - `"the cap is the wallet's dollars on that network, minus gas for native coins"`: wallet `{ ETH: { base: 0.5 } }` gives the message `That's more than your $1,604.56 of ETH on Base.` ((0.5 − 0.0002 reserve) × 3210.4).
    - `"nothing loaded means no cap and no disabled networks"`: `wallet: null`.
    - `"Buy pays from the coin's network when its USDC covers it, else where USDC is largest"`
    - `"coin and network carry from Swap to Buy together"`
    - `"a carried network the wallet holds nothing on falls back to the default"` (Review Focus 3): Swap receives ETH on Arbitrum, then Sell with `wallet { ETH: { ethereum: 1 } }` gives `network` "ethereum".
    - `"demo holdings sit on each coin's home network"`: the existing $4,013.00 cap still holds.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
    - **`normalize`** repairs networks first: after a token change, the side's default; after a carried value the coin isn't on, the default. Then it flips only when a coin pick made both pairs identical. The other side takes this side's previous token, and its previous network, read from `next` before the repair.
    - **Previews** keep today's rows and values and add one row:
        - Swap: `{ id: "route", label: "Route", value: "Ethereum → Solana" }`
        - Buy: `{ id: "from", label: "Paid from", value: "USDC on Base" }`, or "USDC" when unknown
        - Sell: `{ id: "to", label: "Received on", value: "USDC on {network}" }`
- [ ] **Step 4: Run the logic project and `npx tsc --noEmit`.** Expected: PASS, with no type errors (the registry's intent check included).
- [ ] **Step 5: Commit.** Message: `Give Swap, Buy and Sell a network for every coin`.

### Task 6: Two-step picker, badge and pill

**Files:**
- Modify: `components/sentence/picker.tsx`, `components/sentence/dialog.tsx`, `components/sentence/slots.tsx`, `components/sentence/pill.tsx` (only the ring variable), `components/trade/trade-composer.tsx`, `components/trade/trade-icons.tsx`
- Test: `e2e/swap-networks.spec.ts` (new), `e2e/highlights.spec.ts`, `e2e/sentence.spec.ts`

**Interfaces:**
- Consumes: `CompanionView`, `badge`, `subdetail` (Task 4); `logoNetwork` (Task 5).
- Produces, `Picker` prop `then?: { title?: string; label: string; choicesFor(host: string): readonly Choice[]; selected?: string; onPick(host: string): void; onSelect(value: string): void }`:
    - Picking a step-1 row whose `choicesFor(value)` has more than one choice calls `onPick(value)` and shows step 2. Otherwise it calls `onSelect` as today.
    - Step 2 lists `choicesFor(host)`, with `then.selected` selected. Its rows commit through `then.onSelect`.
- Produces, `ChoiceSlot` props `onThen?: (value: string) => void` and `onOpen?: () => void` (the latter is called when the picker opens).
- Produces, the `"network"` icon set in `renderTradeIcon`: `NetworkLogo`, with a `coin` icon carrying a `badge`.

- [ ] **Step 1: Write the failing browser tests** in `swap-networks.spec.ts`, signed out:
    - `"picking a coin moves to its networks in the same picker"`: on the "SOL" pill, pick "BTC". The title becomes "On which network?" and rows include "Base" with "cbBTC". Pick "Base". The picker closes, the pill's name is "BTC", and its description contains "on Base". A `networks/base.svg` image sits inside the pill.
    - `"closing at the network step keeps the default"`: pick "ETH" on the receive pill. "Arbitrum" is the selected row. Press Escape. The description contains "on Arbitrum", and the sentence reads "I want to Swap my ETH to ETH for 10 USD."
    - `"Back returns to the coins"`
    - `"a coin on one network closes after the first step"`: BNB gives "on BNB Chain".
    - `"both steps work from the keyboard"`: Enter on a coin focuses the selected network row; ArrowDown and Enter pick the next one.
    - `"reopening starts at the coins"` (Review Focus 5): reopen during the close animation, and after Back.
    - `"step 2 stays on screen on a phone"`: the panel's bounding box is inside the viewport.
    - `"the badge sits at the coin's bottom-right"`: the badge box's right and bottom edges are within 2 px of the coin's or past them, and its width is 40–48% of the coin's.
    - In `highlights.spec.ts`: on step 2, one highlight and no covered text.
- [ ] **Step 2: Update the `pick()` helpers** in `sentence.spec.ts` (and any other spec that picks a coin) so an open network step is closed with Escape, keeping the default. Update the swap intent JSON assertion with the two networks. Replace "a coin is never swapped into itself" with the flip and bridge behaviour from Task 5.
- [ ] **Step 3: Run them in the isolated copy and watch them fail.**
- [ ] **Step 4: Implement.**
    - **Picker:**
        - A `step` state that resets in the `isPresent` effect and on reopen.
        - Back and the step title render above the listbox. The listbox is keyed by step, so its entrance and highlight replay.
        - The highlight layout effect also depends on the step.
        - ArrowUp on step 2's first row focuses Back.
        - A row with `subdetail` shows `detail` in the foreground and `subdetail` muted under it, as the deposit list's amounts do.
    - **Dialog:** a `ResizeObserver` on the panel re-runs `place()`.
    - **ChoiceSlot:** `contentKey` is `${value}@${then.value}`. The sr-only hint reads `{hint}, on {network label}`.
    - **Composer:**
        - It passes `onThen={(v) => set(slot.then.id, v)}` and marks the host as edited.
        - `shownValue` includes the network, so the announcer says `{hint} is now ETH on Base.`
    - **Badge:**
        - An `aria-hidden` NetworkLogo, about 0.5em on the 1.15em coin, at the bottom-right.
        - Its ring is `shadow-[0_0_0_0.06em_var(--badge-ring,var(--pill))]`.
        - The pill sets `--badge-ring` to its current background, hover included. The picker panel sets it to `var(--panel)`.
- [ ] **Step 5: Run the tests, then all browser specs, on desktop and mobile.** Expected: PASS, including "phones wrap the sentence without overflowing".
- [ ] **Step 6: Commit.** Message: `Pick a coin's network in the same picker, and badge it on the pill`.

### Task 7: Live coins and real wallet balances in the sentence

**Files:**
- Create: `components/trade/coins-store.ts`, `lib/trade/live-coins.ts`, `lib/trade/wallet-holdings.ts`
- Modify: `components/account-client.ts`, `components/account-provider.tsx`, `components/trade/trade-provider.tsx`, `components/trade/trade-composer.tsx` (`onOpen`), `components/wallet-provider.tsx`
- Test: `e2e/swap-live.logic.spec.ts` (new), `e2e/swap-networks.spec.ts`, `e2e/sentence.spec.ts`

**Interfaces:**
- Consumes: `SwapCatalogView`, `SwapHoldingsView` and the socket events (Tasks 2–3); `TradeCtx.wallet` and `Token` (Task 5); `ChoiceSlot.onOpen` (Task 6).
- Produces:
    - `toTokens(view: unknown, fallback: readonly Token[]): Token[]`. It is tolerant: it skips unknown networks and coins it can't place, and a `null` or non-finite price falls back to the built-in token's price. It returns `fallback` for a malformed view.
    - `createCoinsStore({ apiUrl, fetch? })`, with snapshot `{ view: SwapCatalogView | null }`. It caches `localStorage["swaps:catalog"]` and refreshes every 5 min while the page is visible, like the markets store.
    - `walletHoldings(rows: readonly SwapHoldingRow[], signers: { evm?: string; solana?: string }): WalletHoldings`. It keeps only rows of the signing wallets, comparing EVM addresses case-insensitively and Solana exactly.
    - `AccountSnapshot.swapHoldings: SwapHoldingsView | null`, cached per user in `localStorage["swap-holdings:{userId}"]` and cleared on disconnect.
    - `Account.swapHoldings: SwapHoldingRow[] | null`
    - `Account.refreshSwapHoldings(): void`, which emits `swap:holdings:refresh`
- Trade provider:
    - The live tokens come from `toTokens(coinsStore view, TOKENS)` in every Privy branch.
    - Signed in:
        - `holdings` is `{ [QUOTE]: balance }`. The `MOCK_HOLDINGS` merge is removed.
        - `wallet` is `walletHoldings(rows, { evm: depositWalletAddress(user, active), solana: first linked Solana wallet })`, or `null` while rows are null.
    - Signed out: `holdings` and `wallet` are both `null`.
    - Coin pills call `refreshSwapHoldings` through `onOpen`.
- Privy: `supportedChains: [arc, mainnet, bsc, arbitrum, base, optimism, polygon, avalanche]`.

- [ ] **Step 1: Write the failing logic tests** in `swap-live.logic.spec.ts`:
    - `"toTokens takes live prices and keeps built-in ones for nulls"`
    - `"toTokens ignores an unknown network or coin"`
    - `"a malformed catalog gives the built-in tokens"` (Review Focus 4)
    - `"walletHoldings keeps only the signing wallets"`
    - `"switching the active EVM wallet switches the holdings"` (Review Focus 2)
- [ ] **Step 2: Write the failing browser tests** in `swap-networks.spec.ts`, signed in with the e2e wallet (1 ETH on the Ethereum anvil):
    - `"the amount turns red past the wallet's real balance"`: 5000 USD of ETH makes the amount pill `aria-invalid="true"`. Review's description is "That's more than your $3,203.98 of ETH on Ethereum." ((1 − 0.002 reserve) × 3210.4). 100 USD is valid.
    - `"the network step shows the wallet's amount on each network"`: the Ethereum row shows "1 ETH" over its dollar value, and Base is disabled with "Nothing here".
    - `"holdings that never arrive leave the sentence uncapped"` (Review Focus 1): block the `swap:holdings` push in the page. 5000 USD is not red, and no row says "Nothing here".
    - Update `sentence.spec.ts` assertions that depended on mock holdings while signed in (the $4,013.00 cap, the 4013 slider top, the Buy-with-account-USDC case) to the real values. Fund wallet USDC through the backend's `/source/fund` where a test needs it.
- [ ] **Step 3: Run them and watch them fail.**
- [ ] **Step 4: Implement** the files above.
- [ ] **Step 5: Run the logic project, `npx tsc --noEmit`, the server suite, and all browser specs on desktop and mobile.** Expected: all PASS.
- [ ] **Step 6: Commit.** Message: `Cap swaps by the wallet's real coins on each network, at live prices`.
