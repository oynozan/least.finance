import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A JSON-RPC proxy that makes an anvil chain behave like Arc where deposits
 * care: every native value transfer, internal ones included, shows up as a
 * Transfer log from the system address 0xff…fe (EIP-7708), in receipts and in
 * eth_getLogs alike. It can also cap eth_getLogs the way Arc's public RPC
 * does, so the scan's range splitting gets exercised.
 */

const EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type Json = Record<string, unknown>;
type RpcLog = {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    blockHash: string;
    transactionHash: string;
    transactionIndex: string;
    logIndex: string;
    removed: boolean;
};
type CallFrame = { type: string; from: string; to?: string; value?: string; error?: string; calls?: CallFrame[] };
type RpcError = { code: number; message: string };

export type EmulatorOptions = {
    /** Like Arc's public RPC: an eth_getLogs answer with more logs than this is refused. */
    maxResults?: number;
    /** Like Arc's public RPC: an eth_getLogs range wider than this is refused. */
    maxRange?: number;
};

export type ArcEmulator = {
    url: string;
    options: EmulatorOptions;
    /** eth_getLogs calls answered so far, refused ones included. */
    logQueries: number;
    /** Makes the next `count` requests fail as if the RPC were down. */
    failNext(count: number): void;
    stop(): Promise<void>;
};

const hex = (value: number | bigint) => `0x${value.toString(16)}`;
const word = (value: string | bigint) =>
    `0x${(typeof value === "bigint" ? value.toString(16) : value.slice(2)).toLowerCase().padStart(64, "0")}`;

class RpcFailure extends Error {
    readonly rpc: RpcError;
    constructor(rpc: RpcError) {
        super(rpc.message);
        this.rpc = rpc;
    }
}

export async function startArcEmulator(upstream: string, options: EmulatorOptions = {}): Promise<ArcEmulator> {
    let id = 0;
    let failures = 0;
    const blockLogsCache = new Map<string, RpcLog[]>();

    async function call<T>(method: string, params: unknown[]): Promise<T> {
        const response = await fetch(upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        const body = (await response.json()) as { result?: T; error?: RpcError };
        if (body.error) throw new RpcFailure(body.error);
        return body.result as T;
    }

    /** Value moved by a transaction, in call order; reverted frames move nothing. */
    function nativeTransfers(frame: CallFrame, out: { from: string; to: string; value: bigint }[] = []) {
        if (frame.error) return out;
        const value = frame.value ? BigInt(frame.value) : 0n;
        const moves = ["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"].includes(frame.type);
        if (moves && value > 0n && frame.to && frame.to.toLowerCase() !== frame.from.toLowerCase()) {
            out.push({ from: frame.from, to: frame.to, value });
        }
        for (const child of frame.calls ?? []) nativeTransfers(child, out);
        return out;
    }

    /** Every log in a block, Arc style: each transaction's native transfers first, then its own logs. */
    async function blockLogs(number: bigint): Promise<RpcLog[]> {
        const block = await call<{ hash: string; transactions: string[] } | null>("eth_getBlockByNumber", [
            hex(number),
            false,
        ]);
        if (!block) return [];
        const cached = blockLogsCache.get(block.hash);
        if (cached) return cached;

        const logs: RpcLog[] = [];
        let logIndex = 0;
        for (const [txIndex, hash] of block.transactions.entries()) {
            const receipt = await call<{ status: string; logs: RpcLog[] }>("eth_getTransactionReceipt", [hash]);
            const base = {
                blockNumber: hex(number),
                blockHash: block.hash,
                transactionHash: hash,
                transactionIndex: hex(txIndex),
                removed: false,
            };
            if (receipt.status === "0x1") {
                const trace = await call<CallFrame>("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
                for (const move of nativeTransfers(trace)) {
                    logs.push({
                        ...base,
                        address: EMITTER,
                        topics: [TRANSFER, word(move.from), word(move.to)],
                        data: word(move.value),
                        logIndex: hex(logIndex++),
                    });
                }
            }
            for (const log of receipt.logs) logs.push({ ...log, ...base, logIndex: hex(logIndex++) });
        }
        blockLogsCache.set(block.hash, logs);
        return logs;
    }

    async function resolveBlock(tag: unknown, head: bigint): Promise<bigint> {
        if (tag === undefined || tag === "latest" || tag === "safe" || tag === "finalized" || tag === "pending") {
            return head;
        }
        if (tag === "earliest") return 0n;
        return BigInt(tag as string);
    }

    const matches = (log: RpcLog, filter: Json) => {
        const address = filter.address;
        if (address) {
            const allowed = (Array.isArray(address) ? address : [address]).map((a) => String(a).toLowerCase());
            if (!allowed.includes(log.address.toLowerCase())) return false;
        }
        const topics = (filter.topics as (string | string[] | null)[] | undefined) ?? [];
        return topics.every((wanted, i) => {
            if (wanted === null || wanted === undefined) return true;
            const topic = log.topics[i]?.toLowerCase();
            const options = (Array.isArray(wanted) ? wanted : [wanted]).filter((t) => t !== null);
            return options.length === 0 || options.some((t) => t.toLowerCase() === topic);
        });
    };

    async function getLogs(filter: Json): Promise<RpcLog[]> {
        emulator.logQueries++;
        let blocks: bigint[];
        if (filter.blockHash) {
            const block = await call<{ number: string } | null>("eth_getBlockByHash", [filter.blockHash, false]);
            blocks = block ? [BigInt(block.number)] : [];
        } else {
            const head = BigInt(await call<string>("eth_blockNumber", []));
            const from = await resolveBlock(filter.fromBlock, head);
            const to = await resolveBlock(filter.toBlock, head);
            if (options.maxRange !== undefined && to - from + 1n > BigInt(options.maxRange)) {
                throw new RpcFailure({ code: -32602, message: "requested range too large" });
            }
            blocks = [];
            for (let n = from; n <= to && n <= head; n++) blocks.push(n);
        }
        const all = (await Promise.all(blocks.map(blockLogs))).flat().filter((log) => matches(log, filter));
        if (options.maxResults !== undefined && all.length > options.maxResults) {
            throw new RpcFailure({
                code: -32602,
                message: `query exceeds max results ${options.maxResults}, retry with a smaller range`,
            });
        }
        return all;
    }

    async function handle(request: Json): Promise<Json> {
        const reply = (body: Json) => ({ jsonrpc: "2.0", id: request.id ?? null, ...body });
        if (failures > 0) {
            failures--;
            return reply({ error: { code: -32603, message: "upstream unavailable" } });
        }
        const method = String(request.method);
        const params = (request.params as unknown[]) ?? [];
        try {
            if (method === "eth_getLogs") return reply({ result: await getLogs((params[0] as Json) ?? {}) });
            if (method === "eth_getTransactionReceipt") {
                const receipt = await call<(Json & { blockNumber: string; transactionHash: string }) | null>(
                    method,
                    params,
                );
                if (!receipt) return reply({ result: null });
                const logs = (await blockLogs(BigInt(receipt.blockNumber))).filter(
                    (log) => log.transactionHash === receipt.transactionHash,
                );
                return reply({ result: { ...receipt, logs } });
            }
            return reply({ result: await call(method, params) });
        } catch (error) {
            if (error instanceof RpcFailure) return reply({ error: error.rpc });
            return reply({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        }
    }

    const readBody = (req: IncomingMessage) =>
        new Promise<string>((resolve, reject) => {
            let body = "";
            req.setEncoding("utf8");
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => resolve(body));
            req.on("error", reject);
        });

    const server = createServer(async (req, res) => {
        // Browsers (a wallet in an end-to-end test) call it too.
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-headers", "content-type");
        if (req.method === "OPTIONS") return res.writeHead(204).end();
        try {
            const parsed = JSON.parse(await readBody(req)) as Json | Json[];
            const result = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch {
            res.writeHead(400).end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const emulator: ArcEmulator = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        options,
        logQueries: 0,
        failNext: (count) => {
            failures = count;
        },
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return emulator;
}
