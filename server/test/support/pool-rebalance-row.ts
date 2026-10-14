import { Decimal128, ObjectId } from "mongodb";
import type { PoolRebalanceDoc } from "../../src/db/mongo.ts";

const zero = Decimal128.fromString("0");

/** A bare pool rebalance row in `submitting`, with the given parts of `polygon` set. */
export function poolRebalanceRow(o: {
    kind: PoolRebalanceDoc["kind"];
    now: Date;
    polygon?: Partial<PoolRebalanceDoc["polygon"]>;
}): PoolRebalanceDoc {
    return {
        _id: new ObjectId(),
        kind: o.kind,
        direction: o.kind === "move" ? "polygon_to_arc" : null,
        source: "auto",
        reason: "high",
        amountE6: Decimal128.fromString("10000000"),
        maxFeeE6: zero,
        reservedE6: zero,
        state: "submitting",
        attempts: 0,
        nextAt: null,
        lastError: null,
        mintRecipient: null,
        createdAt: o.now,
        updatedAt: o.now,
        doneAt: null,
        resolvedAt: null,
        arc: {
            approveNonce: null,
            approveRawTx: null,
            approveTxHash: null,
            burnNonce: null,
            burnRawTx: null,
            burnTxHash: null,
        },
        polygon: {
            attemptedAt: null,
            relayerTransactionId: null,
            relayerFinalAt: null,
            burnTxHash: null,
            burnLogSeen: null,
            wrapAttemptedAt: null,
            wrapTransactionId: null,
            wrapSubmittedAt: null,
            wrapFinalAt: null,
            mintedE6: null,
            balanceBeforeE6: null,
            ...o.polygon,
        },
        iris: { checkedAt: null, forwardTxHash: null, feeExecutedE6: null, delayReason: null },
    };
}
