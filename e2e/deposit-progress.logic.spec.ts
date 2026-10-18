import { expect, test } from "@playwright/test";
import { explorerOf, outcomeText, shownOrder } from "@/components/deposit-progress";
import type { DepositOrderView } from "@/server/src/protocol";

const order = (overrides: Partial<DepositOrderView> = {}): DepositOrderView => ({
    id: "a".repeat(24),
    coin: "ethereum:ETH",
    amount: "0.1",
    wallet: "0x00000000000000000000000000000000000000c3",
    usdcOut: "300",
    etaSeconds: 30,
    state: "failed",
    sourceTxHashes: [`0x${"ab".repeat(32)}`],
    depositId: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:10.000Z",
    ...overrides,
});

test("a failed or refunded order shows the server's reason, and the short label only when there is none", () => {
    const message = "The transaction reverted on Ethereum, so nothing was bridged. Your ETH stays in your wallet.";
    expect(outcomeText(order({ message }))).toBe(message);
    expect(outcomeText(order())).toBe("Didn't go through");
    expect(outcomeText(order({ state: "refunded" }))).toBe("Refunded to your wallet");
    expect(outcomeText(order({ state: "refunded", message: "Relay refunded this deposit to your wallet." }))).toBe(
        "Relay refunded this deposit to your wallet.",
    );
    expect(outcomeText(order({ state: "bridging", message: "Circle is holding the transfer." }))).toBeNull();
});

test("each source chain has its explorer, and an order the wallet hasn't reported has none", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(explorerOf(order())).toEqual({ name: "Etherscan", url: `https://etherscan.io/tx/${hash}` });
    expect(explorerOf(order({ coin: "bnb:USDT" }))).toEqual({ name: "BscScan", url: `https://bscscan.com/tx/${hash}` });
    expect(explorerOf(order({ coin: "solana:SOL", sourceTxHashes: ["5sig"] }))).toEqual({
        name: "Solscan",
        url: "https://solscan.io/tx/5sig",
    });
    expect(explorerOf(order({ sourceTxHashes: [] }))).toBeNull();
});

test("a failed order that just ended is shown, one that ended long before the page opened is not", () => {
    const since = Date.parse("2026-10-16T00:00:00.000Z");
    expect(shownOrder([order()], null, since)?.id).toBe("a".repeat(24));
    expect(shownOrder([order({ updatedAt: "2026-10-15T00:00:00.000Z" })], null, since)).toBeNull();
});

test("an expired order says why it expired, when it was reported or opened this visit and not otherwise", () => {
    const since = Date.parse("2026-10-16T00:00:00.000Z");
    const message = "Your wallet never sent this deposit, so the order expired. Nothing was taken.";
    const expired = (overrides: Partial<DepositOrderView> = {}) => order({ state: "expired", message, ...overrides });
    expect(outcomeText(expired())).toBe(message);
    expect(outcomeText(expired({ message: undefined }))).toBe("The order expired");
    // Opened this visit
    expect(
        shownOrder([expired({ sourceTxHashes: [], createdAt: "2026-10-16T00:00:01.000Z" })], null, since)?.state,
    ).toBe("expired");
    // Reported before the page opened, expired while it was open
    expect(shownOrder([expired({ createdAt: "2026-10-15T00:00:00.000Z" })], null, since)?.state).toBe("expired");
    // Never reported and opened before this visit
    expect(
        shownOrder([expired({ sourceTxHashes: [], createdAt: "2026-10-15T00:00:00.000Z" })], null, since),
    ).toBeNull();
    // Expired long before the page opened
    expect(shownOrder([expired({ updatedAt: "2026-10-15T00:00:00.000Z" })], null, since)).toBeNull();
});
