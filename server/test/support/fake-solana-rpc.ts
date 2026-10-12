import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A Solana JSON-RPC stand-in that answers getBalance and getTokenAccountsByOwner from what's been set. */
export async function startFakeSolanaRpc() {
    const lamports = new Map<string, bigint>();
    const tokens = new Map<string, bigint>();
    let failures = 0;
    let failStatus = 500;

    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            if (failures > 0) {
                failures -= 1;
                res.writeHead(failStatus).end("fail");
                return;
            }
            const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: any[] };
            let result: unknown;
            if (method === "getBalance") {
                result = { context: { slot: 1 }, value: Number(lamports.get(params[0]) ?? 0n) };
            } else if (method === "getTokenAccountsByOwner") {
                const units = tokens.get(`${params[0]}:${params[1].mint}`);
                const account = (amount: bigint) => ({
                    pubkey: "TokenAccount",
                    account: { data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } },
                });
                // Two accounts when held, so the reader has to sum them.
                const value = units === undefined ? [] : [account(units / 2n), account(units - units / 2n)];
                result = { context: { slot: 1 }, value };
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify(
                    result === undefined
                        ? { jsonrpc: "2.0", id, error: { message: "unknown method" } }
                        : { jsonrpc: "2.0", id, result },
                ),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        setBalance: (owner: string, amount: bigint) => void lamports.set(owner, amount),
        setTokenBalance: (owner: string, mint: string, units: bigint) => void tokens.set(`${owner}:${mint}`, units),
        failNext(count: number, status = 500) {
            failures = count;
            failStatus = status;
        },
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
