import { z } from "zod";
import { AppError } from "./errors.ts";
import { PRICE_RANGES } from "./prices/history.ts";
import { COINS } from "./swaps/coins.ts";

export const depositReport = z.object({
    txHash: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{64}$/, "a transaction hash")
        .transform((hash) => hash.toLowerCase() as `0x${string}`),
});

export const coinWalletAmount = z.object({
    coin: z.string().min(3).max(32),
    amount: z.string().regex(/^\d+(\.\d+)?$/, "an amount such as 0.5"),
    wallet: z.string().trim().min(32).max(64),
});

// An EVM hash is 0x and 64 hex digits; a Solana signature is 64 bytes in base58
const swapTxHash = z
    .string()
    .trim()
    .regex(/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/, "a transaction hash")
    .transform((hash) => (hash.startsWith("0x") ? hash.toLowerCase() : hash));

export const sourceReport = z.object({
    orderId: z.string().regex(/^[0-9a-f]{24}$/i, "an order id"),
    txHashes: z.array(swapTxHash).min(1).max(4),
});

export const depositPage = z.object({
    before: z
        .string()
        .regex(/^[0-9a-f]{24}$/i, "a deposit id")
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const activityPage = z.object({
    before: z
        .string()
        .regex(/^\d{1,16}:\d:[0-9a-f]{24}$/, "a cursor from a previous page")
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    filter: z.enum(["all", "trades", "deposits"]).optional(),
});

export const marketSearch = z.object({ q: z.string().max(100) });

export const marketId = z.string().regex(/^\d{1,12}$/, "a market id");

export const marketHistoryQuery = z.object({
    // Comma-separated outcome token ids, one to five, each once
    outcomes: z
        .string()
        .max(500)
        .transform((list, ctx) => {
            const ids = list.split(",");
            const valid =
                ids.length <= 5 && ids.every((id) => /^\d{1,80}$/.test(id)) && new Set(ids).size === ids.length;
            if (valid) return ids;
            ctx.addIssue({ code: "custom", message: "one to five different outcome token ids, comma-separated" });
            return z.NEVER;
        }),
});

const SWAP_SYMBOLS = new Set(COINS.map((coin) => coin.symbol));

/** The most coins one price history request names; the web asks for one at a time, and each uncached perp market is a Hyperliquid read. */
const MAX_HISTORY_COINS = 3;

export const priceHistory = z.object({
    range: z.enum(PRICE_RANGES),
    // Comma-separated swap coins or perp markets, such as "ETH,kPEPE"; the swap coins when left out
    coins: z
        .string()
        .max(100)
        .optional()
        .transform((list, ctx) => {
            if (list === undefined) return undefined;
            const names = list.split(",").map((name) => name.trim());
            if (names.length <= MAX_HISTORY_COINS && names.every((name) => /^[A-Za-z0-9]{1,12}$/.test(name))) {
                // A market keeps its case (kPEPE); the service matches it against the listed names
                return [
                    ...new Set(names.map((name) => (SWAP_SYMBOLS.has(name.toUpperCase()) ? name.toUpperCase() : name))),
                ];
            }
            ctx.addIssue({
                code: "custom",
                message: `up to ${MAX_HISTORY_COINS} comma-separated coin symbols such as ETH,kPEPE`,
            });
            return z.NEVER;
        }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const predictionQuote = z.object({
    eventId: marketId,
    tokenId: z.string().regex(/^\d{1,80}$/, "a token id"),
    amountUSD: z
        .string()
        .regex(/^\d{1,9}(\.\d{1,2})?$/, "an amount such as 10.50")
        .refine((amount) => Number(amount) > 0, "an amount over zero"),
});

export const predictionOrder = predictionQuote.extend({
    requestId: z.string().regex(UUID, "a UUID"),
    quotedPrice: z.number().gt(0).lt(1),
});

export const sellQuote = z.object({ positionId: z.string().regex(/^[0-9a-f]{24}$/i, "a position id") });

export const predictionClose = sellQuote.extend({
    requestId: z.string().regex(UUID, "a UUID"),
    quotedPrice: z.number().gt(0).lt(1),
});

export const perpQuote = z.object({
    asset: z.string().regex(/^[A-Za-z0-9]{1,12}$/, "an asset such as BTC or kPEPE"),
    side: z.enum(["long", "short"]),
    leverage: z.number().int().min(1).max(100),
    collateralUSD: z
        .string()
        .regex(/^\d{1,9}(\.\d{1,6})?$/, "an amount such as 10.50")
        .refine((amount) => Number(amount) > 0, "an amount over zero"),
});

export const perpOrder = perpQuote.extend({ requestId: z.string().regex(UUID, "a UUID") });

export const perpClose = z.object({
    requestId: z.string().regex(UUID, "a UUID"),
    positionId: z.string().regex(/^[0-9a-f]{24}$/i, "a position id"),
});

const coinSymbol = z.string().regex(/^[A-Z0-9]{2,12}$/, "a coin symbol such as ETH");
const coinDecimal = z.string().regex(/^\d{1,15}(\.\d{1,18})?$/, "an amount such as 0.5");

export const tradeOrder = z.object({
    requestId: z.string().regex(UUID, "a UUID"),
    verb: z.enum(["buy", "sell", "swap"]),
    symbol: coinSymbol,
    toSymbol: coinSymbol.optional(),
    amountUSD: coinDecimal.optional(),
    units: coinDecimal.optional(),
    quotedPriceUSD: coinDecimal,
    quotedToPriceUSD: coinDecimal.optional(),
});

export const coinWithdraw = z.object({
    requestId: z.string().regex(UUID, "a UUID"),
    symbol: coinSymbol,
    units: coinDecimal,
    to: z.string().trim().min(32).max(64),
});

export const withdrawRequest = z.object({
    requestId: z.uuid(),
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "an amount such as 12.5"),
    to: z.string().trim().min(32).max(64),
    /** The fee the person reviewed; a Solana withdrawal is refused when the fee has since risen past it. */
    reviewedFee: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, "an amount such as 0.13")
        .optional(),
});

export const withdrawQuoteRequest = z.object({
    amount: withdrawRequest.shape.amount,
    to: withdrawRequest.shape.to,
});

export const pnlSeries = z.object({ tz: z.string().max(64) });

/** What each field is called in a sentence; a field not named here is its own name, spaced out. */
const FIELD_NAMES: Record<string, string> = {
    to: "The destination address",
    wallet: "The wallet address",
    amount: "The amount",
    amountUSD: "The amount",
    collateralUSD: "The amount",
    units: "The amount",
    requestId: "The request id",
    quotedPrice: "The price",
    quotedPriceUSD: "The price",
    quotedToPriceUSD: "The price",
    txHash: "The transaction hash",
    tz: "The time zone",
    eventId: "The market",
    tokenId: "The outcome",
    positionId: "The position",
    orderId: "The order",
    leverage: "The leverage",
    reviewedFee: "The fee",
    before: "The page position",
    limit: "The page size",
    filter: "The filter",
    outcomes: "The outcomes",
    coins: "The coins",
    q: "The search",
    range: "The range",
    symbol: "The coin",
    toSymbol: "The coin",
    coin: "The coin",
    verb: "The action",
    side: "The side",
    asset: "The market",
    txHashes: "The transaction hash",
};

const fieldName = (path: readonly PropertyKey[]) => {
    const key = path.filter((part) => typeof part === "string").at(-1) as string | undefined;
    if (!key) return "The request";
    return FIELD_NAMES[key] ?? `The ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`;
};

/** One zod issue as a sentence for the person, in place of zod's own wording. */
export function sayIssue(issue: z.core.$ZodIssue): string {
    const name = fieldName(issue.path);
    const address = /^(to|wallet)$/.test(String(issue.path.at(-1)));
    if (issue.code === "invalid_type" && issue.input === undefined) return `${name} is missing.`;
    if (issue.code === "invalid_type") return `${name} isn't the right kind of value.`;
    if (issue.code === "invalid_value") return `${name} must be one of ${issue.values.map(String).join(", ")}.`;
    if (issue.code === "too_small" || issue.code === "too_big") {
        if (address) return "That doesn't look like a wallet address.";
        if (issue.origin === "number") {
            return issue.code === "too_small"
                ? `${name} is too low.`
                : /price/i.test(name)
                  ? "The price must be between 0 and 1."
                  : `${name} is too high.`;
        }
        return `${name} is too ${issue.code === "too_small" ? "short" : "long"}.`;
    }
    if (issue.code === "invalid_format" || issue.code === "custom") {
        const wanted = issue.message;
        if (address) return "That doesn't look like a wallet address.";
        if (/^an amount/.test(wanted)) return `Enter ${wanted}.`;
        // A description of what was wanted, e.g. "a transaction hash"
        if (/^(a|an|one|up) /.test(wanted)) return `${name} should be ${wanted}.`;
        return `${name}: ${wanted}`;
    }
    return `${name} isn't valid.`;
}

/** Parses client input, turning a mismatch into a 400 that says in plain words what is wrong. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const result = schema.safeParse(input ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    // What the client really sent wrong, for the log: every issue with its path and zod's own words
    const detail = result.error.issues.map((each) => `${each.path.join(".") || "(body)"}: ${each.message}`).join("; ");
    throw new AppError("bad_request", issue ? sayIssue(issue) : "The request wasn't valid.", {
        detail: detail.slice(0, 300),
    });
}
