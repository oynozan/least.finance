import { expect, test } from "vitest";
import { withdrawalReason } from "../../src/withdrawals/views.ts";

test("a known stored failure becomes a sentence, an unknown one is quoted, a missing one says it was ours", () => {
    expect(withdrawalReason("Rejected by the network")).toBe("The network rejected the transfer.");
    expect(withdrawalReason("Burn reverted on the network")).toBe("The transfer was reverted on the network.");
    expect(withdrawalReason("Circle said: fee too low")).toBe('The withdrawal failed: "Circle said: fee too low".');
    expect(withdrawalReason(null)).toBe("The withdrawal failed on our side.");
});
