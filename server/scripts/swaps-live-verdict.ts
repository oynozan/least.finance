import type { LifiStatus } from "../src/swaps/lifi.ts";

// A DONE status counts as a pass only when the ordered token arrived and LI.FI did not report PARTIAL or REFUNDED
export function spendVerdict(
    status: LifiStatus,
    expectedToken: string,
): { done: true } | { done: false; reason: string } {
    if (status.substatus === "PARTIAL" || status.substatus === "REFUNDED")
        return { done: false, reason: `LI.FI finished with ${status.substatus}` };
    if (!status.receiving) return { done: false, reason: "LI.FI reported no received token" };
    if (status.receiving.tokenAddress.toLowerCase() !== expectedToken.toLowerCase())
        return { done: false, reason: `received ${status.receiving.tokenAddress} instead of ${expectedToken}` };
    return { done: true };
}
