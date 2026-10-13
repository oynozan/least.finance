/** Whether a Solana signature failed on chain, from the first RPC that answers; null while no RPC has a verdict. */
export function createSolanaSignatureStatus(
    urls: readonly string[],
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): (signature: string) => Promise<{ failed: boolean } | null> {
    const { fetch: send = fetch, timeoutMs = 10_000 } = options;
    return async (signature) => {
        let failure: unknown = new Error("No Solana RPC URL is configured");
        for (const url of urls) {
            try {
                const response = await send(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "getSignatureStatuses",
                        params: [[signature], { searchTransactionHistory: true }],
                    }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!response.ok) throw new Error(`Solana RPC answered ${response.status}`);
                const body = (await response.json()) as { result?: { value?: ({ err: unknown } | null)[] } };
                const value = body.result?.value;
                if (!value) throw new Error("Solana RPC gave no result");
                const found = value[0];
                return found ? { failed: found.err !== null && found.err !== undefined } : null;
            } catch (error) {
                failure = error;
            }
        }
        throw failure;
    };
}
