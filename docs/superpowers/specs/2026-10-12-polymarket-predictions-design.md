# Polymarket predictions: design

2026-10-12. Agreed in conversation; this is the written version for review.

## Goal

The Predict sentence trades real Polymarket markets with the person's Arc balance, instantly, from inside the app:

- **Live markets.** The question picker offers Polymarket's active markets: the trending ones first, and any other through search.
- **Real orders.** Confirming a prediction buys real shares on Polymarket. The person can sell early, and winners are paid into their balance when the market resolves.

## Decisions

|                       |                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Markets               | Every active Polymarket market. The picker opens on trending (24-hour volume), and search finds the rest.                            |
| Thin markets          | Hidden, because orders are real                                                                                                      |
| Multi-outcome events  | The event is the question and its options are the outcomes. Picking an option buys YES on it.                                        |
| Custody               | One pooled Polymarket account run by our server. Our ledger records whose shares are whose.                                          |
| Money path            | A pUSD float on Polygon, topped up by hand. Predictions, closes and payouts move people's Arc balances through the ledger instantly. |
| Positions             | Close sells early at the market price. Winners are paid automatically at resolution.                                                 |
| Location              | No check, for a private demo only. See "Not included".                                                                               |
| Builder fee           | None. People pay only Polymarket's own fee, shown in the review.                                                                     |
| Order type            | Fill-or-kill market orders with a price limit. An order fills completely or not at all.                                              |
| Trades are optimistic | Confirming accepts the trade in the app at once. Only if the server fails it does the app take it back, with a message.              |

## 1. Live markets

**The server owns market data.** The browser never calls Polymarket. That gives one rate limit, one filter, and the exact IDs the order path needs.

- **Sync.** Every 60 seconds the server reads the top 100 active events by 24-hour volume from Polymarket's Gamma API (`GET /events?active=true&closed=false&order=volume24hr&ascending=false&limit=100`). It shapes them as below and keeps the first 50 that pass as **trending**. Events requested through `GET /markets/:eventId` in the last 10 minutes, and events anyone holds shares in, are re-read by ID in the same pass, so their prices stay fresh.
- **Search.** `GET /public-search?q=…&events_status=active` on Gamma, through the server, cached for 60 seconds per normalized query. Results are shaped and filtered the same way, 20 at most. The client sends a query after 250 ms without typing, and only from 2 characters.
- **Public routes.** Market data needs no sign-in, so people browsing signed out see real markets too:
    - `GET /markets/trending`
    - `GET /markets/search?q=`
    - `GET /markets/:eventId`

    They sit outside `/v1`, so they take no token, and they're rate-limited per IP. `GET /markets/trending` returns `{ markets, maxOrderUSD }`. `maxOrderUSD` is the pool's current per-order limit (section 2), and `null` while trading is off.

**Shaping an event into a question.** A market is offered when it is active, not closed, accepting orders, has an order book, closes more than an hour from now, and its spread is at most 10¢. An outcome is offered when its buy price is between 1¢ and 99¢. Then, taking the first rule that fits:

1. **One offered market:** the question's outcomes are that market's two outcomes, with their own labels: YES/NO, Up/Down, or two team names.
2. **Several offered markets, all YES/NO:** each market is an outcome, labeled with its `groupItemTitle` ("25 bps decrease", "October 31", "$120,000"). Choosing it buys that market's YES token. Outcomes are sorted by chance, highest first.
3. **A sports event with a `moneyline` market:** only the moneyline market, as in rule 1. Props, spreads and totals are left out.
4. **Anything else** is left out.

An event with no offered outcome is left out.

**The question, as the client sees it.**

- `PredictionMarket`:
    - `id`: Polymarket's event ID
    - `question`: the event title
    - `short`: the title cut to 24 characters at a word boundary
    - `image`: the event's image URL
    - `closes`: e.g. "Oct 29"
    - `volume24hUSD`
    - `outcomes`
- `Outcome`:
    - `id`: the CLOB token ID
    - `label`
    - `price`: the buy price, from the best ask
    - `chance`: the midpoint, from 0 to 1
    - `tone`: YES is gain, NO is loss, and everything else is neutral
    - `minUSD`: the market's minimum order size × price, rounded up to the cent, and never under $1

**Instant.**

- The client keeps the last trending list in `localStorage` (one key, `markets:trending`; it isn't per person) and shows it on load, before the request returns.
- The picker never shows a spinner. A search with no results yet shows the trending list under the field.

**Odds.** Trending refreshes every 60 seconds while the page is visible. The question picked in the sentence refreshes every 10 seconds through `GET /markets/:eventId`. On the server, `:eventId` answers from a 5-second cache that refreshes the market's prices from the CLOB.

**The sentence engine stays as it is.**

- `ctx.catalog.markets` becomes a client-side store: trending, plus anything searched, picked or held. The engine stays synchronous and never learns about Polymarket.
- The picker gains a search field. It's generic: a choice slot can declare `search: { placeholder }`, and the trade UI answers queries by adding results to the store.
- Picker rows show the event's image, through a new `image` icon set:
    - For a question: the leading outcome's chance and the close date ("84% No change · ends Oct 29").
    - For an outcome: its price and chance ("84¢ · 84% chance").
- **Demo mode** (no Privy app ID) keeps today's mock markets.

## 2. Real orders

**The pool.**

- The pool is a Polymarket deposit wallet: a smart wallet on Polygon whose gas Polymarket's relayer pays.
- Its owner is a fresh EOA whose private key the server holds (`POLYMARKET_POOL_KEY`). The server already holds the deposit mnemonic, which guards more money, so this doesn't change the threat model.
- The owner signs orders (signature type 3, POLY_1271) and the redemption batches.
- Builder API credentials (`POLYMARKET_BUILDER_API_KEY`, `_SECRET`, `_PASSPHRASE`) authorize the relayer. The builder code (`POLYMARKET_BUILDER_CODE`) goes into every order.
- A one-time setup script, `server/scripts/polymarket-setup.ts`, deploys the deposit wallet, sets the trading approvals, derives the CLOB API credentials, and prints the wallet address to fund.
- The client is Polymarket's official TypeScript SDK, `@polymarket/client`, pinned to an exact version. Nothing calls Polymarket's contracts by hand.

**Money units.** The ledger counts Arc USDC in 18-decimal wei. Polymarket counts pUSD and shares in 6-decimal units. Converting is exact (× 10¹²), and nothing is ever rounded in a person's favor or against them by more than one 6-decimal unit.

**The ledger gains a debit.**

- The debit is guarded by `balance >= amount` in the same `findOneAndUpdate`, so a balance never goes negative.
- New entry kinds:

    | Kind                | Direction | `refId`      |
    | ------------------- | --------- | ------------ |
    | `prediction_buy`    | −         | the order    |
    | `prediction_refund` | +         | the order    |
    | `prediction_sell`   | +         | the order    |
    | `prediction_payout` | +         | the position |

- The existing unique index on `(kind, refId)` keeps each one to exactly once.

**A quote.** `prediction:quote { eventId, tokenId, amountUSD }` returns:

- the average price, from the SDK's `estimateMarketPrice`
- the shares
- Polymarket's fee
- the payout if the outcome wins

The review asks for one when it opens, again when the amount changes, and every 10 seconds while it's open. The sentence's "Pays $X if YES" stays a local estimate from the picker price.

**Placing a prediction.** `prediction:order { requestId, eventId, tokenId, amountUSD, quotedPrice }`:

1. **Check.**
    - The market is still offered, refreshed if the cache is older than 5 seconds.
    - The amount is at least the outcome's `minUSD`.
    - The person's balance covers it.
    - The pool's free float covers it.
    - The rate limit allows it: 10 orders per minute.
2. **Hold the money.** One transaction inserts the order (`state: "placing"`, unique on `(accountId, requestId)`, so a retried request is the same order) and debits the amount (`prediction_buy`).
3. **Sign.**
    - A fill-or-kill market buy.
    - `maxSpend` = the amount, so fees are included.
    - `maxPrice` = the quoted price + 2¢, clamped to 99¢ and rounded to the market's tick.
    - The order hash is saved on the order before posting.
4. **Post, then settle.**
    - **Filled:**
        - The order records the shares and what was really spent.
        - Anything unspent is credited back (`prediction_refund`).
        - The position is created or grown (shares, and cost).
    - **Not filled** (the price moved past the limit, or the market closed): the whole amount is credited back.
    - **Delayed** (live sports markets wait a few seconds), **or no clear answer** (a timeout):
        - The order stays `posted`, and the money stays held.
        - A tracker looks the order up by its hash until it's filled or cancelled, then settles as above.
5. **Push.** `prediction:update { requestId, order, position, account }` goes to the person's sockets.

**Optimistic in the app.** The person never waits for Polymarket:

- **On confirm**, the app accepts the trade at once, before the server answers:
    - The review closes as done.
    - The balance drops by the amount.
    - The position appears in the sidebar with the quote's shares.
    - No "confirming" state is shown.
- **A fill** replaces the shares and cost with the real ones in place, and the balance takes the server's value. Each optimistic change is keyed by its `requestId`, so the server's push replaces it instead of counting twice.
- **A failure takes it all back:**
    - The position disappears.
    - The balance returns.
    - One message explains why (see Errors).
- **A delayed or unclear order** stays shown as accepted while the tracker settles it.
- **Not connected at confirm:** the trade is taken back at once with "You're offline. Nothing was spent."
- **After a reload**, the `positions` push includes orders that haven't settled yet, so a trade still in flight stays shown.
- **Fewer failures:** the amount's upper bound is the smaller of the person's balance and the pool's current limit (`maxOrderUSD`, served with the market data). So the float rarely refuses an order the app has already accepted.

**Recovery.** On startup, an order still `placing` was never posted (it has no hash), so it's refunded. Any `posted` order goes to the tracker.

**The float.**

- Free float is the pool's pUSD balance, read from the CLOB after every order and every 60 seconds.
- An order that doesn't fit is refused before any money moves: "Predictions are limited to $X right now."
- Warnings are logged when free float falls under 25% of `POLYMARKET_FLOAT_USD` (default 100), and when it climbs over 200%, the hint to move money back to Arc.
- Moving money between Arc and Polygon is done by hand (CCTP, then wrapping into pUSD) until a later phase automates it.

**Trading switch.** With `PREDICTIONS_TRADING=off`, markets stay live but Review stays simulated, as it is today. Phase 1 ships this way, and the switch doubles as an incident brake.

**Review.**

- For a prediction, confirm sends `prediction:order` instead of the simulation.
- The review shows the quote's rows: you buy, if it wins, otherwise, Polymarket's fee, and market odds.
- The other verbs stay simulated.

## 3. Positions, closing and payouts

**Positions.**

- One position per person and token while it's open: shares, cost, and the question and outcome it bets on. Unique while open on `(accountId, tokenId)`.
- States: `open`, `closed`, `won`, `lost`.
- Positions are pushed when the socket binds (`positions`): open ones, and ones settled in the last 7 days.

**The sidebar.**

- Real prediction positions replace the mock ones. Perps stay mock.
- Each shows its live value (shares × the best bid) and its PnL against cost.
- Settled positions show "Won $X" or "Lost" for 7 days.

**Closing.** `prediction:close { requestId, positionId, quotedPrice }`:

- A fill-or-kill market sell of all the position's shares, with `minPrice` = the quoted price − 2¢, clamped to 1¢ and rounded to the tick.
- The proceeds after fees are credited (`prediction_sell`), and the position becomes `closed`.
- The same order states and tracker as buying.
- **Optimistic, like buying.**
    - Close removes the position from the open list at once and raises the balance by the quoted proceeds.
    - A fill sets the real proceeds.
    - A failure puts the position back, lowers the balance again, and shows the message.
- A position smaller than the market's minimum order size can't be sold. Its Close is disabled with "Too small to sell. It pays out when the market resolves."
- Partial closes aren't offered.

**Payouts.**

- Every 60 seconds the resolver reads the markets that open positions are in (Gamma `/markets?id=…`).
- A market counts as resolved when it's closed and its `umaResolutionStatus` is `resolved`. The payout per share is that outcome's final price: 1, 0, or 0.5 for a 50/50 resolution.
- Each open position is then settled:
    - **A win** (payout above 0): credited shares × payout (`prediction_payout`), exactly once per position, and the position becomes `won`.
    - **A loss:** the position becomes `lost`, with no ledger entry.
- People see the change in place, in the sidebar and their balance.
- People are paid from the ledger as soon as the market resolves. The pool redeems its winning shares on Polymarket separately, through the relayer, once per market. A failed redemption is retried every 10 minutes and logged. Redemption refills the float; it never delays a payout.

**Reconciliation.**

- Every 10 minutes the server compares the open shares in the ledger, per token, with the pool's shares on Polymarket (Data API `/positions`).
- A mismatch is logged as an error. People's balances and positions are unaffected.

**PnL page.** For a signed-in person, real prediction buys, closes and payouts replace the mock prediction rows in the activity list. Other mock trades stay as they are.

## Errors

Every failure after an optimistic accept takes the trade back in the app (as in section 2), then shows one message in the sidebar's status line.

| What happens                     | The message                                                                 | Money on the server     |
| -------------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| The price moved past the limit   | "The price moved, so your prediction didn't go through. Nothing was spent." | Refunded at once        |
| The market closed meanwhile      | "This market just closed. Nothing was spent."                               | Refunded at once        |
| The float is short               | "Predictions are limited to $X right now. Nothing was spent."               | Nothing moved           |
| Polymarket doesn't answer at all | "Polymarket isn't answering. Nothing was spent."                            | Refunded (never posted) |
| Not connected at confirm         | "You're offline. Nothing was spent."                                        | Nothing moved           |
| An answer is late or unclear     | Nothing: the trade stays accepted until the tracker settles it              | Held until settled      |
| A close fails                    | "Couldn't sell right now. Your position is back."                           | Nothing moved           |
| Gamma sync fails                 | Nothing. The last good list stays, and a warning is logged.                 | n/a                     |

## Testing

**Fake Polymarket.** An in-process HTTP server for the parts we call:

- Gamma events, search and markets
- the CLOB book, price estimate, order post and order lookup
- the relayer
- the Data API positions

Its controls set prices, fill or reject the next order, delay it, and resolve a market. Gamma responses come from fixtures recorded from the live API by a script, like the bridge fixtures.

**Unit:**

- shaping, with each rule against recorded events:
    - YES/NO
    - named outcomes
    - several YES/NO markets
    - a sports event
    - a skipped event
- the filters
- unit conversion
- price limits and tick rounding

**Server integration**, on the existing Mongo harness:

- **Markets:**
    - Trending and search are served from the sync and the cache.
    - A failed sync keeps the last list.
- **Buying:**
    - A filled buy debits, records the shares and refunds the unspent part.
    - An unfilled buy refunds in full.
    - The same `requestId` twice is one order.
    - A balance or float that's short is refused with no money moved.
    - Two concurrent orders can't overdraw.
- **Recovery:** `placing` is refunded, and `posted` is settled by the tracker. Delayed orders settle too.
- **Closing:** it credits the proceeds. A position below the minimum can't be closed.
- **Resolution:** a win, a loss and a 50/50, each paid exactly once, even across two resolver passes.
- **Redemption:** it's retried after a failure.
- **Reconciliation:** a mismatch is logged.
- **Trading off:** orders are refused.

**Browser (Playwright)**, against the fake:

- The picker shows the cached trending list at once, then the fresh one, with no loading text.
- Search finds a market that isn't trending.
- A multi-outcome event reads "Predict [No change] on [Fed decision in October?]".
- A prediction:
    - lowers the balance and adds a position in the sidebar at once, while the fake is still holding the order
    - takes the real shares in place when the fake fills it
    - rolls back when the fake rejects it: the position goes, the balance comes back, and "The price moved…" shows
    - survives a reload while the fake holds it
- Close credits the balance at once, and puts the position back if the fake rejects the sale.
- Resolving through the fake pays a win into the balance.
- Signed out, the picker still shows live markets.

**Live check.** The owner places a $1 prediction and closes it with real keys and a funded pool.

## Order of work

Each phase gets its own implementation plan.

1. **Live markets (section 1).** It ships on its own with `PREDICTIONS_TRADING=off`.
2. **Real orders (section 2).**
3. **Positions, closing and payouts (section 3).** Trading turns on only once this is done, so nobody holds shares they can't see or sell.
4. **Live check** with real keys.

## What the owner provides

- A Polymarket builder profile:
    - its builder code
    - Builder API key, secret and passphrase
    - approval from builder@polymarket.com, if their rollout still requires it
- A fresh EOA for the pool owner.
- Running the setup script once, then funding the printed wallet with pUSD: $100 to start, through Polymarket's bridge or by wrapping Polygon USDC.
- **Hosting the server outside Polymarket's restricted regions.** Polymarket sees our server's IP on every order, and orders from blocked or close-only regions (the US and the UK among them) are rejected. The server calls Polymarket directly from its host, with no proxies.

## Not included

- **A location check on people.** Polymarket asks apps that place orders for their users to apply its geoblock. With the pooled account, people in close-only regions could open positions they couldn't open on Polymarket directly. This is acceptable only for a private demo. It must be decided before any public launch, and the order path has one place a check can go: step 1 of placing a prediction.
- **routing Polymarket traffic through proxies, rotating or not, to appear to be in another country.** That would get around Polymarket's location controls, which exist for sanctions and regulatory reasons.
- automatic rebalancing between Arc and Polygon (a later phase, possibly sharing the multichain work's CCTP client)
- a builder fee
- betting NO on one option of a multi-outcome event
- limit orders, partial closes, and combos
- live price ticks over Polymarket's WebSocket. The picked question refreshes every 10 seconds instead.
- making the other verbs real
