import { HttpRequestError } from "viem";
import { expect, test } from "vitest";
import { createLogger } from "../../src/logger.ts";
import { RepeatGate, ago, amountOf, dollars, sendRefusal, upstreamSaid } from "../../src/trading/failures.ts";
import { alreadySent, refused, refusedBy } from "../../src/trading/send-errors.ts";
import { SolanaRefusal } from "../../src/trading/solana-sender.ts";

const KEY_URL = "https://eth-mainnet.g.alchemy.com/v2/SECRET-KEY";

test("an RPC error logged as err carries the host of the node, never its key", () => {
    let text = "";
    const logger = createLogger(
        { LOG_LEVEL: "info", NODE_ENV: "production" },
        { write: (chunk: string) => void (text += chunk) },
    );
    const error = new HttpRequestError({ url: KEY_URL, body: { method: "eth_call" }, details: "rate limited" });

    logger.error({ err: error }, "The RPC failed");

    expect(text).not.toContain("SECRET-KEY");
    expect(text).toContain("https://eth-mainnet.g.alchemy.com");
    expect(JSON.parse(text).err.message).toContain("rate limited");
});

test("what an upstream said keeps the library's summary and the node's details and drops the URL", () => {
    const error = new HttpRequestError({
        url: KEY_URL,
        body: {},
        details: "execution reverted: ERC20: transfer amount exceeds balance",
    });

    const said = upstreamSaid(error);

    expect(said).toBe("HTTP request failed.: execution reverted: ERC20: transfer amount exceeds balance");
    expect(said).not.toContain("SECRET-KEY");
    expect(upstreamSaid(new Error("plain\nsecond line"))).toBe("plain");
    expect(upstreamSaid("a string")).toBe("a string");
});

test("a refusal is read from what the node said, not from the URL or body printed under it", () => {
    const viaUrl = new HttpRequestError({ url: "https://rpc.test/insufficient-funds", body: {}, details: "timeout" });
    expect(refused(viaUrl)).toBe(false);

    expect(refusedBy(new Error("insufficient funds for gas * price + value"))).toBe("insufficient funds");
    expect(refusedBy(new Error("outer", { cause: new Error("execution reverted: nope") }))).toBe("execution reverted");
    expect(refusedBy(new SolanaRefusal("x"))).toBe("solana refusal");
    expect(refusedBy(new Error("timeout"))).toBeNull();
    expect(alreadySent(new Error("Nonce too low"))).toBe(true);
    expect(alreadySent(viaUrl)).toBe(false);
});

test("each known refusal of a send reads as its own sentence and keeps the network's words", () => {
    const ctx = { symbol: "USDT", network: "Base" };
    const cases: [string, string, string][] = [
        [
            "insufficient funds for gas * price + value",
            "out_of_gas",
            "Our sending wallet is out of gas on Base, so the send was refused.",
        ],
        [
            "execution reverted: ERC20: transfer amount exceeds balance",
            "inventory_short",
            "Our sending wallet doesn't hold enough USDT on Base right now.",
        ],
        [
            "replacement transaction underpriced",
            "fee_too_low",
            'Base refused the send\'s fee: "replacement transaction underpriced".',
        ],
        ["invalid address 0xabc", "bad_address", 'Base refused the address: "invalid address 0xabc".'],
        ["execution reverted: paused", "reverted", 'Base rejected the transfer: "execution reverted: paused".'],
    ];
    for (const [said, reason, sentence] of cases) {
        expect(sendRefusal(new Error(said), ctx)).toMatchObject({
            reason,
            detail: said,
            message: `${sentence} Your USDT is back in your holdings.`,
        });
    }
});

test("a Solana refusal keeps its code and error, and a rent refusal reads plainly", () => {
    const rent = new SolanaRefusal("Transaction simulation failed", {
        code: -32002,
        data: { err: "InsufficientFundsForRent" },
    });

    expect(sendRefusal(rent, { symbol: "SOL", network: "Solana" })).toMatchObject({
        reason: "rent",
        detail: 'Transaction simulation failed (code -32002, "InsufficientFundsForRent")',
        message:
            "The send would leave a Solana account below its minimum balance, so Solana refused it. Your SOL is back in your holdings.",
    });
});

test("the same failure is let through once, then once per interval with the count left out", () => {
    let now = 0;
    const gate = new RepeatGate(1000, () => now);

    expect(gate.note("a", "down")).toEqual({ skipped: 0 });
    expect(gate.note("a", "down")).toBeNull();
    expect(gate.note("a", "down")).toBeNull();
    expect(gate.note("b", "down")).toEqual({ skipped: 0 });
    expect(gate.note("a", "other")).toEqual({ skipped: 0 });
    expect(gate.note("a", "other")).toBeNull();
    now = 1000;
    expect(gate.note("a", "other")).toEqual({ skipped: 1 });
    gate.clear("a");
    expect(gate.note("a", "other")).toEqual({ skipped: 0 });
});

test("amounts read the way a person says them", () => {
    expect(dollars(600n * 10n ** 18n)).toBe("$600.00");
    expect(dollars(1234567n * 10n ** 16n)).toBe("$12,345.67");
    expect(dollars(10n ** 17n)).toBe("$0.10");
    expect(dollars(0n)).toBe("$0");
    expect(amountOf(123456789012345678n)).toBe("0.12345678");
    expect(amountOf(5n * 10n ** 18n)).toBe("5");
    expect(ago(90_000)).toBe("90 seconds");
    expect(ago(400_000)).toBe("7 minutes");
});
