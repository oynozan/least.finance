import type { Hex } from "viem";
import { brief } from "../errors.ts";

/** Circle's CCTP domain numbers. */
const ARC_DOMAIN = 26;
const SOLANA_DOMAIN = 5;
const POLYGON_DOMAIN = 7;
/** The attestation speed the burn waits for: standard finality. */
const STANDARD_FINALITY = 2000;
/** USDC has 6 decimals on Circle's side and 18 in the ledger. */
const WEI_PER_UNIT = 10n ** 12n;

export type IrisMessage = {
    status: "pending" | "complete" | "failed";
    forwardTxHash: string | null;
    /** The fee Circle took from the mint, in USDC units (6 decimals); null while the message has no executed fee. */
    feeExecutedE6: bigint | null;
    /** Why Circle holds the message back (for example `insufficient_fee`); null when it doesn't. */
    delayReason: string | null;
    raw: unknown;
};

/** A quoted forward fee in USDC wei and the protocol's fee in basis points (fractions allowed). */
export type ForwardFee = { med: bigint; high: bigint; minimumFeeBps: number };

export type Iris = {
    /** The forward fee of a burn from one domain to another (`setup` also creates the Solana account), in USDC wei. */
    forwardFee(input: { from: number; to: number; setup?: boolean }): Promise<ForwardFee>;
    /** The forward fee of a burn on Solana minted on Arc, in USDC wei. */
    depositFee(): Promise<ForwardFee>;
    /** What Circle reports for the message a burn produced (a hash on EVM, a signature on Solana); null while it has none. */
    message(input: { domain: number; burnTxHash: Hex | string }): Promise<IrisMessage | null>;
};

/** Iris couldn't be asked or answered badly; `rate_limited` and `timeout` mean back off. */
export class IrisError extends Error {
    readonly kind: "rate_limited" | "timeout" | "unavailable";
    /** What Iris was asked and said: the path, its HTTP status and the start of its body, when it answered. */
    readonly path: string | null;
    readonly status: number | null;
    readonly body: string | null;
    /** The seconds Iris asked to wait, when it said. */
    readonly retryAfter: string | null;

    constructor(
        kind: IrisError["kind"],
        message: string,
        options?: { cause?: unknown; path?: string; status?: number; body?: string; retryAfter?: string | null },
    ) {
        super(message, options);
        this.name = "IrisError";
        this.kind = kind;
        this.path = options?.path ?? null;
        this.status = options?.status ?? null;
        this.body = options?.body ?? null;
        this.retryAfter = options?.retryAfter ?? null;
    }
}

type FeeRow = { finalityThreshold?: number; minimumFee?: number; forwardFee?: Record<string, number | string> };

/** A fee Iris quoted in USDC units: a whole number is 6-decimal units, a fraction is dollars, and dollars round up to a unit. */
export function feeUnits(value: number | string): bigint {
    const text = String(value);
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`Not a fee amount: ${text}`);
    const [, whole, fraction = ""] = match;
    if (/^0*$/.test(fraction)) return BigInt(whole!);
    const micros = fraction.padEnd(6, "0");
    const roundUp = /[1-9]/.test(micros.slice(6)) ? 1n : 0n;
    return BigInt(whole!) * 1_000_000n + BigInt(micros.slice(0, 6)) + roundUp;
}

export function createIris(options: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }): Iris {
    const { fetch: send = fetch, timeoutMs = 10_000 } = options;
    const base = options.baseUrl.replace(/\/+$/, "");

    async function get(path: string): Promise<{ status: number; body: unknown }> {
        let response: Response;
        try {
            response = await send(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            const timedOut = error instanceof Error && error.name === "TimeoutError";
            throw new IrisError(timedOut ? "timeout" : "unavailable", `Iris couldn't be reached for ${path}`, {
                cause: error,
                path,
            });
        }
        const status = response.status;
        if (status === 429) {
            const retryAfter = response.headers.get("retry-after");
            throw new IrisError("rate_limited", `Iris is rate limiting (${path})`, { path, status, retryAfter });
        }
        if (status === 404) return { status: 404, body: null };
        if (!response.ok) {
            const body = brief(await response.text().catch(() => ""), 300);
            throw new IrisError("unavailable", `Iris answered ${status} to ${path}${body ? `: ${body}` : ""}`, {
                path,
                status,
                body,
            });
        }
        const text = await response.text().catch(() => "");
        try {
            return { status, body: JSON.parse(text) };
        } catch (error) {
            throw new IrisError("unavailable", `Iris gave an unreadable answer to ${path}: ${brief(text, 300)}`, {
                cause: error,
                path,
                status,
                body: brief(text, 300),
            });
        }
    }

    const toWei = (value: number | string | undefined) => {
        try {
            if (value === undefined) throw new Error("No fee");
            return feeUnits(value) * WEI_PER_UNIT;
        } catch (error) {
            throw new IrisError("unavailable", `Iris gave no forward fee: ${String(error)}`, { cause: error });
        }
    };

    async function fees(path: string) {
        const { body } = await get(path);
        const seen = brief(JSON.stringify(body), 300);
        const rows = (Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data ?? [])) as FeeRow[];
        const row = Array.isArray(rows)
            ? (rows.find((r) => r.finalityThreshold === STANDARD_FINALITY) ?? rows[0])
            : undefined;
        if (!row?.forwardFee)
            throw new IrisError("unavailable", `Iris gave no forward fee for ${path}: ${seen}`, { path, body: seen });
        const bps = row.minimumFee ?? 0;
        if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0) {
            throw new IrisError("unavailable", `Iris gave an unreadable protocol fee for ${path}: ${seen}`, {
                path,
                body: seen,
            });
        }
        return { med: toWei(row.forwardFee.med), high: toWei(row.forwardFee.high), minimumFeeBps: bps };
    }

    return {
        forwardFee: ({ from, to, setup }) =>
            fees(`/v2/burn/USDC/fees/${from}/${to}?forward=true${setup ? "&includeRecipientSetup=true" : ""}`),
        depositFee: () => fees(`/v2/burn/USDC/fees/${SOLANA_DOMAIN}/${ARC_DOMAIN}?forward=true`),
        async message({ domain, burnTxHash }) {
            const { body } = await get(`/v2/messages/${domain}?transactionHash=${burnTxHash}`);
            const found = (body as { messages?: Record<string, unknown>[] } | null)?.messages?.[0];
            if (!found) return null;
            const forwardTxHash =
                typeof found.forwardTxHash === "string" && found.forwardTxHash ? found.forwardTxHash : null;
            const state = String(found.forwardState ?? "").toUpperCase();
            const status = forwardTxHash ? "complete" : state === "FAILED" ? "failed" : "pending";
            const delayReason = typeof found.delayReason === "string" && found.delayReason ? found.delayReason : null;
            const executed = (found.decodedMessage as { decodedMessageBody?: { feeExecuted?: unknown } } | undefined)
                ?.decodedMessageBody?.feeExecuted;
            const feeExecutedE6 = /^\d+$/.test(String(executed)) ? BigInt(String(executed)) : null;
            return { status, forwardTxHash, feeExecutedE6, delayReason, raw: found };
        },
    };
}

export { ARC_DOMAIN, POLYGON_DOMAIN, SOLANA_DOMAIN };
