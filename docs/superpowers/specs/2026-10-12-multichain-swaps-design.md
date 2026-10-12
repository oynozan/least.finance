# Multichain swaps: design

2026-10-12. Agreed in conversation; this is the written version for review.

## Goal

Swap, Buy and Sell become real swaps between the person's own wallets on nine networks, priced and routed by LI.FI, chosen in the same sentence as today:

- **A network for every coin.** Picking a coin in the picker moves on to a second step that lists the networks it exists on. The pill shows the coin's logo with the network's logo as a small badge.
- **Real balances.** The sentence caps each amount at what the wallet really holds of that coin on that network, and turns the amount red past it.
- **Real swaps.** Confirming asks the wallet to sign the swap LI.FI built. The server follows it to the end and the app shows what arrived.

## Decisions

|                    |                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custody            | The person's own wallet. LI.FI builds the transaction, the server checks it, the wallet signs it. The app never holds the coins.                     |
| Networks           | Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche, Arc, Solana                                                                       |
| Ecosystems         | EVM and Solana, both in the first version                                                                                                            |
| Verbs              | Swap, Buy and Sell are real. Long, Short and Predict are unchanged.                                                                                  |
| Buy and Sell       | Buy spends wallet USDC. Sell turns the coin into USDC on its own network.                                                                            |
| Default network    | The pay side: where the wallet holds the most of that coin, else the coin's home network. The receive side: the pay side's network if the coin is there, else its home network. |
| Closing early      | Closing the picker at the network step keeps the default network.                                                                                    |
| Badge style        | The deposit list's style: the network logo at the coin's bottom-right, ringed in the colour of the surface under it                                  |
| Provider           | LI.FI's REST API, called only by the server with `LIFI_API_KEY`                                                                                      |
| Integrator fee     | Off. `LIFI_FEE` turns it on later. LI.FI's own 0.25% is always charged and always shown.                                                             |
| Trades are optimistic | Once the wallet has sent the swap, the app counts it at once and drops the paid balance. If it fails or is refunded, the app puts it back, with a message. |

## 1. Networks and coins

**Networks.** Slugs are the values the sentence stores and the intent carries.

| Slug        | Name      | Chain id                 | Wallet |
| ----------- | --------- | ------------------------ | ------ |
| `ethereum`  | Ethereum  | 1                        | EVM    |
| `arbitrum`  | Arbitrum  | 42161                    | EVM    |
| `base`      | Base      | 8453                     | EVM    |
| `optimism`  | Optimism  | 10                       | EVM    |
| `polygon`   | Polygon   | 137                      | EVM    |
| `bnb`       | BNB Chain | 56                       | EVM    |
| `avalanche` | Avalanche | 43114                    | EVM    |
| `arc`       | Arc       | 5042                     | EVM    |
| `solana`    | Solana    | 1151111081099710 (LI.FI) | Solana |

Every network has its official logo: the eight in `public/logos/networks` (Base added 2026-10-12) and Arc's `ArcLogo`.

**Coins.** A curated table, never a list built from symbols, because symbols collide (three "USDC" on Solana, look-alike "BTC" on Base). Each entry pins the network, the token address or mint, its decimals, and whether it is a wrapped form.

| Coin | Home network | Also, as the same asset                                       | Wrapped or pegged, labelled in the picker                                                    |
| ---- | ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ETH  | Ethereum     | Arbitrum, Base, Optimism                                      | Polygon, BNB Chain, Avalanche and Arc (WETH and its pegs), Solana (Wormhole)                 |
| USDC | Arc          | Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche, Solana |                                                                                  |
| USDT | Ethereum     | Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche, Solana |                                                                                            |
| SOL  | Solana       |                                                               | Ethereum, BNB Chain, Arbitrum, Base, Polygon                                                 |
| BTC  | Ethereum     |                                                               | Every entry: WBTC (Ethereum, Arbitrum, Optimism, Polygon), cbBTC (Base), BTCB (BNB Chain), BTC.b (Avalanche), cirBTC (Arc) |
| BNB  | BNB Chain    |                                                               |                                                                                              |
| AVAX | Avalanche    |                                                               |                                                                                              |
| ARB  | Arbitrum     | Ethereum                                                      |                                                                                              |
| OP   | Optimism     |                                                               |                                                                                              |
| LINK | Ethereum     | Arbitrum, Base, Optimism, Polygon, BNB Chain, Avalanche       |                                                                                              |
| DOGE | BNB Chain    |                                                               | BNB Chain (Binance-Peg)                                                                      |

- **Addresses** come from LI.FI's token list, matched by `coinKey` and by address.
- **An entry stays only if LI.FI quotes it.** The plan checks every entry once, with a $10 quote to USDC on the same network, and records the answers as a test fixture.
- **Labels.** A wrapped row says what it is, for example "Wrapped SOL" or "WBTC". A coin bridged by its own issuer, like USDC on Base, needs no label.
- **Logos.** All eleven coins have official logos in `public/logos/coins`.

**Live prices.** The server reads LI.FI's token list for the nine networks every 5 minutes. From it, it serves `GET /swaps/catalog`: each coin with its name, live USD price, and network entries. The client loads it like the trending markets: cached in the browser, refreshed while open, and falling back to the built-in catalog when it can't be reached. Prices are for display only. A swap always uses its quote's amounts.

## 2. The picker

**Step 1: coins.**
- The same list as today: coin logo, symbol, name.
- On the right, the wallet's total of that coin across networks (units over dollars, as in the deposit list), or its price when no wallet is connected.

**Step 2: networks.**
- Picking a coin with more than one network commits it at once, with its default network, and the same picker moves on to step 2. A coin on one network commits and closes, as today.
- **The title** is the companion slot's prompt, for example "ETH on which network?".
- **A Back control** returns to step 1. It sits above the list, outside the listbox, so the list's one highlight stays its bottom layer.
- **Each row**, styled like the deposit list:
    - the coin's logo with the network's logo as its badge
    - the network's name, with the wrapped label under it when there is one
    - on the right, the wallet's amount there over its dollar value
- **The current network** is the row selected and highlighted when the step opens.
- **Picking a row** commits it and closes.
- **Escape or an outside click** closes and keeps the default network, which was committed with the coin.
- **Rows that can't be picked** stay listed and say why:
    - On the paying side (Swap's pay coin, Sell), a network where the wallet holds none says "Nothing here", once balances are known.
    - On Swap, the row that would make both sides identical says "Same as the other side".

**The pill.**
- It shows the coin's logo with the network's badge at its bottom-right, about 44% of the coin's size, ringed in the pill's colour.
- Its text and accessible name stay the bare symbol, so the sentence still reads "I want to Swap my ETH to SOL for 10 USD."
- The network is read out in its description: "Coin you pay with, on Base".
- A change of network alone still springs the pill, and the announcer says "Coin you pay with is now ETH on Base."

**The panel.** The floating panel places itself again when the step changes its height, so step 2 never runs off the screen.

## 3. The sentence engine

The engine stays domain-free. Four small additions:

- **`ChoiceSpec.then?: string`** names a companion choice slot that holds this slot's follow-up value (the network). The companion is a full slot with its own spec and draft value, but it is not in the template. So the sentence keeps three pills, the same part keys and the same text.
- **`ChoiceSlotView.then`** is the companion's view: `id`, `prompt`, `hint`, `value`, `selected`, and `choicesFor(value)`, its choices for any value of the host. The picker can show step 2 for the coin just picked without waiting for a render. A missing companion value is reported as the host slot's issue.
- **`IconRef.badge?: IconRef`** puts the companion's selected icon on the host's selected icon. The engine passes it through, and the trade icon renderer draws it.
- **`Choice.subdetail?: string`** is a second trailing line under `detail`. When set, `detail` shows in the foreground colour, as the deposit list's amounts do.

**Terms.** The `token` term stays a bare symbol. A new `tokenNetwork` term joins Swap's `toNetwork` and the Buy/Sell `network`, so the coin and its network carry over together when the verb changes. A carried network the coin isn't on fails `accept`, and the domain's `normalize` puts the default in its place.

## 4. The operations

**Swap.**
- Slots: `fromToken` with `fromNetwork`, then `toToken` with `toNetwork` (term `tokenNetwork`), then `amountUSD`.
- A swap is between two (coin, network) pairs. The same coin on two networks is a legal bridge.
- A coin pick (step 1) that makes both sides identical flips them, as picking the other side's coin flips it today. In step 2 that row is disabled instead.
- When the receive coin is the pay coin, its default network is any other network that coin is on: the home network first, else the first in table order.

**Buy.**
- Slots: `token` with `network`, then `amountUSD`.
- It pays with wallet USDC. The network paid from is the coin's own network if the wallet's USDC there covers the amount, else the network with the most USDC.
- The review names the network paid from. The sentence doesn't.

**Sell.**
- Slots: `token` with `network`, then `amountUSD`.
- It receives USDC on the coin's own network. Every one of the nine networks has USDC.

**Long, Short, Predict.** Unchanged, with no network step.

**Bounds.** The cap is the wallet's dollar value of the coin on that network. Past it, the amount is an error, so the pill turns red and Review is blocked: "That's more than your $259.68 of ETH on Ethereum."
- **Native coins** keep a gas reserve per network out of the cap.
- **Buy's cap** is the largest USDC balance on any one network.
- **No cap** applies while no wallet is connected, or until its balances load (as today).

**Which balances.** The sentence reads the wallet that will sign:
- the connected EVM wallet for the eight EVM networks
- the linked Solana wallet for Solana

When signed in, the account's deposited USDC stays the cap for Predict, Long and Short only. **Mock holdings are used only in demo mode** (no Privy app ID); signed in, every number is real. This fixes today's white amount, which came from mock ETH, SOL, BTC, LINK and DOGE holdings being merged into a signed-in person's real USDC.

**Receiving on the other ecosystem.** A swap from an EVM coin to a Solana one, or the other way round, sends the coins to the person's own wallet on the receiving side.
- If they have none linked, that network's row stays pickable and the review offers "Connect a Solana wallet" (or an EVM one), using the existing link flow.
- Review stays blocked until a wallet is linked.

**Intents.**
- `{ type: "swap", fromToken, fromNetwork, toToken, toNetwork, amountUSD }`
- `{ type: "spot", side, token, network, amountUSD }`

The registry's compile-time check covers both.

## 5. Wallet balances

**A new swap holdings reader.** It is separate from the deposit balances, whose list must keep showing only depositable coins.
- **EVM networks:** one Multicall3 call per network per wallet, for the native coin and every listed token.
- **Solana:** `getBalance` plus `getTokenAccountsByOwner`.
- **A failed network** keeps its last good rows.
- **Prices** come from the catalog snapshot.

**When it reads.**
- The server pushes `swap:holdings` for each of the account's linked wallets at sign-in.
- It reads again when the picker or review asks (`swap:holdings:refresh`, at most every 15 s), and after each swap settles.

**RPCs.** Each network gets a URL list in the server config, with public defaults:
- existing lists: `ETHEREUM_RPC_URLS`, `BNB_RPC_URLS`, `SOLANA_RPC_URLS`, and Arc's
- new lists: `ARBITRUM_RPC_URLS`, `BASE_RPC_URLS`, `OPTIMISM_RPC_URLS`, `POLYGON_RPC_URLS`, `AVALANCHE_RPC_URLS`

**Privy.** `supportedChains` grows to the eight EVM networks, so the wallet can be asked to switch to any of them.

## 6. Quotes and swaps (LI.FI)

**Quote.** While the review is open, the client asks `swap:quote` every 15 s. The server:
1. turns the dollar amount into coin units at the catalog price, rounding down to the token's decimals and never over the balance it read
2. calls `GET /v1/quote` with the person's wallet as `fromAddress`, their wallet on the receiving side as `toAddress`, `integrator` set, slippage 0.5% and `fee` only when `LIFI_FEE` is set
3. caches the answer for 10 s, per request

**The review** shows the quote:
- You pay: units and dollars, and "on Base"
- You get ≈ (`toAmount`), and at least (`toAmountMin`)
- Fees: LI.FI's 0.25%, plus ours when set, from `feeCosts`
- Network gas, from `gasCosts`, in dollars
- Time, from `executionDuration`, for example "about 20 s" or "about 18 min"
- Route: the tool's name

**Confirm.** The client sends `swap:order`. The server quotes again and checks the transaction before returning it:
- On EVM, `transactionRequest.to` is the source network's LI.FI diamond (from `/v1/chains`, cached), and `chainId` and `from` match.
- The quoted from and to tokens are the table's addresses.
- `toAddress` is the person's own wallet.
- `value` is 0 for a token input, and at most the amount for a native one. On Arc it is in 18-decimal wei, while LI.FI quotes Arc USDC in 6 decimals. The check converts.
- On Solana, the transaction decodes and its fee payer is the person's wallet.

If the new `toAmountMin` is more than the slippage below the reviewed amount, the server refuses with "price moved" and the review shows the new quote.

**Approvals.** LI.FI doesn't return them.
- For a token input without `skipApproval`, the server reads the allowance to `estimate.approvalAddress`. If it's short, it puts an exact-amount `approve` first.
- USDT on Ethereum with a non-zero allowance gets an `approve(0)` before that.

**Signing.**
- **EVM:** the client reuses the deposit path. It switches the wallet to the source network (`ensureNetwork`), sends each transaction with `eth_sendTransaction` naming its `chainId`, and waits for each to land before the next.
    - On Arc it sets `maxFeePerGas` itself (40 gwei), as `deposit()` does, and never forwards LI.FI's `gasPrice`.
    - With an approval first, the review says so: "Approve USDC in your wallet, then confirm the swap."
- **Solana:** the client decodes LI.FI's base64 transaction and asks the linked wallet to sign and send it: Privy's `useSignAndSendTransaction`, or the wallet's own Wallet Standard `solana:signAndSendTransaction` if Privy's hook can't drive an external wallet. The plan's first Solana task settles which.

**Order record.** The server stores each swap in `swap_orders`:
- account, wallet, both pairs, units in, the quote's `toAmount` and `toAmountMin`, tool, fees
- the transaction hashes the client reports with `swap:sent`
- state: `created`, `sent`, `done`, `partial`, `refunded`, `failed`, `expired`
- what arrived
- the person's IP, kept 30 days (LI.FI's terms require it)

An order the client never reports sent expires after 15 minutes.

**Tracking.** The server polls `GET /v1/status` with the source hash, both chains and the tool: every 10 s for a minute, then every 30 s, then every 60 s, for up to 24 hours.
- `NOT_FOUND` stays pending.
- `DONE` + `COMPLETED` is done, with `receiving.amount`.
- `DONE` + `PARTIAL` means a different token arrived.
- `REFUNDED` (under `DONE` or `FAILED`) is refunded.
- `FAILED` is failed.

It checks that `sending.txHash` and both addresses match the order before acting, because status data is public. Every change is pushed as `swap:update`.

**Optimistic.**
- Once the wallet returns a hash, the review says "Swap sent." and the paid coin's balance drops at once in the picker and caps.
- Done raises the received coin's balance (then a fresh read confirms both).
- Refunded or failed puts the paid balance back.

**Where swaps show.** The review follows the swap live until it's done. The PnL activity lists real swaps:
- "Swap ETH to SOL", with the networks in the detail, its state, and no change to the account balance
- not through `confirmedTrades`, which is the simulated path
- the deposit history stays deposits only

## 7. Errors

Each has one message, in the review or under the sentence:

| Case                              | What the person sees                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| More than the wallet holds        | The amount turns red. "That's more than your $259.68 of ETH on Ethereum."                              |
| No route                          | "There's no route for this swap right now."                                                            |
| Price moved at confirm            | "The price moved. Check the new amount and confirm again." The review shows the new quote.             |
| Wallet rejected                   | Nothing. The button goes back to "Confirm swap".                                                       |
| Couldn't switch network           | "Switch your wallet to Base and try again."                                                            |
| No wallet on the receiving side   | "Connect a Solana wallet to receive SOL on Solana." With a Connect button.                             |
| Same-chain swap reverted          | "The swap failed, so your ETH stayed in your wallet. Only the network fee was spent."                  |
| Refunded                          | "The swap didn't go through. Your 10 USDC is back on Base."                                            |
| A different token arrived         | "Received 10.2 USDC on Arc instead of SOL."                                                            |
| LI.FI down or rate-limited        | "Swaps aren't available right now."                                                                    |

## Testing

- **Engine (logic project).**
    - `then` builds the companion view, `choicesFor` answers for any host value, and the missing issue lands on the host.
    - The badge merges.
    - Term carry-over moves a coin and its network together, and falls back when the network doesn't fit.
    - `view.text` and part keys are unchanged.
- **Operations (logic project).**
    - Default networks follow the rules in section 4.
    - An identical pair flips.
    - Buy's pay network follows its rule.
    - Caps come from the wallet's per-network balances, and the amount is an error past them.
    - Demo mode still runs on mock holdings.
    - Intents carry the networks.
- **Picker (browser, desktop and phone).**
    - Two steps, and Back.
    - Closing at step 2 keeps the default.
    - A one-network coin closes after step 1.
    - Keyboard through both steps.
    - Step 2 keeps one highlight under all text (`highlights.spec.ts`).
    - The panel stays on screen after the step changes.
    - The badge sits at the coin's bottom-right and leaves the pill's name a bare symbol.
    - No horizontal overflow on a phone.
    - The amount turns red past the real balance.
- **Server (vitest).**
    - The catalog against a recorded LI.FI token list.
    - The holdings reader against a fake RPC.
    - Quote checks reject a wrong diamond, chain, sender, token, receiver or value, and Arc's decimals are converted.
    - Approvals: added only when short, and USDT's reset to 0.
    - The tracker through each status, including a mismatched status that is ignored.
    - The order expires when never sent.
    - IPs expire after 30 days.
    - Everything runs against a fake LI.FI, like the fake Polymarket.
- **End to end.** The wallet mock learns the eight EVM networks and a Solana Wallet Standard wallet. A swap, a buy and a sell each run through quote, sign, sent, done and refunded against the fake LI.FI.
- **Live check.** An owner-run script asks LI.FI for a real quote for every table entry and checks the same rules, without signing. An optional `--yes-spend-real-money` flag then runs one $2 swap from a wallet the owner names.

## Order of work

1. **Phase A: networks, balances, prices.**
    - the catalog and `GET /swaps/catalog`
    - the engine's `then`, badge and `subdetail`
    - the two-step picker
    - network slots and defaults in Swap, Buy and Sell
    - the holdings reader and real caps
    - Privy's networks

    Execution stays simulated, and the review's request JSON shows the networks.
2. **Phase B: real swaps.**
    - quotes, orders, checks, approvals
    - EVM and Solana signing
    - tracking, optimistic balances, swap activity, errors
    - the live check

## What the owner provides

- **LI.FI.**
    - Done:
        - the Partner Portal API key (`LIFI_API_KEY` in `server/.env`)
        - fee wallets (EVM `0x42251731F7aFDD590A210E1aCc1A44e6815F09Ce`, Solana `DSfPMZyXjjG4f8k5XQdMN6tZoPGTerVJnnUM1oZBBQF2`, from `LIFI_FEE_MNEMONIC`)
    - Still to do:
        - the integrator id the portal gave (`LIFI_INTEGRATOR`)
        - accepting LI.FI's Commercial API Terms as a company
- **RPC URLs** for the nine networks in production. The public defaults are rate limited.
- **Sanctions screening.** LI.FI's terms put sanctions screening of end users on us. Like the location check for predictions, it isn't built. It's a launch blocker for a public launch.

## Not included

- An integrator fee by default (`LIFI_FEE` exists, set to 0)
- Bitcoin, Sui, Tron and other networks beyond the nine
- Choosing between routes, and limit orders
- Swapping from the account's deposited balance (the account keeps funding Predict, Long and Short)
- Merging the swap holdings reader with the deposit balances
- Networks on Long and Short
