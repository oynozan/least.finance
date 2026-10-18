import type { AccountDoc, PerpOrderDoc, PerpPositionDoc } from "../db/mongo.ts";
import { formatE6, formatUsdc, fromDecimal } from "../db/money.ts";
import { accountView } from "../deposits/views.ts";
import { PERP_MESSAGES } from "./failures.ts";
import type { PerpOrderView, PerpPositionView, PerpUpdate } from "../protocol.ts";

export const perpOrderView = (order: PerpOrderDoc): PerpOrderView => ({
    id: order._id.toHexString(),
    requestId: order.requestId,
    kind: order.kind,
    asset: order.asset,
    side: order.side,
    leverage: order.leverage,
    state: order.state,
    reason: order.reason,
    detail: order.detail ?? null,
    positionId: typeof order.steps.positionId === "string" ? order.steps.positionId : null,
    filledSizeCoin: order.fill?.sizeCoin ?? null,
    requestedSizeCoin: order.sizeCoin,
    collateralUSD: formatUsdc(fromDecimal(order.collateral)),
    creditedUSD: order.credited ? formatUsdc(fromDecimal(order.credited)) : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
});

export const perpPositionView = (position: PerpPositionDoc): PerpPositionView => ({
    id: position._id.toHexString(),
    asset: position.asset,
    side: position.side,
    leverage: position.leverage,
    sizeCoin: position.sizeCoin,
    entryPx: position.entryPx,
    collateralUSD: formatUsdc(fromDecimal(position.collateral)),
    liquidationPx: position.snapshot?.liquidationPx ?? null,
    markPx: position.snapshot?.markPx ?? null,
    unrealizedPnlUSD: position.snapshot ? formatE6(fromDecimal(position.snapshot.unrealizedPnlE6)) : "0",
    cumFundingUSD: position.snapshot ? formatE6(fromDecimal(position.snapshot.cumFundingE6)) : "0",
    feesUSD: formatE6(fromDecimal(position.openedFee) + (position.ourFee ? fromDecimal(position.ourFee) : 0n)),
    state: position.state,
    proceedsUSD: position.proceeds ? formatUsdc(fromDecimal(position.proceeds)) : null,
    notice: position.state === "open" ? position.closeReason : null,
    closeBlocked: position.state === "open" && position.closeReason === PERP_MESSAGES.tooSmall,
    openedAt: position.openedAt.toISOString(),
    settledAt: position.settledAt?.toISOString() ?? null,
    updatedAt: position.updatedAt.toISOString(),
});

export const perpUpdate = (u: {
    order: PerpOrderDoc;
    position: PerpPositionDoc | null;
    account: AccountDoc;
}): PerpUpdate => ({
    order: perpOrderView(u.order),
    position: u.position && perpPositionView(u.position),
    account: accountView(u.account),
});
