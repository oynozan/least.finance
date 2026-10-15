import type { ObjectId } from "mongodb";
import type { Collections } from "../db/mongo.ts";
import type { HoldingView } from "./types.ts";
import { fromUnitsDecimal } from "./units.ts";
import { holdingView } from "./views.ts";

/** The coins an account holds, without the empty ones, in symbol order. */
export async function listHoldings(
    { holdings }: Pick<Collections, "holdings">,
    accountId: ObjectId,
): Promise<HoldingView[]> {
    const docs = await holdings.find({ accountId }).sort({ symbol: 1 }).toArray();
    return docs.filter((doc) => fromUnitsDecimal(doc.units) > 0n).map(holdingView);
}
