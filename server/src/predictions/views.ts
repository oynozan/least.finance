import type { AccountDoc, PositionDoc, PredictionOrderDoc } from "../db/mongo.ts";
import { formatE6, formatUsdc, fromDecimal } from "../db/money.ts";
import { accountView } from "../deposits/views.ts";
import { orderRef } from "./failures.ts";
import type { PositionView, PredictionOrderView, PredictionUpdate } from "../protocol.ts";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "$1,250", or with cents only when they matter ("$12.50"), as the client shows it. */
export const formatUsdShort = (value: number) => (Number.isInteger(value) ? usdWhole.format(value) : usd.format(value));

const optionalUsdc = (wei: PositionDoc["proceeds"]) => (wei ? formatUsdc(fromDecimal(wei)) : null);

const reviewMessage = (order: PredictionOrderDoc) =>
    `We're checking this order with Polymarket (ref ${orderRef(order._id)}). ${order.side === "sell" ? "Your position" : "Your balance"} is held until it is confirmed.`;

export const orderView = (order: PredictionOrderDoc): PredictionOrderView => ({
    id: order._id.toHexString(),
    requestId: order.requestId,
    side: order.side,
    state: order.state,
    reason: order.reason,
    ...(order.state === "failed" && order.message && { message: order.message }),
    // A post nobody could confirm is held, not failed; the person is told so instead of left to wait
    ...(order.state === "posted" && order.needsReviewAt && { message: reviewMessage(order) }),
    eventId: order.eventId,
    tokenId: order.tokenId,
    question: order.question,
    outcome: order.outcome,
    amountUSD: order.side === "buy" ? formatUsdc(fromDecimal(order.amount)) : null,
    shares: order.filledShares
        ? formatE6(fromDecimal(order.filledShares))
        : order.shares
          ? formatE6(fromDecimal(order.shares))
          : null,
    positionId: order.positionId?.toHexString() ?? null,
    ...(order.soldPart && {
        soldPart: {
            costUSD: formatUsdc(fromDecimal(order.soldPart.cost)),
            proceedsUSD: formatUsdc(fromDecimal(order.soldPart.proceeds)),
            at: order.soldPart.at.toISOString(),
        },
    }),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
});

export const positionView = (position: PositionDoc): PositionView => ({
    id: position._id.toHexString(),
    eventId: position.eventId,
    marketId: position.marketId,
    tokenId: position.tokenId,
    question: position.question,
    outcome: position.outcome,
    shares: formatE6(fromDecimal(position.shares)),
    costUSD: formatUsdc(fromDecimal(position.cost)),
    state: position.state,
    proceedsUSD: optionalUsdc(position.proceeds),
    payoutUSD: optionalUsdc(position.payout),
    openedAt: position.openedAt.toISOString(),
    settledAt: position.settledAt?.toISOString() ?? null,
    updatedAt: position.updatedAt.toISOString(),
});

export const predictionUpdate = (u: {
    order: PredictionOrderDoc;
    position: PositionDoc | null;
    account: AccountDoc;
}): PredictionUpdate => ({
    requestId: u.order.requestId,
    order: orderView(u.order),
    position: u.position && positionView(u.position),
    account: accountView(u.account),
});
