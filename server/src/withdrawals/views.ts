import type { WithdrawalDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { WithdrawalView } from "../protocol.ts";

export function withdrawalView(doc: WithdrawalDoc): WithdrawalView {
    return {
        id: doc._id.toHexString(),
        requestId: doc.requestId,
        amount: formatUsdc(fromDecimal(doc.amount)),
        to: doc.to,
        state: doc.state,
        txHash: doc.txHash,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
    };
}
