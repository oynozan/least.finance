import { z } from "zod";
import { AppError } from "./errors.ts";

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

/** Parses client input, turning a mismatch into a 400 that names the field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const result = schema.safeParse(input ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw new AppError("bad_request", field ? `Invalid ${field}: ${issue?.message}` : "Invalid request.");
}
