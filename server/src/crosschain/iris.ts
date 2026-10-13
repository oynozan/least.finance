import type { Hex } from "viem";

/** Circle's CCTP domain numbers. */
const ARC_DOMAIN = 26;
const SOLANA_DOMAIN = 5;
/** The attestation speed the burn waits for: standard finality. */
const STANDARD_FINALITY = 2000;
/** USDC has 6 decimals on Circle's side and 18 in the ledger. */
const WEI_PER_UNIT = 10n ** 12n;

export type IrisMessage = {
    status: "pending" | "complete" | "failed";
    forwardTxHash: string | null;
    raw: unknown;
};

export type Iris = {
    /** The forward fee of a burn on Arc minted on Solana, in USDC wei. */
    forwardFee(input: { from: 26; to: 5; setup: boolean }): Promise<{ med: bigint; high: bigint }>;
    /** What Circle reports for the message a burn produced; null while it has none. */
    message(input: { domain: number; burnTxHash: Hex }): Promise<IrisMessage | null>;
};

/** Iris couldn't be asked or answered badly; `rate_limited` means back off. */
export class IrisError extends Error {
    readonly kind: "rate_limited" | "unavailable";

    constructor(kind: IrisError["kind"], message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "IrisError";
        this.kind = kind;
    }
}

type FeeRow = { finalityThreshold?: number; forwardFee?: Record<string, number | string> };

export function createIris(options: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }): Iris {
    const { fetch: send = fetch, timeoutMs = 10_000 } = options;
    const base = options.baseUrl.replace(/\/+$/, "");

    async function get(path: string): Promise<{ status: number; body: unknown }> {
        let response: Response;
        try {
            response = await send(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            throw new IrisError("unavailable", "Iris couldn't be reached", { cause: error });
        }
        if (response.status === 429) throw new IrisError("rate_limited", "Iris is rate limiting");
        if (response.status === 404) return { status: 404, body: null };
        if (!response.ok) throw new IrisError("unavailable", `Iris answered ${response.status}`);
        try {
            return { status: response.status, body: await response.json() };
        } catch (error) {
            throw new IrisError("unavailable", "Iris gave an unreadable answer", { cause: error });
        }
    }

    const toWei = (value: number | string | undefined) => {
        if (value === undefined || !/^\d+(\.\d+)?$/.test(String(value))) {
            throw new IrisError("unavailable", "Iris gave no forward fee");
        }
        return BigInt(Math.ceil(Number(value))) * WEI_PER_UNIT;
    };

    return {
        async forwardFee({ from, to, setup }) {
            const query = `forward=true${setup ? "&includeRecipientSetup=true" : ""}`;
            const { body } = await get(`/v2/burn/USDC/fees/${from}/${to}?${query}`);
            const rows = (Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data ?? [])) as FeeRow[];
            const row = Array.isArray(rows)
                ? (rows.find((r) => r.finalityThreshold === STANDARD_FINALITY) ?? rows[0])
                : undefined;
            if (!row?.forwardFee) throw new IrisError("unavailable", "Iris gave no forward fee");
            return { med: toWei(row.forwardFee.med), high: toWei(row.forwardFee.high) };
        },
        async message({ domain, burnTxHash }) {
            const { body } = await get(`/v2/messages/${domain}?transactionHash=${burnTxHash}`);
            const found = (body as { messages?: Record<string, unknown>[] } | null)?.messages?.[0];
            if (!found) return null;
            const forwardTxHash =
                typeof found.forwardTxHash === "string" && found.forwardTxHash ? found.forwardTxHash : null;
            const state = String(found.forwardState ?? "").toUpperCase();
            const status = forwardTxHash ? "complete" : state === "FAILED" ? "failed" : "pending";
            return { status, forwardTxHash, raw: found };
        },
    };
}

export { ARC_DOMAIN, SOLANA_DOMAIN };
