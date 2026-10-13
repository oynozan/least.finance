import type { CoinEntry } from "../src/swaps/coins.ts";
import { NATIVE_EVM } from "../src/swaps/coins.ts";
import type { LifiQuote, LifiStatus } from "../src/swaps/lifi.ts";
import { moveFromStatus, type StatusExpect } from "../src/swaps/tracker.ts";

// A status passes only when the tracker would settle the order to done on it
export function spendVerdict(
    status: LifiStatus,
    expect: StatusExpect,
): { done: true } | { done: false; reason: string } {
    const { move, note } = moveFromStatus(status, expect);
    if (move?.state === "done") return { done: true };
    if (move) return { done: false, reason: `the tracker would settle it as ${move.state}` };
    return { done: false, reason: `the tracker would not settle it: ${note ?? `status ${status.status}`}` };
}

// The orders code approves only the diamond, so a token input's quote must name it as the spender
export function approvalVerdict(quote: LifiQuote, from: CoinEntry, diamond: string | null): string | null {
    if (from.network === "solana" || from.address === NATIVE_EVM || quote.skipApproval) return null;
    const spender = quote.approvalAddress;
    if (!spender || diamond === null || spender.toLowerCase() !== diamond.toLowerCase())
        return `approval address ${spender ?? "none"} is not the diamond ${diamond ?? "none"}`;
    return null;
}
