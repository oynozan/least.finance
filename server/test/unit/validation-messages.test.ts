import { expect, test } from "vitest";
import { AppError } from "../../src/errors.ts";
import { coinWithdraw, perpQuote, predictionOrder, parse, withdrawRequest } from "../../src/validation.ts";

const refusal = (schema: Parameters<typeof parse>[0], input: unknown) => {
    try {
        parse(schema, input);
    } catch (error) {
        return error as AppError;
    }
    throw new Error("expected a refusal");
};

const UUID = "11111111-1111-4111-8111-111111111111";

test("a short destination address is not a wallet address, and the log keeps zod's own words", () => {
    const error = refusal(withdrawRequest, { requestId: UUID, amount: "12.5", to: "abc" });
    expect(error.message).toBe("Enter the full wallet address (32 to 64 characters).");
    expect(error.detail).toContain("to: ");
});

test("a missing field is called missing, by name", () => {
    expect(refusal(withdrawRequest, { amount: "12.5", to: "x".repeat(40) }).message).toBe("The request id is missing.");
});

test("a bad amount says what to enter", () => {
    const error = refusal(withdrawRequest, { requestId: UUID, amount: "twelve", to: "x".repeat(40) });
    expect(error.message).toBe("Enter an amount such as 12.5, with at most 6 decimals.");
});

test("a price outside 0 to 1 says so", () => {
    const error = refusal(predictionOrder, {
        eventId: "1",
        tokenId: "2",
        amountUSD: "5",
        requestId: UUID,
        quotedPrice: 1.5,
    });
    expect(error.message).toBe("The price must be between 0 and 1.");
});

test("a choice outside the options lists them", () => {
    const error = refusal(perpQuote, { asset: "BTC", side: "sideways", leverage: 2, collateralUSD: "10" });
    expect(error.message).toBe("The side must be one of long, short.");
});

test("a coin send with a short address is refused the same way", () => {
    expect(refusal(coinWithdraw, { requestId: UUID, symbol: "ETH", units: "1", to: "0x1" }).message).toBe(
        "Enter the full wallet address (32 to 64 characters).",
    );
});
