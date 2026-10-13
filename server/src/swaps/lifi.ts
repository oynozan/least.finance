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
    slippage: number;
    integrator: string;
    fee?: number;
};

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
    approvalAddress: string | null;
    skipApproval: boolean;
    etaSeconds: number;
    fees: { name: string; amountUSD: number; included: boolean }[];
    gasUSD: number;
    tx: EvmTxRequest | SolanaTxRequest;
};

export type LifiStatus = {
    status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
    substatus: string | null;
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

export type LifiStatusRequest = { txHash: string; fromChain: number; toChain: number; bridge: string };

export type Lifi = {
    tokens(chainIds: readonly number[]): Promise<LifiToken[]>;
    chains(): Promise<{ id: number; diamondAddress: string | null }[]>;
    quote(req: LifiQuoteRequest): Promise<LifiQuote>;
    status(req: LifiStatusRequest): Promise<LifiStatus>;
};

export class LifiError extends Error {
    readonly kind: "no_route" | "rate_limited" | "unavailable";

    constructor(kind: LifiError["kind"], message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "LifiError";
        this.kind = kind;
    }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const CHAINS_TTL_MS = 3_600_000;
// LI.FI's codes for no route found and for a tool that can't serve the request
const NO_ROUTE_CODES = new Set([1002, 1011]);
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
    }),
    estimate: z.object({
        toAmount: amount,
        toAmountMin: amount,
        approvalAddress: z.string().nullish(),
        skipApproval: z.boolean().optional(),
        executionDuration: z.number().optional(),
        feeCosts: z
            .array(
                z.object({ name: z.string().optional(), amountUSD: usd.optional(), included: z.boolean().optional() }),
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
            throw new LifiError("unavailable", `LI.FI could not be reached for ${path}`, { cause: error });
        }
    }

    async function json(response: Response): Promise<unknown> {
        try {
            return await response.json();
        } catch (error) {
            throw new LifiError("unavailable", "LI.FI sent an unreadable answer", { cause: error });
        }
    }

    function parse<T>(schema: z.ZodType<T>, body: unknown): T {
        const parsed = schema.safeParse(body);
        if (!parsed.success)
            throw new LifiError("unavailable", "LI.FI sent an unexpected answer", { cause: parsed.error });
        return parsed.data;
    }

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

        async chains() {
            if (chainsCache && now() - chainsCache.at < CHAINS_TTL_MS) return chainsCache.chains;
            const response = await get("/v1/chains", "chainTypes=EVM,SVM");
            if (!response.ok) throw new LifiError("unavailable", `LI.FI answered ${response.status} for its chains`);
            const chains = parse(rawChains, await json(response)).chains.map((chain) => ({
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
                slippage: String(req.slippage),
                integrator: req.integrator,
            });
            if (req.fee !== undefined && req.fee > 0) params.set("fee", String(req.fee));
            const response = await get("/v1/quote", params);
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
                if (response.status === 404 || (response.status === 400 && NO_ROUTE_CODES.has(Number(body?.code)))) {
                    throw new LifiError("no_route", "LI.FI has no route for this swap");
                }
                if (response.status === 429) throw new LifiError("rate_limited", "LI.FI is rate limiting quotes");
                throw new LifiError("unavailable", `LI.FI answered ${response.status} for a quote`);
            }
            const raw = parse(rawQuote, await json(response));
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
                approvalAddress: estimate.approvalAddress ?? null,
                skipApproval: estimate.skipApproval ?? false,
                etaSeconds: estimate.executionDuration ?? 0,
                fees: (estimate.feeCosts ?? []).map((fee) => ({
                    name: fee.name ?? "Fee",
                    amountUSD: fee.amountUSD ?? 0,
                    included: fee.included ?? false,
                })),
                gasUSD: (estimate.gasCosts ?? []).reduce((sum, gas) => sum + (gas.amountUSD ?? 0), 0),
                tx,
            };
        },

        async status(req) {
            const response = await get(
                "/v1/status",
                new URLSearchParams({
                    txHash: req.txHash,
                    fromChain: String(req.fromChain),
                    toChain: String(req.toChain),
                    bridge: req.bridge,
                }),
            );
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
            if (!response.ok) throw new LifiError("unavailable", `LI.FI answered ${response.status} for a status`);
            const raw = parse(rawStatus, await json(response));
            const got = raw.receiving;
            return {
                status: raw.status,
                substatus: raw.substatus ?? null,
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
