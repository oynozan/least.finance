# Hero heading

A Next.js 16 landing hero: a centered heading with spring-animated pill buttons that cycle through mock options on click.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Where things live

- `app/page.tsx`: page shell (centered layout)
- `components/hero-heading.tsx`: the heading and its click-to-cycle pills (client component, [Motion](https://motion.dev) springs). Edit `VISUALS`, `CUSTOMIZABLES` and `TOOLS` to change the mock options.
- `components/icons.tsx`: sticker-style SVG icons for the pills

Tune the springs with the `spring`, `wobble` and `resize` transitions at the top of `components/hero-heading.tsx`.
