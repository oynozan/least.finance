import { AppError } from "../errors.ts";
import { ARC_USDC_TOKENS } from "./catalog.ts";
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
    logger?: ErrorLog,
) {
    const instructions = txs.flatMap((tx) => tx.instructions);
    const unlisted = instructions.find((ix) => !allowedPrograms.includes(ix.programId));
    if (unlisted) {
        logger?.error(
            { programId: unlisted.programId },
            "Refused a Solana quote with an instruction from an unlisted program",
        );
        return false;
    }
    let total = 0n;
    for (const ix of instructions) {
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
                { programId: ix.programId },
                "Refused a Solana quote with an instruction a deposit never needs",
            );
            return false;
        }
        total += amount;
    }
    const ceiling = request.coin.mint === null ? request.amount + SOL_ALLOWANCE : request.amount;
    if (total > ceiling) logger?.error({ total }, "Refused a Solana quote that moves more than the deposit");
    return total <= ceiling;
}

/**
 * Whether a provider's quote does what was asked: it takes the requested coin and amount, pays native USDC on Arc
 * (by address, never by symbol) to the requested recipient, refunds the requested wallet, and has the user sign
 * at least one transaction, all on the coin's chain. A Solana quote also keeps to the allowed programs and, within them, to the
 * instructions a deposit needs, with deposits no larger than the amount (CCTP's is one exact burn); Solana addresses compare exactly.
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
        ? quote.txs.every((tx): tx is SolanaTx => tx.kind === "solana") &&
          solanaTxsHold(
              quote.txs as SolanaTx[],
              request,
              quote.provider === "cctp" ? [TOKEN_MESSENGER_MINTER_V2] : allowedPrograms,
              quote.provider === "cctp",
              logger,
          )
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
