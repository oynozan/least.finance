import { expect, test } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import {
    delayMessage,
    FORWARD_FAILED,
    orderFailureMessage,
    refusalMessage,
    throttle,
    UpstreamRefusal,
} from "../../src/crosschain/failures.ts";
import { brief, hostOf, refOf, shortOf } from "../../src/errors.ts";

const ETH = coinByKey("ethereum:ETH");
const refused = (provider: string, code: string | null, message = "words") =>
    new UpstreamRefusal({ provider, status: 400, code, message });

test("each known Relay and Across code has its plain sentence", () => {
    const sentence = (provider: string, code: string) => refusalMessage(refused(provider, code), ETH);
    expect(sentence("relay", "AMOUNT_TOO_LOW")).toEqual({
        message: "Relay's minimum for this route is higher than that. Try a larger amount.",
        known: true,
    });
    expect(sentence("relay", "INSUFFICIENT_LIQUIDITY").message).toBe(
        "Relay doesn't have enough liquidity on this route right now. Try a smaller amount or try again later.",
    );
    expect(sentence("relay", "UNSUPPORTED_ROUTE").message).toBe(
        "Relay can't bridge ETH from Ethereum to Arc right now.",
    );
    expect(sentence("relay", "SWAP_IMPACT_TOO_HIGH").message).toBe(
        "That deposit would lose too much to price impact. Try a smaller amount.",
    );
    expect(sentence("relay", "SANCTIONED_WALLET_ADDRESS").message).toBe("Relay refuses this wallet or coin.");
    expect(sentence("relay", "SOLANA_TX_TOO_LARGE").message).toBe(
        "Relay couldn't fit this Solana deposit in one transaction. Try a smaller amount.",
    );
    expect(sentence("across", "AMOUNT_TOO_LOW").message).toBe(
        "Across' minimum for this route is higher than that. Try a larger amount.",
    );
    expect(sentence("across", "AMOUNT_TOO_HIGH").message).toBe("That's more than Across can bridge in one go.");
    expect(sentence("across", "ROUTE_NOT_ENABLED").message).toBe("Across doesn't bridge ETH to Arc.");
    expect(sentence("across", "SWAP_LIQUIDITY_INSUFFICIENT").message).toBe(
        "Across has no quote or liquidity for this right now.",
    );
});

test("a refusal nobody maps shows the bridge's own words, trimmed to one quoted line", () => {
    expect(refusalMessage(refused("relay", "SOMETHING_NEW", "Slippage\n  too high.  "), ETH)).toEqual({
        message: 'Relay refused the deposit: "Slippage too high".',
        known: false,
    });
    const long = refusalMessage(refused("across", null, "x".repeat(500)), ETH).message;
    expect(long.length).toBeLessThan(200);
    expect(refusalMessage(refused("across", null, ""), ETH).message).toBe("Across refused the deposit (400).");
});

test("Circle's hold reasons are explained, and an unknown one is quoted", () => {
    expect(delayMessage("insufficient_fee")).toBe(
        "Circle is holding the transfer because its fee changed; it will mint when the fee is covered.",
    );
    expect(delayMessage("amount_above_max")).toBe("Circle won't mint a transfer this large in one go.");
    expect(delayMessage("new_reason")).toBe('Circle is holding the transfer: "new_reason".');
});

test("each way an order ends has its own sentence", () => {
    const order = { provider: "relay", coin: ETH, ref: "a1b2c3" };
    const say = (code: Parameters<typeof orderFailureMessage>[1]["code"], detail = "") =>
        orderFailureMessage(order, { code, detail });
    expect(say("source_reverted")).toBe(
        "The transaction reverted on Ethereum, so nothing was bridged. Your ETH stays in your wallet; only the network fee was spent.",
    );
    expect(say("source_replaced")).toContain("replaced that transaction");
    expect(say("source_failed", '{"InstructionError":[2,{"Custom":1}]}')).toBe(
        'Solana rejected the transaction ({"InstructionError":[2,{"Custom":1}]}). Nothing left your wallet except the network fee.',
    );
    expect(say("source_not_found")).toBe(
        "Solana never confirmed the transaction within 10 minutes; it was probably dropped. Nothing was sent.",
    );
    expect(say("bridge_refunded", "Destination reverted")).toBe(
        'Relay refunded this deposit to your wallet, saying: "Destination reverted".',
    );
    expect(say("bridge_refunded")).toBe("Relay refunded this deposit to your wallet.");
    expect(say("bridge_failed", "Fill failed")).toBe(
        'Relay couldn\'t finish this deposit, saying: "Fill failed". If your ETH already left your wallet, it is refunded to it.',
    );
    expect(say("expired")).toBe("Your wallet never sent this deposit, so the order expired. Nothing was taken.");
    expect(say("given_up")).toContain("ref a1b2c3");
    expect(
        orderFailureMessage({ ...order, provider: "cctp" }, { code: "bridge_failed", detail: `${FORWARD_FAILED}: {}` }),
    ).toBe(
        "Circle's forwarder failed to mint on Arc. Your USDC is burned on Solana and needs manual recovery (ref a1b2c3).",
    );
});

test("the shared helpers trim, shorten and never print an RPC key", () => {
    expect(brief("  a\n b  ")).toBe("a b");
    expect(brief("x".repeat(300), 20)).toHaveLength(20);
    expect(refOf("66e0a1b2c3d4e5f6a7b8c9d0")).toBe("b8c9d0");
    expect(shortOf("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortOf("short")).toBe("short");
    expect(hostOf("https://mainnet.example.com/v2/SECRETKEY?x=1")).toBe("mainnet.example.com");
    expect(hostOf("not a url")).toBe("unknown host");
});

test("a throttle says yes once per window per key", () => {
    let now = 0;
    const again = throttle(1_000, () => now);
    expect(again("a")).toBe(true);
    expect(again("a")).toBe(false);
    expect(again("b")).toBe(true);
    now = 1_000;
    expect(again("a")).toBe(true);
});
