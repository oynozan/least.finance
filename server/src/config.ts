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

/** An optional secret: left blank in the .env file, it's the same as unset. */
const optionalKey = z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined);

const usdc = z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/, "a USDC amount such as 0.01")
    .transform((value) => parseUnits(value, NATIVE_DECIMALS));

const schema = z.object({
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

    ARC_RPC_URLS: list(ARC_RPC_URLS),
    /** BIP-39 phrase every account's deposit address is derived from. Losing it loses the deposits. */
    DEPOSIT_MNEMONIC: z
        .string()
        .transform((phrase) => phrase.trim().split(/\s+/).join(" "))
        .refine((phrase) => validateMnemonic(phrase, wordlist), "a valid BIP-39 mnemonic"),
    DEPOSIT_MIN_USDC: usdc.default(parseUnits("0.01", NATIVE_DECIMALS)),
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
    ETHEREUM_RPC_URLS: list(["https://ethereum-rpc.publicnode.com"]),
    BNB_RPC_URLS: list(["https://bsc-dataseed.bnbchain.org"]),
    /** RPCs for reading Solana wallets' balances, tried in order. */
    SOLANA_RPC_URLS: list(["https://api.mainnet-beta.solana.com"]),
    RELAY_API_KEY: optionalKey,
    ACROSS_API_KEY: optionalKey,
    ACROSS_INTEGRATOR_ID: optionalKey,
    /** How often a bridge order's status is checked. */
    ORDER_POLL_MS: z.coerce.number().int().min(100).default(1_500),
});

export type Config = z.output<typeof schema>;

/** Reads and checks the environment, naming every bad variable at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = schema.safeParse(env);
    if (parsed.success) return parsed.data;
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join("\n")}`);
}
