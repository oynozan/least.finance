import type { WithdrawalDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { WithdrawalView } from "../protocol.ts";

/** Time in `forwarding` after which the view says it is taking longer than expected. */
export const FORWARDING_DELAYED_MS = 15 * 60_000;

export function withdrawalView(doc: WithdrawalDoc, now = Date.now()): WithdrawalView {
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
        delayed: doc.state === "forwarding" && now - doc.updatedAt.getTime() >= FORWARDING_DELAYED_MS,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
    };
}
