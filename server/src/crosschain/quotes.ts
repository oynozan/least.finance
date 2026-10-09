import { AppError } from "../errors.ts";
import { ARC_USDC_TOKENS } from "./catalog.ts";
import type { BridgeProvider, Quote, QuoteRequest } from "./providers/types.ts";

const QUOTE_TIMEOUT_MS = 3_000;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether a provider's quote does what was asked: it pays native USDC on Arc (by address, never by symbol)
 * to the requested recipient, refunds the requested wallet, and only has the user sign on the coin's chain.
 */
export function checkQuote(quote: Quote, request: QuoteRequest): boolean {
    return (
        ARC_USDC_TOKENS.some((token) => sameAddress(token, quote.destinationToken)) &&
        sameAddress(quote.recipient, request.recipient) &&
        sameAddress(quote.refundTo, request.refundTo) &&
        quote.txs.every((tx) => tx.chainId === request.coin.chainId) &&
        quote.usdcOut > 0n
    );
}

/** Aborts the provider's request when time runs out, and stops waiting even if the provider ignores that. */
async function quoteWithin(provider: BridgeProvider, request: QuoteRequest, timeoutMs: number): Promise<Quote> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`${provider.name} gave no quote within ${timeoutMs} ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([provider.quote(request, controller.signal), timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The usable quote paying the most USDC, from every provider that supports the coin, asked in parallel.
 * A tie goes to the shorter ETA. A provider that fails or is too slow, or whose quote doesn't check out, is left out.
 */
export async function bestQuote(
    providers: readonly BridgeProvider[],
    request: QuoteRequest,
    { timeoutMs = QUOTE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Quote> {
    const settled = await Promise.allSettled(
        providers
            .filter((provider) => provider.supports(request.coin))
            .map((provider) => quoteWithin(provider, request, timeoutMs)),
    );
    const usable = settled
        .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
        .filter((quote) => checkQuote(quote, request));

    const best = usable.reduce<Quote | undefined>(
        (top, quote) =>
            !top || quote.usdcOut > top.usdcOut || (quote.usdcOut === top.usdcOut && quote.etaSeconds < top.etaSeconds)
                ? quote
                : top,
        undefined,
    );
    if (!best) throw new AppError("unavailable", "No route for this deposit right now.");
    return best;
}
