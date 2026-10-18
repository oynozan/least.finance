import type { WithdrawalDoc } from "../db/mongo.ts";
import { quoted } from "../errors.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { WithdrawalView } from "../protocol.ts";
import { BALANCE_BACK, forwardFailedMessage, forwardSlowMessage, withdrawalRef } from "./failures.ts";

/** Time in `forwarding` after which the view says it is taking longer than expected. */
export const FORWARDING_DELAYED_MS = 15 * 60_000;

const REASONS: [RegExp, string][] = [
    [/^rejected by the network/i, "The network rejected the transfer."],
    [/^(approval |burn )?reverted on the network/i, "The transfer was reverted on the network."],
];

/** A failed withdrawal's stored reason as a sentence for the person; what we don't recognise is quoted. */
export function withdrawalReason(failure: string | null): string {
    if (!failure) return `The withdrawal failed on our side. ${BALANCE_BACK}`;
    const known = REASONS.find(([test]) => test.test(failure));
    return `${known ? known[1] : `The withdrawal failed: ${quoted(failure)}.`} ${BALANCE_BACK}`;
}

export function withdrawalView(doc: WithdrawalDoc, now = Date.now()): WithdrawalView {
    const solana = doc.network === "solana" ? doc.solana : undefined;
    const fee = solana ? fromDecimal(solana.fee) : null;
    const delayed = doc.state === "forwarding" && now - doc.updatedAt.getTime() >= FORWARDING_DELAYED_MS;
    const message =
        doc.state === "failed"
            ? (doc.message ?? withdrawalReason(doc.failure))
            : doc.state === "forwarding" && solana?.forwardFailure
              ? forwardFailedMessage(withdrawalRef(doc._id))
              : delayed
                ? forwardSlowMessage(withdrawalRef(doc._id))
                : undefined;
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
        delayed,
        ...(message && { message }),
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
    };
}
