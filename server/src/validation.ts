import { z } from "zod";
import { AppError } from "./errors.ts";

export const depositReport = z.object({
    txHash: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{64}$/, "a transaction hash")
        .transform((hash) => hash.toLowerCase() as `0x${string}`),
});

export const depositPage = z.object({
    before: z
        .string()
        .regex(/^[0-9a-f]{24}$/i, "a deposit id")
        .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Parses client input, turning a mismatch into a 400 that names the field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const result = schema.safeParse(input ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw new AppError("bad_request", field ? `Invalid ${field}: ${issue?.message}` : "Invalid request.");
}
