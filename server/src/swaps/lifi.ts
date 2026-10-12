import { z } from "zod";

/** A token as the swaps code uses it; `priceUSD` is null when LI.FI gave no usable price. */
export type LifiToken = { chainId: number; address: string; symbol: string; decimals: number; priceUSD: number | null };

export type Lifi = { tokens(chainIds: readonly number[]): Promise<LifiToken[]> };

const DEFAULT_TIMEOUT_MS = 15_000;

const rawToken = z.object({
    chainId: z.number().int(),
    address: z.string().min(1),
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(255),
    priceUSD: z.unknown().optional(),
});

const answer = z.object({ tokens: z.record(z.string(), z.unknown()) });

// LI.FI sends prices as strings; anything that isn't a positive number is no price
function priceOf(value: unknown): number | null {
    const price = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(price) && price > 0 ? price : null;
}

/** LI.FI's REST API, which only the server calls. */
export function createLifi(options: { url: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }): Lifi {
    const { url, apiKey, fetch: fetchLifi = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    return {
        async tokens(chainIds) {
            const response = await fetchLifi(`${url}/v1/tokens?chains=${chainIds.join(",")}&chainTypes=EVM,SVM`, {
                headers: apiKey ? { "x-lifi-api-key": apiKey } : {},
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) throw new Error(`LI.FI answered ${response.status} for its token list`);
            const { tokens } = answer.parse(await response.json());

            const found: LifiToken[] = [];
            for (const chainId of chainIds) {
                const listed = tokens[String(chainId)];
                if (!Array.isArray(listed)) continue;
                for (const candidate of listed) {
                    const parsed = rawToken.safeParse(candidate);
                    if (!parsed.success) continue;
                    const { priceUSD, ...token } = parsed.data;
                    found.push({ ...token, priceUSD: priceOf(priceUSD) });
                }
            }
            return found;
        },
    };
}
