import { expect, test } from "vitest";
import { createLogger } from "../../src/logger.ts";

test("secrets never reach a log line", () => {
    let text = "";
    const logger = createLogger(
        { LOG_LEVEL: "info", NODE_ENV: "production" },
        { write: (chunk: string) => void (text += chunk) },
    );
    logger.info(
        {
            req: { headers: { authorization: "Bearer a", cookie: "b", "x-api-key": "c" } },
            res: { headers: { "set-cookie": "d" } },
            token: "e",
            wallet: { mnemonic: "f", privateKey: "g", apiKey: "h", secret: "i" },
        },
        "hello",
    );
    for (const secret of ["Bearer a", '"b"', '"c"', '"d"', '"e"', '"f"', '"g"', '"h"', '"i"']) {
        expect(text).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
});
