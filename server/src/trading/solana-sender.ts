import {
    AccountRole,
    address,
    appendTransactionMessageInstruction,
    createKeyPairSignerFromPrivateKeyBytes,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Blockhash,
    type Instruction,
} from "@solana/kit";
import type { SolanaRpc } from "../crosschain/solana.ts";
import type { SolanaSender } from "./coin-sender.ts";
import { upstreamSaid } from "./failures.ts";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
/** The System program's Transfer instruction index. */
const TRANSFER = 2;

/** The System program's transfer: the instruction index as a u32 and the lamports as a u64, both little-endian. */
function transferData(lamports: bigint): Uint8Array {
    const data = new DataView(new ArrayBuffer(12));
    data.setUint32(0, TRANSFER, true);
    data.setBigUint64(4, lamports, true);
    return new Uint8Array(data.buffer);
}

/** Sends SOL from the Solana inventory wallet: the transaction is signed first, so its signature can be recorded before it goes out. */
export function createSolanaSender(options: {
    seed: Uint8Array;
    rpc: Pick<SolanaRpc, "getLatestBlockhash" | "getSignatureStatuses">;
    /** Sends a base64 wire transaction; JSON-RPC `sendTransaction` over the configured URLs by default. */
    send: (wire: string) => Promise<void>;
}): SolanaSender {
    const { seed, rpc, send } = options;
    const signer = createKeyPairSignerFromPrivateKeyBytes(seed);

    return {
        async prepare(to, lamports) {
            const from = await signer;
            const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
            const instruction: Instruction = {
                programAddress: SYSTEM_PROGRAM,
                accounts: [
                    { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
                    { address: address(to), role: AccountRole.WRITABLE },
                ],
                data: transferData(lamports),
            } as Instruction;
            const message = pipe(
                createTransactionMessage({ version: 0 }),
                (tx) => setTransactionMessageFeePayerSigner(from, tx),
                (tx) =>
                    setTransactionMessageLifetimeUsingBlockhash(
                        { blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) },
                        tx,
                    ),
                (tx) => appendTransactionMessageInstruction(instruction, tx),
            );
            const signed = await signTransactionMessageWithSigners(message);
            const wire = getBase64EncodedWireTransaction(signed);
            return { signature: getSignatureFromTransaction(signed), broadcast: () => send(wire) };
        },

        async status(signature) {
            const [status] = await rpc.getSignatureStatuses([signature]);
            if (!status) return null;
            if (status.err !== null && status.err !== undefined) return { state: "failed" as const, err: status.err };
            return status.confirmationStatus === "processed" ? null : "confirmed";
        },
    };
}

/** Answers that say the node is busy or behind, not that the transaction is bad. */
const TRANSIENT = /blockhash not found|node is unhealthy|node is behind|too many requests|try again/i;
const TRANSIENT_CODES = new Set([-32004, -32005]);

/** `sendTransaction` over JSON-RPC, trying each URL in order. A failure names the provider by its place in the list, never by its URL, which carries a key. */
export function jsonRpcSend(
    urls: readonly string[],
    fetchImpl: typeof fetch = fetch,
    logger?: { warn(context: object, message: string): void },
) {
    return async (wire: string): Promise<void> => {
        const failures: string[] = [];
        for (const [index, url] of urls.entries()) {
            try {
                const response = await fetchImpl(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "sendTransaction",
                        params: [wire, { encoding: "base64", preflightCommitment: "confirmed" }],
                    }),
                    signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = (await response.json()) as {
                    error?: { message?: string; code?: number; data?: { err?: unknown; logs?: unknown } };
                };
                // A preflight rejection is the network turning the transaction down
                // A node that is busy or behind says nothing about the transaction, so it is tried elsewhere or again
                if (body.error && (TRANSIENT.test(body.error.message ?? "") || TRANSIENT_CODES.has(body.error.code ?? 0)))
                    throw new Error(`${body.error.message ?? "node busy"} (code ${body.error.code})`);
                if (body.error)
                    throw new SolanaRefusal(body.error.message ?? "The cluster refused the transaction", {
                        code: body.error.code,
                        data: body.error.data,
                    });
                return;
            } catch (error) {
                if (error instanceof SolanaRefusal) throw error;
                const said =
                    error instanceof Error && error.name === "TimeoutError" ? "timed out" : upstreamSaid(error);
                logger?.warn(
                    { event: "solana:send", provider: index + 1, providers: urls.length, err: error },
                    `Solana RPC #${index + 1} didn't take the transaction: ${said}`,
                );
                failures.push(`RPC #${index + 1}: ${said}`);
            }
        }
        throw new Error(failures.length > 0 ? failures.join("; ") : "No Solana RPC URL is configured");
    };
}

/** The cluster read the transaction and said no; its text names what failed, such as insufficient funds, and `code` and `data.err` say it exactly. */
export class SolanaRefusal extends Error {
    readonly code: number | undefined;
    readonly data: { err?: unknown; logs?: unknown } | undefined;

    constructor(message: string, said: { code?: number; data?: { err?: unknown; logs?: unknown } } = {}) {
        super(message);
        this.name = "SolanaRefusal";
        this.code = said.code;
        this.data = said.data;
    }
}
