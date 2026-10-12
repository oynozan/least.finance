import { formatUnits, parseUnits } from "viem";
import type {
    AccountView,
    ApiError,
    DepositOrderView,
    DepositOrigin,
    DepositQuoteView,
    DepositReceipt,
    DepositRules,
    DepositView,
    Hex,
    PositionView,
    PositionsView,
    PredictionFailure,
    PredictionOrderView,
    PredictionUpdate,
    QuoteView,
    SourceTxView,
    WalletSession,
} from "@/server/src/protocol";

export type {
    AccountView,
    ApiError,
    DepositOrderView,
    DepositOrigin,
    DepositQuoteView,
    DepositReceipt,
    DepositRules,
    DepositView,
    Hex,
    PositionView,
    PositionsView,
    PredictionFailure,
    PredictionOrderView,
    PredictionUpdate,
    QuoteView,
    SourceTxView,
    WalletSession,
};

/** Arc's native USDC, which the server's amounts keep in full. */
export const USDC_DECIMALS = 18;

/** A deposit the wallet has sent and the server hasn't confirmed yet. */
export type PendingDeposit = {
    txHash: Hex;
    /** Wei. */
    amount: bigint;
    /** When the wallet handed back the transaction, in ms. */
    sentAt: number;
};

/** A prediction buy the server has accepted but not yet shown back, counted against the balance meanwhile. */
export type OptimisticTrade = {
    requestId: string;
    side: "buy";
    eventId: string;
    tokenId: string;
    question: string;
    outcome: string;
    /** Wei. */
    amountWei: bigint;
    /** The quote's estimate. */
    shares: string;
    at: number;
};

export type AccountState =
    | { status: "idle" }
    | { status: "connecting" }
    | { status: "failed"; error: ApiError }
    | {
          status: "ready";
          account: AccountView;
          /** Wei, as the server last reported it. */
          balance: bigint;
          /** Newest first, as credited. */
          deposits: DepositView[];
          /** Cursor for older deposits, null once they're all here. */
          next: string | null;
          rules: DepositRules;
          /** Newest first; shown and counted until the server settles them. */
          pending: PendingDeposit[];
          /** Bridge orders still open, newest first. */
          orders: DepositOrderView[];
          /** The server's view of the account's predictions. */
          predictions: PositionsView;
          /** Newest first; counted against the balance until the server's order shows up. */
          optimistic: OptimisticTrade[];
      };

export type AccountAction =
    | { type: "reset" }
    | { type: "connecting" }
    | { type: "failed"; error: ApiError }
    | { type: "session"; session: WalletSession }
    /** A bridge order opened or moved on; an expired one leaves the list. */
    | { type: "order"; order: DepositOrderView }
    | { type: "credited"; deposit: DepositView; account: AccountView }
    | { type: "older"; deposits: DepositView[]; next: string | null }
    | { type: "sent"; txHash: Hex; amount: bigint; sentAt: number }
    | { type: "settled"; receipt: DepositReceipt }
    /** The server couldn't confirm the deposit, so it comes back out of the balance. */
    | { type: "reverted"; txHash: Hex }
    | { type: "predict"; trade: OptimisticTrade }
    /** The server turned the order down, or it never got there. */
    | { type: "predict-failed"; requestId: string }
    | { type: "prediction"; update: PredictionUpdate }
    | { type: "positions"; positions: PositionsView };

export const initialAccountState: AccountState = { status: "idle" };

export const toWei = (usdc: string) => parseUnits(usdc, USDC_DECIMALS);
export const toUsdc = (wei: bigint) => Number(formatUnits(wei, USDC_DECIMALS));

export function accountReducer(state: AccountState, action: AccountAction): AccountState {
    switch (action.type) {
        case "reset":
            return initialAccountState;
        case "connecting":
            // A reconnect keeps what's showing; only a first connect has nothing to show.
            return state.status === "ready" ? state : { status: "connecting" };
        case "failed":
            return state.status === "ready" ? state : { status: "failed", error: action.error };
        case "session": {
            const { account, deposits, rules } = action.session;
            // Deposits sent before a reconnect stay pending until the server has them.
            const pending = state.status === "ready" ? state.pending : [];
            return settle({
                status: "ready",
                account,
                balance: toWei(account.balance),
                deposits: deposits.items,
                next: deposits.next,
                rules,
                pending,
                orders: sortOrders(action.session.orders),
                // Positions follow as their own push after the session.
                predictions: state.status === "ready" ? state.predictions : { positions: [], orders: [] },
                optimistic: state.status === "ready" ? state.optimistic : [],
            });
        }
        case "order": {
            if (state.status !== "ready") return state;
            // An older version of an order that is already showing, such as a late acknowledgement, is dropped.
            const held = state.orders.find((o) => o.id === action.order.id);
            if (held && held.updatedAt > action.order.updatedAt) return state;
            const rest = state.orders.filter((o) => o.id !== action.order.id);
            const orders = sortOrders(action.order.state === "expired" ? rest : [action.order, ...rest]);
            return { ...state, orders, deposits: withOrigins(state.deposits, orders) };
        }
        case "credited":
            if (state.status !== "ready") return state;
            return settle(withAccount(withOrders(mergeDeposits(state, [action.deposit])), action.account));
        case "older":
            if (state.status !== "ready") return state;
            return { ...mergeDeposits(state, action.deposits), next: action.next };
        case "sent":
            if (state.status !== "ready") return state;
            if (state.pending.some((p) => p.txHash === action.txHash)) return state;
            if (state.deposits.some((d) => d.txHash === action.txHash)) return state;
            return {
                ...state,
                pending: [{ txHash: action.txHash, amount: action.amount, sentAt: action.sentAt }, ...state.pending],
            };
        case "settled":
            if (state.status !== "ready") return state;
            return settle(withAccount(mergeDeposits(state, action.receipt.deposits), action.receipt.account));
        case "reverted":
            if (state.status !== "ready") return state;
            return { ...state, pending: state.pending.filter((p) => p.txHash !== action.txHash) };
        case "predict":
            if (state.status !== "ready") return state;
            if (state.optimistic.some((t) => t.requestId === action.trade.requestId)) return state;
            return { ...state, optimistic: [action.trade, ...state.optimistic] };
        case "predict-failed":
            if (state.status !== "ready") return state;
            return { ...state, optimistic: state.optimistic.filter((t) => t.requestId !== action.requestId) };
        case "prediction": {
            if (state.status !== "ready") return state;
            const { update } = action;
            const held = state.predictions.orders.find((o) => o.id === update.order.id);
            const stale = !!held && held.updatedAt > update.order.updatedAt;
            const next = withAccount(state, update.account);
            return {
                ...next,
                predictions: stale
                    ? next.predictions
                    : {
                          orders: upsert(next.predictions.orders, update.order),
                          positions: update.position
                              ? upsert(next.predictions.positions, update.position)
                              : next.predictions.positions,
                      },
                optimistic: next.optimistic.filter((t) => t.requestId !== update.requestId),
            };
        }
        case "positions": {
            if (state.status !== "ready") return state;
            const known = new Set(action.positions.orders.map((o) => o.requestId));
            return {
                ...state,
                predictions: action.positions,
                optimistic: state.optimistic.filter((t) => !known.has(t.requestId)),
            };
        }
    }
}

type Ready = Extract<AccountState, { status: "ready" }>;

/** Replaces the entry with the same id, or adds it on top. */
const upsert = <T extends { id: string }>(items: T[], item: T): T[] => [item, ...items.filter((i) => i.id !== item.id)];

const sortOrders = (orders: DepositOrderView[]) =>
    orders
        .filter((o) => o.state !== "expired")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

/** A delivered order's deposit is credited before the order is linked to it, so the link is made here too. */
function withOrigins(deposits: DepositView[], orders: DepositOrderView[]): DepositView[] {
    return deposits.map((deposit) => {
        if (deposit.origin) return deposit;
        const order = orders.find((o) => o.state === "delivered" && o.depositId === deposit.id);
        const txHash = order?.sourceTxHashes.at(-1);
        return order && txHash ? { ...deposit, origin: { coin: order.coin, amount: order.amount, txHash } } : deposit;
    });
}

const withOrders = (state: Ready): Ready => ({ ...state, deposits: withOrigins(state.deposits, state.orders) });

/** Takes the server's account unless a newer version is already showing; pushes can arrive out of order. */
function withAccount(state: Ready, account: AccountView): Ready {
    if (account.version < state.account.version) return state;
    return { ...state, account, balance: toWei(account.balance) };
}

/** Adds deposits by id, keeping newest first. */
function mergeDeposits(state: Ready, incoming: DepositView[]): Ready {
    const byId = new Map(state.deposits.map((d) => [d.id, d]));
    for (const deposit of incoming) byId.set(deposit.id, deposit);
    const deposits = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { ...state, deposits };
}

/** Drops pending deposits the server has credited. */
function settle(state: Ready): Ready {
    if (state.pending.length === 0) return state;
    const credited = new Set(state.deposits.map((d) => d.txHash.toLowerCase()));
    const pending = state.pending.filter((p) => !credited.has(p.txHash.toLowerCase()));
    return pending.length === state.pending.length ? state : { ...state, pending };
}

/** The balance to show: the server's, plus whatever is still on its way. */
export function optimisticBalance(state: AccountState): bigint | null {
    if (state.status !== "ready") return null;
    const placed = new Set(state.predictions.orders.map((o) => o.requestId));
    // An order the server has is already debited in `account.balance`.
    const inFlight = state.optimistic.filter((t) => !placed.has(t.requestId));
    const afterDeposits = state.pending.reduce((sum, p) => sum + p.amount, state.balance);
    return inFlight.reduce((sum, t) => sum - t.amountWei, afterDeposits);
}

export type HistoryRow = {
    /**
     * The transaction hash, so a pending row keeps its identity once it's
     * credited; a transaction that credited more than once adds the log index.
     */
    key: string;
    /** Wei. */
    amount: bigint;
    at: Date;
    pending: boolean;
    /** The coin a bridged deposit came from. */
    origin?: DepositOrigin;
};

/** Pending deposits on top, then credited ones, newest first. */
export function historyRows(state: AccountState): HistoryRow[] {
    if (state.status !== "ready") return [];
    const perTx = new Map<string, number>();
    for (const d of state.deposits) perTx.set(d.txHash, (perTx.get(d.txHash) ?? 0) + 1);
    return [
        ...state.pending.map((p) => ({ key: p.txHash, amount: p.amount, at: new Date(p.sentAt), pending: true })),
        ...state.deposits.map((d) => ({
            key: (perTx.get(d.txHash) ?? 0) > 1 ? `${d.txHash}:${d.logIndex}` : d.txHash,
            amount: toWei(d.amount),
            at: new Date(d.creditedAt),
            pending: false,
            origin: d.origin,
        })),
    ];
}
