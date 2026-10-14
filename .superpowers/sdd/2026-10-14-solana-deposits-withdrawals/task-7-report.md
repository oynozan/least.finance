# Task 7 report: withdraw form, wallet picker and history

BASE 8b6782804335aaedafde876bf489eb5ae2038e13.

Built: the withdraw form lists every linked wallet (network logo, short address) and defaults to the wallet in use; a Solana pick asks `withdraw:quote` debounced (400 ms) and shows "Fee 0.13 USDC · you receive 9.87 USDC" and, with setup, "Includes 0.16 USDC to set up your USDC account."; the Solana minimum of 1 replaces the floor and a press below it shakes the field; Withdraw is held until a quote is shown and sends it as `reviewedFee`; `quote_changed` returns "changed" (no notice, nothing sent), the form re-quotes and asks to press Withdraw again; "Connect an EVM wallet" shows only with no wallet at all. History reads Sending / Sending to Solana / Taking longer than expected / age. Pure logic is in `lib/account/withdraw-form.ts` (picker rows, floor, quote lines, `WithdrawQuoter`).

Files: lib/account/withdraw-form.ts (new), components/withdraw-form.tsx, wallet-sidebar.tsx, account-provider.tsx, account-client.ts, history-entries.ts, server/src/{protocol.ts,socket/sockets.ts,withdrawals/withdrawals.ts}, server/test/e2e/serve.ts (fail-next-burn and iris/forward controls; seed fix for Solana people), e2e/backend.ts, e2e/withdraw.spec.ts, e2e/withdraw-solana.spec.ts, e2e/withdraw-solana.logic.spec.ts, two server integration tests (expect `setupFee`). lib/account/state.ts needed no change: it already upserts by `updatedAt` and the new test pins `forwarding`.

Tests
- `npx playwright test --project=logic e2e/withdraw-solana.logic.spec.ts`: 12/12. `npm run test:logic`: 284/284.
- Browser, isolated copy on 3650/4650/4651: withdraw-solana.spec.ts 4/4; withdraw.spec.ts 10/10 (run together with the first, before the final seed fix; the seed fix touches Solana people only).
- `cd server && npm test`: 862/863 on the full run, the failures all in prediction-resolver.test.ts (load flake, known from earlier tasks); that file and withdraw-socket.test.ts pass alone, 25/25. Server and app `tsc --noEmit` clean; eslint clean; prettier clean on my files (the two relay fixtures flagged are not mine).
- Red run: NOT observed for the logic and browser tests (written after the implementation). The server `setupFee` change was red first (2 tests failed before, 19/19 after).

Rulings
- Ruling: `WithdrawQuote` gains `setupFee` (fee less the plain fee, from a second Iris read when `setup`) — the spec's "Includes 0.16 USDC" line needs the setup part, which `{fee, receive, setup}` cannot give. Null when not setup or the second read fails; the line is then omitted.
- Ruling: fee shown rounded up to cents and what you receive rounded down — never show more than arrives. `reviewedFee` sent is the raw fee of the quote shown.
- Ruling: the Solana floor is the client constant 1 (the server config default) — `withdraw:limits` carries only the Arc floor; the server checks again.
- Ruling: Solana wallets are listed only when the session says `solana.withdrawals` is on — otherwise every press would be refused "Solana isn't open yet."
- Ruling: `withdraw()` returns "changed" for `quote_changed` and shows "The fee changed. Check the new amount and press Withdraw again." (no copy specified).
- Ruling: removed two withdraw.spec.ts tests that need a Solana-only person to be asked for an EVM wallet (now false by spec), and changed "the wallet in use is Solana with an EVM wallet" to expect Solana as default then pick EVM. The Connect row is unreachable in e2e with the switch on.
- Ruling: the e2e `seed` gave a Solana person a lowercased base58 `from`, which made the account view throw; it now uses a zero Ethereum address.

Concerns: the quote line hides while the next quote is debounced/loading (Withdraw is held meanwhile). The form keeps the first `quote` function it was given (same client).

## Fix round 2

BASE 478b2cab9ee733c824cc4d72dfe322d170489a7d.

Both Important findings were test gaps; the form already behaved as specified, so only e2e/withdraw-solana.spec.ts changed (two browser tests, driving the real form).
- Below the Solana minimum: types 0.5, presses Withdraw, asserts the field is aria-invalid with the hint, the amount is kept, and no withdraw:quote or withdraw:create frame was sent. The shake animation itself is not asserted (a transient transform); the invalid marking and the nothing-sent check are the observable part, as the finding allowed.
- quote_changed: a routed websocket answers the first withdraw:create with quote_changed and makes later quotes read a fee of 0.4. Asserts the "fee changed" hint, the new line "Fee 0.40 USDC · you receive 49.60 USDC", nothing sent on its own (one create after a wait), the form still open with 50, then the next press sends reviewedFee "0.4" (the first carried "0.286") and the balance drops.

Tests: withdraw-solana.spec.ts 6/6 in the isolated copy (3650/4650/4651). Prettier, eslint and app tsc clean.
Red run: not applicable in the usual sense, since the behavior already existed; the new tests failed first on my own assertion mistakes (not on the form), then passed.
