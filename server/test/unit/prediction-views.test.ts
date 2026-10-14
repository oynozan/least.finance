import { ObjectId } from "mongodb";
import { expect, test } from "vitest";
import type { PredictionOrderDoc } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import { orderView } from "../../src/predictions/views.ts";
import { wei } from "../support/prediction-harness.ts";

const sellOrder = (extra: Partial<PredictionOrderDoc> = {}): PredictionOrderDoc => {
    const now = new Date("2026-10-14T10:00:00.000Z");
    return {
        _id: new ObjectId(),
        accountId: new ObjectId(),
        requestId: "request-1",
        side: "sell",
        eventId: "evt-1",
        marketId: "mkt-1",
        tokenId: "tok-yes",
        conditionId: "0xcondition",
        question: "Will it rain?",
        outcome: "YES",
        amount: toDecimal(0n),
        shares: toDecimal(12_000_000n),
        quotedPrice: 0.48,
        limitPrice: 0,
        positionId: new ObjectId(),
        orderHash: null,
        clobOrderId: null,
        signed: null,
        state: "filled",
        reason: null,
        filledShares: toDecimal(12_000_000n),
        cost: null,
        postedAt: null,
        createdAt: now,
        updatedAt: now,
        ...extra,
    };
};

test("orderView carries soldPart as costUSD, proceedsUSD and an ISO at", () => {
    const at = new Date("2026-10-14T11:30:00.000Z");
    const view = orderView(
        sellOrder({ soldPart: { cost: toDecimal(wei("6")), proceeds: toDecimal(wei("5.76")), at } }),
    );
    expect(view.soldPart).toEqual({ costUSD: "6", proceedsUSD: "5.76", at: "2026-10-14T11:30:00.000Z" });
});

test("orderView leaves soldPart out when the doc has none", () => {
    expect("soldPart" in orderView(sellOrder())).toBe(false);
});
