# Polymarket Live Markets Implementation Plan (phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Predict sentence's question picker offers real Polymarket markets: trending at once (from a cached copy), the rest through search, with live odds. Review stays simulated.

**Architecture:**
- **Server.**
    - A `MarketService` syncs the top events from Polymarket's Gamma API every minute.
    - It shapes each event into a question with outcomes, using four rules, and serves three public HTTP routes.
    - Prices for a requested question come from the CLOB's order books, cached for 5 seconds.
- **Client.**
    - A markets store fetches the routes and caches trending in `localStorage`.
    - It feeds the sentence's catalog, so the engine stays synchronous and never learns about Polymarket.
    - The picker gains a generic search field.

**Tech Stack:** Node 24 + Express 5 + zod (server), vitest, Next.js 16 + React 19 (client), `next/image`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-polymarket-predictions-design.md`, section 1 and the phase 1 parts of Testing. Phases 2 (orders) and 3 (positions and payouts) get their own plans.

## Global Constraints

- **Commits:**
    - Commit by path (`git commit -- <paths>`), with no `Co-Authored-By` trailer.
    - Never `git add -A`, stash, or reset files you didn't write.
    - Don't touch `server/src/crosschain/*` (owned by the `tradeeverything-bb` session).
- **Running tests:**
    - Server tests: `cd server && npm test`.
    - Browser tests: run from an isolated copy (`git archive HEAD | tar -x -C <dir>`, then `cp -cR node_modules`), on `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641`. Other sessions share port 3100 and `.next`.
- **Next.js 16 differs from your training data.** Read `node_modules/next/dist/docs/01-app/01-getting-started/12-images.md` before using `next/image` or editing `next.config.ts`.
- **Polymarket endpoints, exactly:**
    - Top events: `GET {gamma}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100`
    - Search: `GET {gamma}/public-search?q={q}&events_status=active&limit_per_type=20`
    - One event: `GET {gamma}/events/{id}`
    - Order books: `POST {clob}/books` with the body `[{"token_id": "…"}]`. It answers with an array of `{ asset_id, bids: [{price, size}], asks: [{price, size}], min_order_size, tick_size }`. Match books to tokens by `asset_id`, never by position.
    - Defaults: `gamma` = `https://gamma-api.polymarket.com`, `clob` = `https://clob.polymarket.com`.
    - In Gamma, `outcomes`, `outcomePrices` and `clobTokenIds` are JSON-encoded strings. A market's `bestBid` and `bestAsk` are for its first outcome's token.
- **Numbers from the spec:**

  | What                         | Value                                                                  |
  | ---------------------------- | ---------------------------------------------------------------------- |
  | Sync                         | every 60 000 ms, top 100 events, trending = first 50 that shape        |
  | Spread                       | at most 0.10                                                           |
  | Offered outcome's buy price  | from 0.01 to 0.99                                                      |
  | Market close                 | more than 1 hour from now                                              |
  | Search                       | 2+ characters, 250 ms debounce, 20 results, 60 s cache per query       |
  | Price cache per event        | 5 s                                                                    |
  | Requested events re-read     | if requested in the last 10 minutes                                    |
  | Client refresh               | trending every 60 s, the watched question every 10 s, only while the page is visible; every 2 s until the server has a list |
  | Short title                  | 24 characters                                                          |
  | `minUSD`                     | `max(1, ceil(orderMinSize × buyPrice × 100) / 100)`                    |
  | Route rate limits per IP     | trending 120/min, search 60/min, event 120/min                         |

- **Copy, verbatim:**
    - The search field's placeholder and label: "Search markets".
    - An empty list: "No markets to show right now."
    - A query with no matches: `No markets match “{query}”.`, with the trending list under it.
    - A missing outcome: message "Pick an outcome for this question.", button "Pick an outcome".
- **No loading text or spinner anywhere in the picker.** A pending search shows the trending list under the field.
- **Demo mode** (no `NEXT_PUBLIC_PRIVY_APP_ID`) keeps today's mock markets. Review stays simulated for every verb.

## Review Focus

1. **Polymarket is down on someone's first visit, with nothing cached.** The picker shows "No markets to show right now." The sentence asks for a question; nothing crashes. Test in Task 4.
2. **The picked question stops being offered** (it closed or turned thin). Its refresh answers 404, and the pill falls back to "Pick a question." without an error. Test in Task 4.
3. **A slow search answers after a newer one.** Only the latest query's results show. Test in Task 5.
4. **A corrupt or old-shaped cache** in `localStorage`. It's ignored, and the fresh list loads. Test in Task 4.
5. **One malformed event or market from Gamma** (bad JSON in `clobTokenIds`, a missing `bestBid`). Only that market is skipped, never the whole sync. Test in Task 1.

---

### Task 1: Shape Polymarket events into questions

**Files:**
- Create:
    - `server/src/markets/gamma.ts`: zod schemas for the Gamma fields we read
    - `server/src/markets/shape.ts`
    - `server/scripts/record-polymarket-fixtures.ts`
    - `server/test/fixtures/polymarket/events.json` (recorded)
- Modify: `server/src/protocol.ts`, for the view types
- Test: `server/test/unit/markets-shape.test.ts`

**Interfaces:**
- Produces, in `server/src/protocol.ts` (type-only, shared with the client):
  ```ts
  export type MarketOutcomeView = {
      tokenId: string; label: string; buyPrice: number; chance: number;
      tone: "gain" | "loss" | "neutral"; minUSD: number; image: string | null;
  };
  export type MarketView = {
      id: string; title: string; image: string | null; endDate: string;
      volume24hUSD: number; outcomes: MarketOutcomeView[];
  };
  export type TrendingView = { markets: MarketView[]; maxOrderUSD: number | null; readAt: string | null };
  export type MarketSearchView = { query: string; markets: MarketView[] };
  ```
- Produces, in `server/src/markets/gamma.ts`:
    - `gammaEvent`, a zod schema that keeps every event-level field `shapeEvent` reads, and parses `markets` leniently. A market that fails its schema becomes `null` and is skipped, never failing the event.
    - `type GammaEvent` and `type GammaMarket`, with `outcomes: string[]`, `outcomePrices: number[]` and `clobTokenIds: string[]` already decoded from their JSON strings.
- Produces, in `server/src/markets/shape.ts`: `shapeEvent(event: GammaEvent, now: Date): MarketView | null`.
- Produces the fixture file `{ recordedAt: string; top: unknown[]; extra: unknown[]; samples: { yesNo: string; named: string; multi: string; sports: string; skipped: string; extra: string } }`:
    - `top` is the raw top-100 answer.
    - `extra` holds events found by search that aren't in `top`.
    - `samples` are event IDs that the recorder checked shape under each rule. `skipped` shapes to `null`.
    - Each event is trimmed to the schema's fields, and to at most 12 markets: every offered one, the `moneyline` one, then others.

- [ ] **Step 1: Record the fixtures.** Write the recorder:
    - It reads the top 100.
    - It searches "aliens", "kraken", "fed" and "senate", and keeps the first shaped event that isn't in the top 100 as `extra`.
    - It picks one sample event per rule, plus a skipped one.
    - It writes `events.json`.
  Run it: `cd server && node scripts/record-polymarket-fixtures.ts`. Expected: it prints one event ID per sample, and the file is under 1 MB.
- [ ] **Step 2: Write the failing tests** in `markets-shape.test.ts`, with `now = new Date(fixtures.recordedAt)`:
  ```ts
  test("a single YES/NO market keeps YES and NO, YES in the gain tone", () => {
      const view = shapeEvent(event(samples.yesNo), now)!;
      expect(view.outcomes.map((o) => [o.label, o.tone])).toEqual([["YES", "gain"], ["NO", "loss"]]);
  });
  test("a single named market keeps its own labels, neutral", ...);           // samples.named; tones are both "neutral"
  test("several YES/NO markets become one outcome each, by chance", ...);     // samples.multi: labels are the groupItemTitles, sorted by chance descending, each tokenId is that market's first token
  test("a sports event keeps only its moneyline market", ...);                 // samples.sports: exactly 2 outcomes, both from the moneyline market's tokens
  test("an event no rule fits is left out", ...);                              // samples.skipped → null
  test("prices: YES buys at the ask, NO at 1 − bid, chance is the midpoint", ...);  // bid 0.83, ask 0.84 → YES 0.84 / 0.835; NO 0.17 / 0.165 (to 4 decimals)
  test("a market with a spread over 10¢, or closing within the hour, isn't offered", ...);
  test("an outcome priced under 1¢ or over 99¢ isn't offered", ...);
  test("minUSD is the minimum size times the price, rounded up to the cent, at least $1", ...);  // orderMinSize 5 × 0.84 → 4.2; 5 × 0.1 → 1
  test("a market with malformed clobTokenIds or no bestBid is skipped, the event still shapes", ...);
  ```
  Build the edge cases by copying a sample event and editing one field.
- [ ] **Step 3: Run the tests and confirm they fail.** Run: `cd server && npx vitest run test/unit/markets-shape.test.ts`. Expected: FAIL, "Cannot find module '../../src/markets/shape.ts'".
- [ ] **Step 4: Implement `shapeEvent`.** Follow the spec's "Shaping an event into a question" rules 1–4, in order:
    - Labels: "Yes" becomes "YES" and "No" becomes "NO"; other labels stay as they are.
    - Rule 2's outcome `image` is the market's `image`. Every other outcome's `image` is `null`.
    - `MarketView.image` is the event's `image`, else its `icon`, else `null`.
    - `endDate` is the event's `endDate`, and `volume24hUSD` is `volume24hr`, else 0.
    - Prices are rounded to 4 decimals.
- [ ] **Step 5: Run the tests and confirm they pass.** Then run `npx tsc --noEmit -p server`. Expected: all pass.
- [ ] **Step 6: Commit** the files above, with the message "Shape Polymarket events into questions".

### Task 2: The market service, against a fake Polymarket

**Files:**
- Create:
    - `server/src/markets/polymarket-data.ts`
    - `server/src/markets/markets.ts`
    - `server/test/support/fake-polymarket.ts`
- Test: `server/test/integration/markets.test.ts`

**Interfaces:**
- Consumes `shapeEvent` and `gammaEvent` (Task 1).
- Produces, in `polymarket-data.ts`:
  ```ts
  export type Book = { bestBid: number | null; bestAsk: number | null; minOrderSize: number | null };
  export interface PolymarketData {
      topEvents(): Promise<GammaEvent[]>;
      search(query: string): Promise<GammaEvent[]>;
      event(id: string): Promise<GammaEvent | null>;   // null on 404
      books(tokenIds: string[]): Promise<Map<string, Book>>;
  }
  export function createPolymarketData(options: { gammaUrl: string; clobUrl: string; fetch?: typeof fetch }): PolymarketData;
  ```
  Requests time out after 5 s (`AbortSignal.timeout`). Any status other than 200 or 404 throws `Error("Polymarket answered <status> to <path>")`. This follows the shape of `crosschain/providers/relay.ts`.
- Produces, in `markets.ts`, a class with this shape:
  ```ts
  export class MarketService {
      constructor(deps: { data: PolymarketData; logger: Logger; syncMs: number; now?: () => number });
      start(): void; stop(): Promise<void>; tick(): Promise<void>;
      trending(): TrendingView;                        // maxOrderUSD is null in this phase
      search(query: string): Promise<MarketSearchView>;
      event(id: string): Promise<MarketView | null>;
  }
  ```
  `start`, `stop` and the loop follow `crosschain/tracker.ts`.
- Produces, in `fake-polymarket.ts`: `startFakePolymarket(options?: { now?: () => number }): Promise<FakePolymarket>`, where:
  ```ts
  type FakePolymarket = {
      url: string; fixtures: Fixtures; requests: string[];
      setBook(tokenId: string, book: { bid: number | null; ask: number | null }): void;
      hide(eventId: string): void;    // gone from top, search and /events/:id (404)
      failNext(path: "/events" | "/public-search" | "/books"): void;  // answers 500 once
      stop(): Promise<void>;
  };
  ```
  It serves the four endpoints from the fixtures. Search is a case-insensitive title match over `top` and `extra`. Books come from each market's `bestBid`, `bestAsk` and `orderMinSize`, unless `setBook` overrode them. It shifts every `endDate` (event and market) by `now − recordedAt`, so the fixtures never go stale.

- [ ] **Step 1: Write the failing tests** in `markets.test.ts`, with a `MarketService` over `createPolymarketData` pointed at the fake:
    - `"trending is the first 50 events that shape, in volume order"`: after `tick()`, `trending().markets` has at most 50 entries, starts with the first shaped event of `top`, and `readAt` is set.
    - `"before the first sync, trending is empty with readAt null"`
    - `"a failed sync keeps the last list"`: `tick()`, then `failNext("/events")` and `tick()` again. The list is unchanged, and a warning is logged.
    - `"search shapes the results and caches each query for 60 s"`: `search("  Fed ")` and `search("fed")` make one Gamma request (count `requests`). After `now` moves 61 s, the next search makes another.
    - `"a one-character query asks Polymarket nothing"`: `search("f")` returns `{ query: "f", markets: [] }` with no request.
    - `"event prices come from the books, cached for 5 s"`: `setBook` changes the ask. `event(id)` within 5 s still returns the old price; after 5 s it returns the new one.
    - `"an event that's gone, or no longer shapes, is null"`: `hide(id)` gives `null`, and so does `setBook(<samples.yesNo's first token>, { bid: 0.2, ask: 0.5 })` on `samples.yesNo`, which makes its only market's spread too wide.
    - `"a requested event is re-read by the sync for 10 minutes"`: an `extra` event read through `event()` is fetched again by `tick()` until `now` is 10 minutes past the request.
    - `"concurrent event() calls share one books request"`
- [ ] **Step 2: Run them and confirm they fail.** Run: `cd server && npx vitest run test/integration/markets.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `createPolymarketData`, `MarketService` and the fake.** For each event, `MarketService` keeps the last raw event, read within 60 s, and its book prices, read within 5 s. `event()` patches the books into the raw event's markets, then shapes it.
- [ ] **Step 4: Run them and confirm they pass,** then the whole server suite (`cd server && npm test`). Expected: all pass.
- [ ] **Step 5: Commit**, with the message "Sync Polymarket's markets and serve them shaped".

### Task 3: Public market routes, wired into the server

**Files:**
- Modify:
    - `server/src/config.ts`: `POLYMARKET_GAMMA_URL`, `POLYMARKET_CLOB_URL` and `MARKETS_SYNC_MS`, with the defaults from Global Constraints and `MARKETS_SYNC_MS` defaulting to `60000`
    - `server/.env.example`
    - `server/src/services.ts` and `server/src/server.ts`: construct `markets`, `start()` it after listening, and `stop()` it in `close()`
    - `server/src/http/app.ts`: the three routes, before the `/v1` router, with no token
    - `server/test/support/stack.ts` and `server/test/e2e/serve.ts`: start `startFakePolymarket()`, point both URLs at it, and await `services.markets.tick()` once before reporting ready
- Test: `server/test/integration/markets-routes.test.ts`, and `server/test/unit/config.test.ts` for the defaults

**Interfaces:**
- Consumes `MarketService` (Task 2).
- Produces the routes:
    - `GET /markets/trending` → `TrendingView`
    - `GET /markets/search?q=` → `MarketSearchView`. It's validated with zod: `q` is a string of at most 100 characters, and anything else is a `bad_request`.
    - `GET /markets/:eventId` → `MarketView`, or a 404 with `not_found`. `eventId` matches `/^\d{1,12}$/`; anything else is a `bad_request`.
    - Each answer sends `Cache-Control: no-store`.
- Produces `Services.markets: MarketService`.

- [ ] **Step 1: Write the failing tests:**
    - `"GET /markets/trending answers without a token"`: 200, and `markets.length > 0` after the stack's first tick.
    - `"GET /markets/search?q=fed returns shaped events"`
    - `"GET /markets/:eventId is 404 for a hidden event and 400 for a non-numeric id"`
    - `"the search route is rate-limited at 60 a minute per IP"`: the 61st request answers 429 with `rate_limited`.
    - In `config.test.ts`: `"Polymarket URLs and the sync interval have defaults"`.
- [ ] **Step 2: Run them and confirm they fail.** Expected: 404s for the routes, and an undefined config key.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** the server suite and `npx tsc --noEmit -p server`. Then, from the isolated copy, run `E2E_API_PORT=4640 E2E_CONTROL_PORT=4641 node server/test/e2e/serve.ts` and check `curl -s localhost:4640/markets/trending | head -c 200`. Expected: all pass, and the curl prints shaped markets.
- [ ] **Step 5: Commit**, with the message "Serve Polymarket markets on public routes".

### Task 4: Live markets in the sentence

**Files:**
- Create:
    - `lib/api.ts`: `export const API_URL`, moved from `components/account-provider.tsx`, which imports it
    - `lib/trade/markets.ts`
    - `components/trade/markets-store.ts`
    - `components/trade/market-image.tsx`
- Modify:
    - `lib/trade/catalog.ts`:
        - `Outcome` gains `chance: number`, `minUSD: number` and `image?: string`, and its `tone` gains `"neutral"`.
        - `PredictionMarket` gains `image?: string`.
        - `Catalog` gains `findMarket(id: string): PredictionMarket | undefined`.
        - The mock outcomes get `chance` equal to `price` and `minUSD: 1`.
    - `lib/trade/operations/prediction.ts`
    - `components/trade/use-trade-sentence.ts` and `components/trade/trade-provider.tsx`
    - `components/trade/trade-icons.tsx`: the `image` set
    - `next.config.ts`: `images.remotePatterns` for `https://polymarket-upload.s3.us-east-2.amazonaws.com/**`
    - `e2e/sentence.spec.ts`: lines 138–140, 330–334 and 484–487 assert mock questions; they now read the question from the fake's fixtures (`e2e/polymarket.ts`)
- Create, for tests:
    - `e2e/polymarket.ts`: loads the fixtures and reads a sample's shaped view from `GET {API}/markets/{id}`
    - `e2e/markets.spec.ts`
- Test:
    - `e2e/trade.logic.spec.ts` (prediction cases)
    - `e2e/markets.logic.spec.ts`
    - `e2e/markets.spec.ts`

**Interfaces:**
- Consumes `MarketView`, `TrendingView` and `MarketSearchView` from `@/server/src/protocol`, and the routes (Task 3).
- Produces, in `lib/trade/markets.ts`:
    - `toPredictionMarket(view: MarketView, now: Date): PredictionMarket`:
        - `id` comes from `view.id`, `question` from the title, and `image` from `view.image ?? undefined`.
        - `short` is the title cut to 24 characters at a word boundary, plus "…". A first word longer than 24 is cut mid-word.
        - `closes` is "Oct 29", or "Nov 8, 2028" in another year.
        - `symbol` is `""`.
        - Each outcome is `{ id: tokenId, label, price: buyPrice, chance, tone, minUSD, image: image ?? undefined }`.
    - `loadCachedTrending(): TrendingView | null` and `saveCachedTrending(view)`, under the key `markets:trending`. They're wrapped in try/catch, and the load checks the shape (`markets` an array, `readAt` a string).
- Produces, in `components/trade/markets-store.ts`:
  ```ts
  export type MarketsSnapshot = { trending: MarketView[]; readAt: string | null; query: string; results: MarketView[] | null; known: ReadonlyMap<string, MarketView> };
  export function createMarketsStore(options: { apiUrl: string; fetch?: typeof fetch; now?: () => number }): {
      subscribe(listener: () => void): () => void; getSnapshot(): MarketsSnapshot;
      start(): void; stop(): void; search(query: string): void; watch(eventId: string | null): void;
  };
  ```
  Task 5 implements `search`. In this task it only sets `query`.
    - `start()` shows the cached trending list at once, fetches the fresh one, and then refreshes it on the intervals in Global Constraints.
    - `watch(id)` refreshes that question every 10 s. A 404 drops it from `known` and from `trending`.
    - Every view the store receives also goes into `known`.
- Produces, in the prediction operation, with `pct = (fraction: number) => Math.round(fraction * 100)`:
    - The question choices are `ctx.catalog.markets`, plus the selected market (through `findMarket`) when it isn't listed.
    - Detail strings:
        - A question: `` `${pct(top.chance)}% ${top.label} · ends ${closes}` ``, where `top` is the outcome with the highest chance.
        - An outcome: `` `${formatCents(price)} · ${pct(chance)}% chance` ``.
    - Icons:
        - A question with an image gets `{ set: "image", id: url }`; otherwise its coin.
        - Outcomes labeled YES or NO keep the `outcome` icons. Other outcomes get their image, if they have one.
    - `defaults`: the first market, and its outcome labeled "YES", else its first outcome.
    - `normalize`: a new question keeps the outcome with the same label, else it's set to `""`.
    - The amount's minimum is `minimum(outcome?.minUSD ?? 1)`.
    - Preview: the "If …" loss row uses the other outcome only when there are exactly two. Otherwise it's labeled "Otherwise". "Market odds" reads `` `${pct(outcome.chance)}% chance` ``.
- `TradeProvider`, when `walletEnabled`, creates one store, `start`s it, and builds the catalog:
    - `markets`: `(results ?? trending)` mapped through `toPredictionMarket`
    - `findMarket`: looks in `known`
    - the mock `tokens` and `perps`
  While the verb is Predict, it calls `watch(marketId)`, else `watch(null)`.
- Accepted gap until phase 3: a simulated confirm on a live market shows "on a market" in the PnL list, because `lib/trade/activity.ts` looks questions up in the mock list.
- `market-image.tsx`: `MarketImage({ src, label })` renders `next/image` at the icon size (`size-[1.15em]`, rounded, with the same ring as the coin icons). If it fails to load, it falls back to a neutral circle with the label's first letter.

- [ ] **Step 1: Write the failing logic tests:**
    - In `markets.logic.spec.ts`:
        - `"toPredictionMarket maps a view and formats its close date"`: "Oct 29" in the same year, "Nov 8, 2028" in another.
        - `"short titles cut at a word boundary"`: `"Democratic Presidential Nominee 2028"` becomes `"Democratic Presidential…"`.
        - `"a corrupt or old-shaped cache is ignored"`: `"{"`, `"[]"` and `{"markets":{}}` in `localStorage` all give `null`.
    - In `trade.logic.spec.ts`, with a catalog built from a hand-written multi-outcome `MarketView` and a YES/NO one:
        - `"a multi-outcome event reads Predict [top option] on [title]"`: `"I want to Predict No change on Fed Decision in October? with 10 USD."`
        - `"a new question keeps YES, and asks for an outcome when it has none"`: the issue message is `"Pick an outcome for this question."`.
        - `"the amount's minimum is the outcome's minUSD"`: `minUSD 4.2` with an amount of 3 gives `"The minimum is $4.20."`.
        - `"a picked question that isn't listed still resolves"`: it's found through `findMarket`.
    - All existing prediction logic tests must still pass unchanged against the mock catalog.
- [ ] **Step 2: Run them and confirm they fail.** Run: `LOGIC_ONLY=1 npx playwright test --project=logic`. Expected: the new tests FAIL, with missing exports or the old copy.
- [ ] **Step 3: Write the failing browser tests** in `e2e/markets.spec.ts`:
    - `"the picker shows the cached markets at once, then the fresh ones"`:
        - Seed `markets:trending` with one made-up question through `addInitScript`.
        - Hold `**/markets/trending` with `page.route` until the made-up question is visible in the Predict question picker, then release it.
        - The fixture's first trending title appears, and the made-up one goes.
        - Nothing matching `/loading|checking/i` ever shows.
    - `"signed out, the picker still shows live markets"`
    - `"a multi-outcome event reads Predict [option] on [event]"`: pick `samples.multi`'s title. The sentence reads its top option's label, then "on", then its title.
    - `"with nothing cached and Polymarket down, the picker says so"`: route `**/markets/trending` to `{ markets: [], maxOrderUSD: null, readAt: null }`. The picker shows "No markets to show right now."
    - `"a question that stops being offered asks for a question again"`:
        - Pick a sample, then route `**/markets/<id>` to 404.
        - Advance `page.clock` by 10 s.
        - The question pill's accessible name is "pick one", and the status line reads "Pick a question.".
- [ ] **Step 4: Implement** the files above, and update the three places in `e2e/sentence.spec.ts`.
- [ ] **Step 5: Run** the logic project, then the full browser suite from an isolated copy, then `npx tsc --noEmit -p .` and `npx eslint`. Expected: all pass.
- [ ] **Step 6: Commit**, with the message "Show Polymarket's live markets in the Predict sentence".

### Task 5: Search in the picker

**Files:**
- Modify:
    - `lib/sentence/types.ts`: `ChoiceSpec.search?: { placeholder: string }`
    - `lib/sentence/resolve.ts`: `ChoiceSlotView.search?: { placeholder: string }`
    - `components/sentence/picker.tsx` and `components/sentence/slots.tsx`
    - `components/trade/trade-composer.tsx`
    - `components/trade/markets-store.ts`: `search`
    - `lib/trade/operations/prediction.ts`: `marketId` declares `search: { placeholder: "Search markets" }`
- Test:
    - `e2e/markets.logic.spec.ts`: the store's search, with an injected `fetch`
    - `e2e/markets.spec.ts`

**Interfaces:**
- Consumes `createMarketsStore` (Task 4).
- Produces:
    - `ChoiceSlot` gains `onSearch?: (query: string) => void`, and `Picker` gains `search?: { placeholder: string; onQuery: (query: string) => void; empty?: string }`.
    - When `search` is set:
        - The picker shows a search field above the list (`type="search"`, `aria-label` = placeholder), focused when it opens.
        - Typeahead is off. ArrowDown from the field moves into the list.
        - Closing the picker calls `onQuery("")`.
        - `empty` is a line shown above the list (the "No markets match …" copy).
    - `TradeComposer` passes `onSearch` for a slot whose view has `search`, calling the store's `search`. While the query has an answer with no markets, it passes `empty`.
- The store's `search(query)`:
    - It trims the query. Under 2 characters, it clears `query` and `results` at once.
    - Otherwise it waits 250 ms after the last call, then fetches `/markets/search?q=`.
    - It sets `results` only if the query is still the current one. Results also go into `known`.

- [ ] **Step 1: Write the failing tests:**
    - Logic:
        - `"a slow search can't overwrite a newer one"`: the fetch for "fe" resolves after the one for "fed". `results` is fed's.
        - `"a query under 2 characters clears the results without fetching"`
        - `"typing quickly sends one request"`: three calls within 250 ms.
    - Browser:
        - `"search finds a market that isn't trending"`: type the first word of `samples.extra`'s title. Its option appears. Pick it, and the sentence shows its title.
        - `"a query with no matches says so, over the trending list"`: `zzzz` shows `No markets match “zzzz”.`, and the first trending title is still listed.
        - `"the search field is reachable by keyboard"`: open the picker. The field is focused; type, then ArrowDown, and the first option is focused.
- [ ] **Step 2: Run them and confirm they fail.** Expected: the store has no search, and the picker has no field.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** the logic project, the full browser suite from an isolated copy, `tsc` and `eslint`. Expected: all pass, including the existing picker tests (custom leverage input, typeahead in the coin pickers).
- [ ] **Step 5: Commit**, with the message "Search Polymarket markets from the question picker".
