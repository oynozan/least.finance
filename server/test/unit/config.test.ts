import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";

const MNEMONIC = "test test test test test test test test test test test junk";
const base = {
    MONGODB_URI: "mongodb://localhost:27017",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    DEPOSIT_MNEMONIC: MNEMONIC,
};
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });

describe("loadConfig", () => {
    it("names every missing required variable in one error", () => {
        let message = "";
        try {
            loadConfig({});
        } catch (error) {
            message = (error as Error).message;
        }
        for (const name of ["MONGODB_URI", "PRIVY_APP_ID", "PRIVY_APP_SECRET", "DEPOSIT_MNEMONIC"]) {
            expect(message).toContain(name);
        }
    });

    it("Polymarket URLs and the sync interval have defaults", () => {
        const config = load();
        expect(config.POLYMARKET_GAMMA_URL).toBe("https://gamma-api.polymarket.com");
        expect(config.POLYMARKET_CLOB_URL).toBe("https://clob.polymarket.com");
        expect(config.MARKETS_SYNC_MS).toBe(60_000);
    });

    it("trading defaults to off", () => {
        const config = load();
        expect(config.PREDICTIONS_TRADING).toBe("off");
        expect(config.POLYMARKET_FLOAT_USD).toBe(100);
        expect(config.PREDICTIONS_POLL_MS).toBe(2_000);
        expect(config.SWAPS_POLL_MS).toBe(2_000);
        expect(config.POLYGON_RPC_URL).toBe("https://polygon.drpc.org");
        expect(config.POLYMARKET_POOL_KEY).toBeUndefined();
    });

    it("trading on without the pool key or builder secrets names each missing one", () => {
        let message = "";
        try {
            load({ PREDICTIONS_TRADING: "on" });
        } catch (error) {
            message = (error as Error).message;
        }
        for (const name of [
            "POLYMARKET_POOL_KEY",
            "POLYMARKET_BUILDER_API_KEY",
            "POLYMARKET_BUILDER_API_SECRET",
            "POLYMARKET_BUILDER_API_PASSPHRASE",
        ]) {
            expect(message).toContain(name);
        }
        const key = `0x${"1".repeat(64)}`;
        const config = load({
            PREDICTIONS_TRADING: "on",
            POLYMARKET_POOL_KEY: key,
            POLYMARKET_BUILDER_API_KEY: "k",
            POLYMARKET_BUILDER_API_SECRET: "s",
            POLYMARKET_BUILDER_API_PASSPHRASE: "p",
        });
        expect(config.POLYMARKET_POOL_KEY).toBe(key);
    });

    it("fills in defaults", () => {
        const config = load();
        expect(config.PORT).toBe(4500);
        expect(config.MONGODB_DB).toBe("TradeEverything");
        expect(config.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
        expect(config.ARC_RPC_URLS).toEqual([
            "https://rpc.mainnet.arc.io",
            "https://rpc.blockdaemon.mainnet.arc.io",
            "https://rpc.drpc.mainnet.arc.io",
        ]);
        expect(config.DEPOSIT_MIN_USDC).toBe(10n ** 16n);
        expect(config.TRUST_PROXY).toBe(0);
        expect(config.DEPOSIT_CONFIRMATIONS).toBe(0);
    });

    it("parses CORS origins, ignoring spaces and empty entries", () => {
        const config = load({ CORS_ORIGINS: " https://a.example , ,https://b.example,, " });
        expect(config.CORS_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    });

    it("falls back to the default origin when CORS_ORIGINS has nothing in it", () => {
        expect(load({ CORS_ORIGINS: " , " }).CORS_ORIGINS).toEqual(["http://localhost:3000"]);
    });

    it("rejects an invalid mnemonic", () => {
        expect(() => load({ DEPOSIT_MNEMONIC: "not a real mnemonic phrase" })).toThrow(/DEPOSIT_MNEMONIC/);
    });

    it("normalises whitespace in the mnemonic", () => {
        const messy = `  ${MNEMONIC.replaceAll(" ", "\n  ")}\t `;
        expect(load({ DEPOSIT_MNEMONIC: messy }).DEPOSIT_MNEMONIC).toBe(MNEMONIC);
    });

    it("turns \\n escapes in the Privy verification key into newlines", () => {
        const config = load({ PRIVY_VERIFICATION_KEY: "-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----" });
        expect(config.PRIVY_VERIFICATION_KEY).toBe("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----");
    });

    it("treats an empty verification key as unset", () => {
        expect(load({ PRIVY_VERIFICATION_KEY: "" }).PRIVY_VERIFICATION_KEY).toBeUndefined();
    });

    it("parses the minimum deposit in USDC", () => {
        expect(load({ DEPOSIT_MIN_USDC: "0.5" }).DEPOSIT_MIN_USDC).toBe(5n * 10n ** 17n);
        expect(load({ DEPOSIT_MIN_USDC: "2" }).DEPOSIT_MIN_USDC).toBe(2n * 10n ** 18n);
        expect(load({ DEPOSIT_MIN_USDC: "0.000000000000000001" }).DEPOSIT_MIN_USDC).toBe(1n);
    });

    it.each(["1e3", "-1", "0.1234567890123456789", "abc", ".5", ""])("rejects a minimum deposit of '%s'", (value) => {
        expect(() => load({ DEPOSIT_MIN_USDC: value })).toThrow(/DEPOSIT_MIN_USDC/);
    });

    it("defaults the minimum withdrawal to 0.01 USDC and parses an override", () => {
        expect(load().WITHDRAW_MIN_USDC).toBe(parseUnits("0.01", 18));
        expect(load({ WITHDRAW_MIN_USDC: "0.5" }).WITHDRAW_MIN_USDC).toBe(parseUnits("0.5", 18));
    });

    it.each(["0", "0.0"])("rejects a minimum withdrawal of '%s'", (value) => {
        expect(() => load({ WITHDRAW_MIN_USDC: value })).toThrow(/WITHDRAW_MIN_USDC/);
    });

    it("defaults the Ethereum and BNB Chain RPCs to public ones", () => {
        const config = load();
        expect(config.ETHEREUM_RPC_URLS).toEqual(["https://ethereum-rpc.publicnode.com"]);
        expect(config.BNB_RPC_URLS).toEqual(["https://bsc-dataseed.bnbchain.org"]);
    });

    it("parses comma lists of source-chain RPCs, ignoring spaces and empty entries", () => {
        const config = load({
            ETHEREUM_RPC_URLS: " https://eth-a.example , ,https://eth-b.example,",
            BNB_RPC_URLS: "https://bnb-a.example",
        });
        expect(config.ETHEREUM_RPC_URLS).toEqual(["https://eth-a.example", "https://eth-b.example"]);
        expect(config.BNB_RPC_URLS).toEqual(["https://bnb-a.example"]);
    });

    it("defaults the Solana RPC to the public one, and parses an override", () => {
        expect(load().SOLANA_RPC_URLS).toEqual(["https://api.mainnet-beta.solana.com"]);
        expect(load({ SOLANA_RPC_URLS: " https://sol-a.example ,https://sol-b.example," }).SOLANA_RPC_URLS).toEqual([
            "https://sol-a.example",
            "https://sol-b.example",
        ]);
    });

    it("leaves the bridge provider keys unset until given", () => {
        const config = load();
        expect(config.RELAY_API_KEY).toBeUndefined();
        expect(config.ACROSS_API_KEY).toBeUndefined();
        expect(config.ACROSS_INTEGRATOR_ID).toBeUndefined();
        const set = load({ RELAY_API_KEY: "relay-key", ACROSS_API_KEY: "across-key", ACROSS_INTEGRATOR_ID: "0xabcd" });
        expect(set.RELAY_API_KEY).toBe("relay-key");
        expect(set.ACROSS_API_KEY).toBe("across-key");
        expect(set.ACROSS_INTEGRATOR_ID).toBe("0xabcd");
    });

    it("polls bridge orders every 1.5 seconds unless told otherwise, and not faster than 100 ms", () => {
        expect(load().ORDER_POLL_MS).toBe(1_500);
        expect(load({ ORDER_POLL_MS: "100" }).ORDER_POLL_MS).toBe(100);
        expect(() => load({ ORDER_POLL_MS: "50" })).toThrow(/ORDER_POLL_MS/);
    });

    it("defaults the LI.FI settings and the swap catalog sync", () => {
        const config = load();
        expect(config.LIFI_URL).toBe("https://li.quest");
        expect(config.LIFI_API_KEY).toBeUndefined();
        expect(config.LIFI_INTEGRATOR).toBe("least-finance");
        expect(config.LIFI_FEE).toBe(0);
        expect(config.SWAPS_CATALOG_SYNC_MS).toBe(300_000);
    });

    it("reads the LI.FI settings, treating a blank key as unset", () => {
        const config = load({
            LIFI_URL: "https://lifi.example",
            LIFI_API_KEY: "key",
            LIFI_INTEGRATOR: "my_app.1",
            LIFI_FEE: "0.005",
            SWAPS_CATALOG_SYNC_MS: "10000",
        });
        expect(config.LIFI_URL).toBe("https://lifi.example");
        expect(config.LIFI_API_KEY).toBe("key");
        expect(config.LIFI_INTEGRATOR).toBe("my_app.1");
        expect(config.LIFI_FEE).toBe(0.005);
        expect(config.SWAPS_CATALOG_SYNC_MS).toBe(10_000);
        expect(load({ LIFI_API_KEY: "  " }).LIFI_API_KEY).toBeUndefined();
    });

    it.each(["least finance", "", "a".repeat(24)])("rejects a LI.FI integrator of '%s'", (value) => {
        expect(() => load({ LIFI_INTEGRATOR: value })).toThrow(/LIFI_INTEGRATOR/);
    });

    it.each(["0.2", "0.1", "-0.01", "abc"])("rejects a LI.FI fee of '%s'", (value) => {
        expect(() => load({ LIFI_FEE: value })).toThrow(/LIFI_FEE/);
    });

    it("rejects a LI.FI URL that isn't one, and a catalog sync under 10 seconds", () => {
        expect(() => load({ LIFI_URL: "li.quest" })).toThrow(/LIFI_URL/);
        expect(() => load({ SWAPS_CATALOG_SYNC_MS: "9999" })).toThrow(/SWAPS_CATALOG_SYNC_MS/);
    });

    it("rejects an out-of-range port", () => {
        expect(() => load({ PORT: "70000" })).toThrow(/PORT/);
    });
});
