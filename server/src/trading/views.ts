import type { CoinWithdrawalDoc, HoldingDoc, TradeDoc } from "./docs.ts";
import type { CoinWithdrawalView, HoldingView, TradeView } from "./types.ts";
import { formatUnits18, fromUnitsDecimal } from "./units.ts";

export const holdingView = (holding: HoldingDoc): HoldingView => ({
    symbol: holding.symbol,
    units: formatUnits18(fromUnitsDecimal(holding.units)),
    network: holding.network,
});

export const tradeView = (trade: TradeDoc): TradeView => ({
    id: trade._id.toHexString(),
    requestId: trade.requestId,
    verb: trade.verb,
    paidSymbol: trade.paidSymbol,
    paidUnits: formatUnits18(fromUnitsDecimal(trade.paidUnits)),
    gotSymbol: trade.gotSymbol,
    gotUnits: formatUnits18(fromUnitsDecimal(trade.gotUnits)),
    usd: formatUnits18(fromUnitsDecimal(trade.usd)),
    at: trade.createdAt.toISOString(),
});

export const coinWithdrawalView = (doc: CoinWithdrawalDoc): CoinWithdrawalView => ({
    id: doc._id.toHexString(),
    requestId: doc.requestId,
    symbol: doc.symbol,
    units: formatUnits18(fromUnitsDecimal(doc.units)),
    network: doc.network,
    to: doc.to,
    state: doc.state,
    txHash: doc.txHash,
    reason: doc.reason,
    at: doc.createdAt.toISOString(),
});
