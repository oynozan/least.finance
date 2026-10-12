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

    it("rejects an out-of-range port", () => {
        expect(() => load({ PORT: "70000" })).toThrow(/PORT/);
    });
});
