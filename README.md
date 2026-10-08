# Hero heading

A Next.js 16 landing hero: a centered heading with spring-animated pill buttons that cycle through mock options on click.

## Getting started

```bash
npm install
cp .env.example .env.local   # then add your Privy app ID
npm run dev
```

The wallet button needs `NEXT_PUBLIC_PRIVY_APP_ID` (from the [Privy dashboard](https://dashboard.privy.io)); without it the button renders disabled.

Open [http://localhost:3000](http://localhost:3000).

## Where things live

- `app/page.tsx`: page shell (centered layout)
- `components/hero-heading.tsx`: the heading and its click-to-cycle pills (client component, [Motion](https://motion.dev) springs). Edit `VISUALS`, `CUSTOMIZABLES` and `TOOLS` to change the mock options.
- `components/connect-wallet.tsx`: the wallet button docked at the bottom, wrapped in `Magnet` (`components/magnet.tsx`). Before sign-in it opens Privy's login; after, it toggles the wallet sidebar. Privy is set up in `components/wallet-provider.tsx`, and `app/privy.css` restyles its modal to match the app.
- `components/sidebar.tsx`: the right-hand sidebar shell. Opening it pushes the page left on a spring (on phones the sidebar covers the screen and the page slides out).
- `components/arc.ts`: Arc Mainnet (chain ID 5042), the app's only chain, and the USDC balance read over its public RPC. Privy defaults wallets to Arc and asks them to switch on connect. `components/arc-wallet.ts` holds the hooks: the polled USDC balance, and whether the wallet has drifted to another network.
- `components/wallet-sidebar.tsx`: the sidebar's content: balance, deposit button, deposit history (revealed on hover) and open positions (`components/position-row.tsx`), stacked bottom-up. The balance is the wallet's USDC on Arc. While the wallet is on another network, the deposit button becomes "Switch to Arc". Deposits and positions are mock data in `components/wallet-data.ts`.
- `components/icons.tsx`: sticker-style SVG icons for the pills

## Tests

`npm run test:e2e` builds the app and runs the Playwright suite on Chrome. Privy's backend, Arc's RPC and a MetaMask-like wallet are mocked (`e2e/privy-mock.ts`), so the wallet flow runs offline with a placeholder app ID. Set `PLAYWRIGHT_CHROMIUM_PATH` to run on a Chromium binary instead of installed Chrome.

Tune the springs with the `spring`, `wobble` and `resize` transitions at the top of `components/hero-heading.tsx`.
