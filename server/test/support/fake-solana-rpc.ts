import { base58 } from "@scure/base";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeSolanaRpc = Awaited<ReturnType<typeof startFakeSolanaRpc>>;

/** A Solana JSON-RPC stand-in that answers balance, blockhash, signature, lookup-table and account reads from what's been set. */
export async function startFakeSolanaRpc() {
    const lamports = new Map<string, bigint>();
    const tokens = new Map<string, bigint>();
    const statuses = new Map<string, { confirmationStatus: string; err: unknown }>();
    const tables = new Map<string, string[]>();
    const accounts = new Map<string, { owner: string; lamports: bigint }>();
    let blockhash = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
    let failures = 0;
    let failStatus = 500;
    let requests = 0;

    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            requests += 1;
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
            } else if (method === "getLatestBlockhash") {
                result = { context: { slot: 1 }, value: blockhash };
            } else if (method === "getSignatureStatuses") {
                result = {
                    context: { slot: 1 },
                    value: (params[0] as string[]).map((sig) => statuses.get(sig) ?? null),
                };
            } else if (method === "getMultipleAccounts") {
                const value = (params[0] as string[]).map((address) => {
                    const list = tables.get(address);
                    if (!list) return null;
                    const data = Buffer.concat([Buffer.alloc(56), ...list.map((a) => Buffer.from(base58.decode(a)))]);
                    return {
                        data: [data.toString("base64"), "base64"],
                        lamports: 1,
                        owner: "AddressLookupTab1e1111111111111111111111111",
                    };
                });
                result = { context: { slot: 1 }, value };
            } else if (method === "getMinimumBalanceForRentExemption") {
                result = (params[0] + 128) * 6960;
            } else if (method === "getAccountInfo") {
                const found = accounts.get(params[0]);
                result = {
                    context: { slot: 1 },
                    value: found
                        ? { data: ["", "base64"], owner: found.owner, lamports: Number(found.lamports) }
                        : null,
                };
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
        setBlockhash: (value: string, lastValidBlockHeight: number) =>
            void (blockhash = { blockhash: value, lastValidBlockHeight }),
        setSignatureStatus: (signature: string, status: { confirmationStatus: string; err: unknown }) =>
            void statuses.set(signature, status),
        setLookupTable: (address: string, addresses: string[]) => void tables.set(address, addresses),
        setAccount: (address: string, account: { owner: string; lamports: bigint }) =>
            void accounts.set(address, account),
        /** JSON-RPC requests received so far, failed ones included. */
        requests: () => requests,
        failNext(count: number, status = 500) {
            failures = count;
            failStatus = status;
        },
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
