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
            if (status.err !== null && status.err !== undefined) return "failed";
            return status.confirmationStatus === "processed" ? null : "confirmed";
        },
    };
}

/** `sendTransaction` over JSON-RPC, trying each URL in order. */
export function jsonRpcSend(urls: readonly string[], fetchImpl: typeof fetch = fetch) {
    return async (wire: string): Promise<void> => {
        let failure: unknown = new Error("No Solana RPC URL is configured");
        for (const url of urls) {
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
                if (!response.ok) throw new Error(`Solana RPC answered ${response.status}`);
                const body = (await response.json()) as { error?: { message?: string } };
                // A preflight rejection is the network turning the transaction down
                if (body.error) throw new SolanaRefusal(body.error.message ?? "The cluster refused the transaction");
                return;
            } catch (error) {
                if (error instanceof SolanaRefusal) throw error;
                failure = error;
            }
        }
        throw failure;
    };
}

/** The cluster read the transaction and said no; its text names what failed, such as insufficient funds. */
export class SolanaRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SolanaRefusal";
    }
}
