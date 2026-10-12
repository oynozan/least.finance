# Least Finance server

Gives every connected wallet an account of its own on the server, so trades and bets can run on the user's behalf without a signature or a transaction each time. This first part covers accounts and deposits: Express and socket.io over MongoDB, crediting real USDC deposits on Arc Mainnet (chain 5042).

## How deposits work

1. The web app signs in with Privy (wallet login, so Privy has already checked a SIWE signature). It sends the Privy access token over the socket handshake, or as `Authorization: Bearer` over HTTP. The server verifies the token locally; the token's user is the account's owner, so the app never asks for a signature of its own.
2. `account:open` opens the signed-in person's account on first use, one per Privy user however many wallets they link. Each account gets its own deposit address, derived from `DEPOSIT_MNEMONIC` at `m/44'/60'/0'/0/{index}`; only the index is stored. Index 0 is kept back for the operator.
3. The user sends USDC on Arc to that address. The client counts the deposit as soon as the wallet hands back the transaction hash, and reports it (`deposit:submit`); the server waits for the receipt and credits it, usually within a second or two.
4. A chain scan credits every deposit whether or not anyone reports it, such as one sent from an exchange. It reads the `Transfer` logs Arc's system address `0xff…fe` emits for every native USDC movement (EIP-7708): plain sends, value a contract forwards, and transfers through the ERC-20 view at `0x3600…` alike. The ERC-20 view's own `Transfer` log is ignored, so nothing is credited twice. Gas isn't logged. Arc's finality is instant. Still, each pass reads the head and the logs from one RPC and stays three blocks behind it (`DEPOSIT_SCAN_LAG_BLOCKS`), so a lagging node can't make it skip a block. It moves to the next RPC after a failure. A block busier than the RPC will return at once is read recipient by recipient.
5. Crediting is one MongoDB transaction: the deposit, the balance (`$inc`, plus a `version` for ordering on the client), and a ledger entry. A unique index on `(chain, tx hash, log index)` makes every repeat a no-op, so the report and the scan can race safely. Pushes go out on `deposit:credited` to every socket bound to the account.

Amounts keep all 18 of Arc's native decimals: Decimal128 wei in the database, decimal strings such as `"12.5"` on the wire. Transfers under `DEPOSIT_MIN_USDC` (0.01) aren't credited.

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
| `POST /v1/account`                        | Opens the signed-in person's account on first use and returns the account, its latest deposits and the deposit rules.                |
| `GET /v1/account`                         | The account.                                                                                                                         |
| `GET /v1/account/deposits?before=&limit=` | Deposits, newest first, up to 100 a page.                                                                                            |
| `POST /v1/account/deposits` `{ txHash }`  | Credits what a transaction sent to the account's deposit address.                                                                    |

### Socket.io

The handshake carries `auth: { token }`; a token that expires gets `session:expired` and a disconnect, and the client reconnects with a fresh one. Every event takes an acknowledgement and answers `{ ok: true, data } | { ok: false, error }`.

| Event                                 |                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account:open` `{}`                   | Binds the socket to the person's account (opening it) and answers like the HTTP route.                                                                   |
| `deposits:list` `{ before?, limit? }` | A page of deposits.                                                                                                                                      |
| `deposit:submit` `{ txHash }`         | Like the HTTP route.                                                                                                                                     |
| `deposit:credited` (server → client)  | `{ deposit, account }`, for each deposit as it's credited.                                                                                               |
| `balances:refresh` `{}`               | Reads the person's wallets again, silently: answers `{ read }`, and `read` is false within 30 s of the last read. A wallet not read yet is read at once. |
| `balances` (server → client)          | `{ readAt, rows }`: every supported coin in every linked wallet. Pushed after `account:open` and after each read, to every socket of the account.        |

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
- `src/chain/`: Arc's chain definition and reading its transfer logs.
- `src/db/`: collections, indexes and money conversions.

Collections in the `TradeEverything` database: `accounts`, `deposits`, `ledger` (every balance change), `cursors` (how far the scan has got) and `counters`.
