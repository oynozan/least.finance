import { AppError, newRef } from "../errors.ts";
import { ARC_USDC_TOKENS } from "./catalog.ts";
import { bridgeName, QuoteTimeout, refusalMessage, UpstreamRefusal } from "./failures.ts";
import { BURN_DISCRIMINATOR_HEX, TOKEN_MESSENGER_MINTER_V2 } from "./providers/cctp.ts";
import type { BridgeProvider, Quote, QuoteRequest, SourceTx } from "./providers/types.ts";

const QUOTE_TIMEOUT_MS = 3_000;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Relay's depository on Solana, whose deposit instructions carry the amount the wallet sends. */
const RELAY_DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
/** Anchor discriminators of relay-depository's `deposit_native` and `deposit_token`. */
const DEPOSIT_NATIVE = "0d9e0ddf5fd51c06";
const DEPOSIT_TOKEN = "0b9c60da27a3b413";
/** The depository's deposit data: discriminator, u64 amount, 32-byte id. */
const DEPOSIT_DATA_BYTES = 48;
/** Compute Budget instruction tags: SetComputeUnitLimit (u32 units) and SetComputeUnitPrice (u64 micro-lamports). */
const SET_COMPUTE_UNIT_LIMIT = "02";
const SET_COMPUTE_UNIT_PRICE = "03";
const MAX_COMPUTE_UNITS = 1_400_000n;
const MAX_MICRO_LAMPORTS_PER_UNIT = 1_000_000n;
/** SOL beyond the deposit a SOL quote may cost the wallet. */
const SOL_ALLOWANCE = 10_000n;
const CCTP_ARC_DOMAIN = 26;

type SolanaTx = Extract<SourceTx, { kind: "solana" }>;
type SolanaIx = SolanaTx["instructions"][number];
type ErrorLog = { error: (fields: object, message: string) => void };
type QuoteLog = ErrorLog & { warn: (fields: object, message: string) => void };

/** Who asked for what, on every line a refused quote leaves in the log. */
const describe = (provider: string, request: QuoteRequest) => ({
    provider,
    coin: request.coin.key,
    amount: String(request.amount),
    sender: request.sender,
});

// A little-endian unsigned integer of `bytes` bytes at a byte offset of hex instruction data, or null when too short
function uintAt(data: string, offset: number, bytes: number): bigint | null {
    const hex = data.slice(2 + offset * 2, 2 + (offset + bytes) * 2);
    if (hex.length !== bytes * 2) return null;
    return BigInt(`0x${(hex.match(/../g) as string[]).reverse().join("")}`);
}

/** The amount a Relay depository deposit moves from `wallet` in the quoted coin, or null when the instruction is anything else. */
function depositAmount(ix: SolanaIx, request: QuoteRequest): bigint | null {
    const data = ix.data.toLowerCase();
    if (data.length !== 2 + DEPOSIT_DATA_BYTES * 2) return null;
    const sender = ix.keys[1];
    if (sender?.pubkey !== request.sender || !sender.isSigner) return null;
    const discriminator = data.slice(2, 18);
    const isSol = request.coin.mint === null;
    if (discriminator === DEPOSIT_NATIVE && isSol) return uintAt(data, 8, 8);
    if (discriminator === DEPOSIT_TOKEN && !isSol && ix.keys[4]?.pubkey === request.coin.mint) {
        return uintAt(data, 8, 8);
    }
    return null;
}

/** Whether the Compute Budget instruction sets a unit limit or a unit price within the caps. */
function computeBudgetOk(ix: SolanaIx): boolean {
    const data = ix.data.toLowerCase();
    const tag = data.slice(2, 4);
    if (tag === SET_COMPUTE_UNIT_LIMIT) {
        const units = data.length === 2 + 5 * 2 ? uintAt(data, 1, 4) : null;
        return units !== null && units <= MAX_COMPUTE_UNITS;
    }
    if (tag === SET_COMPUTE_UNIT_PRICE) {
        const price = data.length === 2 + 9 * 2 ? uintAt(data, 1, 8) : null;
        return price !== null && price <= MAX_MICRO_LAMPORTS_PER_UNIT;
    }
    return false;
}

/** Whether the instruction creates an associated token account with the wallet paying. */
function createAtaOk(ix: SolanaIx, wallet: string): boolean {
    const data = ix.data.toLowerCase();
    return (data === "0x" || data === "0x00" || data === "0x01") && ix.keys[0]?.pubkey === wallet;
}

/** Whether the CCTP burn takes the requested amount from the wallet, to Arc, to the deposit address left-padded to 32 bytes. */
function burnOk(ix: SolanaIx, request: QuoteRequest): boolean {
    const data = ix.data.toLowerCase();
    return (
        data.slice(2, 18) === BURN_DISCRIMINATOR_HEX &&
        ix.keys[0]?.pubkey === request.sender &&
        uintAt(data, 8, 8) === request.amount &&
        uintAt(data, 16, 4) === BigInt(CCTP_ARC_DOMAIN) &&
        data.slice(2 + 20 * 2, 2 + 52 * 2) === `${"00".repeat(12)}${request.recipient.slice(2).toLowerCase()}`
    );
}

/**
 * Whether every instruction is an allowed one of an allowed program, and the deposits add up to no more than the
 * amount: Relay's quotes are Compute Budget limits and prices, token account creations for the wallet and the
 * depository's deposits; CCTP's is its burn alone. Anything else, including any System or Token instruction, is refused.
 */
function solanaTxsHold(
    txs: readonly SolanaTx[],
    request: QuoteRequest,
    allowedPrograms: readonly string[],
    cctp: boolean,
    provider: string,
    logger?: ErrorLog,
) {
    const who = describe(provider, request);
    const instructions = txs.flatMap((tx) => tx.instructions);
    const unlistedAt = instructions.findIndex((ix) => !allowedPrograms.includes(ix.programId));
    if (unlistedAt >= 0) {
        logger?.error(
            { ...who, instructionIndex: unlistedAt, programId: instructions[unlistedAt]!.programId, allowedPrograms },
            "Refused a Solana deposit quote: instruction from a program not on the allowlist",
        );
        return false;
    }
    let total = 0n;
    for (const [index, ix] of instructions.entries()) {
        let amount: bigint | null = 0n;
        if (cctp) {
            amount = burnOk(ix, request) ? request.amount : null;
        } else if (ix.programId === RELAY_DEPOSITORY) {
            amount = depositAmount(ix, request);
        } else if (ix.programId === COMPUTE_BUDGET_PROGRAM) {
            if (!computeBudgetOk(ix)) amount = null;
        } else if (ix.programId === ASSOCIATED_TOKEN_PROGRAM) {
            if (!createAtaOk(ix, request.sender)) amount = null;
        } else {
            amount = null;
        }
        if (amount === null) {
            logger?.error(
                { ...who, instructionIndex: index, programId: ix.programId },
                "Refused a Solana deposit quote: an instruction a deposit never needs",
            );
            return false;
        }
        total += amount;
    }
    const ceiling = request.coin.mint === null ? request.amount + SOL_ALLOWANCE : request.amount;
    if (total > ceiling) {
        logger?.error(
            { ...who, total: String(total), ceiling: String(ceiling) },
            "Refused a Solana deposit quote: it moves more than the deposit",
        );
    }
    return total <= ceiling;
}

/**
 * The first thing a provider's quote gets wrong, or null when it does what was asked: it takes the requested coin and
 * amount, pays native USDC on Arc (by address, never by symbol) to the requested recipient, refunds the requested
 * wallet, and has the user sign at least one transaction, all on the coin's chain. A Solana quote also keeps to the
 * allowed programs and, within them, to the instructions a deposit needs, with deposits no larger than the amount
 * (CCTP's is one exact burn); Solana addresses compare exactly.
 */
export function quoteMismatch(
    quote: Quote,
    request: QuoteRequest,
    allowedPrograms: readonly string[],
    logger?: ErrorLog,
): { check: string; expected: string; got: string } | null {
    const { coin } = request;
    const solana = coin.chain === "solana";
    const sameWallet = solana ? quote.refundTo === request.refundTo : sameAddress(quote.refundTo, request.refundTo);
    const checks: [string, () => boolean, string, string][] = [
        ["coin", () => quote.coin === coin.key, coin.key, quote.coin],
        ["amountIn", () => quote.amountIn === request.amount, String(request.amount), String(quote.amountIn)],
        [
            "destinationToken",
            () => ARC_USDC_TOKENS.some((token) => sameAddress(token, quote.destinationToken)),
            ARC_USDC_TOKENS.join(" or "),
            quote.destinationToken,
        ],
        ["recipient", () => sameAddress(quote.recipient, request.recipient), request.recipient, quote.recipient],
        ["refundTo", () => sameWallet, request.refundTo, quote.refundTo],
        ["txs", () => quote.txs.length > 0, "at least one transaction", `${quote.txs.length} transactions`],
        [
            "txs",
            () =>
                solana
                    ? quote.txs.every((tx): tx is SolanaTx => tx.kind === "solana") &&
                      solanaTxsHold(
                          quote.txs as SolanaTx[],
                          request,
                          quote.provider === "cctp" ? [TOKEN_MESSENGER_MINTER_V2] : allowedPrograms,
                          quote.provider === "cctp",
                          quote.provider,
                          logger,
                      )
                    : quote.txs.every((tx) => tx.kind === "evm" && tx.chainId === coin.chainId),
            solana ? "Solana instructions that only deposit" : `EVM transactions on chain ${coin.chainId}`,
            quote.txs.map((tx) => (tx.kind === "evm" ? `evm ${tx.chainId}` : "solana")).join(", "),
        ],
        ["usdcOut", () => quote.usdcOut > 0n, "over zero", String(quote.usdcOut)],
    ];
    const failed = checks.find(([, holds]) => !holds());
    return failed ? { check: failed[0], expected: failed[2], got: failed[3] } : null;
}

/** Whether a provider's quote does what was asked (see quoteMismatch). */
export const checkQuote = (
    quote: Quote,
    request: QuoteRequest,
    allowedPrograms: readonly string[],
    logger?: ErrorLog,
): boolean => quoteMismatch(quote, request, allowedPrograms, logger) === null;

/** Aborts the provider's request when time runs out, and stops waiting even if the provider ignores that. */
async function quoteWithin(provider: BridgeProvider, request: QuoteRequest, timeoutMs: number): Promise<Quote> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new QuoteTimeout(provider.name, timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([provider.quote(request, controller.signal), timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

type QuoteIssue =
    | { provider: string; kind: "refused"; message: string }
    | { provider: string; kind: "app"; error: AppError }
    | { provider: string; kind: "timeout" }
    | { provider: string; kind: "mismatch"; ref: string }
    | { provider: string; kind: "error"; ref: string };

/** Logs one provider's failure to quote, once, with what it said, and says what kind it was. */
function explain(
    provider: string,
    reason: unknown,
    request: QuoteRequest,
    timeoutMs: number,
    logger?: QuoteLog,
): QuoteIssue {
    const who = describe(provider, request);
    const name = bridgeName(provider);
    if (reason instanceof QuoteTimeout) {
        logger?.warn({ op: "deposit.quote", ...who, timeoutMs }, `${name} didn't answer a deposit quote in time`);
        return { provider, kind: "timeout" };
    }
    if (reason instanceof UpstreamRefusal) {
        const { message, known } = refusalMessage(reason, request.coin);
        logger?.warn(
            {
                op: "deposit.quote",
                ...who,
                upstreamStatus: reason.status,
                upstreamCode: reason.code,
                upstreamMessage: reason.upstream,
                upstreamData: reason.data,
                known,
            },
            `${name} refused a deposit quote`,
        );
        return { provider, kind: "refused", message };
    }
    if (reason instanceof AppError) {
        logger?.warn(
            { op: "deposit.quote", ...who, code: reason.code },
            `${name} can't quote this deposit: ${reason.message}`,
        );
        return { provider, kind: "app", error: reason };
    }
    const ref = newRef();
    logger?.error({ op: "deposit.quote", ...who, err: reason, ref }, `${name} failed to give a deposit quote`);
    return { provider, kind: "error", ref };
}

/** The refusal the person sees when no bridge gave a usable quote: the most specific reason any of them gave. */
function noQuote(issues: QuoteIssue[], request: QuoteRequest, timeoutMs: number): AppError {
    const { coin } = request;
    const app = issues.find((issue): issue is Extract<QuoteIssue, { kind: "app" }> => issue.kind === "app");
    if (app) return new AppError(app.error.code, app.error.message, { logged: true, cause: app.error });
    const refused = [...new Set(issues.flatMap((issue) => (issue.kind === "refused" ? [issue.message] : [])))];
    if (refused.length > 0) return new AppError("no_route", refused.slice(0, 2).join(" "), { logged: true });
    const mismatch = issues.find(
        (issue): issue is Extract<QuoteIssue, { kind: "mismatch" }> => issue.kind === "mismatch",
    );
    if (mismatch) {
        return new AppError(
            "no_route",
            `${bridgeName(mismatch.provider)}'s quote didn't match your request, so nothing was sent (ref ${mismatch.ref}).`,
            { logged: true },
        );
    }
    const broken = issues.find((issue): issue is Extract<QuoteIssue, { kind: "error" }> => issue.kind === "error");
    if (broken) {
        return new AppError(
            "unavailable",
            `Couldn't get a quote from ${bridgeName(broken.provider)} (ref ${broken.ref}). Try again in a minute.`,
            { logged: true },
        );
    }
    if (issues.length > 0) {
        return new AppError("unavailable", `No bridge answered within ${timeoutMs / 1000} seconds. Try again.`, {
            logged: true,
        });
    }
    return new AppError("no_route", `No bridge carries ${coin.symbol} from ${coin.chainName} to Arc.`);
}

/**
 * The usable quote paying the most USDC, tier by tier: a tier's providers are asked in parallel, and a later tier
 * only when the earlier ones gave nothing usable. Without tiers everyone is one tier. A tie goes to the shorter ETA.
 * A provider that fails or is too slow, or whose quote doesn't check out, is left out and logged once with why;
 * when none is usable, the person is told the most specific reason any of them gave.
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
        logger?: QuoteLog;
    },
): Promise<Quote> {
    const issues: QuoteIssue[] = [];
    for (const tier of tiers) {
        const asked = providers.filter((provider) => tier.includes(provider.name) && provider.supports(request.coin));
        const settled = await Promise.allSettled(asked.map((provider) => quoteWithin(provider, request, timeoutMs)));
        const usable: Quote[] = [];
        settled.forEach((result, i) => {
            const provider = asked[i]!.name;
            if (result.status === "rejected") {
                issues.push(explain(provider, result.reason, request, timeoutMs, logger));
                return;
            }
            const mismatch = quoteMismatch(result.value, request, allowedPrograms, logger);
            if (!mismatch) {
                usable.push(result.value);
                return;
            }
            const ref = newRef();
            issues.push({ provider, kind: "mismatch", ref });
            logger?.error(
                {
                    op: "deposit.quote.rejected",
                    ...describe(provider, request),
                    ...mismatch,
                    quote: result.value.ref,
                    ref,
                },
                "Refused a bridge quote that does not match the request",
            );
        });

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
    throw noQuote(issues, request, timeoutMs);
}
