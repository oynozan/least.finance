import { expect, test } from "vitest";
import { createLifi, type LifiError, type LifiQuoteRequest } from "../../src/swaps/lifi.ts";

const request: LifiQuoteRequest = {
    fromChain: 8453,
    toChain: 8453,
    fromToken: "0x1",
    toToken: "0x2",
    fromAddress: "0x3",
    toAddress: "0x3",
    fromAmount: "50000000",
    integrator: "least-finance",
};

const answering = (status: number, body: unknown) =>
    createLifi({ url: "http://lifi.test", fetch: async () => Response.json(body, { status }) });

test("a refusal keeps LI.FI's status, code and words on the error and in its message", async () => {
    const body = {
        code: 1007,
        message: "Slippage exceeded",
        errors: [{ message: "Price impact too high", errorType: "SLIPPAGE" }],
    };

    const error = await answering(400, body)
        .quote(request)
        .catch((caught: LifiError) => caught);

    expect(error).toMatchObject({
        kind: "unavailable",
        said: { status: 400, code: 1007, upstream: "Price impact too high", errorTypes: ["SLIPPAGE"] },
    });
    expect((error as LifiError).message).toBe('LI.FI answered 400 (code 1007) for a quote: "Price impact too high"');
});

test("a rejected API key is its own kind, whichever way LI.FI says it", async () => {
    for (const [status, body] of [
        [401, { message: "Invalid key" }],
        [403, { message: "Forbidden" }],
        [400, { code: 1010, message: "Unauthorized" }],
    ] as const) {
        await expect(answering(status, body).quote(request)).rejects.toMatchObject({ kind: "unauthorized" });
    }
});

test("a rate limit by code is rate_limited, and the chains, status and token reads keep LI.FI's words too", async () => {
    await expect(answering(400, { code: 1005, message: "Slow" }).quote(request)).rejects.toMatchObject({
        kind: "rate_limited",
    });
    const refused = answering(502, { message: "Nope" });
    await expect(refused.chains()).rejects.toThrow('answered 502 for its chains: "Nope"');
    await expect(refused.status({ txHash: "0xa", fromChain: 1, toChain: 8453 })).rejects.toThrow(
        'answered 502 for a status: "Nope"',
    );
    await expect(refused.tokens([1, 10])).rejects.toThrow('answered 502 for its token list on chains 1,10: "Nope"');
});

test("an answer in the wrong shape names the endpoint and the field", async () => {
    await expect(answering(200, { tokens: "x" }).tokens([1])).rejects.toThrow(/\/v1\/tokens answer has a bad tokens/);
});

test("a timeout and a refused connection read differently", async () => {
    const slow = createLifi({
        url: "http://lifi.test",
        timeoutMs: 20,
        fetch: (_input, init) =>
            new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    });
    await expect(slow.tokens([1])).rejects.toThrow("LI.FI didn't answer /v1/tokens in 0 seconds");

    const down = createLifi({
        url: "http://lifi.test",
        fetch: async () => {
            throw new TypeError("fetch failed");
        },
    });
    await expect(down.tokens([1])).rejects.toThrow("LI.FI could not be reached for /v1/tokens");
});

test("a status keeps LI.FI's own sentence for the substatus", async () => {
    const lifi = answering(200, { status: "FAILED", substatus: "SLIPPAGE_EXCEEDED", substatusMessage: "Too much slippage" });

    expect(await lifi.status({ txHash: "0xa", fromChain: 1, toChain: 8453 })).toMatchObject({
        status: "FAILED",
        substatus: "SLIPPAGE_EXCEEDED",
        substatusMessage: "Too much slippage",
    });
});
