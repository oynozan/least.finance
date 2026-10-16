import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { parseUnits } from "viem";
import { z } from "zod";
import { ARC_RPC_URLS, NATIVE_DECIMALS } from "./chain/arc.ts";

const list = (fallback: readonly string[]) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const items = (value ?? "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
            return items.length > 0 ? items : [...fallback];
        });

/** The public RPCs each chain falls back to when its variable is unset. */
const DEFAULT_RPC_URLS = {
    ARC_RPC_URLS,
    ETHEREUM_RPC_URLS: ["https://ethereum-rpc.publicnode.com"],
    BNB_RPC_URLS: ["https://bsc-dataseed.bnbchain.org"],
    ARBITRUM_RPC_URLS: ["https://arb1.arbitrum.io/rpc"],
    BASE_RPC_URLS: ["https://mainnet.base.org"],
    OPTIMISM_RPC_URLS: ["https://mainnet.optimism.io"],
    POLYGON_RPC_URLS: ["https://polygon.drpc.org"],
    AVALANCHE_RPC_URLS: ["https://api.avax.network/ext/bc/C/rpc"],
    SOLANA_RPC_URLS: ["https://api.mainnet-beta.solana.com"],
} as const satisfies Record<string, readonly string[]>;

const SOLANA_ALLOWED_PROGRAMS = [
    "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
] as const;

/** An optional secret: left blank in the .env file, it's the same as unset. */
const optionalKey = z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined);

const hex = (digits: number, what: string) =>
    optionalKey.refine((value) => value === undefined || new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(value), what);

const usdc = z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/, "a USDC amount such as 0.01")
    .transform((value) => parseUnits(value, NATIVE_DECIMALS));

const fields = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /** Unset, it listens on every interface, IPv6 included (so `localhost` reaches it on macOS too). */
    HOST: z.string().min(1).optional(),
    PORT: z.coerce.number().int().min(0).max(65_535).default(4500),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Origins allowed to call the API, comma-separated. */
    CORS_ORIGINS: list(["http://localhost:3000"]),
    /** How many reverse proxies sit in front, so client IPs (and rate limits) come from the right hop. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    /** Socket connections a minute from one IP. Users behind one NAT share it, so it's generous. */
    SOCKET_HANDSHAKES_PER_MINUTE: z.coerce.number().int().min(1).default(120),

    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().min(1).default("TradeEverything"),

    PRIVY_APP_ID: z.string().min(1),
    PRIVY_APP_SECRET: z.string().min(1),
    /** The PEM verification key from the Privy dashboard; saves fetching it. `\n` escapes are allowed. */
    PRIVY_VERIFICATION_KEY: z
        .string()
        .optional()
        .transform((key) => key?.replaceAll("\\n", "\n") || undefined),
    PRIVY_API_URL: z.url().optional(),

    ARC_RPC_URLS: list(DEFAULT_RPC_URLS.ARC_RPC_URLS),
    /** BIP-39 phrase every account's deposit address is derived from. Losing it loses the deposits. */
    DEPOSIT_MNEMONIC: z
        .string()
        .transform((phrase) => phrase.trim().split(/\s+/).join(" "))
        .refine((phrase) => validateMnemonic(phrase, wordlist), "a valid BIP-39 mnemonic"),
    DEPOSIT_MIN_USDC: usdc.default(parseUnits("0.01", NATIVE_DECIMALS)),
    WITHDRAW_MIN_USDC: usdc
        .refine((wei) => wei > 0n, "a USDC amount above 0")
        .default(parseUnits("0.01", NATIVE_DECIMALS)),
    DEPOSIT_POLL_MS: z.coerce.number().int().min(100).default(1_000),
    /** Blocks to wait past the one holding a deposit. Arc's finality is instant, so none by default. */
    DEPOSIT_CONFIRMATIONS: z.coerce.number().int().min(0).default(0),
    /** Blocks the chain scan stays behind the head, so a lagging node behind a load balancer can't make it skip any. */
    DEPOSIT_SCAN_LAG_BLOCKS: z.coerce.number().int().min(0).default(3),
    /** Blocks per log query. Arc's public RPC caps results at 2000, and bigger ranges get split anyway. */
    DEPOSIT_SCAN_RANGE: z.coerce.number().int().min(1).max(10_000).default(500),
    /** Where the very first scan starts; otherwise at the oldest account, or the chain head. */
    DEPOSIT_START_BLOCK: z.coerce.number().int().min(0).optional(),
    /** How long a reported transaction may take to show up on chain. */
    DEPOSIT_RECEIPT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

    /** RPCs for the chains deposits are bridged from, tried in order. */
    ETHEREUM_RPC_URLS: list(DEFAULT_RPC_URLS.ETHEREUM_RPC_URLS),
    BNB_RPC_URLS: list(DEFAULT_RPC_URLS.BNB_RPC_URLS),
    /** RPCs for the other EVM networks swaps read wallets' holdings from, tried in order. */
    ARBITRUM_RPC_URLS: list(DEFAULT_RPC_URLS.ARBITRUM_RPC_URLS),
    BASE_RPC_URLS: list(DEFAULT_RPC_URLS.BASE_RPC_URLS),
    OPTIMISM_RPC_URLS: list(DEFAULT_RPC_URLS.OPTIMISM_RPC_URLS),
    POLYGON_RPC_URLS: list(DEFAULT_RPC_URLS.POLYGON_RPC_URLS),
    AVALANCHE_RPC_URLS: list(DEFAULT_RPC_URLS.AVALANCHE_RPC_URLS),
    /** RPCs for reading Solana wallets' balances, tried in order. */
    SOLANA_RPC_URLS: list(DEFAULT_RPC_URLS.SOLANA_RPC_URLS),
    /** Deposits from a linked Solana wallet are open only while this is on. */
    SOLANA_DEPOSITS: z.enum(["on", "off"]).default("off"),
    /** Withdrawals to a linked Solana wallet are open only while this is on. */
    SOLANA_WITHDRAWALS: z.enum(["on", "off"]).default("off"),
    /** Solana deposits quoted below this many dollars are refused. */
    SOLANA_DEPOSIT_MIN_USD: z.coerce.number().positive().default(2),
    SOLANA_WITHDRAW_MIN_USDC: usdc
        .refine((wei) => wei > 0n, "a USDC amount above 0")
        .default(parseUnits("1", NATIVE_DECIMALS)),
    /** How far the USDC received may fall short of the amount less the shown fee. */
    SOLANA_WITHDRAW_FEE_TOLERANCE: usdc.default(parseUnits("0.05", NATIVE_DECIMALS)),
    /** Programs a Relay quote's instructions may call: Relay's depository, System, Token, Associated Token, Compute Budget. */
    SOLANA_ALLOWED_PROGRAMS: list(SOLANA_ALLOWED_PROGRAMS),
    CIRCLE_IRIS_URL: z.url().default("https://iris-api.circle.com"),
    RELAY_API_KEY: optionalKey,
    ACROSS_API_KEY: optionalKey,
    ACROSS_INTEGRATOR_ID: optionalKey,
    /** How often a bridge order's status is checked. */
    ORDER_POLL_MS: z.coerce.number().int().min(100).default(1_500),

    POLYMARKET_GAMMA_URL: z.url().default("https://gamma-api.polymarket.com"),
    POLYMARKET_CLOB_URL: z.url().default("https://clob.polymarket.com"),
    /** How often the top Polymarket events are re-read. */
    MARKETS_SYNC_MS: z.coerce.number().int().min(1_000).default(60_000),

    LIFI_URL: z.url().default("https://li.quest"),
    LIFI_API_KEY: optionalKey,
    /** Names the app to LI.FI; it allows letters, digits, dots, dashes and underscores, up to 23. */
    LIFI_INTEGRATOR: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,23}$/)
        .default("least-finance"),
    /** The share of each swap kept as our fee, from 0 up to but not including 0.1 (10%). */
    LIFI_FEE: z.coerce.number().min(0).lt(0.1).default(0),
    /** How often the swap coins' prices are re-read from LI.FI; trades refuse a price not read for three of these. */
    SWAPS_CATALOG_SYNC_MS: z.coerce.number().int().min(10_000).default(60_000),
    /** How often sent swaps are checked for ones that are due a status call. */
    SWAPS_POLL_MS: z.coerce.number().int().min(100).default(2_000),

    /** DefiLlama's coin prices API; with a Pro key, `https://pro-api.llama.fi/<key>/coins`. */
    DEFILLAMA_COINS_URL: z.url().default("https://coins.llama.fi"),

    /** Real orders go to Polymarket only while this is on. */
    PREDICTIONS_TRADING: z.enum(["on", "off"]).default("off"),
    /** Owner key of the pool's Polymarket deposit wallet. */
    POLYMARKET_POOL_KEY: hex(64, "0x followed by 64 hex digits"),
    POLYMARKET_BUILDER_API_KEY: optionalKey,
    POLYMARKET_BUILDER_API_SECRET: optionalKey,
    POLYMARKET_BUILDER_API_PASSPHRASE: optionalKey,
    /** Attributes the pool's orders to our builder profile. */
    POLYMARKET_BUILDER_CODE: hex(64, "0x followed by 64 hex digits"),
    /** Pins the deposit wallet; otherwise it's derived from the pool key. */
    POLYMARKET_DEPOSIT_WALLET: hex(40, "an address"),
    POLYGON_RPC_URL: z.url().default("https://polygon.drpc.org"),
    POLYMARKET_RELAYER_URL: z.url().default("https://relayer-v2.polymarket.com"),
    POLYMARKET_DATA_URL: z.url().default("https://data-api.polymarket.com"),
    /** The pool's pUSD float; warnings fire well under and over it. */
    POLYMARKET_FLOAT_USD: z.coerce.number().positive().default(100),
    /** How often unsettled prediction orders are checked. */
    PREDICTIONS_POLL_MS: z.coerce.number().int().min(100).default(2_000),
    /** How often open positions' markets are checked for a resolution. */
    PREDICTIONS_RESOLVE_MS: z.coerce.number().int().min(100).default(60_000),

    /** The pool rebalancer moves money between the Arc treasury and the pool only while this is on. */
    POOL_REBALANCE: z.enum(["on", "off"]).default("off"),
    /** The largest single move, in dollars. */
    POOL_REBALANCE_MAX_MOVE_USD: z.coerce.number().positive().default(100),
    /** The most that may move from Arc to Polygon in 24 hours, in dollars. */
    POOL_REBALANCE_MAX_DAY_USD: z.coerce.number().positive().default(300),
    /** What the treasury keeps after a top-up, on top of pending withdrawals and gas, in dollars. */
    POOL_REBALANCE_ARC_RESERVE_USD: z.coerce.number().min(0).default(100),
    /** The smallest automatic move, in dollars. */
    POOL_REBALANCE_MIN_MOVE_USD: z.coerce.number().positive().default(10),
    /** Minutes to wait after a move before deciding again. */
    POOL_REBALANCE_PAUSE_MIN: z.coerce.number().min(0).default(5),

    /** Held coins are sent out to the person's wallet only while this is on; off, requests are refused. */
    COIN_WITHDRAWALS: z.enum(["on", "off"]).default("off"),
    /** The hedger buys and sells the net of account trades on the market only while this is on. */
    TRADE_HEDGING: z.enum(["on", "off"]).default("off"),

    /** Real orders go to Hyperliquid only while this is on. */
    PERPS_TRADING: z.enum(["on", "off"]).default("off"),
    HYPERLIQUID_API_URL: z.url().default("https://api.hyperliquid.xyz"),
    /** The master Hyperliquid float; warnings fire well under and over it. */
    PERPS_FLOAT_USD: z.coerce.number().positive().default(200),
    /** The most an opening order may be allowed to fill past the book's price, in basis points; each order is given only what its size and the book need, up to this. */
    PERPS_OPEN_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(9_999).default(300),
    /** The same for a closing order. */
    PERPS_CLOSE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(9_999).default(500),
    PERPS_MAX_LEVERAGE: z.coerce.number().int().min(1).max(50).default(20),
    /** How far the master's Hyperliquid balance may differ from the books before it's flagged. */
    PERPS_RECONCILE_TOLERANCE_USD: z.coerce.number().min(0).default(5),
});

const TRADING_SECRETS = [
    "POLYMARKET_POOL_KEY",
    "POLYMARKET_BUILDER_API_KEY",
    "POLYMARKET_BUILDER_API_SECRET",
    "POLYMARKET_BUILDER_API_PASSPHRASE",
] as const;

const isHttpsPublicOrigin = (origin: string) => {
    try {
        const url = new URL(origin);
        return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
        return false;
    }
};

const hasMongoCredentials = (uri: string) => /^mongodb(\+srv)?:\/\/[^/@\s]+@/.test(uri);

const schema = fields.superRefine((config, context) => {
    if (config.NODE_ENV === "production") {
        const bad = config.CORS_ORIGINS.filter((origin) => !isHttpsPublicOrigin(origin));
        if (bad.length > 0)
            context.addIssue({
                code: "custom",
                path: ["CORS_ORIGINS"],
                message: `must be public https:// origins in production, not ${bad.join(", ")}`,
            });
        if (config.TRUST_PROXY < 1)
            context.addIssue({ code: "custom", path: ["TRUST_PROXY"], message: "must be 1 or more in production" });
        if (!hasMongoCredentials(config.MONGODB_URI))
            context.addIssue({
                code: "custom",
                path: ["MONGODB_URI"],
                message: "must carry credentials (user:password@) in production",
            });
    }
    if (config.POOL_REBALANCE_MIN_MOVE_USD > config.POOL_REBALANCE_MAX_MOVE_USD)
        context.addIssue({
            code: "custom",
            path: ["POOL_REBALANCE_MIN_MOVE_USD"],
            message: "must not be above POOL_REBALANCE_MAX_MOVE_USD",
        });
    const switches = (["PREDICTIONS_TRADING", "POOL_REBALANCE"] as const)
        .filter((name) => config[name] === "on")
        .map((name) => `${name}=on`);
    if (switches.length === 0) return;
    for (const name of TRADING_SECRETS) {
        if (!config[name])
            context.addIssue({ code: "custom", path: [name], message: `required when ${switches.join(" and ")}` });
    }
});

export type Config = z.output<typeof schema>;

/** Reads and checks the environment, naming every bad variable at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = schema.safeParse(env);
    if (parsed.success) return parsed.data;
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join("\n")}`);
}

/** One line per chain whose RPC list is still only the built-in public defaults. */
export function publicRpcWarnings(config: Config): string[] {
    return Object.entries(DEFAULT_RPC_URLS)
        .filter(([name, defaults]) => {
            const urls = config[name as keyof typeof DEFAULT_RPC_URLS];
            return urls.length === defaults.length && urls.every((url, i) => url === defaults[i]);
        })
        .map(([name]) => `${name} is only the built-in public RPCs; set it to a dedicated provider`);
}
