import { expect, test } from "vitest";
import { networkSays, refused, upstreamLine } from "../../src/trading/send-errors.ts";

const viemError = (shortMessage: string, details: string, code?: number) =>
    Object.assign(new Error(`${shortMessage}\n\nRequest Arguments:\n  from: 0x01\n\nDetails: ${details}`), {
        shortMessage,
        details,
        ...(code !== undefined && { cause: { message: details, code } }),
    });

test("upstreamLine keeps viem's headline and the node's own details on one line, with the code", () => {
    const error = viemError(
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
        "insufficient funds for gas * price + value: address 0x01 have 0 want 5",
        -32000,
    );
    expect(upstreamLine(error)).toBe(
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account. - insufficient funds for gas * price + value: address 0x01 have 0 want 5 (code -32000)",
    );
});

test("upstreamLine trims a long multi-line message to one short line", () => {
    const line = upstreamLine(new Error(`first\n${"x".repeat(500)}`));
    expect(line).toBe("first");
    expect(upstreamLine(new Error("y".repeat(500))).length).toBe(240);
});

test.each([
    [
        "insufficient funds for gas * price + value",
        "Our payout wallet can't cover the network fee right now, so the network refused it.",
    ],
    ["replacement transaction underpriced", "The network wanted a higher fee than we offered."],
    ["intrinsic gas too low", "The network says the gas limit was too low."],
    ["invalid sender", "The network refused the destination address."],
])("a node saying %s becomes a plain sentence", (said, plain) => {
    expect(networkSays(new Error(said))).toBe(plain);
    expect(refused(new Error(said))).toBe(true);
});

test("a reverted token transfer says the contract rejected it and quotes the node", () => {
    expect(networkSays(new Error("execution reverted: blocked"))).toBe(
        'The token contract rejected the transfer (for example because the receiving address is blocked): "execution reverted: blocked".',
    );
});

test("a Solana refusal for lack of funds is ours, and any other is quoted", () => {
    const refusal = (message: string) => Object.assign(new Error(message), { name: "SolanaRefusal" });
    expect(networkSays(refusal("Attempt to debit an account but found no record of a prior credit."))).toBe(
        "Our Solana wallet can't pay for this transfer right now (balance or fees).",
    );
    expect(networkSays(refusal("Transaction simulation failed: custom program error: 0x1"))).toBe(
        'The Solana network rejected the transfer: "Transaction simulation failed: custom program error: 0x1".',
    );
});

test("a refusal we don't know is quoted, not swallowed", () => {
    const error = new Error("txpool is full");
    expect(refused(error)).toBe(false);
    expect(networkSays(error)).toBe('The network refused it: "txpool is full".');
});
