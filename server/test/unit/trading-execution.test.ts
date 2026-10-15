import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { createTradingExecution } from "../../src/trading/execution.ts";

const keyring = createKeyring("test test test test test test test test test test test junk");

const build = (TRADE_HEDGING: "on" | "off", COIN_WITHDRAWALS: "on" | "off") =>
    createTradingExecution({
        config: { TRADE_HEDGING, COIN_WITHDRAWALS, LIFI_INTEGRATOR: "test", SOLANA_RPC_URLS: ["http://127.0.0.1:9"] },
        keyring,
        database: { client: {} as never, collections: {} as never },
        lifi: {} as never,
        clients: {} as never,
        solana: {} as never,
        logger: pino({ level: "silent" }),
    });

describe("trading execution", () => {
    test("builds only the workers whose switch is on", () => {
        expect(build("off", "off")).toMatchObject({ hedger: null, sender: null });
        const hedgingOnly = build("on", "off");
        expect(hedgingOnly.hedger).not.toBeNull();
        expect(hedgingOnly.sender).toBeNull();
        const sendingOnly = build("off", "on");
        expect(sendingOnly.hedger).toBeNull();
        expect(sendingOnly.sender).not.toBeNull();
    });

    test("stopping workers that never started is harmless", async () => {
        await build("on", "on").stop();
    });
});
