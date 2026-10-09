# Trade Everything

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

## Where things live

- `app/page.tsx`: page shell (centered layout)
- `components/hero-heading.tsx`: the heading and its click-to-cycle pills (client component, [Motion](https://motion.dev) springs). Edit `VISUALS`, `CUSTOMIZABLES` and `TOOLS` to change the mock options.
- `components/connect-wallet.tsx`: the wallet button docked at the bottom, wrapped in `Magnet` (`components/magnet.tsx`). Before sign-in it opens Privy's login; after, it toggles the wallet sidebar. Privy is set up in `components/wallet-provider.tsx`, and `app/privy.css` restyles its modal to match the app.
- `components/sidebar.tsx`: the right-hand sidebar shell. Opening it pushes the page left on a spring (on phones the sidebar covers the screen and the page slides out).
- `components/arc.ts`: Arc Mainnet (chain ID 5042), where accounts are credited, and the USDC balance read over its public RPC. Wallets connect on any network and are switched to Arc only when they deposit (`ensureNetwork` in `lib/wallet/network.ts`, which also checks the network again right before sending). `components/arc-wallet.ts` holds the hooks: the polled USDC balance, and the network the wallet is on, whose logo the sidebar header shows (`components/network-icons.tsx`).
- `components/wallet-sidebar.tsx`: the sidebar's content: balance, deposit button, deposit history (revealed on hover) and open positions (`components/position-row.tsx`), stacked bottom-up. The balance is the account's USDC on the deposit server, deposits still on their way included. Positions are still mock data in `components/wallet-data.ts`.
- `components/deposit-form.tsx`: the amount entry the deposit button opens. It sends USDC from the wallet to the account's deposit address; the wallet's own balance (`useUsdcBalance`) sets the Max.
- `components/account-provider.tsx` and `components/account-client.ts`: the account over a socket to the deposit server, signed in with the Privy access token. Deposits are optimistic: one counts as soon as the wallet sends it, and comes back out if the server can't confirm it. The state itself is a pure reducer in `lib/account/state.ts`. Its USDC also feeds the trade sentence's spendable balance.
- `components/icons.tsx`: sticker-style SVG icons for the pills

## Tests

`npm run test:e2e` builds the app and runs the Playwright suite on Chrome, against the real deposit server: Playwright starts it with `server/test/e2e/serve.ts`, on a throwaway database, a local chain that behaves like Arc ([anvil](https://getfoundry.sh) behind an emulator of Arc's transfer logs) and a stand-in for Privy's API. Privy's web SDK, Arc's RPC and a MetaMask-like wallet are mocked in the browser (`e2e/privy-mock.ts`); the wallet's transactions really land on the local chain. It needs `npm ci` in `server/`, Foundry's `anvil`, and a `mongod` binary (or one mongodb-memory-server can download). Ports default to 3100 (app), 4100 (server) and 4101 (test control); set `E2E_PORT`, `E2E_API_PORT` and `E2E_CONTROL_PORT` to move them. Set `PLAYWRIGHT_CHROMIUM_PATH` to run on a Chromium binary instead of installed Chrome.

`npm run test:logic` runs the browserless logic tests (the trade sentence and the account reducer). The deposit server has its own suites; see [server/README.md](server/README.md).

Format with `npm run format` (Prettier, 4-space indentation).

Tune the springs with the `spring`, `wobble` and `resize` transitions at the top of `components/hero-heading.tsx`.
