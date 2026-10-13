# Least Finance

[least.finance](https://least.finance)

Trade with one sentence on Arc Mainnet. A Next.js 16 web app, and a deposit server (`server/`) that gives every connected wallet an account of its own, so trades can run without a signature each time.

## Getting started

```bash
npm install
cp .env.example .env.local   # then add your Privy app ID
npm run dev
```

The wallet button needs `NEXT_PUBLIC_PRIVY_APP_ID` (from the [Privy dashboard](https://dashboard.privy.io)); without it the button renders disabled. Also enable Solana wallets (Solana login) for the app in the Privy dashboard, or signing in with a Solana wallet fails.

Balances and deposits come from the deposit server. Set it up as [server/README.md](server/README.md) describes, then run it beside the app (`npm run dev` in `server/`). The app finds it at `NEXT_PUBLIC_API_URL`, `http://localhost:4500` by default.

Open [http://localhost:3000](http://localhost:3000).

To run it on a server (Docker Compose behind Caddy, with backups), follow the [deployment runbook](deploy/README.md).

## Prediction trading

Predictions are simulated until you turn real trading on. To send real orders to Polymarket from the pool's wallet, set up the server (`server/`) in this order:

1. Create a builder profile on [polymarket.com](https://polymarket.com) and generate its API key, secret and passphrase (Settings, Builders). Put them in `server/.env` as `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_API_SECRET` and `POLYMARKET_BUILDER_API_PASSPHRASE`. `POLYMARKET_BUILDER_CODE` is optional and only attributes orders to you.
2. Make a fresh private key for the pool (`0x` and 64 hex characters), used for nothing else, and set it as `POLYMARKET_POOL_KEY`. Whoever holds it controls the pool's funds.
3. From `server/`, run `node --env-file=.env scripts/polymarket-setup.ts`. It deploys the pool's Polymarket deposit wallet, approves Polymarket's contracts and prints the wallet's address. Running it again is safe.
4. Fund that address with pUSD, either through Polymarket's bridge deposit or by wrapping USDC.e into pUSD with the Collateral Onramp. The Onramp takes USDC.e (bridged), not native USDC, so swap native USDC first. Set `POLYMARKET_FLOAT_USD` to the balance you mean to keep.
5. Host the server outside Polymarket's restricted regions, and let it call Polymarket directly. Do not route its traffic through proxies to appear to be elsewhere.
6. Run the live check from `server/`: `node --env-file=.env scripts/polymarket-live-check.ts --yes-spend-real-money`. It buys and sells about $1 on the most liquid trending question, and prints PASS or FAIL for each assumption that could not be confirmed offline: the CLOB order ID equals the computed order hash, the units of the post amounts, the sell fee being netted, and the words an order lookup answers with. Do not go on if any line fails.
7. Set `PREDICTIONS_TRADING=on` and restart the server.
8. Set `TRUST_PROXY` to the number of reverse proxies in front of the server (0 when it is exposed directly), so per-IP limits see the real client.

After launch, watch the logs for "The pool's Polymarket float is low" and "is high" warnings (top up or withdraw), and for the errors "The pool's holdings don't match the positions" and "Prediction reconciliation failed" (the ledger and the pool disagree; look into them before anything else).

A location check on users is still a launch blocker. Polymarket asks apps that place orders to geoblock their users, and the pooled account has none, so keep real trading to a private demo until one exists (see "Not included" in the [design](docs/superpowers/specs/2026-10-12-polymarket-predictions-design.md)).

## Swaps

Buy, Sell and Swap run as real swaps from the person's own wallet, quoted and routed by [LI.FI](https://li.quest) on nine networks. Set up the server (`server/`) in this order:

1. Get an API key from the [LI.FI Partner Portal](https://portal.li.fi) and set it as `LIFI_API_KEY` in `server/.env`. Set `LIFI_INTEGRATOR` to the integrator id registered there (letters, digits, dots, dashes and underscores, up to 23 characters).
2. To earn a fee, make a fee wallet (`LIFI_FEE_MNEMONIC`, kept apart from the deposit mnemonic), register its addresses with LI.FI in the portal, and set `LIFI_FEE` (a share below 0.1). Leave it at 0 for none.
3. Accept LI.FI's terms of service in the portal for the integrator before launch.
4. Set the RPC URLs for the networks swaps read holdings and allowances from (`ETHEREUM_RPC_URLS`, `ARBITRUM_RPC_URLS`, `BASE_RPC_URLS`, `OPTIMISM_RPC_URLS`, `POLYGON_RPC_URLS`, `BNB_RPC_URLS`, `AVALANCHE_RPC_URLS`, `ARC_RPC_URLS`, `SOLANA_RPC_URLS`). The defaults are public and rate limited; use paid endpoints in production.
5. From `server/`, run the read-only live check: `node --env-file=.env scripts/swaps-live-check.ts`. It quotes about $10 of every coin on every network it is listed on, holds each quote to the server's checks, and prints a line per coin and a summary. It exits 1 if any fails; do not go on if it does.
6. Optionally prove one real swap end to end: fund a throwaway wallet with a few dollars of USDC and a little ETH for gas on Base, put its key in `SWAP_CHECK_KEY` (never the key of a wallet that holds anything else), and run `node --env-file=.env scripts/swaps-live-check.ts --yes-spend-real-money`. It swaps $2 of USDC to USDT, sends the approval and the swap, waits for LI.FI to report DONE and prints the transaction hashes.

Sanctions screening of users is a launch blocker. LI.FI asks integrators to screen wallets and the app has no screening yet, so keep swaps to a private demo until one exists (see the [design](docs/superpowers/specs/2026-10-12-multichain-swaps-design.md)).

## Where things live

- `app/page.tsx`: page shell (centered layout)
- `components/hero-heading.tsx`: the heading and its click-to-cycle pills (client component, [Motion](https://motion.dev) springs). Edit `VISUALS`, `CUSTOMIZABLES` and `TOOLS` to change the mock options.
- `components/connect-wallet.tsx`: the wallet button docked at the bottom, wrapped in `Magnet` (`components/magnet.tsx`). Before sign-in it opens Privy's login; after, it toggles the wallet sidebar. Privy is set up in `components/wallet-provider.tsx`, and `app/privy.css` restyles its modal to match the app.
- `components/sidebar.tsx`: the right-hand sidebar shell. Opening it pushes the page left on a spring (on phones the sidebar covers the screen and the page slides out).
- `components/arc.ts`: Arc Mainnet (chain ID 5042), where accounts are credited, and the USDC balance read over its public RPC. Wallets connect on any network and are switched to Arc only when they deposit (`ensureNetwork` in `lib/wallet/network.ts`, which also checks the network again right before sending). `components/arc-wallet.ts` holds the hooks: the polled USDC balance, and the network the wallet is on, whose logo the sidebar header shows (`components/network-icons.tsx`).
- `components/wallet-sidebar.tsx`: the sidebar's content: balance, deposit button, deposit history (revealed on hover) and open positions (`components/position-row.tsx`), stacked bottom-up. The balance is the account's USDC on the deposit server, deposits still on their way included. Open positions are the account's live predictions, plus bets still waiting for their fill (`components/wallet-data.ts` shapes them).
- `components/deposit-form.tsx`: the amount entry the deposit button opens. It sends USDC from the wallet to the account's deposit address; the wallet's own balance (`useUsdcBalance`) sets the Max.
- `components/account-provider.tsx` and `components/account-client.ts`: the account over a socket to the deposit server, signed in with the Privy access token. Deposits are optimistic: one counts as soon as the wallet sends it, and comes back out if the server can't confirm it. The state itself is a pure reducer in `lib/account/state.ts`. Its USDC also feeds the trade sentence's spendable balance.
- `components/icons.tsx`: sticker-style SVG icons for the pills

## Tests

`npm run test:e2e` builds the app and runs the Playwright suite on Chrome, against the real deposit server: Playwright starts it with `server/test/e2e/serve.ts`, on a throwaway database, a local chain that behaves like Arc ([anvil](https://getfoundry.sh) behind an emulator of Arc's transfer logs) and a stand-in for Privy's API. Privy's web SDK, Arc's RPC and a MetaMask-like wallet are mocked in the browser (`e2e/privy-mock.ts`); the wallet's transactions really land on the local chain. It needs `npm ci` in `server/`, Foundry's `anvil`, and a `mongod` binary (or one mongodb-memory-server can download). Ports default to 3100 (app), 4100 (server) and 4101 (test control); set `E2E_PORT`, `E2E_API_PORT` and `E2E_CONTROL_PORT` to move them. Set `PLAYWRIGHT_CHROMIUM_PATH` to run on a Chromium binary instead of installed Chrome.

`npm run test:logic` runs the browserless logic tests (the trade sentence and the account reducer). The deposit server has its own suites; see [server/README.md](server/README.md).

Format with `npm run format` (Prettier, 4-space indentation).

Tune the springs with the `spring`, `wobble` and `resize` transitions at the top of `components/hero-heading.tsx`.
