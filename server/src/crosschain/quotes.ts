import { AppError } from "../errors.ts";
import { ARC_USDC_TOKENS } from "./catalog.ts";
import type { BridgeProvider, Quote, QuoteRequest, SourceTx } from "./providers/types.ts";

const QUOTE_TIMEOUT_MS = 3_000;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type SolanaTx = Extract<SourceTx, { kind: "solana" }>;
type ErrorLog = { error: (fields: object, message: string) => void };

// A little-endian u64 at a byte offset of hex instruction data, or null when the data is too short
function u64At(data: string, offset: number): bigint | null {
    const hex = data.slice(2 + offset * 2, 2 + (offset + 8) * 2);
    if (hex.length !== 16) return null;
    return BigInt(`0x${(hex.match(/../g) as string[]).reverse().join("")}`);
}

/** The most a top-level System or Token transfer from `wallet` moves, in each program's own unit, by instruction tag. */
function transferred(tx: SolanaTx, wallet: string): { system: bigint; token: bigint } {
    let system = 0n;
    let token = 0n;
    for (const { programId, keys, data } of tx.instructions) {
        if (programId === SYSTEM_PROGRAM && data.slice(2, 10) === "02000000" && keys[0]?.pubkey === wallet) {
            system = max(system, u64At(data, 4));
        } else if (programId === TOKEN_PROGRAM) {
            const tag = data.slice(2, 4);
            const authority = tag === "03" ? keys[2] : tag === "0c" ? keys[3] : undefined;
            if (authority?.pubkey === wallet) token = max(token, u64At(data, 1));
        }
    }
    return { system, token };
}

const max = (a: bigint, b: bigint | null) => (b !== null && b > a ? b : a);

/** Whether every instruction is from an allowed program and nothing top-level moves more of the wallet's funds than the deposit. */
function solanaTxHolds(tx: SolanaTx, request: QuoteRequest, allowedPrograms: readonly string[], logger?: ErrorLog) {
    const unlisted = tx.instructions.find((ix) => !allowedPrograms.includes(ix.programId));
    if (unlisted) {
        logger?.error(
            { programId: unlisted.programId },
            "Refused a Solana quote with an instruction from an unlisted program",
        );
        return false;
    }
    const { system, token } = transferred(tx, request.sender);
    const isSol = request.coin.mint === null;
    const ok = isSol ? system <= request.amount && token === 0n : token <= request.amount && system === 0n;
    if (!ok) logger?.error({ system, token }, "Refused a Solana quote that moves more than the deposit");
    return ok;
}

/**
 * Whether a provider's quote does what was asked: it takes the requested coin and amount, pays native USDC on Arc
 * (by address, never by symbol) to the requested recipient, refunds the requested wallet, and has the user sign
 * at least one transaction, all on the coin's chain. A Solana quote also keeps to the allowed programs and to
 * transfers no larger than the deposit; Solana addresses compare exactly.
 */
export function checkQuote(
    quote: Quote,
    request: QuoteRequest,
    allowedPrograms: readonly string[],
    logger?: ErrorLog,
): boolean {
    const { coin } = request;
    const solana = coin.chain === "solana";
    const sameWallet = solana ? quote.refundTo === request.refundTo : sameAddress(quote.refundTo, request.refundTo);
    const txsHold = solana
        ? quote.txs.every((tx) => tx.kind === "solana" && solanaTxHolds(tx, request, allowedPrograms, logger))
        : quote.txs.every((tx) => tx.kind === "evm" && tx.chainId === coin.chainId);
    return (
        quote.coin === coin.key &&
        quote.amountIn === request.amount &&
        ARC_USDC_TOKENS.some((token) => sameAddress(token, quote.destinationToken)) &&
        sameAddress(quote.recipient, request.recipient) &&
        sameWallet &&
        quote.txs.length > 0 &&
        txsHold &&
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
 * The usable quote paying the most USDC, tier by tier: a tier's providers are asked in parallel, and a later tier
 * only when the earlier ones gave nothing usable. Without tiers everyone is one tier. A tie goes to the shorter ETA.
 * A provider that fails or is too slow, or whose quote doesn't check out, is left out.
 */
export async function bestQuote(
    providers: readonly BridgeProvider[],
    request: QuoteRequest,
    {
        timeoutMs = QUOTE_TIMEOUT_MS,
        tiers = [providers.map((provider) => provider.name)],
        allowedPrograms,
        logger,
    }: {
        timeoutMs?: number;
        tiers?: readonly (readonly string[])[];
        allowedPrograms: readonly string[];
        logger?: ErrorLog;
    },
): Promise<Quote> {
    for (const tier of tiers) {
        const settled = await Promise.allSettled(
            providers
                .filter((provider) => tier.includes(provider.name) && provider.supports(request.coin))
                .map((provider) => quoteWithin(provider, request, timeoutMs)),
        );
        const usable = settled
            .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
            .filter((quote) => checkQuote(quote, request, allowedPrograms, logger));

        const best = usable.reduce<Quote | undefined>(
            (top, quote) =>
                !top ||
                quote.usdcOut > top.usdcOut ||
                (quote.usdcOut === top.usdcOut && quote.etaSeconds < top.etaSeconds)
                    ? quote
                    : top,
            undefined,
        );
        if (best) return best;
    }
    throw new AppError("unavailable", "No route for this deposit right now.");
}
