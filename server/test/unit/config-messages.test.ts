import { expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";

const base = {
    MONGODB_URI: "mongodb://localhost:27017",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    DEPOSIT_MNEMONIC: "test test test test test test test test test test test junk",
};

const message = (env: Record<string, string>) => {
    try {
        loadConfig(env);
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as Error).message;
    }
    throw new Error("expected loadConfig to refuse");
};

it("says a missing variable is not set and a wrong one what it must be", () => {
    expect(message({ ...base, PRIVY_APP_ID: undefined as never })).toContain("PRIVY_APP_ID is not set");
    expect(message({ ...base, DEPOSIT_MIN_USDC: "abc" })).toContain(
        "DEPOSIT_MIN_USDC must be a USDC amount such as 0.01",
    );
});

it("never echoes the value it was given", () => {
    const text = message({ ...base, DEPOSIT_MNEMONIC: "super secret words that are not a phrase" });
    expect(text).toContain("DEPOSIT_MNEMONIC must be a valid BIP-39 mnemonic");
    expect(text).not.toContain("super secret");
});
