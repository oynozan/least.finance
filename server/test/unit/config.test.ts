import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { loadConfig, publicRpcWarnings } from "../../src/config.ts";

const MNEMONIC = "test test test test test test test test test test test junk";
const base = {
    MONGODB_URI: "mongodb://localhost:27017",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    DEPOSIT_MNEMONIC: MNEMONIC,
};
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });
const SECRETS = {
    POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_BUILDER_API_KEY: "k",
    POLYMARKET_BUILDER_API_SECRET: "s",
    POLYMARKET_BUILDER_API_PASSPHRASE: "p",
};
const TRADING_SECRETS = Object.keys(SECRETS);

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

    it("PREDICTIONS_TRADING=on still names its four secrets", () => {
        let message = "";
        try {
            load({ PREDICTIONS_TRADING: "on" });
        } catch (error) {
            message = (error as Error).message;
        }
        for (const name of TRADING_SECRETS) expect(message).toContain(`${name}: required when PREDICTIONS_TRADING=on`);
        expect(message).not.toContain("POOL_REBALANCE=on");
    });

    it("pool rebalancing defaults", () => {
        const config = load();
        expect(config.POOL_REBALANCE).toBe("off");
        expect(config.POOL_REBALANCE_MAX_MOVE_USD).toBe(100);
        expect(config.POOL_REBALANCE_MAX_DAY_USD).toBe(300);
        expect(config.POOL_REBALANCE_ARC_RESERVE_USD).toBe(100);
        expect(config.POOL_REBALANCE_MIN_MOVE_USD).toBe(10);
        expect(config.POOL_REBALANCE_PAUSE_MIN).toBe(5);
    });

    it("POOL_REBALANCE=on without the pool key and builder secrets names each missing one, with trading off", () => {
        let message = "";
        try {
            load({ POOL_REBALANCE: "on" });
        } catch (error) {
            message = (error as Error).message;
        }
        for (const name of TRADING_SECRETS) expect(message).toContain(`${name}: required when POOL_REBALANCE=on`);
        expect(message).not.toContain("PREDICTIONS_TRADING=on");
    });

    it("POOL_REBALANCE=on with the four secrets loads", () => {
        const config = load({ POOL_REBALANCE: "on", ...SECRETS });
        expect(config.POOL_REBALANCE).toBe("on");
        expect(config.PREDICTIONS_TRADING).toBe("off");
        expect(config.POLYMARKET_POOL_KEY).toBe(SECRETS.POLYMARKET_POOL_KEY);
    });

    it("both switches on name both in each missing secret's message", () => {
        expect(() => load({ POOL_REBALANCE: "on", PREDICTIONS_TRADING: "on" })).toThrow(
            /POLYMARKET_POOL_KEY: required when PREDICTIONS_TRADING=on and POOL_REBALANCE=on/,
        );
    });

    it("a minimum move above the maximum move is refused", () => {
        expect(() => load({ POOL_REBALANCE_MIN_MOVE_USD: "50", POOL_REBALANCE_MAX_MOVE_USD: "40" })).toThrow(
            /POOL_REBALANCE_MIN_MOVE_USD/,
        );
        const config = load({ POOL_REBALANCE_MIN_MOVE_USD: "40", POOL_REBALANCE_MAX_MOVE_USD: "40" });
        expect(config.POOL_REBALANCE_MIN_MOVE_USD).toBe(40);
    });

    it("pool rebalancing limits: the reserve and the pause may be 0, the moves and the day total may not", () => {
        const config = load({ POOL_REBALANCE_ARC_RESERVE_USD: "0", POOL_REBALANCE_PAUSE_MIN: "0" });
        expect(config.POOL_REBALANCE_ARC_RESERVE_USD).toBe(0);
        expect(config.POOL_REBALANCE_PAUSE_MIN).toBe(0);
        for (const name of [
            "POOL_REBALANCE_MAX_MOVE_USD",
            "POOL_REBALANCE_MAX_DAY_USD",
            "POOL_REBALANCE_MIN_MOVE_USD",
        ]) {
            expect(() => load({ [name]: "0" })).toThrow(new RegExp(name));
        }
        expect(() => load({ POOL_REBALANCE_ARC_RESERVE_USD: "-1" })).toThrow(/POOL_REBALANCE_ARC_RESERVE_USD/);
        expect(() => load({ POOL_REBALANCE_PAUSE_MIN: "-1" })).toThrow(/POOL_REBALANCE_PAUSE_MIN/);
        expect(() => load({ POOL_REBALANCE: "maybe" })).toThrow(/POOL_REBALANCE/);
    });

    it("perps defaults", () => {
        const config = load();
        expect(config.PERPS_TRADING).toBe("off");
        expect(config.PERPS_FLOAT_USD).toBe(200);
        expect(config.PERPS_OPEN_MAX_SLIPPAGE_BPS).toBe(300);
        expect(config.PERPS_CLOSE_MAX_SLIPPAGE_BPS).toBe(500);
        expect(config.PERPS_MAX_LEVERAGE).toBe(20);
        expect(config.PERPS_RECONCILE_TOLERANCE_USD).toBe(5);
        expect(config.HYPERLIQUID_API_URL).toBe("https://api.hyperliquid.xyz");
    });

    it("PERPS_TRADING=on needs no extra secret", () => {
        expect(load({ PERPS_TRADING: "on" }).PERPS_TRADING).toBe("on");
    });

    it("PERPS_MAX_LEVERAGE stays within 1 to 50", () => {
        expect(() => load({ PERPS_MAX_LEVERAGE: "0" })).toThrow(/PERPS_MAX_LEVERAGE/);
        expect(() => load({ PERPS_MAX_LEVERAGE: "51" })).toThrow(/PERPS_MAX_LEVERAGE/);
    });

    it("Solana switches are off by default", () => {
        const config = load();
        expect(config.SOLANA_DEPOSITS).toBe("off");
        expect(config.SOLANA_WITHDRAWALS).toBe("off");
        expect(config.SOLANA_DEPOSIT_MIN_USD).toBe(2);
        expect(config.SOLANA_WITHDRAW_FEE_TOLERANCE).toBe(parseUnits("0.05", 18));
    });

    it("SOLANA_WITHDRAW_MIN_USDC defaults to 1 USDC in wei", () => {
        expect(load().SOLANA_WITHDRAW_MIN_USDC).toBe(parseUnits("1", 18));
        expect(load({ SOLANA_WITHDRAW_MIN_USDC: "2.5" }).SOLANA_WITHDRAW_MIN_USDC).toBe(parseUnits("2.5", 18));
    });

    it("SOLANA_ALLOWED_PROGRAMS defaults to the five programs", () => {
        expect(load().SOLANA_ALLOWED_PROGRAMS).toEqual([
            "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
            "11111111111111111111111111111111",
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
            "ComputeBudget111111111111111111111111111111",
        ]);
        expect(load({ SOLANA_ALLOWED_PROGRAMS: "A, B" }).SOLANA_ALLOWED_PROGRAMS).toEqual(["A", "B"]);
    });

    it("CIRCLE_IRIS_URL defaults to https://iris-api.circle.com", () => {
        expect(load().CIRCLE_IRIS_URL).toBe("https://iris-api.circle.com");
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
        expect(config.SWAPS_CATALOG_SYNC_MS).toBe(60_000);
    });

    it("reads the LI.FI settings, treating a blank key as unset", () => {
        const config = load({
            LIFI_URL: "https://lifi.example",
            LIFI_API_KEY: "key",
            LIFI_INTEGRATOR: "my_app.1",
            SWAPS_CATALOG_SYNC_MS: "10000",
        });
        expect(config.LIFI_URL).toBe("https://lifi.example");
        expect(config.LIFI_API_KEY).toBe("key");
        expect(config.LIFI_INTEGRATOR).toBe("my_app.1");
        expect(config.SWAPS_CATALOG_SYNC_MS).toBe(10_000);
        expect(load({ LIFI_API_KEY: "  " }).LIFI_API_KEY).toBeUndefined();
    });

    it.each(["least finance", "", "a".repeat(24)])("rejects a LI.FI integrator of '%s'", (value) => {
        expect(() => load({ LIFI_INTEGRATOR: value })).toThrow(/LIFI_INTEGRATOR/);
    });

    it("ignores the LI.FI fee and the swap status poll that an older env file still sets", () => {
        const config = load({ LIFI_FEE: "0.5", SWAPS_POLL_MS: "1" });
        expect(config).not.toHaveProperty("LIFI_FEE");
        expect(config).not.toHaveProperty("SWAPS_POLL_MS");
    });

    it("rejects a LI.FI URL that isn't one, and a catalog sync under 10 seconds", () => {
        expect(() => load({ LIFI_URL: "li.quest" })).toThrow(/LIFI_URL/);
        expect(() => load({ SWAPS_CATALOG_SYNC_MS: "9999" })).toThrow(/SWAPS_CATALOG_SYNC_MS/);
    });

    it("rejects an out-of-range port", () => {
        expect(() => load({ PORT: "70000" })).toThrow(/PORT/);
    });
});

describe("production refusals", () => {
    const safe = {
        NODE_ENV: "production",
        CORS_ORIGINS: "https://least.finance",
        TRUST_PROXY: "1",
        MONGODB_URI: "mongodb://app:pw@mongo:27017/?replicaSet=rs0",
    };
    const unsafe = {
        CORS_ORIGINS: "https://least.finance,http://localhost:3000",
        TRUST_PROXY: "0",
        MONGODB_URI: "mongodb://mongo:27017",
    };
    const message = (extra: Record<string, string>) => {
        try {
            load(extra);
        } catch (error) {
            return (error as Error).message;
        }
        return "";
    };

    it("accepts safe production settings", () => {
        expect(load(safe).NODE_ENV).toBe("production");
    });

    it("names every unsafe setting at once", () => {
        const text = message({ ...safe, ...unsafe });
        for (const name of ["CORS_ORIGINS", "TRUST_PROXY", "MONGODB_URI"]) expect(text).toContain(name);
    });

    it("refuses localhost, 127.0.0.1 and non-https origins", () => {
        for (const origin of ["http://localhost:3000", "https://127.0.0.1", "http://least.finance", "least.finance"]) {
            expect(message({ ...safe, CORS_ORIGINS: origin })).toContain("CORS_ORIGINS");
        }
    });

    it("refuses a trusted proxy count of 0 and an unset one", () => {
        expect(message({ ...safe, TRUST_PROXY: "0" })).toContain("TRUST_PROXY");
        const rest: Record<string, string> = { ...safe };
        delete rest.TRUST_PROXY;
        expect(message(rest)).toContain("TRUST_PROXY");
    });

    it("accepts a Mongo URI with credentials, including srv, and refuses one without", () => {
        expect(message({ ...safe, MONGODB_URI: "mongodb+srv://u:p@cluster.example.net/db" })).toBe("");
        expect(message({ ...safe, MONGODB_URI: "mongodb+srv://cluster.example.net/db" })).toContain("MONGODB_URI");
    });

    it("changes nothing in development or test", () => {
        for (const NODE_ENV of ["development", "test"]) expect(() => load({ ...unsafe, NODE_ENV })).not.toThrow();
        expect(() => load(unsafe)).not.toThrow();
    });
});

describe("publicRpcWarnings", () => {
    it("names exactly the chains left on the built-in RPCs", () => {
        expect(publicRpcWarnings(load())).toHaveLength(9);
        const warnings = publicRpcWarnings(
            load({ BASE_RPC_URLS: "https://rpc.example/base", ARC_RPC_URLS: "https://a" }),
        );
        expect(warnings).toHaveLength(7);
        expect(warnings.join("\n")).not.toContain("BASE_RPC_URLS");
        expect(warnings.join("\n")).not.toContain("ARC_RPC_URLS");
        expect(warnings.join("\n")).toContain("SOLANA_RPC_URLS");
    });

    it("is empty when every chain has its own RPC", () => {
        const names = ["ARC", "ETHEREUM", "BNB", "ARBITRUM", "BASE", "OPTIMISM", "POLYGON", "AVALANCHE", "SOLANA"];
        const env = Object.fromEntries(names.map((name) => [`${name}_RPC_URLS`, `https://rpc.example/${name}`]));
        expect(publicRpcWarnings(load(env))).toEqual([]);
    });
});

describe("solanaOpen", () => {
    it("throws unavailable while the switch is off and passes when it is on", async () => {
        const { solanaOpen } = await import("../../src/crosschain/solana-switch.ts");
        expect(() => solanaOpen(load(), "deposits")).toThrow("Solana isn't open yet.");
        expect(() => solanaOpen(load({ SOLANA_DEPOSITS: "on" }), "withdrawals")).toThrow(/open yet/);
        expect(() => solanaOpen(load({ SOLANA_DEPOSITS: "on" }), "deposits")).not.toThrow();
    });
});
