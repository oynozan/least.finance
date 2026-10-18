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
    sourceTxHashes: order.sourceTxHashes,
    depositId: order.depositId?.toHexString() ?? null,
    reason: order.state === "failed" || order.state === "refunded" ? (order.failure ?? null) : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
});

/** The view of a transaction; `tables` holds the contents of every lookup table a Solana transaction names. */
export function sourceTxView(tx: SourceTx, tables: ReadonlyMap<string, string[]> = new Map()): SourceTxView {
    if (tx.kind === "solana") {
        return {
            kind: "solana",
            instructions: tx.instructions,
            lookupTables: tx.lookupTables.flatMap((address) => {
                const addresses = tables.get(address);
                return addresses ? [{ address, addresses }] : [];
            }),
        };
    }
    return {
        kind: "evm",
        chainId: tx.chainId,
        to: getAddress(tx.to) as Hex,
        data: tx.data,
        value: `0x${tx.value.toString(16)}`,
    };
}
