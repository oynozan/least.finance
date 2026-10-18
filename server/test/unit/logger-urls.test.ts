import { HttpRequestError } from "viem";
import { expect, test } from "vitest";
import { createLogger } from "../../src/logger.ts";

test("an RPC error written to the log keeps its host and loses the provider key and the request body", () => {
    let text = "";
    const logger = createLogger(
        { LOG_LEVEL: "info", NODE_ENV: "production" },
        { write: (chunk: string) => void (text += chunk) },
    );
    const error = new HttpRequestError({
        url: "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123?apikey=QUERYKEY",
        body: { method: "eth_getBalance", params: ["0xabc"] },
        details: "fetch failed for https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123",
    });
    logger.warn({ err: new Error("outer", { cause: error }) }, "Couldn't read a balance");
    expect(text).not.toContain("SECRETKEY123");
    expect(text).not.toContain("QUERYKEY");
    expect(text).not.toContain("eth_getBalance");
    expect(text).toContain("eth-mainnet.g.alchemy.com");
});
