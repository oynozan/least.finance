import type { SwapOrderDoc } from "../db/mongo.ts";
import type { SwapOrderView } from "../protocol.ts";

export const swapOrderView = (order: SwapOrderDoc): SwapOrderView => ({
    id: order._id.toHexString(),
    state: order.state,
    from: { token: order.from.token, network: order.from.network, amount: order.from.amount },
    to: {
        token: order.to.token,
        network: order.to.network,
        amount: order.to.amount,
        received: order.received,
        receivedSymbol: order.receivedSymbol,
    },
    wallet: order.wallet,
    txHashes: order.txHashes,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
});
