import type { WithdrawalDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { WithdrawalView } from "../protocol.ts";

export function withdrawalView(doc: WithdrawalDoc): WithdrawalView {
    const solana = doc.network === "solana" ? doc.solana : undefined;
    const fee = solana ? fromDecimal(solana.fee) : null;
    return {
        id: doc._id.toHexString(),
        requestId: doc.requestId,
        amount: formatUsdc(fromDecimal(doc.amount)),
        to: doc.to,
        network: doc.network ?? "arc",
        fee: fee === null ? null : formatUsdc(fee),
        receive: fee === null ? null : formatUsdc(fromDecimal(doc.amount) - fee),
        state: doc.state,
        txHash: solana ? solana.burnTxHash : doc.txHash,
        forwardTxHash: solana?.forwardTxHash ?? null,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
    };
}
