# Least Finance server

Gives every connected wallet an account of its own on the server, so trades and bets can run on the user's behalf without a signature or a transaction each time. It is Express and socket.io over MongoDB: accounts, deposits and withdrawals on Arc Mainnet (chain 5042) and other networks, Polymarket predictions and LI.FI swaps. To run it in production, follow the [deployment runbook](../deploy/README.md).

## How deposits work

1. The web app signs in with Privy (wallet login, so Privy has already checked a SIWE signature). It sends the Privy access token over the socket handshake, or as `Authorization: Bearer` over HTTP. The server verifies the token locally; the token's user is the account's owner, so the app never asks for a signature of its own.
2. `account:open` opens the signed-in person's account on first use, one per Privy user however many wallets they link. Each account gets its own deposit address, derived from `DEPOSIT_MNEMONIC` at `m/44'/60'/0'/0/{index}`; only the index is stored. Index 0 is kept back for the operator.
3. The user sends USDC on Arc to that address. The client counts the deposit as soon as the wallet hands back the transaction hash, and reports it (`deposit:submit`); the server waits for the receipt and credits it, usually within a second or two.
4. A chain scan credits every deposit whether or not anyone reports it, such as one sent from an exchange. It reads the `Transfer` logs Arc's system address `0xff…fe` emits for every native USDC movement (EIP-7708): plain sends, value a contract forwards, and transfers through the ERC-20 view at `0x3600…` alike. The ERC-20 view's own `Transfer` log is ignored, so nothing is credited twice. Gas isn't logged. Arc's finality is instant. Still, each pass reads the head and the logs from one RPC and stays three blocks behind it (`DEPOSIT_SCAN_LAG_BLOCKS`), so a lagging node can't make it skip a block. It moves to the next RPC after a failure. A block busier than the RPC will return at once is read recipient by recipient.
5. Crediting is one MongoDB transaction: the deposit, the balance (`$inc`, plus a `version` for ordering on the client), and a ledger entry. A unique index on `(chain, tx hash, log index)` makes every repeat a no-op, so the report and the scan can race safely. Pushes go out on `deposit:credited` to every socket bound to the account.

Amounts keep all 18 of Arc's native decimals: Decimal128 wei in the database, decimal strings such as `"12.5"` on the wire. Transfers under `DEPOSIT_MIN_USDC` (0.01) aren't credited.

## How withdrawals work

Withdrawals are paid from the treasury, the wallet at HD index 0 of `DEPOSIT_MNEMONIC`; its address is logged at startup. A sweeper moves every credited deposit's balance from its deposit address into the treasury (right after each credit, and in a catch-up pass every 10 minutes), so withdrawals are paid from one place. Balances under ten sends' worth of gas stay put as dust. `withdraw:create` takes the amount off the balance in one transaction, and only when the treasury holds it plus a 0.01 USDC gas reserve; a payout worker then signs and sends it, and a failed one is refunded. The smallest withdrawal is `WITHDRAW_MIN_USDC` (0.01). There are no fees.

**Don't send from the treasury key while the server runs.** The worker signs with the treasury's nonces, so a transaction from elsewhere can clash with a payout or a sweep.

## How Long and Short work

Each person trades from a Hyperliquid account of their own, derived from `DEPOSIT_MNEMONIC` at `m/44'/60'/1'/0/{index}`. Index 0 is the master float, which funds an order with a `usdSend` and takes the money back when the position closes. The collateral leaves the person's Arc balance when they confirm, and the close credits what came back. Each position pays a flat $1 fee, taken from its collateral when it opens and sent to the master with the unused collateral; a position that doesn't open pays nothing. Real orders go out only while `PERPS_TRADING=on`. The tracker, closes and liquidations run either way, so turning trading off never traps a position. A reconciler checks every 10 minutes that positions match Hyperliquid and that the assets cover the books. It sweeps money stuck on an idle address back to the master and only logs, never changing a position or a balance. Long and Short offer every market on Hyperliquid's main dex that isn't delisted (the builder dexes are left out), busiest by 24-hour volume first; the order holds for ten minutes, and re-sorts at once when a market is added, so the picker doesn't reshuffle.

The operator keeps the master funded, at around `PERPS_FLOAT_USD`. Run these from `server/` with the server up, but never while it is paying a withdrawal, since both sign from the treasury key:

```bash
node --env-file=.env scripts/perps-rebalance.ts arc-to-hl <usd>   # Arc treasury to the master, by CCTP (needs HYPERCORE_CCTP_FORWARDER)
node --env-file=.env scripts/perps-rebalance.ts hl-to-arc <usd>   # the master back to the Arc treasury
```

Each prints what it would do and sends nothing without `--yes-send-real-money`. `arc-to-hl` refuses to leave the treasury short of what withdrawals need. Before turning trading on, run `scripts/perps-check.ts` on the testnet (its header says how), then on mainnet open and close a $10 BTC position and try a $5 rebalance each way.

## Setup

Needs Node 24.12 or later (it runs the TypeScript directly) and MongoDB running as a replica set (deposits are credited in transactions; one node is enough).

```bash
npm ci
npm run db:up                  # MongoDB 7 as a single-node replica set on localhost:27018, in Docker
cp .env.example .env           # then fill it in:
npm run mnemonic               #   a fresh DEPOSIT_MNEMONIC
                               #   PRIVY_APP_ID and PRIVY_APP_SECRET from the Privy dashboard
npm run dev                    # http://localhost:4500, restarting on changes
```

`npm start` runs it without the watcher. Without Docker, any replica set works: `mongod --replSet rs0 --port 27018 --dbpath <dir>`, then `mongosh --port 27018 --eval "rs.initiate()"` once.

The variables are documented in [.env.example](.env.example). The server checks them all at startup and names any that are missing or invalid.

**Deploying the one-account-per-person release:** stop every server instance first. At startup the new code merges each person's accounts into the oldest and deletes the rest. An instance still on the old code would keep a merged address mapped to a deleted account, and its deposit scan would wedge on it.

**`DEPOSIT_MNEMONIC` holds every deposit.** Whoever has it can move the funds, and losing it loses them. Generate it once, keep it in a secret manager, and back it up. Never change it while accounts exist: their deposit addresses come from it. Moving the keys to a KMS or HSM is the next step before this holds real money at scale.

## API

### HTTP

Everything under `/v1` takes `Authorization: Bearer <Privy access token>`. Errors are `{ "error": { "code", "message" } }`, with the codes listed in [src/protocol.ts](src/protocol.ts).

| Route                                     |                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                             | Liveness.                                                                                                                            |
| `GET /ready`                              | 200 once MongoDB answers and the deposit scan has run in the last minute; 503 otherwise. Reports how many blocks the scan is behind. |
| `GET /prices/history?range=&coins=`       | Public. The swap coins' dollar price history from DefiLlama; see [Price history](#price-history).                                    |
| `GET /markets/:eventId/history?outcomes=` | Public. One to five outcomes' chance over the market's life from Polymarket; see [Market history](#market-history).                  |
| `POST /v1/account`                        | Opens the signed-in person's account on first use and returns the account, its latest deposits and the deposit rules.                |
| `GET /v1/account`                         | The account.                                                                                                                         |
| `GET /v1/account/deposits?before=&limit=` | Deposits, newest first, up to 100 a page.                                                                                            |
| `POST /v1/account/deposits` `{ txHash }`  | Credits what a transaction sent to the account's deposit address.                                                                    |

### Price history

`GET /prices/history?range=7d` answers every swap coin's dollar price over the range, oldest first, as `[unix ms, USD]` pairs (`PriceHistoryView` in [src/protocol.ts](src/protocol.ts)). `coins=ETH,BTC` narrows it to those coins, in that order. It needs no token: the history is the same for everyone. The web app reads it from here and never calls DefiLlama itself.

| `range` | Points per coin      | Fresh for  |
| ------- | -------------------- | ---------- |
| `1d`    | 96, every 15 minutes | 5 minutes  |
| `7d`    | 168, hourly          | 15 minutes |
| `30d`   | 120, every 6 hours   | 1 hour     |
| `90d`   | 90, daily            | 3 hours    |
| `1y`    | 365, daily           | 6 hours    |

The last point is the latest price, so it isn't on a whole step. DefiLlama leaves the odd gap of a few hours, and those points are missing rather than filled.

Prices come from DefiLlama's free coins API, `https://coins.llama.fi`, which needs no key (its docs name `api.llama.fi`, which answers 404 for prices). It caps a chart at 500 points across all its coins, so a range is read in batches under the cap, three requests at a time: 3 to 11 requests a range. A background loop reads every range at startup and each again once 80% of its time in the table is up, so requests are answered from memory and never wait on DefiLlama. That's about 80 requests an hour, however many people ask. If DefiLlama fails, the last read is served (its `readAt` says how old it is) and DefiLlama isn't asked again for 30 s, or for longer when a 429 says so. A range never read is a 503 until it can be.

DefiLlama doesn't publish a firm free limit (its pricing page says 10 to 200 requests a minute), which this stays well under. With a Pro key, point `DEFILLAMA_COINS_URL` at `https://pro-api.llama.fi/<key>/coins`. The key is then part of the URL, so no error or log names the URL.

### Market history

`GET /markets/:eventId/history?outcomes=a,b` answers one to five outcomes' chance over the market's life, oldest first, as `[unix ms, chance 0 to 1]` pairs of at most 300 points (`MarketHistoryView` in [src/protocol.ts](src/protocol.ts)). `outcomes` holds distinct token ids, and they come back in the order asked. It needs no token, and a token the event doesn't offer is a 404. The web app reads it from here and never calls Polymarket itself.

The market's age picks the resolution, so a line holds about 250 points however old the market is:

| Age            | Polymarket query                | Points are about |
| -------------- | ------------------------------- | ---------------- |
| Under a day    | `interval=1d`, `fidelity=5`     | 5 minutes apart  |
| Under 30 days  | `interval=max`, age / 250 min   | 10 min or more   |
| Under 180 days | `interval=max`, `fidelity=720`  | 12 hours apart   |
| Older          | `interval=max`, `fidelity=1440` | a day apart      |

A market with no opening date is read at `interval=max`, `fidelity=60`. All the asked tokens go in one `batch-prices-history` call, and concurrent reads of the same token share a call. A token's line is fresh for 3 minutes. If Polymarket fails, a line read within the last 30 minutes is served (the view's `readAt` says how old it is); a token with nothing that recent is a 503. At most 1,000 tokens are kept, and Polymarket is given 8 seconds to answer.

### Socket.io

The handshake carries `auth: { token }`; a token that expires gets `session:expired` and a disconnect, and the client reconnects with a fresh one. Every event takes an acknowledgement and answers `{ ok: true, data } | { ok: false, error }`.

| Event                                          |                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account:open` `{}`                            | Binds the socket to the person's account (opening it) and answers like the HTTP route.                                                                          |
| `deposits:list` `{ before?, limit? }`          | A page of deposits.                                                                                                                                             |
| `deposit:submit` `{ txHash }`                  | Like the HTTP route.                                                                                                                                            |
| `deposit:credited` (server → client)           | `{ deposit, account }`, for each deposit as it's credited.                                                                                                      |
| `balances:refresh` `{}`                        | Reads the person's wallets again, silently: answers `{ read }`, and `read` is false within 30 s of the last read. A wallet not read yet is read at once.        |
| `balances` (server → client)                   | `{ readAt, rows }`: every supported coin in every linked wallet. Pushed after `account:open` and after each read, to every socket of the account.               |
| `deposit:quote` `{ coin, amount, wallet }`     | What the coin would pay in USDC on Arc, with no order opened. 30 a minute per user. The wallet must be linked to the person.                                    |
| `deposit:order` `{ coin, amount, wallet }`     | Opens a bridge order paying the account's Arc address and refunding the wallet; answers `{ order, txs }`, the transactions the wallet signs.                    |
| `deposit:source` `{ orderId, txHashes }`       | Reports the sent hashes: a created order becomes sent, and a repeat changes nothing.                                                                            |
| `deposit:progress` (server → client)           | `{ order }`, whenever an order of the account changes.                                                                                                          |
| `withdraw:limits` `{}`                         | `{ max, min }`: `max` is the smaller of the balance and what the treasury can pay now.                                                                          |
| `withdraw:create` `{ requestId, amount, to }`  | Takes `amount` off the balance and pays it to a linked EVM wallet; answers the withdrawal. A repeated `requestId` is the same withdrawal. 10 a minute per user. |
| `withdrawal:update` (server → client)          | `{ withdrawal }`, when a withdrawal is created and each time it changes: `sending`, then `sent` or `failed` (the balance is refunded).                          |
| `pnl:series` `{ tz }`                          | The balance by day, week or month for 7D, 30D and All, with the days cut in the zone `tz`. 30 a minute per user.                                                |
| `pnl:changed` (server → client)                | No payload: something that moves the series happened, so the client asks again.                                                                                 |
| `activity:list` `{ before?, limit?, filter? }` | A page of the whole history, newest first. 60 a minute per user.                                                                                                |

A failed network keeps its last values in `rows` (a coin never read has a null amount). Solana balances are read from `SOLANA_RPC_URLS` (the Ethereum and BNB Chain ones from `ETHEREUM_RPC_URLS` and `BNB_RPC_URLS`), so a production deployment should list a paid endpoint first: the public one rate-limits.

The types for both live in [src/protocol.ts](src/protocol.ts), which the web app imports as types only.

## Security

- Helmet's headers, with a `default-src 'none'` CSP for a JSON API.
- CORS and socket upgrades only from `CORS_ORIGINS`.
- Rate limits per IP: 300 requests a minute overall, 30 a minute to connect wallets or report deposits, and 120 socket handshakes a minute (`SOCKET_HANDSHAKES_PER_MINUTE`, since users behind one NAT share an IP). Per user: 40 socket events every 10 seconds, 20 reported deposits a minute. An account runs at most 3 deposit checks at once, since each one watches the chain until its transaction lands.
- Access tokens are verified with the dashboard's verification key when `PRIVY_VERIFICATION_KEY` is set, otherwise with Privy's cached key set. Privy being unreachable is a 503, not a sign-out.
- When Privy's API can't answer (it's down, or rejects `PRIVY_APP_SECRET`), opening an account and every request after it need no answer from Privy, since the access token is checked locally. The server checks its Privy credentials at startup, logs a rejected secret as an error, and `/ready` reports Privy's state (`privy`) without failing over it.
- JSON bodies and socket messages are capped at 16 KB, and inputs are validated with zod.
- Behind a proxy, set `TRUST_PROXY` to its hop count so the rate limits see real client IPs.
- Tokens and cookies are redacted from the logs, and unexpected errors reach clients as a generic `internal`.
- Rate limits and socket rooms live in memory, so one instance is the supported setup for now. Several instances can share the database (crediting stays exactly-once, and each instance picks up accounts the others open), but they'd also need a socket.io adapter (such as Redis) and a shared rate-limit store.

## Tests

```bash
npm test                 # unit and integration suites, about 35 s
npm run test:mainnet     # read-only checks against Arc Mainnet itself
npm run typecheck
```

The integration suites boot the real server against a throwaway MongoDB replica set (mongodb-memory-server, on the system `mongod` when there is one) and an [anvil](https://getfoundry.sh) chain with Arc's chain ID. In front of anvil sits `test/support/arc-emulator.ts`, a JSON-RPC proxy that adds Arc's `0xff…fe` transfer logs (worked out from call traces, so internal transfers count too) and can cap `eth_getLogs` the way Arc's public RPC does. A fake Privy API (`test/support/fake-privy.ts`) serves users and signs real ES256 access tokens, so the real `@privy-io/node` client runs end to end. Install Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`) or set `ANVIL_PATH`.

The mainnet suite reads real Arc transactions: native sends, ERC-20 transfers through `0x3600…` (credited once, not twice), and multi-hop contract transfers. It runs the scan over real blocks into a real database. One more test makes a real deposit and is skipped unless you fund it:

```bash
ARC_LIVE_PRIVATE_KEY=0x… ARC_LIVE_AMOUNT=0.02 npm run test:mainnet
```

It opens an account, deposits `ARC_LIVE_AMOUNT` USDC from that key on Arc Mainnet, and checks the credit and the push. Then it sends the funds back from the deposit address with the server's derived key, less gas, which proves the server controls the address.

`test/e2e/serve.ts` is the backend for the web app's Playwright suite (see the root README).

## Layout

- `src/index.ts`: the entry point: config, logging, graceful shutdown.
- `src/server.ts`: wires everything and starts listening; tests start it the same way.
- `src/http/app.ts` and `src/socket/sockets.ts`: the two APIs over the same services.
- `src/auth/identity.ts`: Privy token checks, and which wallets a user has linked.
- `src/accounts/`: accounts and deposit address derivation.
- `src/deposits/`: crediting (`ledger.ts`), the chain scan (`watcher.ts`, `registry.ts`), and reported deposits and history (`deposits.ts`).
- `src/crosschain/`: coins, quotes and bridge providers, balances on other chains, and deposit orders (`orders.ts`).
- `src/chain/`: Arc's chain definition and reading its transfer logs.
- `src/pnl/`: the PnL series and the paged activity history.
- `src/db/`: collections, indexes and money conversions.

Collections in the `TradeEverything` database: `accounts`, `deposits`, `ledger` (every balance change), `deposit_orders` (bridged deposits), `cursors` (how far the scan has got) and `counters`.
