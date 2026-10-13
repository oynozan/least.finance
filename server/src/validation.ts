import { z } from "zod";
import { AppError } from "./errors.ts";
import { NETWORKS, type NetworkId } from "./swaps/coins.ts";

export const depositReport = z.object({
    txHash: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{64}$/, "a transaction hash")
        .transform((hash) => hash.toLowerCase() as `0x${string}`),
});

const txHash = depositReport.shape.txHash;

export const coinWalletAmount = z.object({
    coin: z.string().min(3).max(32),
    amount: z.string().regex(/^\d+(\.\d+)?$/, "an amount such as 0.5"),
    wallet: z.string().trim().min(32).max(64),
});

export const sourceReport = z.object({
    orderId: z.string().regex(/^[0-9a-f]{24}$/i, "an order id"),
    txHashes: z.array(txHash).min(1).max(4),
});

export const depositPage = z.object({
    before: z
        .string()
        .regex(/^[0-9a-f]{24}$/i, "a deposit id")
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const marketSearch = z.object({ q: z.string().max(100) });

export const marketId = z.string().regex(/^\d{1,12}$/, "a market id");

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

const swapSide = z.object({
    token: z.string().trim().min(1).max(16),
    network: z.enum(NETWORKS.map((network) => network.id) as [NetworkId, ...NetworkId[]]),
});

export const swapRequest = z.object({
    from: swapSide,
    to: swapSide,
    amountUSD: z
        .string()
        .regex(/^\d{1,9}(\.\d{1,6})?$/, "an amount such as 10.50")
        .refine((amount) => Number(amount) > 0, "an amount over zero"),
    wallet: z.string().trim().min(32).max(64),
    receiver: z.string().trim().min(32).max(64),
});

export const swapOrder = swapRequest.extend({
    reviewedMin: z.string().regex(/^\d{1,30}(\.\d{1,30})?$/, "an amount such as 0.5"),
});

// An EVM hash is 0x and 64 hex digits; a Solana signature is 64 bytes in base58
const swapTxHash = z
    .string()
    .trim()
    .regex(/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/, "a transaction hash")
    .transform((hash) => (hash.startsWith("0x") ? hash.toLowerCase() : hash));

export const swapSent = z.object({
    orderId: sourceReport.shape.orderId,
    txHashes: z.array(swapTxHash).min(1).max(4),
});

export const withdrawRequest = z.object({
    requestId: z.uuid(),
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "an amount such as 12.5"),
    to: z.string().trim().min(32).max(64),
});

/** Parses client input, turning a mismatch into a 400 that names the field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const result = schema.safeParse(input ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw new AppError("bad_request", field ? `Invalid ${field}: ${issue?.message}` : "Invalid request.");
}
