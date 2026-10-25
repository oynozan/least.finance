import { liveValue, type LivePredictionPosition, type Position } from "@/components/wallet-data";
import type { HoldingView } from "@/server/src/trading/types";

/** Everything the account holds in dollars, and the three parts it adds up from. */
export type Worth = { total: number; cash: number; coins: number; positions: number };

/** What an open position is worth now: a prediction at its sell price and a perp at its mark, or the stake while either is unknown or still filling. */
function positionWorth(p: Position, sellPriceOf: (p: LivePredictionPosition) => number | null): number {
    if (p.status === "pending") return p.size;
    const live = liveValue(p, p.kind === "prediction-live" ? sellPriceOf(p) : null);
    return live === null ? p.size : Math.max(live.value, 0);
}

/**
 * The account's worth: its cash, its coins at their prices and its open positions at what they're worth now, so opening
 * a position moves money from cash to positions instead of shrinking the total. A coin with no price yet is left out.
 * Undefined while the cash is loading and null while it can't be read, as the cash itself is.
 */
export function walletWorth(o: {
    cash: number | null | undefined;
    holdings: HoldingView[];
    priceOf: (symbol: string) => number | null;
    positions: Position[];
    sellPriceOf: (p: LivePredictionPosition) => number | null;
}): Worth | null | undefined {
    if (o.cash === undefined || o.cash === null) return o.cash;
    const coins = o.holdings.reduce((sum, h) => {
        const price = o.priceOf(h.symbol);
        return price === null ? sum : sum + Number(h.units) * price;
    }, 0);
    const positions = o.positions.reduce((sum, p) => sum + positionWorth(p, o.sellPriceOf), 0);
    return { total: o.cash + coins + positions, cash: o.cash, coins, positions };
}
