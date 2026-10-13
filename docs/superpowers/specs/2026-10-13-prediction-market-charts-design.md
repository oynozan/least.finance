# Prediction market charts: design

2026-10-13. Agreed in conversation; this is the written version for review.

## Goal

Hovering the Predict sentence's pills shows how the market's odds moved:

- **The question pill** shows a line chart of its outcomes' chances over the market's whole life.
- **The outcome pill** shows only that outcome's chance over the same span.

They are built as hover cards, the same as the coin price card (`components/sentence/hover-card.tsx`): mouse hover only, hidden while the pill's picker is open, closed by Escape, never focusable.

## Decisions

|                       |                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Hover targets         | The Predict sentence's question pill (`marketId`) and outcome pill (`outcomeId`). Not the rows inside the market picker.               |
| Range                 | The market's whole life, from when it opened to now                                                                                     |
| Lines on the question | The 4 outcomes most likely now. When there are more, the card says "+N more".                                                           |
| Yes/No questions      | Only the YES line on the question card. Two named sides (Team A vs Team B) keep both lines.                                             |
| Outcome card          | That outcome's line only, even when it is not among the question card's 4                                                               |
| Source                | Polymarket's CLOB price history, read only by our server. The browser never calls Polymarket.                                          |
| Approach              | On demand through our server, cached per outcome token. The browser reads the picked market's charts ahead, so a hover finds them ready. |
| Line's end            | Each line ends at the outcome's live chance, the same % the pill and picker show                                                       |

## 1. Polymarket's price history

These facts were checked live on 2026-10-13. Documentation: `docs.polymarket.com/api-reference/markets/get-prices-history` and `get-batch-prices-history`.

- **Single endpoint.** `GET {POLYMARKET_CLOB_URL}/prices-history?market=<tokenId>&interval=…&fidelity=…`
- **Batch endpoint.** `POST {POLYMARKET_CLOB_URL}/batch-prices-history` takes `{ markets: tokenId[], interval, fidelity }`. It accepts at most 20 tokens and answers `{ history: { [tokenId]: [{ t, p }] } }`.
- **Points.** `t` is unix seconds and `p` is the token's price from 0 to 1, which is its chance. Every outcome is a token, so a Yes/No market has two.
- **No key.** No authentication is needed, and the rate limit is 1,000 requests per 10 s for `/prices-history`.
- **A time component is required.** Either `interval` or `startTs` and `endTs` must be sent.
- **`fidelity` is minutes per point, with minimums.** `1w` needs `fidelity` of 5 or more, and `1m` needs 10 or more.
- **How far back `interval=max` reaches.** With `fidelity` under 720 it reaches back only 30 days, with points at least 10 minutes apart. With `fidelity` of 720 or 1440 it reaches back to the market's first trade.
- **`interval=1d`** returns the last 24 hours. With `fidelity=5` that is about 288 points.
- **`startTs` and `endTs`** together may span at most about 15 days. This design doesn't use them.
- **Resolved markets** keep their history. However, `interval=max` at the default `fidelity` returns nothing for them, while `fidelity=1440` returns everything. This design only charts markets that are open.

## 2. Server

### Opening time

`gammaEvent` gains `startDate` and `createdAt` (both `string`, nullish). The markets service exposes:

```ts
openedAt(eventId: string): Date | null
```

It reads the cached Gamma event and returns `startDate`, else `createdAt`, else null.

### Resolution

`server/src/markets/history.ts` picks one request for every line of an event, from the event's age `A = now − openedAt`:

| Age                        | Request                                               | Points                        |
| -------------------------- | ----------------------------------------------------- | ----------------------------- |
| under 1 day                | `interval=1d&fidelity=5`                              | 5 minutes apart               |
| under 30 days              | `interval=max&fidelity=max(10, ceil(A in minutes / 250))` | about 250 across its life |
| under 180 days             | `interval=max&fidelity=720`                           | 12 hours apart                |
| 180 days or more           | `interval=max&fidelity=1440`                          | 1 day apart                   |
| opening time unknown       | `interval=max&fidelity=60`                            | the last 30 days, hourly      |

Each line is then cleaned:

- Points before the opening time are dropped.
- Points that aren't finite, or whose `p` is outside 0–1, are skipped.
- A line longer than 300 points is thinned evenly, keeping the first and last.
- Chances are rounded to 4 decimals.

### Route

```
GET /markets/:eventId/history?outcomes=<tokenId>,<tokenId>
```

- **Public and rate-limited.** It has `noStore` and `limit(120, 60_000)`, like the other `/markets` routes.
- **Bad request.** `outcomes` must hold 1 to 5 distinct token ids, or the answer is `bad_request`.
- **Not found.** Each token must be one of the cached Gamma event's own `clobTokenIds` (`MarketService.tokensOf`), even if the books no longer offer it, and the event must shape now. An unknown event, or a token that isn't one of its own, gets `not_found` ("That market isn't available."). This means no request can make us read an arbitrary token.
- **Unavailable.** When Polymarket can't be read and nothing is cached for a token that was asked for, the answer is `unavailable`.

The answer is a `MarketHistoryView` (in `server/src/protocol.ts`):

```ts
/** One outcome's chance over the market's life, oldest first, as [unix ms, chance 0–1]; empty when Polymarket has none. */
export type OutcomeHistoryView = { tokenId: string; points: [number, number][] };

export type MarketHistoryView = {
    eventId: string;
    /** About how far apart the points are, in ms. */
    stepMs: number;
    /** In the order the tokens were asked for. */
    outcomes: OutcomeHistoryView[];
    /** When Polymarket was last read for the oldest of these lines (ISO 8601). */
    readAt: string;
};
```

### Cache

- **Per-token entries.** The cache is keyed by token id and holds `{ points, stepMs, readAt }`. The question card and the outcome card share entries.
- **Freshness.** An entry is fresh for 3 minutes. A stale entry is still served for up to 30 minutes when Polymarket fails.
- **Size.** The cache holds at most 1,000 tokens, dropping the oldest read first.
- **Upstream calls.** Each request makes one `batch-prices-history` call, for the tokens that are missing or stale. Five tokens at most stays well under the batch limit of 20. The timeout is 8 s, and the call goes through the same HTTP client the server already uses for `/books`.
- **Shared reads.** Requests for the same token at the same time share one read.

## 3. Browser

### Which lines

`lib/trade/market-lines.ts` holds pure logic, tested in the logic suite. It works on the existing `PredictionMarket` type, where `Outcome.id` is the token id.

```ts
/** The outcomes the question card draws: YES alone for a Yes/No question, else up to 4 by chance, most likely first. */
export function chartedOutcomes(market: PredictionMarket): { drawn: Outcome[]; more: number };

/** The tokens both cards need: the charted outcomes plus the picked one. */
export function historyTokens(market: PredictionMarket, outcomeId: string | null): string[];
```

### Store

`components/trade/market-history-store.ts` keeps each token's points, as read from our server.

- **Read-ahead.** When the Predict sentence's question or outcome changes, it reads `historyTokens(...)` for that market once the page is idle. One request covers all of them.
- **Hover.** A hover shows what is cached at once, and reads again if the entry is older than 3 minutes.
- **Failures.** A failed read keeps what was there, so nothing flickers.
- **Line's end.** Each line gets a final point `[now, outcome.chance]` from the live market, so it ends exactly on the % the pill shows.

### Cards

`components/trade/market-chart-card.tsx` has two exports. Both draw their chart 300 px wide, edge to edge, with the coin card's draw-in animation and pointer behaviour. The question card's header (image and question) was dropped so it fits a 720 px-tall screen; the pill under the card already shows both.

**`QuestionChartCard`**, top to bottom (about 223 px for 4 lines, about 192 px for one or two)
- **Legend.** It leads: a 2×2 grid, each cell a color swatch, the name (truncated) and the % (NumberFlow, rolling to the pointed-at moment). One or two lines make a single row.
- **Muted line.** On the left, "Ends …", which gives way to the pointed-at date while pointing. On the right, "+N more" when outcomes were left out.
- **Chart.** About 106 px tall, flush to the card's bottom and side edges, with no fill.
  - **Lines.** One per drawn outcome. A YES-only chart uses `--gain`. Named outcomes use `--chart-1` to `--chart-4` in order of their chance.
  - **Pointing.** A dashed crosshair follows the pointer, with a dot on every line.
  - **A line that starts later.** If a line hadn't started yet at the pointed time, it shows no dot and its legend reads "—".

**`OutcomeChartCard`**
- **Header.**
  - **Left.** The outcome's label, whole where it fits, with no icon since the outcome pill under the card shows it. The subtitle shows "Ends …", or the pointed-at date while pointing.
  - **Right.** The chance now (NumberFlow) and a chip showing the change since the line's first point, in percentage points: "+12 pts" or "−3.5 pts". Under 0.5 points reads as flat.
- **Line.**
  - **Color.** YES uses `--gain` and NO uses `--loss`. A named outcome uses its color from the question card, or `--chart-1` when that card doesn't draw it.

**Both cards**
- **Dates.** The pointed-at date carries the year when the line spans two calendar years, and drops the hour when it spans more than 60 days (`chartDate`).
- **Vertical scale.** It fits the data but never spans less than 20 points, and is clamped to 0–100%.
- **No card when there's nothing to draw.** A card renders only when at least one of its lines has 2 or more points, including the live end. Otherwise there is no card, as with coins.

**Colors.** `--chart-1` to `--chart-4` are new tokens in `app/globals.css`, with light and dark values, distinct from `--gain` and `--loss`.

**Shared code.** The monotone smoothing (`smoothPath`) moves from `coin-price-card.tsx` to `components/trade/chart-path.ts`, and both cards import it.

### Wiring

- **`trade-composer.tsx`** gains:
  ```ts
  marketPreview?: (marketId: string, outcomeId: string | null) => ReactNode
  ```
  - **Question pill.** The `marketId` slot's pill gets `marketPreview(marketId, null)`.
  - **Outcome pill.** The `outcomeId` slot's pill gets `marketPreview(marketId, outcomeId)`.
- **`trade-screen.tsx`** supplies `marketPreview` from the market history store and the trade catalog. It also starts the read-ahead while the verb is Predict.

## 4. Errors

| What happens                              | What the person sees                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| History not read yet when hovered         | No card, then the card appears as soon as the read lands (if still hovered) |
| Polymarket down, cached data on our server | The last data, up to 30 minutes old, ending at the live chance        |
| Polymarket down, nothing cached           | No card                                                                |
| Market too new for 2 points               | No card                                                                |
| Our server unreachable                    | No card. The store tries again on the next hover.                      |
| Event no longer offered (404)             | No card. The sentence already handles a market that went away.         |

## Testing

- **Server unit tests** (`server/test/unit/market-history.test.ts`):
  - The resolution chosen for each age, including an unknown opening time.
  - Parsing: bad points are skipped and points before opening are dropped.
  - Thinning to 300 points, keeping the first and last.
- **Server integration tests** (`server/test/integration/market-history.test.ts`), against `fake-polymarket.ts` with a new `/batch-prices-history`:
  - A Yes/No event and a named multi-outcome event answer in the order asked.
  - A token from another event gets `not_found`.
  - Six tokens get `bad_request`.
  - Two requests within 3 minutes make one upstream call, and two at the same time share one.
  - A failure with data cached serves the stale data. A failure with nothing cached is `unavailable`.
  - The rate limit applies.
- **Logic tests** (`e2e/trade.logic.spec.ts`):
  - `chartedOutcomes` returns YES alone for a Yes/No question and the top 4 by chance with `more` for a 7-outcome event.
  - `historyTokens` adds a picked outcome outside the top 4.
- **Browser tests** (`e2e/market-chart.spec.ts`), with the e2e backend serving recorded history:
  - Hovering the question pill of a named event shows 4 lines and "+N more".
  - A Yes/No question shows one line.
  - The outcome pill shows one line with its % and change chip.
  - Pointing rolls the values and shows the date.
  - Opening the picker hides the card, and Escape closes it.
  - A history read that fails shows no card.
  - Both runs, desktop and mobile. Mobile asserts that no card opens on tap.
- **Live check.** A read-only script, `server/scripts/market-history-live-check.ts`, reads three real trending events through the route's service and prints each line's span and point count. It confirms the resolution table against real Polymarket.

## Order of work

1. Server: the Gamma fields, `openedAt`, the history service and its cache, the route, `MarketHistoryView`, the fake's batch endpoint, and the tests.
2. Browser logic: `market-lines.ts` and its logic tests.
3. Browser: the store, the shared `chart-path.ts`, the cards, the color tokens, the wiring, and the browser tests.
4. Live check against Polymarket.

## Shared files

The coin price card's session owns `coin-price-card.tsx`, `trade-composer.tsx` and `trade-screen.tsx`. Before editing them, I'll tell that session what changes there:

- `smoothPath` moves to `chart-path.ts`.
- `trade-composer.tsx` gains one optional prop and two preview lines in `renderSlot`.
- `trade-screen.tsx` gains one store hook.

Only those hunks are committed (`git apply --cached`).

## Not included

- Charts when hovering rows inside the market picker.
- A range switcher in the card.
- Charts on touch, which has no hover.
- Volume or order-book charts.
- Charts for resolved positions on the PnL page.
