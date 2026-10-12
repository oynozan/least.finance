import { CATALOG, PREDICTION_MARKETS, QUOTE } from "./catalog";
import { formatCents, formatUnits, formatUsdShort } from "./format";
import type { TransactionIntent } from "./intent";
import type { PositionView } from "@/server/src/protocol";

export type ActivityKind = "deposit" | "swap" | "buy" | "sell" | "long" | "short" | "close" | "predict";

/** One thing the account did, as the PnL page lists it. */
export type Activity = {
    id: string;
    at: Date;
    kind: ActivityKind;
    /** "Swap ETH to SOL", "Long BTC 10x", "YES on Will BTC reach $150K?" */
    title: string;
    /** A second line: "0.8 ETH for 13.5 SOL". */
    detail: string;
    /** Coins for the icon; a swap shows both. */
    symbols: string[];
    /** Its size, in USD. */
    amountUSD: number;
    /** What it did to the balance, in USD: a deposit adds itself, a close its realized PnL, every trade its fee. */
    change: number;
    /** A deposit the server hasn't confirmed yet. */
    pending?: boolean;
    /** Confirmed in Review, but nothing was sent: trading isn't live yet. */
    simulated?: boolean;
};

const DAY = 86_400_000;
const SWAP_FEE_USD = 0.03;
const SPOT_FEE_RATE = 0.002;
const PERP_FEE_RATE = 0.0005;

const priceOf = (symbol: string) => CATALOG.tokens.find((t) => t.symbol === symbol)?.priceUSD ?? 1;
const units = (usd: number, symbol: string) => formatUnits(usd / priceOf(symbol), symbol);

type Trade =
    | { kind: "swap"; from: string; to: string; usd: number }
    | { kind: "buy" | "sell"; symbol: string; usd: number }
    | { kind: "long" | "short"; symbol: string; leverage: number; usd: number }
    | { kind: "close"; symbol: string; side: "long" | "short"; leverage: number; usd: number; pnl: number }
    | { kind: "predict"; marketId: string; outcome: "yes" | "no"; usd: number };

/** Titles, details and balance effects, the same for mock trades and confirmed ones. */
function describe(trade: Trade): Omit<Activity, "id" | "at"> {
    switch (trade.kind) {
        case "swap":
            return {
                kind: "swap",
                title: `Swap ${trade.from} to ${trade.to}`,
                detail: `${units(trade.usd, trade.from)} for ${units(trade.usd - SWAP_FEE_USD, trade.to)}`,
                symbols: [trade.from, trade.to],
                amountUSD: trade.usd,
                change: -SWAP_FEE_USD,
            };
        case "buy":
        case "sell":
            return {
                kind: trade.kind,
                title: `${trade.kind === "buy" ? "Buy" : "Sell"} ${trade.symbol}`,
                detail: units(trade.usd, trade.symbol),
                symbols: [trade.symbol],
                amountUSD: trade.usd,
                change: -trade.usd * SPOT_FEE_RATE,
            };
        case "long":
        case "short": {
            const size = trade.usd * trade.leverage;
            return {
                kind: trade.kind,
                title: `${trade.kind === "long" ? "Long" : "Short"} ${trade.symbol} ${trade.leverage}x`,
                detail: `A ${formatUsdShort(size)} position`,
                symbols: [trade.symbol],
                amountUSD: trade.usd,
                change: -size * PERP_FEE_RATE,
            };
        }
        case "close": {
            const size = trade.usd * trade.leverage;
            return {
                kind: "close",
                title: `Close ${trade.side} ${trade.symbol} ${trade.leverage}x`,
                detail: `A ${formatUsdShort(size)} position`,
                symbols: [trade.symbol],
                amountUSD: trade.usd,
                change: trade.pnl - size * PERP_FEE_RATE,
            };
        }
        case "predict": {
            const market = PREDICTION_MARKETS.find((m) => m.id === trade.marketId);
            const outcome = market?.outcomes.find((o) => o.id === trade.outcome);
            return {
                kind: "predict",
                title: `${outcome?.label ?? trade.outcome.toUpperCase()} on ${market?.question ?? "a market"}`,
                detail: outcome
                    ? `${formatUnits(trade.usd / outcome.price, "shares")} at ${formatCents(outcome.price)}`
                    : "",
                symbols: [market?.symbol ?? QUOTE],
                amountUSD: trade.usd,
                change: 0,
            };
        }
    }
}

export function depositActivity(deposit: { key: string; amountUSD: number; at: Date; pending?: boolean }): Activity {
    return {
        id: `deposit:${deposit.key}`,
        at: deposit.at,
        kind: "deposit",
        title: "Deposit",
        detail: `${QUOTE} on Arc`,
        symbols: [QUOTE],
        amountUSD: deposit.amountUSD,
        change: deposit.amountUSD,
        pending: deposit.pending,
    };
}

/**
 * The rows for a real prediction: its opening, which moves nothing, then what settling did.
 * `optimistic` marks a buy the server hasn't filled yet.
 */
export function predictionActivity(position: PositionView, optimistic = false): Activity[] {
    const cost = Number(position.costUSD);
    const name = `${position.outcome} on ${position.question}`;
    const base = { symbols: [QUOTE], amountUSD: cost };
    const rows: Activity[] = [
        {
            ...base,
            id: `prediction:${position.id}:open`,
            at: new Date(position.openedAt),
            kind: "predict",
            title: name,
            detail: formatUnits(Number(position.shares), "shares"),
            change: 0,
            pending: optimistic || undefined,
        },
    ];
    const settled = {
        closed: { prefix: "Sold", gross: Number(position.proceedsUSD ?? 0) },
        won: { prefix: "Won", gross: Number(position.payoutUSD ?? 0) },
        lost: { prefix: "Lost", gross: 0 },
    }[position.state as "closed" | "won" | "lost"];
    if (!optimistic && settled) {
        rows.push({
            ...base,
            id: `prediction:${position.id}:settle`,
            at: new Date(position.settledAt ?? position.updatedAt),
            kind: "close",
            title: `${settled.prefix} ${name}`,
            detail: position.state === "lost" ? "" : `${formatUsdShort(settled.gross)} back`,
            change: settled.gross - cost,
        });
    }
    return rows;
}

/** A buy the server hasn't filled yet. */
export function pendingBuyActivity(buy: {
    id: string;
    question: string;
    outcome: string;
    amountUSD: number;
    shares: string;
    at: Date;
}): Activity {
    return {
        id: `prediction:${buy.id}:open`,
        at: buy.at,
        kind: "predict",
        title: `${buy.outcome} on ${buy.question}`,
        detail: buy.shares ? formatUnits(Number(buy.shares), "shares") : "",
        symbols: [QUOTE],
        amountUSD: buy.amountUSD,
        change: 0,
        pending: true,
    };
}

// Mock content until trading is live: days ago, hour of day, and the trade.
const MOCK_TRADES: [number, number, Trade][] = [
    [29, 10, { kind: "swap", from: "ETH", to: "SOL", usd: 2_000 }],
    [28, 15, { kind: "long", symbol: "BTC", leverage: 10, usd: 420 }],
    [26, 9, { kind: "buy", symbol: "LINK", usd: 600 }],
    [25, 18, { kind: "short", symbol: "ETH", leverage: 5, usd: 570 }],
    [23, 11, { kind: "predict", marketId: "btc-150k-2026", outcome: "yes", usd: 250 }],
    [21, 14, { kind: "close", symbol: "DOGE", side: "long", leverage: 5, usd: 300, pnl: 86.4 }],
    [19, 16, { kind: "sell", symbol: "LINK", usd: 640 }],
    [17, 10, { kind: "long", symbol: "SOL", leverage: 3, usd: 400 }],
    [15, 13, { kind: "close", symbol: "AVAX", side: "short", leverage: 3, usd: 500, pnl: -54.2 }],
    [13, 9, { kind: "swap", from: "SOL", to: "USDC", usd: 750 }],
    [12, 17, { kind: "predict", marketId: "eth-5k-2026", outcome: "no", usd: 400 }],
    [10, 12, { kind: "close", symbol: "ARB", side: "long", leverage: 2, usd: 350, pnl: 128.75 }],
    [9, 15, { kind: "short", symbol: "DOGE", leverage: 2, usd: 320 }],
    [8, 11, { kind: "buy", symbol: "ETH", usd: 900 }],
    [5, 10, { kind: "close", symbol: "BTC", side: "short", leverage: 5, usd: 800, pnl: -112.3 }],
    [4, 14, { kind: "long", symbol: "LINK", leverage: 5, usd: 180 }],
    [3, 16, { kind: "swap", from: "USDC", to: "ETH", usd: 1_200 }],
    [2, 9, { kind: "close", symbol: "SOL", side: "long", leverage: 3, usd: 400, pnl: 64.1 }],
    [1, 13, { kind: "predict", marketId: "sol-ath-2026", outcome: "yes", usd: 150 }],
    [0, 9, { kind: "long", symbol: "AVAX", leverage: 3, usd: 383 }],
];

/** Deposits for the demo, which has no account to read them from. */
const MOCK_DEPOSITS: [number, number, number][] = [
    [30, 9, 5_000],
    [18, 12, 2_500],
    [6, 10, 1_000],
];

/** `days` ago at `hour`, never later than now. */
function ago(now: Date, days: number, hour: number) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return new Date(Math.min(start.getTime() - days * DAY + hour * 3_600_000, now.getTime()));
}

export function mockTrades(now: Date): Activity[] {
    return MOCK_TRADES.map(([days, hour, trade], i) => ({
        id: `mock:${i}`,
        at: ago(now, days, hour),
        ...describe(trade),
    }));
}

export function mockDeposits(now: Date): Activity[] {
    return MOCK_DEPOSITS.map(([days, hour, usd], i) =>
        depositActivity({ key: `mock:${i}`, amountUSD: usd, at: ago(now, days, hour) }),
    );
}

function toTrade(intent: TransactionIntent): Trade {
    switch (intent.type) {
        case "swap":
            return { kind: "swap", from: intent.fromToken, to: intent.toToken, usd: Number(intent.amountUSD) };
        case "spot":
            return { kind: intent.side, symbol: intent.token, usd: Number(intent.amountUSD) };
        case "perp":
            return {
                kind: intent.side,
                symbol: intent.asset,
                leverage: intent.leverage,
                usd: Number(intent.collateralUSD),
            };
        case "prediction":
            return {
                kind: "predict",
                marketId: intent.marketId,
                outcome: intent.outcomeId === "no" ? "no" : "yes",
                usd: Number(intent.amountUSD),
            };
    }
}

/** A trade confirmed in Review. Nothing was sent, so it doesn't move the balance. */
export function confirmedActivity(intent: TransactionIntent, at: Date, id: string): Activity {
    return { id, at, ...describe(toTrade(intent)), change: 0, simulated: true };
}

/** Newest first. */
export const byNewest = (a: Activity, b: Activity) => b.at.getTime() - a.at.getTime();

export type BalanceDay = {
    /** Midnight, local time. */
    day: Date;
    /** At the end of the day. */
    balance: number;
    /** Realized PnL and fees that day; deposits aren't PnL. */
    pnl: number;
    /** Just the PnL of positions closed that day, which says how the day went; fees alone don't. */
    realized: number;
    deposited: number;
};

/** The balance at the end of each of the last `days` days, today last. */
export function balanceHistory(activity: readonly Activity[], days: number, now: Date): BalanceDay[] {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const first = today.getTime() - (days - 1) * DAY;
    let balance = 0;
    for (const a of activity) if (a.at.getTime() < first) balance += a.change;
    const out: BalanceDay[] = [];
    for (let i = 0; i < days; i++) {
        const start = first + i * DAY;
        let pnl = 0;
        let realized = 0;
        let deposited = 0;
        for (const a of activity) {
            const t = a.at.getTime();
            if (t < start || t >= start + DAY) continue;
            if (a.kind === "deposit") deposited += a.change;
            else pnl += a.change;
            if (a.kind === "close") realized += a.change;
        }
        balance += pnl + deposited;
        out.push({ day: new Date(start), balance, pnl, realized, deposited });
    }
    return out;
}

/** Days back to the oldest activity, today included. */
export function daysSince(activity: readonly Activity[], now: Date) {
    const oldest = Math.min(...activity.map((a) => a.at.getTime()), now.getTime());
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return Math.max(1, Math.ceil((today.getTime() - oldest) / DAY) + 1);
}

// Trades confirmed in Review this session, newest first. Kept in memory: they
// were never sent anywhere, so there's nothing to restore after a reload.
let confirmed: Activity[] = [];
const listeners = new Set<() => void>();

export const confirmedTrades = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
    get: () => confirmed,
    add(intent: TransactionIntent) {
        const at = new Date();
        confirmed = [confirmedActivity(intent, at, `confirmed:${at.getTime()}:${confirmed.length}`), ...confirmed];
        for (const listener of listeners) listener();
    },
};
