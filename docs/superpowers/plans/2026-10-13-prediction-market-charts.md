# Prediction Market Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering the Predict sentence's question pill shows its outcomes' chances over the market's life as a line chart, and hovering the outcome pill shows only that outcome's line.

**Architecture:**
- **Server.** Our server reads Polymarket's CLOB `batch-prices-history` on demand. It caches per outcome token and serves `GET /markets/:eventId/history?outcomes=…`, checking every token against the event as the markets service shapes it.
- **Browser.** A small store reads the picked market's lines ahead of the hover. Two cards draw them inside the existing `HoverCard` (`components/sentence/hover-card.tsx`), using the coin price card's chart conventions.

**Tech Stack:** Express + zod + vitest (server), Next.js client components + Motion + NumberFlow + Playwright (browser and logic tests).

**Spec:** `docs/superpowers/specs/2026-10-13-prediction-market-charts-design.md`

## Global Constraints

- The browser never calls Polymarket. Only the server reads `POLYMARKET_CLOB_URL`.
- **Polymarket limits:** `batch-prices-history` takes at most 20 tokens. Our route takes 1 to 5 distinct token ids.
- **Server cache:** an entry is fresh for 3 minutes, a stale one is served for up to 30 minutes when Polymarket fails, at most 1,000 tokens are kept, and the upstream timeout is 8 s.
- **Lines:** at most 300 points per line, chances rounded to 4 decimals, points as `[unix ms, chance 0–1]`, oldest first.
- **Question card:** YES alone for a Yes/No question, otherwise up to 4 outcomes by chance, then "+N more".
- **Scale:** the vertical scale never spans less than 20 points (0.2) and is clamped to 0–1.
- **Change chip:** shown in percentage points ("+12 pts", "−3.5 pts"). Under 0.5 points reads as flat.
- **No co-author trailer** on any commit.
- **Commit by path:** `git commit -- <paths>`. Peer sessions edit this tree. When a file you changed also holds someone else's uncommitted hunks, stage only yours (`git diff <file>` → filtered patch → `git apply --cached`) and commit the index.
- **Comments are one line each.** They describe the code as it is, never the change ("moved", "now", "previously"), and follow the file's existing style.
- **Browser tests run only from an isolated copy:** `git archive HEAD | tar -x` into a scratch dir, then `cp -cR node_modules` and `server/node_modules`, then overlay your changed files. Use ports `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641`. Never run Playwright browser projects in the repo tree.
- Never read or print any `.env` file.

## Review Focus

1. **The outcome pill of an outcome outside the top 4** (the 7th candidate) must still show its own line. Task 3's `historyTokens` test and Task 6's browser test pin this.
2. **An outcome added to the event later starts partway across the chart.** Pointing before it existed shows no dot and "—". Task 4's `valueAt` test pins this.
3. **A market under a day old** must be read with `interval=1d&fidelity=5`, never `max`. Task 1's resolution test pins this.
4. **Two pills hovered in quick succession** share one server request per token, not one per card. Task 2's concurrency test and Task 5's store test pin this.
5. **Polymarket fails after a first good read:** the card keeps showing the cached line (up to 30 min old), never an empty or broken card. Task 2's stale test pins this.

---

### Task 1: History service (server core)

**Files:**
- Modify: `server/src/markets/gamma.ts` (add `startDate` and `createdAt` to `gammaEvent`)
- Modify: `server/src/markets/markets.ts` (add `openedAt`)
- Modify: `server/src/markets/polymarket-data.ts` (add `priceHistory`)
- Modify: `server/src/protocol.ts` (add the view types)
- Create: `server/src/markets/history.ts`
- Test: `server/test/unit/market-history.test.ts`

**Interfaces:**
- Produces, in `protocol.ts`, the spec's `OutcomeHistoryView` and `MarketHistoryView`, verbatim with their doc comments.
- Produces, in `polymarket-data.ts`:
  ```ts
  export type HistoryQuery = { interval: "1d" | "max"; fidelity: number };
  export type RawPoint = { t: number; p: number };
  // on PolymarketData:
  /** Each token's points as Polymarket answers them; a token it has nothing for is absent. */
  priceHistory(tokenIds: string[], query: HistoryQuery): Promise<Map<string, RawPoint[]>>;
  ```
  It POSTs `{ markets, interval, fidelity }` to `${clobUrl}/batch-prices-history`, with an 8 s timeout (give `send` an optional timeout). It parses `{ history: Record<string, unknown[]> }` and keeps only points whose `t` and `p` are numbers.
- Produces, in `markets.ts`:
  ```ts
  /** When the cached event opened: its startDate, else createdAt, else null (also null when it isn't cached). */
  openedAt(eventId: string): Date | null
  ```
  Unparseable dates count as missing.
- Produces, in `history.ts`:
  ```ts
  export const HISTORY_FRESH_MS = 180_000;
  export const HISTORY_STALE_MS = 1_800_000;
  export const HISTORY_MAX_TOKENS = 1_000;
  export const MAX_POINTS = 300;
  export function historyQuery(openedAt: Date | null, now: number): HistoryQuery & { stepMs: number };
  export function cleanPoints(raw: RawPoint[], openedAt: Date | null): [number, number][];
  export function thin<T>(points: readonly T[], max: number): T[];
  export class MarketHistory {
      constructor(deps: {
          data: Pick<PolymarketData, "priceHistory">;
          markets: Pick<MarketService, "event" | "openedAt">;
          logger: Logger;
          now?: () => number;
      });
      /** The asked tokens' lines in the order asked; null when the event or any token isn't offered now; rejects when Polymarket fails and a token has nothing read within HISTORY_STALE_MS. */
      view(eventId: string, tokenIds: string[]): Promise<MarketHistoryView | null>;
  }
  ```

- [ ] **Step 1: Write the failing unit tests** in `server/test/unit/market-history.test.ts`:
  - **`historyQuery` picks the spec's resolution for each age**, with `now = Date.parse("2026-10-13T12:00:00Z")` and an hour as 3,600,000 ms:
    - Opened 2 hours ago gives `{ interval: "1d", fidelity: 5, stepMs: 300_000 }`.
    - An opening time in the future gives the same.
    - Opened 2 days ago gives `{ interval: "max", fidelity: 12, stepMs: 720_000 }`: ceil(2880 / 250) = 12.
    - Opened 1 day + 1 minute ago gives fidelity 10, the floor.
    - Opened 29 days ago gives fidelity 168.
    - Opened 30 days ago gives `{ "max", 720, 43_200_000 }`.
    - Opened 179 days ago gives 720.
    - Opened 180 days ago gives `{ "max", 1440, 86_400_000 }`.
    - `null` gives `{ "max", 60, 3_600_000 }`.
  - **`cleanPoints` cleans and converts.** From unsorted points it:
    - drops one before the opening time,
    - drops one with `p: 1.2`, one with `p: NaN` and one with `t: Infinity`,
    - returns the rest sorted, as `[t * 1000, p rounded to 4 decimals]`,
    - and with `openedAt` null drops nothing for its age.
  - **`thin`**
    - 1,000 points become 300, with the first and last kept and the order kept.
    - 300 or fewer points come back unchanged.
  - **`MarketHistory.view`** uses a stub `data` that counts calls, a stub `markets` whose event has outcomes `["a", "b", "c"]`, and a mutable clock:
    - **Order.** It answers the order asked (`["c", "a"]`).
    - **Unknown tokens.** A token not in the event, or an unknown event, gives `null` without calling `data`.
    - **Caching.** A second view within 3 minutes makes no call. At 3 minutes it calls again, for the stale tokens only.
    - **Concurrency.** Two concurrent views of overlapping tokens make one call per token: `"a"` is never asked twice in flight.
    - **Failure with a cache.** A failing `data` with entries 10 minutes old resolves with them.
    - **Failure past the stale limit.** With entries 31 minutes old it rejects.
    - **Failure with no cache.** It rejects.
    - **Missing tokens.** A token Polymarket leaves out is answered with `points: []`, and that answer is cached.
    - **Eviction.** After 1,001 distinct tokens are cached, the first one read is gone: the next view of it calls `data` again.
    - **`readAt`** is the oldest entry's read time, and **`stepMs`** is the largest among the entries.

- [ ] **Step 2: Run them and see them fail**
  - Run: `cd server && npx vitest run test/unit/market-history.test.ts`
  - Expected: FAIL, because `../../src/markets/history.ts` doesn't exist.

- [ ] **Step 3: Implement**
  - Gamma fields: `startDate: z.string().nullish()` and `createdAt: z.string().nullish()` on `gammaEvent`.
  - `openedAt` reads `this.#events`.
  - `priceHistory` as described above.
  - `history.ts` as in the interfaces.
  - **Thinning.** Pick indices `Math.round(i * (n - 1) / (max - 1))` for `i` from 0 to max − 1.
  - **Cache.** A `Map` in insertion order: delete and re-set on write, and drop the first key past 1,000.
  - **Shared reads.** One pending promise per token. A view starts one `priceHistory` call for every token that is missing or stale and not already pending, then awaits every token it needs.
  - **Failures.** A failed read logs at `warn` with the event id.

- [ ] **Step 4: Run them and see them pass**
  - Run: `cd server && npx vitest run test/unit/market-history.test.ts test/unit/markets-shape.test.ts test/integration/markets.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Read Polymarket price history per outcome token, cached and sized to the market's age" -- server/src/markets/gamma.ts server/src/markets/markets.ts server/src/markets/polymarket-data.ts server/src/protocol.ts server/src/markets/history.ts server/test/unit/market-history.test.ts
  ```
  Add any new files first.

### Task 2: History route and fake Polymarket history

**Files:**
- Modify: `server/src/validation.ts` (add `marketHistoryQuery`)
- Modify: `server/src/http/app.ts` (the route)
- Modify: `server/src/services.ts` and `server/src/server.ts` (construct and wire `MarketHistory`)
- Modify: `server/test/support/fake-polymarket.ts` (opening dates and `/batch-prices-history`)
- Modify: `server/README.md` (a table row and a "Market history" section)
- Test: `server/test/integration/market-history.test.ts`

**Interfaces:**
- Consumes `MarketHistory`, `MarketHistoryView` and `HISTORY_FRESH_MS` from Task 1.
- Produces `export const marketHistoryQuery = z.object({ outcomes: … })`. It turns `"a,b"` into a string array, and is rejected unless it holds 1 to 5 entries, each matching `/^\d{1,80}$/`, with no duplicates.
- **The route.**
  ```
  GET /markets/:eventId/history?outcomes=a,b
  ```
  - It uses `noStore` and `limit(120, 60_000)`, and parses `:eventId` with `marketId`.
  - `null` from the service gives `not_found` ("That market isn't available.").
  - A rejection from the service or `markets.event` logs `warn` and gives the existing `unavailable()`.
- **`services.marketHistory: MarketHistory`.**
- **Fake additions, which Task 6 relies on:**
  ```ts
  // FakePolymarket gains:
  /** Sets when an event opened (shifted with the clock like endDate); null removes startDate and createdAt. Default: 20 days before now. */
  setOpened(eventId: string, at: Date | null): void;
  /** Serves these points for a token instead of the generated ones; null restores them. */
  setHistory(tokenId: string, points: { t: number; p: number }[] | null): void;
  // failNext's path union gains "/batch-prices-history"
  ```
- **`POST /batch-prices-history` in the fake**
  - **Rejects** with 400 when `markets` has more than 20 entries or `interval` is missing.
  - **Where the points start:**
    - `interval: "1d"`: 24 hours before now.
    - `interval: "max"` with `fidelity < 720`: 30 days before now.
    - Otherwise: the event's opening time.
  - **Points.** The window never starts before the event opened. Points run every `fidelity` minutes to now, capped at 5,000.
  - **Prices** follow a deterministic wave that ends at the token's current midpoint. Use the same bid/ask the books use, mirrored for the second token.
  - **Unknown tokens** are left out.

- [ ] **Step 1: Write the failing integration tests** in `server/test/integration/market-history.test.ts`, using `startStack` like `price-history.test.ts` and the fixture samples `yesNo` (73130) and `multi` (79987):
  - **"a Yes/No event's two lines come back in the order asked, without a token"**
    - Status 200, `cache-control: no-store`.
    - `outcomes.map(o => o.tokenId)` equals the asked order.
    - Points are ascending, with chances in 0–1.
    - `readAt` and `stepMs` are present.
  - **"a multi-outcome event serves up to five of its outcomes in one upstream call"**
    - It asks for 5 of the event's tokens.
    - The fake's `requests` show exactly one new `POST /batch-prices-history`.
  - **"each event's age picks its resolution"**
    - `setOpened(yesNo, 2 hours ago)` gives `stepMs` 300,000, and the fake saw `"interval":"1d"`.
    - `setOpened(multi, 200 days ago)` gives `stepMs` 86,400,000.
  - **Errors**
    - A token from another event gives 404 `not_found`.
    - An unknown event gives 404.
    - Six tokens give 400 `bad_request`.
    - A duplicate token gives 400.
    - A token with letters gives 400.
  - **"a second read within 3 minutes is answered from memory"**
    - The upstream count stays the same.
  - **"concurrent reads share one upstream call"**
    - Two concurrent requests for the same tokens make one call.
  - **"a failure after a good read serves the cached lines; with nothing cached it is 503 unavailable"**
    - Use `failNext("/batch-prices-history")`.
    - A fresh token gives 503.
  - **"the route is rate-limited like the other market routes"**
    - The 121st request inside a minute gives 429.
    - Copy how `markets-routes.test.ts` reaches the limit, if it does.

- [ ] **Step 2: Run them and see them fail**
  - Run: `cd server && npx vitest run test/integration/market-history.test.ts`
  - Expected: FAIL with 404 on the route.

- [ ] **Step 3: Implement**
  - The schema, the route and the wiring.
  - **Construction.** In `server.ts`: `new MarketHistory({ data: polymarket, markets, logger: marketLogger })`.
  - **The fake's additions.** Shift the default opening time with the clock in `shifted()`, the same way as `endDate`.
  - **README.**
    - **A table row.** `GET /markets/:eventId/history?outcomes=` — Public. One to five outcomes' chance over the market's life from Polymarket; see [Market history](#market-history).
    - **A "Market history" section after "Price history".** It covers the resolution table from the spec, the 3-minute and 30-minute cache, and that the browser never calls Polymarket.

- [ ] **Step 4: Run them and see them pass, then the whole server suite**
  - Run: `cd server && npx vitest run test/integration/market-history.test.ts && npx vitest run && npx tsc --noEmit`
  - Expected: all pass, and tsc is clean.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Serve GET /markets/:eventId/history: up to five outcomes' chance over the market's life, checked against the event" -- server/src/validation.ts server/src/http/app.ts server/src/services.ts server/src/server.ts server/test/support/fake-polymarket.ts server/README.md server/test/integration/market-history.test.ts
  ```

### Task 3: Which lines each card draws (browser logic)

**Files:**
- Create: `lib/trade/market-lines.ts`
- Test: `e2e/market-chart.logic.spec.ts`

**Interfaces:**
- Consumes `PredictionMarket` and `Outcome` from `lib/trade/catalog.ts`. `Outcome.id` is the token id.
- Produces:
  ```ts
  export const QUESTION_LINES = 4;
  /** The outcomes the question card draws: YES alone for a Yes/No question, else up to 4 by chance, most likely first; `more` counts the rest. */
  export function chartedOutcomes(market: PredictionMarket): { drawn: Outcome[]; more: number };
  /** The tokens both cards need, charted first, then the picked outcome if it isn't charted. */
  export function historyTokens(market: PredictionMarket, outcomeId: string | null): string[];
  /** The palette slot ("--chart-1" to "--chart-4") or tone ("--gain", "--loss") an outcome's line uses. */
  export function lineColor(market: PredictionMarket, outcomeId: string): string;
  ```
- **Color rule for `lineColor`:**
  - YES uses `--gain` and NO uses `--loss`.
  - A named outcome uses `--chart-<k>`, where k is its 1-based rank in `chartedOutcomes(...).drawn`.
  - A named outcome that isn't drawn uses `--chart-1`.
- **What counts as Yes/No:** exactly two outcomes, labelled `YES` and `NO`, in any case.

- [ ] **Step 1: Write the failing logic tests** in `e2e/market-chart.logic.spec.ts`. Build markets inline as `PredictionMarket` objects.
  - **A Yes/No question**
    - `drawn` is `[YES]` and `more` is 0, even when NO is more likely.
    - `historyTokens(m, NO.id)` is `[YES.id, NO.id]`.
  - **Two named sides**
    - `drawn` holds both, by chance, and `more` is 0.
  - **A 7-outcome event**
    - `drawn` is the 4 most likely, in order, and `more` is 3.
    - `historyTokens(m, seventh.id)` has 5 entries, ending with `seventh.id`.
    - `historyTokens(m, second.id)` has 4.
    - `historyTokens(m, null)` has 4.
  - **`lineColor`**
    - YES gives `--gain` and NO gives `--loss`.
    - The 3rd most likely gives `--chart-3`.
    - The 7th gives `--chart-1`.

- [ ] **Step 2: Run them and see them fail**
  - Run: `npm run test:logic -- e2e/market-chart.logic.spec.ts`
  - Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `lib/trade/market-lines.ts`.** Ties in chance keep the market's order.

- [ ] **Step 4: Run them and see them pass, then the whole logic suite**
  - Run: `npm run test:logic`
  - Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Choose which outcomes a market's chart draws and the color of each line" -- lib/trade/market-lines.ts e2e/market-chart.logic.spec.ts
  ```

### Task 4: Chart geometry and the two cards

**Files:**
- Create: `components/trade/chart-path.ts`. `smoothPath` moves here **verbatim** from `components/trade/coin-price-card.tsx`, and that file imports it.
- Modify: `components/trade/coin-price-card.tsx` (only the import, and removing the moved function)
- Create: `lib/trade/chance-chart.ts` (pure geometry and formatting)
- Create: `components/trade/market-chart-card.tsx`
- Modify: `app/globals.css` (`--chart-1` to `--chart-4`)
- Test: `e2e/market-chart.logic.spec.ts` (extend)

**Interfaces:**
- Consumes `chartedOutcomes` and `lineColor` (Task 3), and `smoothPath`.
- Produces, in `lib/trade/chance-chart.ts`:
  ```ts
  export type ChancePoints = readonly (readonly [number, number])[];
  /** Points with the live chance appended at `now`; one already at or after `now` is replaced. */
  export function withLiveEnd(points: ChancePoints, chance: number, now: number): ChancePoints;
  /** The vertical range: fits the values, never under 0.2, kept inside 0–1. */
  export function chanceScale(values: readonly number[]): { floor: number; span: number };
  /** The chance at a moment: the last point at or before it, or null before the line starts. */
  export function valueAt(points: ChancePoints, time: number): number | null;
  /** "+12 pts", "−3.5 pts", "0 pts": whole points from 10 up, one decimal under, flat under 0.5. */
  export function formatPts(delta: number): { text: string; trend: "gain" | "loss" | "flat" };
  ```
- Produces, in `components/trade/market-chart-card.tsx`:
  ```ts
  export function QuestionChartCard(props: { market: PredictionMarket; lines: ReadonlyMap<string, ChancePoints> }): ReactNode;
  export function OutcomeChartCard(props: { market: PredictionMarket; outcome: Outcome; points: ChancePoints }): ReactNode;
  /** Whether a card has anything to draw: some line with at least 2 points. */
  export function drawable(lines: Iterable<ChancePoints>): boolean;
  ```
  The `lines` and `points` passed in already end at the live chance. Task 6 applies `withLiveEnd`.
- **Card DOM contract (Task 6's browser tests rely on it):**
  - **Roots:** `data-market-card="question"` or `data-market-card="outcome"` on the root.
  - **Lines:** each line's `<path>` has `data-line={tokenId}`.
  - **Legend rows** have `data-legend={tokenId}`, and each row's % element has `data-chance={value at the shown moment, 0–1, or ""}`.
  - **"+N more":** the row has `data-more` and the text `+N more`.
  - **Outcome card header:** `data-chance` on its % and `data-change` on its chip text.
  - **Pointing:** the subtitle swaps to the pointed-at date, as `data-subtitle` does in the coin card.

- [ ] **Step 1: Write the failing logic tests** (append to `e2e/market-chart.logic.spec.ts`):
  - **`withLiveEnd`** adds `[now, chance]`, and replaces a last point whose time is ≥ now.
  - **`chanceScale`**
    - `[0.5, 0.52]` gives `span` 0.2, centred on 0.51.
    - `[0.01, 0.05]` gives `floor` 0 and `span` 0.2, kept inside 0–1.
    - `[0.1, 0.9]` gives `floor` 0.1 and `span` ≈ 0.8.
    - `[0.95, 0.99]` gives `floor` 0.8.
  - **`valueAt`**
    - Before the first point it gives null.
    - Between two points it gives the earlier one's value.
    - After the last it gives the last.
  - **`formatPts`**
    - 0.12 gives `"+12 pts"` gain.
    - −0.035 gives `"−3.5 pts"` loss. The sign is U+2212.
    - 0.004 gives `"0 pts"` flat.
    - 0.095 gives `"+9.5 pts"`.
  - **`drawable`**
    - Lines with lengths `[1]` give false.
    - Lengths `[1, 2]` give true.
    - No lines give false.

- [ ] **Step 2: Run them and see them fail**
  - Run: `npm run test:logic -- e2e/market-chart.logic.spec.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement**
  - `chance-chart.ts` and `chart-path.ts`, plus the coin card's import change. That file belongs to another session, so the change is the import and the removal only.
  - **The color tokens:** `--chart-1: #5b9dff; --chart-2: #f2b84b; --chart-3: #b48cff; --chart-4: #5fd4e6;` in `:root`. Also add `--color-chart-1` to `--color-chart-4` in `@theme inline`.
  - **The cards**, following `coin-price-card.tsx`:
    - **Chart and motion:** the same 300 × 120 viewBox, `TOP` and `BOTTOM` room, draw-in, dashed crosshair, pop-in dots, and subtitle swap.
    - **Scale:** `chanceScale`.
    - **Shared time axis.** In the question card it runs from the earliest first point among the lines to `now`, and each dot uses `valueAt`.
    - **Question card legend.** It sits under the chart: rows with an 8 px swatch, a truncated name, and a NumberFlow % with `{ style: "percent", maximumFractionDigits: 0 }`.
    - **Outcome card header.** Icon: the YES/NO outcome mark, as in `components/sentence/icons.tsx` (`set: "outcome"`), else the outcome's image, else none. Then the label, the NumberFlow %, and the `formatPts` chip, from the first point to the shown point, tinted like the coin card's chip.
    - **Question card header.** The market image (40 px, rounded) and the question with `line-clamp-2`. The subtitle shows `Ends {market.closes}`, or the pointed-at date while pointing.

- [ ] **Step 4: Run them and see them pass, and typecheck**
  - Run: `npm run test:logic && npx tsc --noEmit -p .`
  - Expected: PASS, and tsc is clean.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Draw a market's outcome chances as a question card and an outcome card, sharing the coin card's smoothing" -- components/trade/chart-path.ts components/trade/coin-price-card.tsx lib/trade/chance-chart.ts components/trade/market-chart-card.tsx app/globals.css e2e/market-chart.logic.spec.ts
  ```

### Task 5: Market history store

**Files:**
- Create: `components/trade/market-history-store.ts`
- Test: `e2e/market-chart.logic.spec.ts` (extend)

**Interfaces:**
- Consumes `MarketHistoryView` (Task 1) and `ChancePoints` (Task 4).
- Produces:
  ```ts
  export type MarketHistorySnapshot = { lines: ReadonlyMap<string, ChancePoints> };
  export function createMarketHistoryStore(options: { apiUrl: string; fetch?: typeof fetch; now?: () => number }): {
      subscribe(listener: () => void): () => void;
      getSnapshot(): MarketHistorySnapshot;
      /** Reads the tokens it has no line for, or a line older than 3 minutes, in one request; tokens already being read aren't asked again. */
      want(eventId: string, tokenIds: readonly string[]): Promise<void>;
  };
  export type MarketHistoryStore = ReturnType<typeof createMarketHistoryStore>;
  /** The shared store's lines; components call `marketHistoryStore().want(...)` to read ahead. */
  export function useMarketHistory(): MarketHistorySnapshot;
  export function marketHistoryStore(): MarketHistoryStore;
  ```
- **The request:** `${apiUrl}/markets/${eventId}/history?outcomes=${tokens.join(",")}`.
- **Validation:** answers are checked like `price-history-store.ts`'s `toCoins`. Points that aren't `[finite, finite in 0–1]` are skipped.
- **Failures:** a failed or invalid read changes nothing, and the next `want` tries again.

- [ ] **Step 1: Write the failing logic tests** (append), using a stub `fetch` that records URLs and a mutable `now`:
  - **One request:** `want("1", ["a", "b"])` makes one request with `outcomes=a,b`, and the snapshot then has both lines. Listeners are told once.
  - **No repeats:** `want` again within 3 minutes makes no request. At 3 minutes it requests both again.
  - **Overlap:** a concurrent `want("1", ["a", "c"])` while `a` is in flight requests only `c`.
  - **Bad answers:** a 503, or an answer with a bad point, keeps the earlier lines. The bad point is skipped, not the whole line.
  - **Order:** points come back oldest first, as the server sends them.

- [ ] **Step 2: Run them and see them fail**
  - Run: `npm run test:logic -- e2e/market-chart.logic.spec.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement.** Follow `price-history-store.ts`: `useSyncExternalStore`, a lazily created shared store from `API_URL`, and an empty server snapshot.

- [ ] **Step 4: Run them and see them pass**
  - Run: `npm run test:logic`
  - Expected: all pass.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Keep each outcome's chance history in the browser, read from our server ahead of the hover" -- components/trade/market-history-store.ts e2e/market-chart.logic.spec.ts
  ```

### Task 6: Wiring and browser tests

**Files:**
- Modify: `components/trade/trade-composer.tsx` (the `marketPreview` prop)
- Modify: `components/trade/trade-screen.tsx` (supply it, and read ahead)
- Modify: `e2e/price-card.spec.ts`. Its test "a market's pill shows no price card, though it has a coin's icon" becomes "a market's pill shows its market chart, never a coin price card": the hover card shows `[data-market-card="question"]` and no `[data-coin-card]`.
- Test: `e2e/market-chart.spec.ts`

**Interfaces:**
- Consumes everything from Tasks 3–5, and the fake's `setOpened`, `setHistory` and `failNext` from Task 2.
- Produces `TradeComposer`'s new prop:
  ```ts
  marketPreview?: (marketId: string, outcomeId: string | null) => ReactNode
  ```
  - **Question pill:** in `renderSlot`, slot `"marketId"` with a selected value gets `preview={marketPreview?.(value, null)}`.
  - **Outcome pill:** slot `"outcomeId"` with a selected value, while `marketId` has one, gets `marketPreview?.(marketValue, outcomeValue)`.
  - The coin preview logic stays as it is.
- **`TradeScreen`**
  - **Reading the lines:** `useMarketHistory()`, so a read that lands while the pill is hovered opens the card.
  - **Finding the market:** `catalog.markets.find(...) ?? catalog.findMarket(id)`.
  - **Read-ahead:** while the verb is `predict` and a market is picked, an effect on `[marketId, outcomeId]` calls `marketHistoryStore().want(marketId, historyTokens(market, outcomeId))` once the page is idle (`requestIdleCallback`, else `setTimeout` 200).
  - **`marketPreview(marketId, null)`** builds each drawn outcome's line with `withLiveEnd(line, outcome.chance, Date.now())`. It returns `null` unless `drawable(...)`, else a `QuestionChartCard`.
  - **`marketPreview(marketId, outcomeId)`** does the same for that one outcome, giving an `OutcomeChartCard`.
  - **On hover:** whenever a preview is built, it also calls `want(...)`, so a stale line refreshes.

- [ ] **Step 1: Write the failing browser tests** in `e2e/market-chart.spec.ts`.
  - **Setup:**
    - Reuse `e2e/price-card.spec.ts`'s `card` and `openCard` helpers and the `picker`/`trade` helpers.
    - Pick markets through the picker the way `e2e/predictions.spec.ts` does.
    - Set up the fake through the e2e control server. Add control routes `/polymarket/opened` and `/polymarket/history` to `server/test/e2e/serve.ts`, mirroring `/polymarket/resolve`.
  - **Tests** (all skip on mobile except the last):
    - **"hovering a multi-outcome question shows its 4 likeliest outcomes and +N more"**
      - Pick the `multi` sample (79987).
      - Hover `[data-slot="marketId"] button`.
      - The card is `[data-market-card="question"]`, with 4 `[data-line]` and 4 `[data-legend]` entries.
      - `[data-more]` reads `+N more`, where N = offered outcomes − 4.
    - **"a Yes/No question draws only YES"**
      - Pick the `yesNo` sample.
      - One `[data-line]`, whose token is the YES outcome's.
    - **"the outcome pill shows only that outcome, with its chance and change"**
      - Hover `[data-slot="outcomeId"] button`.
      - `[data-market-card="outcome"]` has one `[data-line]` equal to the picked outcome.
      - `data-chance` equals the pill's chance within 0.005.
      - `data-change` matches `/^([+−]\d+(\.\d)? pts|0 pts)$/`.
    - **"an outcome outside the 4 likeliest still shows its own line"**
      - In `multi`, pick the outcome ranked 5th or lower by chance, then hover the outcome pill. The event must offer at least 5; if the recording offers fewer, pick another recorded event that does and say which in the report.
    - **"pointing rolls the chances and says when"**
      - Move the mouse across the chart.
      - `data-chance` changes, and the subtitle stops reading `Ends …`.
    - **"the chart is read before the hover"**
      - A request to `/markets/79987/history` is seen after the market is picked and before any hover.
    - **"opening the picker hides the card, and Escape closes it"**
    - **"a history that can't be read shows no card"**
      - Use `failNext("/batch-prices-history")` on a market not read yet. Hover, wait 500 ms, and no card shows.
    - **Mobile only: "a tap opens the picker, never a chart"**

- [ ] **Step 2: Run them in an isolated copy and see them fail**
  - Run (from the copy): `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641 npx playwright test e2e/market-chart.spec.ts e2e/price-card.spec.ts`
  - Expected: FAIL, because no market card exists yet.

- [ ] **Step 3: Implement** the composer prop, the screen wiring, the control routes and the `price-card.spec.ts` rename.

- [ ] **Step 4: Run them in the isolated copy and see them pass, with neighbours**
  - Run (from the copy): `E2E_PORT=3640 E2E_API_PORT=4640 E2E_CONTROL_PORT=4641 npx playwright test e2e/market-chart.spec.ts e2e/price-card.spec.ts e2e/predictions.spec.ts e2e/markets.spec.ts e2e/sentence.spec.ts`
  - Then, in the repo: `npm run test:logic && npx tsc --noEmit -p .`
  - Expected: all pass on desktop and mobile.

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "Show a market's chart when its question or outcome pill is hovered, read ahead from our server" -- components/trade/trade-composer.tsx components/trade/trade-screen.tsx e2e/price-card.spec.ts e2e/market-chart.spec.ts server/test/e2e/serve.ts
  ```

### Task 7: Live check

**Files:**
- Create: `server/scripts/market-history-live-check.ts`

**Interfaces:**
- Consumes `createPolymarketData`, `MarketService`, `MarketHistory` and `historyQuery`.

- [ ] **Step 1: Write the script.** It is read-only, and its only network calls are GETs to Gamma and POSTs to `batch-prices-history`. It:
  - builds `createPolymarketData` from the default public URLs (`https://gamma-api.polymarket.com` and `https://clob.polymarket.com`), with no `.env` needed;
  - builds a `MarketService` and runs one `tick()`;
  - picks the first 3 trending events by different ages: the youngest, a middle one, and the oldest by `openedAt`;
  - for each, prints the event id, title, age in days, `historyQuery`'s `interval` and `fidelity`, and each of its first 4 outcomes' point count, first and last point time (ISO), and last chance;
  - exits non-zero if any line has fewer than 2 points, or if a line's first point is more than one step after the opening time while that event is under 30 days old.

- [ ] **Step 2: Run it**
  - Run: `cd server && node scripts/market-history-live-check.ts`
  - Expected: three events printed and exit 0.

- [ ] **Step 3: Commit**
  ```bash
  git commit -m "Add a read-only live check of market history against Polymarket" -- server/scripts/market-history-live-check.ts
  ```
