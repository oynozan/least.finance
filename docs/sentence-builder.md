# The sentence builder

The page is one sentence whose pills are the inputs:

- I want to **[Swap]** my **[ETH]** to **[SOL]** for **[10 USD]**.
- I want to **[Buy]** **[SOL]** for **[10 USD]**. / I want to **[Sell]** my **[SOL]** for **[10 USD]**.
- I want to **[Long]** **[BTC]** at **[5x]** leverage with **[100 USD]**. (and Short)
- I want to **[Predict]** **[YES]** on **[Will BTC reach $150K?]** with **[10 USD]**.

The first pill picks the verb; changing it rebuilds the rest of the sentence. The page shows nothing
else: the green **Review** button next to the wallet button stays disabled until the sentence is
complete and valid, and opens the details and the confirm step in the right-hand sidebar.

## Layers

| Layer | What it knows | Files |
| --- | --- | --- |
| Engine | Sentences, slots, validation, state. No trading, no React. | `lib/sentence/` |
| Domain | The four operations, mock market data, intents, execution stub. | `lib/trade/` |
| Renderer | Generic sentence UI: pills, pickers, the amount input, motion. No trading. | `components/sentence/` |
| Trade UI | Wires the domain to the renderer, the dock's Review button and the review sidebar. | `components/trade/` |

## An operation

Each operation is one file in `lib/trade/operations/`, written with `operation({...})` from
`lib/trade/context.ts`, and declares:

- `verbs`: the pills that pick it, and the values each verb fixes (Buy fixes `side: "buy"`).
- `slots`: a spec for every value it stores. Either a `choice` (allowed values from `choices(values, ctx)`,
  optionally a `custom` typed value, e.g. leverage) or a `number` (decimals, prefix/suffix, `bounds`).
  Each spec also has its copy: the picker `prompt`, the accessible `hint`, and a `missing` message.
- `defaults(ctx)`, `template(values)` (words, `VERB`, `{ slot }`; falsy items are dropped),
  `normalize` (keep values consistent: a swap's coins never match, leverage stays under the cap),
  `check` (cross-slot rules), `toIntent` (the normalized intent) and `preview` (the review rows).

The engine adds the per-slot issues itself (empty, out of bounds, no longer offered), only builds an
intent when nothing blocks, and keeps a draft per operation. Slots bound to a shared `term` (the amount,
the coin) carry their value across verbs when the next operation accepts it, and their pills glide
between sentences instead of being replaced.

Operations never import market data: prices, markets and the wallet's holdings come in through `ctx`
(`holdings` is `null` while no wallet is connected, which lifts balance caps).

## Adding a transaction type

1. Add its intent to `TransactionIntent` in `lib/trade/intent.ts`.
2. Write `lib/trade/operations/<name>.ts` with `operation({...})`.
3. Add it to the list in `lib/trade/registry.ts`.

Nothing in `components/` changes. A compile-time check in the registry fails if an intent has no
operation or an operation produces something that isn't in `TransactionIntent`. New icon sets (say,
chain logos) are one case in `components/trade/trade-icons.tsx`.

## Tests

- `npm run test:logic`: the engine and operations, no browser (`e2e/trade.logic.spec.ts`).
- `npm run test:e2e`: the sentence in Chrome on desktop and a phone (`e2e/sentence.spec.ts`).

## Not built yet

Real prices, balances and quotes; execution (`lib/trade/execute.ts` only logs the intent);
slippage and order types; markets with more than two outcomes; picker search.
