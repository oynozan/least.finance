import { getAddress } from "viem";
import type { DepositOrderDoc } from "../db/mongo.ts";
import { formatUsdc, fromDecimal } from "../db/money.ts";
import type { DepositOrderView, Hex, SourceTxView } from "../protocol.ts";
import type { SourceTx } from "./providers/types.ts";

export const orderView = (order: DepositOrderDoc): DepositOrderView => ({
    id: order._id.toHexString(),
    coin: order.coin,
    amount: order.amount,
    wallet: order.wallet,
    usdcOut: formatUsdc(fromDecimal(order.usdcOut)),
    etaSeconds: order.etaSeconds,
    state: order.state,
    sourceTxHashes: order.sourceTxHashes as Hex[],
    depositId: order.depositId?.toHexString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
});

export function sourceTxView(tx: SourceTx): SourceTxView {
    if (tx.kind !== "evm") throw new Error("A Solana transaction has no EVM view");
    return { chainId: tx.chainId, to: getAddress(tx.to) as Hex, data: tx.data, value: `0x${tx.value.toString(16)}` };
}
