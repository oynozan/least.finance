import { z } from "zod";
import { readBody } from "../markets/upstream.ts";

/** DefiLlama's id for each swap coin, keyed by symbol. */
export const LLAMA_IDS: Readonly<Record<string, string>> = {
    ETH: "coingecko:ethereum",
    SOL: "coingecko:solana",
    BTC: "coingecko:bitcoin",
    USDC: "coingecko:usd-coin",
    USDT: "coingecko:tether",
    BNB: "coingecko:binancecoin",
    LINK: "coingecko:chainlink",
    DOGE: "coingecko:dogecoin",
    AVAX: "coingecko:avalanche-2",
    ARB: "coingecko:arbitrum",
    OP: "coingecko:optimism",
};

/** DefiLlama answers 400 to a chart over this many points, every coin's counted. */
export const MAX_POINTS = 500;

const TIMEOUT_MS = 10_000;

const chartBody = z.object({
    coins: z.record(z.string(), z.object({ prices: z.array(z.object({ timestamp: z.number(), price: z.number() })) })),
});

/** A dollar price at a moment: [unix ms, USD]. */
export type PricePoint = [number, number];

export type ChartRequest = {
    /** DefiLlama ids, such as `coingecko:ethereum`. */
    ids: readonly string[];
    /** Unix seconds of the last point. */
    end: number;
    /** Points per coin. */
    span: number;
    /** Time between points in DefiLlama's notation: `15m`, `1h`, `1d`. */
    period: string;
};

/** A failed read; `retryAfterMs` is set when DefiLlama asked us to wait. */
export class LlamaError extends Error {
    readonly status: number | null;
    readonly retryAfterMs: number | null;

    constructor(message: string, options: { status?: number; retryAfterMs?: number | null; cause?: unknown } = {}) {
        super(message, { cause: options.cause });
        this.name = "LlamaError";
        this.status = options.status ?? null;
        this.retryAfterMs = options.retryAfterMs ?? null;
    }
}

export type DefiLlama = {
    /** Each coin's prices, oldest first, keyed by id; a coin DefiLlama doesn't price is left out. */
    chart(request: ChartRequest): Promise<Map<string, PricePoint[]>>;
};

/**
 * DefiLlama's coin prices API. `url` is `https://coins.llama.fi`, or
 * `https://pro-api.llama.fi/<key>/coins` with a Pro key, so errors never
 * name the URL.
 */
export function createDefiLlama(options: { url: string; fetch?: typeof fetch }): DefiLlama {
    const base = options.url.replace(/\/+$/, "");
    const fetchChart = options.fetch ?? fetch;

    return {
        async chart({ ids, end, span, period }) {
            if (ids.length * span > MAX_POINTS)
                throw new LlamaError(`A chart of ${ids.length * span} points is over DefiLlama's ${MAX_POINTS}`);
            const query = new URLSearchParams({ end: String(end), span: String(span), period });
            // What was asked, never the URL, which holds the Pro key
            const asked = `${ids.length} coins, ${span} points, every ${period}`;
            let response: Response;
            try {
                response = await fetchChart(`${base}/chart/${ids.join(",")}?${query}`, {
                    headers: { accept: "application/json" },
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            } catch (error) {
                if (error instanceof Error && error.name === "TimeoutError")
                    throw new LlamaError(`DefiLlama didn't answer within ${TIMEOUT_MS / 1000} s (${asked})`, {
                        cause: error,
                    });
                const code = (error as { cause?: { code?: string } }).cause?.code;
                throw new LlamaError(`Couldn't reach DefiLlama${code ? ` (${code})` : ""} (${asked})`, {
                    cause: error,
                });
            }
            if (!response.ok) {
                const body = await readBody(response);
                throw new LlamaError(`DefiLlama answered ${response.status}${body ? `: "${body}"` : ""} (${asked})`, {
                    status: response.status,
                    retryAfterMs: retryAfter(response.headers.get("retry-after")),
                });
            }
            let body: z.infer<typeof chartBody>;
            try {
                body = chartBody.parse(await response.json());
            } catch (error) {
                throw new LlamaError(`DefiLlama's chart isn't in the expected shape (${asked})`, { cause: error });
            }

            const found = new Map<string, PricePoint[]>();
            for (const id of ids) {
                const coin = body.coins[id];
                if (!coin) continue;
                const byTime = new Map<number, number>();
                for (const { timestamp, price } of coin.prices) {
                    if (Number.isFinite(timestamp) && Number.isFinite(price) && price > 0)
                        byTime.set(timestamp * 1000, price);
                }
                found.set(
                    id,
                    [...byTime].sort((a, b) => a[0] - b[0]),
                );
            }
            return found;
        },
    };
}

/** Retry-After in seconds or as an HTTP date; null when absent or unreadable. */
function retryAfter(header: string | null): number | null {
    if (header === null) return null;
    const seconds = Number(header);
    if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
