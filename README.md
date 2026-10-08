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
- `components/connect-wallet.tsx`: the wallet button docked at the bottom, wrapped in `Magnet` (`components/magnet.tsx`). Privy is set up in `components/wallet-provider.tsx`.
- `components/icons.tsx`: sticker-style SVG icons for the pills

Tune the springs with the `spring`, `wobble` and `resize` transitions at the top of `components/hero-heading.tsx`.
