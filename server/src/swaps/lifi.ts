import { z } from "zod";

/** A token as the swaps code uses it; `priceUSD` is null when LI.FI gave no usable price. */
export type LifiToken = { chainId: number; address: string; symbol: string; decimals: number; priceUSD: number | null };

export type EvmTxRequest = { kind: "evm"; chainId: number; from: string; to: string; data: string; value: string };
export type SolanaTxRequest = { kind: "solana"; data: string };

export type LifiQuoteRequest = {
    fromChain: number;
    toChain: number;
    fromToken: string;
    toToken: string;
    fromAddress: string;
    toAddress: string;
    fromAmount: string;
    /** Left out, LI.FI picks the slippage for the tokens in the route. */
    slippage?: number;
    integrator: string;
};

/** The most that a quote's minimum may sit under its amount for us to accept it, whoever chose the slippage. */
export const MAX_QUOTE_SLIPPAGE = 0.02;

export type LifiQuote = {
    id: string;
    tool: string;
    toolName: string;
    fromChainId: number;
    toChainId: number;
    fromToken: string;
    toToken: string;
    fromAddress: string;
    toAddress: string;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    /** The slippage LI.FI built the quote with: the one asked for, or the one it chose. An intent route reports more than `toAmountMin` shows. */
    slippage: number;
    /** How far `toAmountMin` sits under `toAmount`: the most the person can lose to a move in the price. */
    shortfall: number;
    approvalAddress: string | null;
    skipApproval: boolean;
    etaSeconds: number;
    /** `amount` is the fee in the smallest units of the token at `token`; both are empty when LI.FI sent none. */
    fees: { name: string; amountUSD: number; included: boolean; amount: string; token: string }[];
    gasUSD: number;
    tx: EvmTxRequest | SolanaTxRequest;
};

/** Whether a quote's minimum sits more than MAX_QUOTE_SLIPPAGE under its amount. LI.FI floors the minimum to a whole unit, so one unit of it is rounding, not slippage. */
export function tooFarUnder(quote: Pick<LifiQuote, "toAmount" | "toAmountMin">): boolean {
    const kept = BigInt(Math.round((1 - MAX_QUOTE_SLIPPAGE) * 1_000_000));
    return (BigInt(quote.toAmountMin) + 1n) * 1_000_000n < BigInt(quote.toAmount) * kept;
}

export type LifiStatus = {
    status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
    substatus: string | null;
    /** LI.FI's own sentence for the substatus. */
    substatusMessage?: string | null;
    sendingTxHash: string | null;
    fromAddress: string | null;
    toAddress: string | null;
    receiving: {
        txHash: string | null;
        amount: string;
        tokenAddress: string;
        tokenSymbol: string;
        decimals: number;
        chainId: number;
    } | null;
};

export type LifiStatusRequest = { txHash: string; fromChain: number; toChain: number; bridge?: string };

export type Lifi = {
    tokens(chainIds: readonly number[]): Promise<LifiToken[]>;
    chains(): Promise<{ id: number; diamondAddress: string | null }[]>;
    quote(req: LifiQuoteRequest): Promise<LifiQuote>;
    status(req: LifiStatusRequest): Promise<LifiStatus>;
};

/** What LI.FI said in an error body, kept as it came. */
export type LifiSaid = {
    status?: number;
    code?: number;
    /** The body's message, or the first of its `errors`. */
    upstream?: string;
    errorTypes?: string[];
};

export class LifiError extends Error {
    readonly kind: "no_route" | "rate_limited" | "unauthorized" | "unavailable";
    readonly said: LifiSaid;

    constructor(kind: LifiError["kind"], message: string, options?: { cause?: unknown; said?: LifiSaid }) {
        super(message, options);
        this.name = "LifiError";
        this.kind = kind;
        this.said = options?.said ?? {};
    }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const CHAINS_TTL_MS = 3_600_000;
// LI.FI's codes for no route found and for a tool that can't serve the request
const NO_ROUTE_CODES = new Set([1002, 1011]);
// 1005 is rate limited, 1010 an unauthorized key
const RATE_LIMITED_CODE = 1005;
const UNAUTHORIZED_CODE = 1010;
const SOLANA_CHAIN_ID = 1151111081099710;

const amount = z.union([z.string(), z.number()]).transform(String);
const usd = z.coerce.number().catch(0);

const rawQuote = z.object({
    id: z.string().min(1),
    tool: z.string().min(1),
    toolDetails: z.object({ name: z.string().optional() }).optional(),
    action: z.object({
        fromChainId: z.number().int(),
        toChainId: z.number().int(),
        fromToken: z.object({ address: z.string().min(1) }),
        toToken: z.object({ address: z.string().min(1) }),
        fromAddress: z.string().min(1),
        toAddress: z.string().min(1),
        fromAmount: amount,
        slippage: z.number().optional(),
    }),
    estimate: z.object({
        toAmount: amount,
        toAmountMin: amount,
        approvalAddress: z.string().nullish(),
        skipApproval: z.boolean().optional(),
        executionDuration: z.number().optional(),
        feeCosts: z
            .array(
                z.object({
                    name: z.string().optional(),
                    amount: amount.optional(),
                    amountUSD: usd.optional(),
                    included: z.boolean().optional(),
                    token: z.object({ address: z.string() }).optional(),
                }),
            )
            .optional(),
        gasCosts: z.array(z.object({ amountUSD: usd.optional() })).optional(),
    }),
    transactionRequest: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        chainId: z.number().int().optional(),
        data: z.string().min(1),
        value: amount.optional(),
    }),
});

const rawStatus = z.object({
    status: z.enum(["NOT_FOUND", "INVALID", "PENDING", "DONE", "FAILED"]),
    substatus: z.string().nullish(),
    substatusMessage: z.string().nullish(),
    fromAddress: z.string().nullish(),
    toAddress: z.string().nullish(),
    sending: z.object({ txHash: z.string().nullish() }).nullish(),
    receiving: z
        .object({
            txHash: z.string().nullish(),
            chainId: z.number().int().optional(),
            amount: amount.optional(),
            token: z
                .object({
                    address: z.string(),
                    symbol: z.string(),
                    decimals: z.number().int(),
                    chainId: z.number().int().optional(),
                })
                .optional(),
        })
        .nullish(),
});

const rawChains = z.object({
    chains: z.array(z.object({ id: z.number().int(), diamondAddress: z.string().nullish() })),
});

// A transaction value arrives as hex or decimal; it is a decimal string from here on
function decimalValue(value: string | undefined): string {
    if (value === undefined || value === "" || value === "0x") return "0";
    try {
        return BigInt(value).toString();
    } catch {
        throw new Error(`LI.FI sent an unreadable transaction value ${value}`);
    }
}

// How far toAmountMin sits under toAmount, to a billionth so that exactly 2% reads as 0.02 and not 0.020000000000000018
function shortfall(toAmount: string, toAmountMin: string): number {
    const expected = Number(toAmount);
    const least = Number(toAmountMin);
    return expected > 0 && Number.isFinite(least) ? Math.max(0, Math.round((1 - least / expected) * 1e9) / 1e9) : 0;
}

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
export function createLifi(options: {
    url: string;
    apiKey?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
}): Lifi {
    const { url, apiKey, fetch: fetchLifi = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = options;
    const headers: Record<string, string> = apiKey ? { "x-lifi-api-key": apiKey } : {};
    let chainsCache: { at: number; chains: { id: number; diamondAddress: string | null }[] } | undefined;

    // One GET: the response, or a LifiError for a failure to reach LI.FI
    async function get(path: string, params: URLSearchParams | string): Promise<Response> {
        try {
            return await fetchLifi(`${url}${path}?${params}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
            throw new LifiError(
                "unavailable",
                timedOut
                    ? `LI.FI didn't answer ${path} in ${Math.round(timeoutMs / 1000)} seconds`
                    : `LI.FI could not be reached for ${path}`,
                { cause: error },
            );
        }
    }

    async function json(response: Response, path: string): Promise<unknown> {
        try {
            return await response.json();
        } catch (error) {
            throw new LifiError("unavailable", `LI.FI sent an unreadable answer for ${path}`, { cause: error });
        }
    }

    function parse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const where = issue?.path.length ? issue.path.join(".") : "the answer";
            throw new LifiError(
                "unavailable",
                `LI.FI's ${path} answer has a bad ${where}: ${issue?.message ?? "invalid"}`,
                { cause: parsed.error },
            );
        }
        return parsed.data;
    }

    // A refusal: LI.FI's status, code and words are kept on the error, and its kind says what we can do about it
    async function refusal(what: string, response: Response, notFoundIsNoRoute = false) {
        const body = (await response.json().catch(() => null)) as {
            message?: unknown;
            code?: unknown;
            errors?: { message?: unknown; errorType?: unknown }[];
        } | null;
        const code = Number(body?.code);
        const errors = Array.isArray(body?.errors) ? body.errors : [];
        const upstream = [errors[0]?.message, body?.message].find((text) => typeof text === "string" && text !== "") as
            string | undefined;
        const said: LifiSaid = {
            status: response.status,
            ...(body?.code !== undefined && Number.isFinite(code) && { code }),
            ...(upstream !== undefined && { upstream: upstream.slice(0, 300) }),
            errorTypes: errors.flatMap((entry) => (typeof entry?.errorType === "string" ? [entry.errorType] : [])),
        };
        const words = `${response.status}${said.code !== undefined ? ` (code ${said.code})` : ""} for ${what}${
            said.upstream ? `: "${said.upstream}"` : ""
        }`;
        if (response.status === 401 || response.status === 403 || code === UNAUTHORIZED_CODE)
            return new LifiError("unauthorized", `LI.FI rejected our API key, it answered ${words}`, { said });
        if (response.status === 429 || code === RATE_LIMITED_CODE)
            return new LifiError("rate_limited", `LI.FI is rate limiting us, it answered ${words}`, { said });
        if ((notFoundIsNoRoute && response.status === 404) || (response.status === 400 && NO_ROUTE_CODES.has(code)))
            return new LifiError("no_route", `LI.FI found no route, it answered ${words}`, { said });
        return new LifiError("unavailable", `LI.FI answered ${words}`, { said });
    }

    return {
        async tokens(chainIds) {
            const path = "/v1/tokens";
            const response = await get(path, `chains=${chainIds.join(",")}&chainTypes=EVM,SVM`);
            if (!response.ok) throw await refusal(`its token list on chains ${chainIds.join(",")}`, response);
            const { tokens } = parse(answer, await json(response, path), path);

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

        async chains() {
            if (chainsCache && now() - chainsCache.at < CHAINS_TTL_MS) return chainsCache.chains;
            const response = await get("/v1/chains", "chainTypes=EVM,SVM");
            if (!response.ok) throw await refusal("its chains", response);
            const chains = parse(rawChains, await json(response, "/v1/chains"), "/v1/chains").chains.map((chain) => ({
                id: chain.id,
                diamondAddress: chain.diamondAddress ?? null,
            }));
            chainsCache = { at: now(), chains };
            return chains;
        },

        async quote(req) {
            const params = new URLSearchParams({
                fromChain: String(req.fromChain),
                toChain: String(req.toChain),
                fromToken: req.fromToken,
                toToken: req.toToken,
                fromAddress: req.fromAddress,
                toAddress: req.toAddress,
                fromAmount: req.fromAmount,
                ...(req.slippage !== undefined && { slippage: String(req.slippage) }),
                integrator: req.integrator,
            });
            const response = await get("/v1/quote", params);
            if (!response.ok) throw await refusal("a quote", response, true);
            const raw = parse(rawQuote, await json(response, "/v1/quote"), "/v1/quote");
            let value: string;
            try {
                value = decimalValue(raw.transactionRequest.value);
            } catch (error) {
                throw new LifiError("unavailable", "LI.FI sent an unreadable quote", { cause: error });
            }
            const { action, estimate, transactionRequest } = raw;
            const tx: LifiQuote["tx"] =
                action.fromChainId === SOLANA_CHAIN_ID
                    ? { kind: "solana", data: transactionRequest.data }
                    : {
                          kind: "evm",
                          chainId: transactionRequest.chainId ?? action.fromChainId,
                          from: transactionRequest.from ?? "",
                          to: transactionRequest.to ?? "",
                          data: transactionRequest.data,
                          value,
                      };
            return {
                id: raw.id,
                tool: raw.tool,
                toolName: raw.toolDetails?.name ?? raw.tool,
                fromChainId: action.fromChainId,
                toChainId: action.toChainId,
                fromToken: action.fromToken.address,
                toToken: action.toToken.address,
                fromAddress: action.fromAddress,
                toAddress: action.toAddress,
                fromAmount: action.fromAmount,
                toAmount: estimate.toAmount,
                toAmountMin: estimate.toAmountMin,
                slippage: action.slippage ?? shortfall(estimate.toAmount, estimate.toAmountMin),
                shortfall: shortfall(estimate.toAmount, estimate.toAmountMin),
                approvalAddress: estimate.approvalAddress ?? null,
                skipApproval: estimate.skipApproval ?? false,
                etaSeconds: estimate.executionDuration ?? 0,
                fees: (estimate.feeCosts ?? []).map((fee) => ({
                    name: fee.name ?? "Fee",
                    amountUSD: fee.amountUSD ?? 0,
                    included: fee.included ?? false,
                    amount: fee.amount ?? "0",
                    token: fee.token?.address ?? "",
                })),
                gasUSD: (estimate.gasCosts ?? []).reduce((sum, gas) => sum + (gas.amountUSD ?? 0), 0),
                tx,
            };
        },

        async status(req) {
            const params = new URLSearchParams({
                txHash: req.txHash,
                fromChain: String(req.fromChain),
                toChain: String(req.toChain),
            });
            if (req.bridge !== undefined) params.set("bridge", req.bridge);
            const response = await get("/v1/status", params);
            if (response.status === 404) {
                return {
                    status: "NOT_FOUND",
                    substatus: null,
                    sendingTxHash: null,
                    fromAddress: null,
                    toAddress: null,
                    receiving: null,
                };
            }
            if (!response.ok) throw await refusal("a status", response);
            const raw = parse(rawStatus, await json(response, "/v1/status"), "/v1/status");
            const got = raw.receiving;
            return {
                status: raw.status,
                substatus: raw.substatus ?? null,
                ...(raw.substatusMessage ? { substatusMessage: raw.substatusMessage } : {}),
                sendingTxHash: raw.sending?.txHash ?? null,
                fromAddress: raw.fromAddress ?? null,
                toAddress: raw.toAddress ?? null,
                receiving:
                    got?.amount !== undefined && got.token && got.chainId !== undefined
                        ? {
                              txHash: got.txHash ?? null,
                              amount: got.amount,
                              tokenAddress: got.token.address,
                              tokenSymbol: got.token.symbol,
                              decimals: got.token.decimals,
                              chainId: got.chainId,
                          }
                        : null,
            };
        },
    };
}
